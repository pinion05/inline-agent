/**
 * Context transparency SSE server.
 *
 * Serves real-time agent context state via Server-Sent Events.
 * The frontend (Astro + SolidJS) connects to /events.
 *
 * The LLM never knows this exists.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Message } from "./compact.js";
import { DEFAULT_RECENT_RAW_TOOL_ACTIONS } from "./config.js";

const PORT = parseInt(process.env.INLINE_PORT ?? "7878", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, "..", "web", "dist");

let currentMessages: Message[] = [];
let lastApiMessages: Message[] = [];
let lastApiTools: unknown[] = [];
let lastApiModel: string | null = null;
let lastApiReasoningEffort: string | null = null;
let currentStats: Stats = {
  totalTokens: 0,
  messageCount: 0,
  contextWindow: 0,
  eliminatedTokens: 0,
  safetyTruncatedTokens: 0,
  currentProjectionTokens: 0,
  configuredRawActions: DEFAULT_RECENT_RAW_TOOL_ACTIONS,
  effectiveRawActions: DEFAULT_RECENT_RAW_TOOL_ACTIONS,
  totalPromptTokens: 0,
  cacheHitTokens: 0,
  compressionHistory: [],
  lastAction: "idle",
};
let clients: ServerResponse[] = [];

export interface Stats {
  totalTokens: number;
  messageCount: number;
  contextWindow: number;
  eliminatedTokens: number;
  safetyTruncatedTokens: number;
  currentProjectionTokens: number;
  configuredRawActions: number;
  effectiveRawActions: number;
  totalPromptTokens: number;
  cacheHitTokens: number;
  compressionHistory: {
    from: number;
    to: number;
    eliminatedTokens: number;
    time: string;
  }[];
  lastAction: string;
}

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) for (const tc of m.tool_calls) chars += JSON.stringify(tc).length;
  }
  return Math.ceil(chars / 4);
}

export function getSnapshot() {
  return {
    stats: currentStats,
    apiMessages: lastApiMessages,
    apiTools: lastApiTools,
    apiModel: lastApiModel,
    apiReasoningEffort: lastApiReasoningEffort,
    messages: currentMessages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
      toolCalls: m.tool_calls,
      toolCallId: m.tool_call_id,
      tokens: Math.ceil(
        ((m.content?.length ?? 0) +
          (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)) / 4
      ),
    })),
  };
}

function broadcast() {
  const data = JSON.stringify(getSnapshot());
  for (const res of clients) res.write(`data: ${data}\n\n`);
}

export function recordApiContext(
  messages: Message[],
  tools: unknown[],
  metadata: {
    model: string;
    reasoningEffort: string;
    configuredRawActions: number;
    effectiveRawActions: number;
    projectionTokens: number;
  },
) {
  lastApiMessages = structuredClone(messages);
  lastApiTools = structuredClone(tools);
  lastApiModel = metadata.model;
  lastApiReasoningEffort = metadata.reasoningEffort;
  currentStats.currentProjectionTokens = Math.max(0, metadata.projectionTokens);
  currentStats.configuredRawActions = metadata.configuredRawActions;
  currentStats.effectiveRawActions = metadata.effectiveRawActions;
  updateEliminatedTotal();
  broadcast();
}

export function updateContext(
  messages: Message[],
  contextWindow: number,
  action: string
) {
  currentMessages = messages;
  currentStats = {
    totalTokens: estimateTokens(messages),
    messageCount: messages.length,
    contextWindow,
    eliminatedTokens: currentStats.eliminatedTokens,
    safetyTruncatedTokens: currentStats.safetyTruncatedTokens,
    currentProjectionTokens: currentStats.currentProjectionTokens,
    configuredRawActions: currentStats.configuredRawActions,
    effectiveRawActions: currentStats.effectiveRawActions,
    totalPromptTokens: currentStats.totalPromptTokens,
    cacheHitTokens: currentStats.cacheHitTokens,
    compressionHistory: currentStats.compressionHistory,
    lastAction: action,
  };
  broadcast();
}

export function recordSafetyTruncation(eliminatedTokens: number) {
  currentStats.safetyTruncatedTokens += Math.max(0, eliminatedTokens);
  updateEliminatedTotal();
  broadcast();
}

/** @deprecated Use recordSafetyTruncation. */
export const recordEliminatedTokens = recordSafetyTruncation;

export function recordCompression(
  from: number,
  to: number,
  eliminatedTokens: number
) {
  const eliminated = Math.max(0, eliminatedTokens);
  currentStats.compressionHistory.push({
    from,
    to,
    eliminatedTokens: eliminated,
    time: new Date().toLocaleTimeString(),
  });
  broadcast();
}

function updateEliminatedTotal(): void {
  currentStats.eliminatedTokens = currentStats.safetyTruncatedTokens
    + currentStats.currentProjectionTokens;
}

export function recordUsage(promptTokens: number, cacheHitTokens: number) {
  const prompt = Math.max(0, promptTokens);
  const cached = Math.min(prompt, Math.max(0, cacheHitTokens));
  currentStats.totalPromptTokens += prompt;
  currentStats.cacheHitTokens += cached;
  broadcast();
}

export function startServer(options: { silent?: boolean; open?: boolean } = {}): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
      clients.push(res);
      req.on("close", () => {
        clients = clients.filter((c) => c !== res);
      });
      return;
    }

    // Serve built frontend if available
    if (existsSync(WEB_DIST)) {
      let filePath = req.url === "/" ? "/index.html" : req.url!;
      const fullPath = join(WEB_DIST, filePath);
      if (existsSync(fullPath)) {
        const ext = filePath.split(".").pop();
        const types: Record<string, string> = {
          html: "text/html; charset=utf-8",
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          json: "application/json",
          png: "image/png",
          ico: "image/x-icon",
        };
        res.writeHead(200, { "Content-Type": types[ext ?? ""] ?? "application/octet-stream" });
        res.end(readFileSync(fullPath));
        return;
      }
    }

    // Fallback: minimal status page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<html><body style="font-family:monospace;background:#0d1117;color:#58a6ff;padding:40px">` +
        `<h2>inline-agent context server</h2>` +
        `<p>SSE: <a href="/events" style="color:#58a6ff">/events</a></p>` +
        `<p>Frontend: <code>cd web && npm run dev</code></p>` +
        `<p>Or build: <code>cd web && npm run build</code></p>` +
        `</body></html>`
    );
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    if (!options.silent) process.stderr.write(`📊 ${url}\n`);
    if (options.open !== false) openBrowser(url);
  });
}

/**
 * 크로스플랫폼 기본 브라우저 오픈.
 * macOS: open / Windows: start / 그 외(Linux 등): xdg-open.
 * detach + unref로 자식 프로세스가 Node 종료를 막지 않게 한다.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" :
    "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { /* 브라우저 오픈 실패는 치명적이지 않음 */ });
    child.unref();
  } catch {
    /* 무시 */
  }
}
