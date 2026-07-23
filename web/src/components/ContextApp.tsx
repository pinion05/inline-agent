import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface ApiMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  tokens?: number;
}

interface Stats {
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

interface Snapshot {
  stats: Stats;
  apiMessages: ApiMessage[];
  apiTools: unknown[];
  apiModel: string | null;
  apiReasoningEffort: string | null;
}

function normalizeSnapshot(next: Snapshot): Snapshot {
  return {
    ...next,
    stats: {
      ...next.stats,
      eliminatedTokens: next.stats.eliminatedTokens ?? 0,
      safetyTruncatedTokens: next.stats.safetyTruncatedTokens ?? 0,
      currentProjectionTokens: next.stats.currentProjectionTokens ?? 0,
      configuredRawActions: next.stats.configuredRawActions ?? 3,
      effectiveRawActions: next.stats.effectiveRawActions ?? 3,
      totalPromptTokens: next.stats.totalPromptTokens ?? 0,
      cacheHitTokens: next.stats.cacheHitTokens ?? 0,
      compressionHistory: (next.stats.compressionHistory ?? []).map((item) => ({
        ...item,
        eliminatedTokens: item.eliminatedTokens ?? 0,
      })),
    },
    apiMessages: next.apiMessages ?? [],
    apiTools: next.apiTools ?? [],
    apiModel: next.apiModel ?? null,
    apiReasoningEffort: next.apiReasoningEffort ?? null,
  };
}

const ROLE_COLORS: Record<string, string> = {
  user: '#58a6ff',
  assistant: '#3fb950',
  tool: '#d29922',
};

const ROLE_LABELS: Record<string, string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
  system: 'SYSTEM',
};

const COMPRESSED_COLOR = '#bc8cff';

const COMPRESSED_MARKER = /\[\.\.\.\d+ chars compressed\.\.\.\]/;

function isCompressedMessage(msg: ApiMessage): boolean {
  return typeof msg.content === 'string' && COMPRESSED_MARKER.test(msg.content);
}

export default function ContextApp() {
  const [snapshot, setSnapshot] = createSignal<Snapshot>({
    stats: {
      totalTokens: 0,
      messageCount: 0,
      contextWindow: 0,
      eliminatedTokens: 0,
      safetyTruncatedTokens: 0,
      currentProjectionTokens: 0,
      configuredRawActions: 3,
      effectiveRawActions: 3,
      totalPromptTokens: 0,
      cacheHitTokens: 0,
      compressionHistory: [],
      lastAction: 'connecting...',
    },
    apiMessages: [],
    apiTools: [],
    apiModel: null,
    apiReasoningEffort: null,
  });
  let es: EventSource | undefined;

  onMount(() => {
    es = new EventSource('/events');
    es.onmessage = (e) => setSnapshot(normalizeSnapshot(JSON.parse(e.data)));
    es.onerror = () => {
      const s = snapshot();
      setSnapshot({ ...s, stats: { ...s.stats, lastAction: 'reconnecting...' } });
    };
  });

  onCleanup(() => es?.close());

  const apiTokens = () => snapshot().apiMessages.reduce(
    (total, message) => total + (message.tokens ?? 0),
    Math.ceil(JSON.stringify(snapshot().apiTools).length / 4),
  );

  const usagePct = () => {
    const contextWindow = snapshot().stats.contextWindow;
    return contextWindow > 0 ? (apiTokens() / contextWindow * 100) : 0;
  };

  const cacheHitPct = () => {
    const s = snapshot().stats;
    return s.totalPromptTokens > 0
      ? (s.cacheHitTokens / s.totalPromptTokens) * 100
      : null;
  };

  return (
    <div style={{ padding: '20px', 'max-width': '1200px', margin: '0 auto' }}>
      {/* Stats Bar */}
      <div style={{
        position: 'sticky', top: '0', 'z-index': '100',
        background: '#0d1117', 'padding-bottom': '16px',
        'border-bottom': '1px solid #30363d', 'margin-bottom': '16px',
      }}>
        <div style={{ display: 'flex', gap: '32px', 'flex-wrap': 'wrap' }}>
          <Stat label="Tokens" value={apiTokens().toLocaleString()} />
          <Stat label="Messages" value={String(snapshot().apiMessages.length)} />
          <Stat label="Context Window" value={snapshot().stats.contextWindow.toLocaleString()} />
          <Stat label="Model" value={snapshot().apiModel ?? '—'} />
          <Stat label="Reasoning" value={snapshot().apiReasoningEffort ?? '—'} />
          <Stat
            label="안전 상한 소거"
            value={snapshot().stats.safetyTruncatedTokens.toLocaleString()}
            color="#f0883e"
          />
          <Stat
            label="현재 요청 압축"
            value={snapshot().stats.currentProjectionTokens.toLocaleString()}
            color="#d29922"
          />
          <Stat
            label="Raw Actions"
            value={`${snapshot().stats.effectiveRawActions}/${snapshot().stats.configuredRawActions}`}
            color="#d29922"
          />
          <Stat
            label="캐시히트"
            value={snapshot().stats.cacheHitTokens.toLocaleString()}
            color="#3fb950"
          />
          <Stat
            label="전체 캐시 비율"
            value={cacheHitPct() === null ? '—' : `${cacheHitPct()!.toFixed(1)}%`}
            color="#3fb950"
          />
          <Stat
            label="Usage"
            value={`${usagePct().toFixed(1)}%`}
            color={usagePct() > 80 ? '#f85149' : usagePct() > 50 ? '#f0883e' : '#58a6ff'}
          />
        </div>
        {/* Progress bar */}
        <div style={{
          height: '4px', background: '#21262d', 'border-radius': '2px',
          'margin-top': '10px', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(usagePct(), 100)}%`,
            background: usagePct() > 80 ? '#f85149' : usagePct() > 50 ? '#f0883e' : '#3fb950',
            transition: 'width 0.3s, background 0.3s',
          }} />
        </div>
        <div style={{ 'font-size': '11px', color: '#8b949e', 'margin-top': '6px' }}>
          <span style={{ color: '#58a6ff' }}>●</span> {snapshot().stats.lastAction}
        </div>
      </div>

      {/* Compression Log */}
      <Show when={snapshot().stats.compressionHistory.length > 0}>
        <div style={{
          'margin-bottom': '16px', padding: '10px 14px',
          background: '#1c1208', 'border-radius': '8px',
          'border-left': '3px solid #f0883e',
        }}>
          <div style={{ color: '#f0883e', 'font-weight': '600', 'font-size': '12px', 'margin-bottom': '4px' }}>
            ⚡ Trajectory Compression
          </div>
          <For each={snapshot().stats.compressionHistory}>
            {(c) => (
              <div style={{ color: '#f0883e', 'font-size': '11px', opacity: 0.8 }}>
                {c.time}: {c.from} → {c.to} messages · -{c.eliminatedTokens.toLocaleString()} tokens
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Exact tool definitions */}
      <ContextSectionTitle title="실제 TOOL DEFINITIONS" subtitle="API 요청에 포함된 tools 원문 전체" />
      <Show
        when={snapshot().apiTools.length > 0}
        fallback={<EmptyContext>Tool 정의 없음</EmptyContext>}
      >
        <RawBlock value={JSON.stringify(snapshot().apiTools, null, 2)} />
      </Show>

      {/* Exact API context */}
      <div style={{ 'margin': '20px 0 12px' }}>
        <div style={{ color: '#58a6ff', 'font-size': '15px', 'font-weight': '700' }}>
          실제 LLM 컨텍스트
        </div>
        <div style={{ color: '#8b949e', 'font-size': '11px', 'margin-top': '3px' }}>
          마지막 API 호출 직전에 캡처한 messages 원문 전체
        </div>
      </div>
      <Show
        when={snapshot().apiMessages.length > 0}
        fallback={(
          <div style={{ padding: '20px', color: '#8b949e', background: '#161b22', 'border-radius': '8px' }}>
            아직 API에 전송된 컨텍스트가 없습니다.
          </div>
        )}
      >
        <For each={snapshot().apiMessages}>
          {(msg, i) => <ApiMessageCard msg={msg} index={i()} />}
        </For>
      </Show>
    </div>
  );
}

function Stat(props: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
      <span style={{ color: '#8b949e', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.5px' }}>
        {props.label}
      </span>
      <span style={{
        color: props.color ?? '#58a6ff',
        'font-size': '20px',
        'font-weight': '600',
      }}>
        {props.value}
      </span>
    </div>
  );
}

function ApiMessageCard(props: { msg: ApiMessage; index: number }) {
  const compressed = () => isCompressedMessage(props.msg);
  const color = () => compressed()
    ? COMPRESSED_COLOR
    : (ROLE_COLORS[props.msg.role] ?? '#8b949e');
  const label = () => ROLE_LABELS[props.msg.role] ?? props.msg.role.toUpperCase();

  return (
    <div style={{
      'margin-bottom': '10px', padding: '14px 16px',
      'border-radius': '8px',
      'border-left': `3px solid ${color()}`,
      background: '#161b22',
    }}>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '10px' }}>
        <span style={{ color: '#8b949e', 'font-size': '10px', 'font-weight': '600' }}>
          #{props.index + 1} {label()}
        </span>
        <Show when={compressed()}>
          <span style={{
            'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
            background: COMPRESSED_COLOR + '22', color: COMPRESSED_COLOR,
          }}>
            compressed
          </span>
        </Show>
        <span style={{
          'font-size': '9px', padding: '1px 6px', 'border-radius': '10px',
          background: '#21262d', color: '#8b949e',
        }}>
          ~{props.msg.tokens ?? '?'} tok
        </span>
      </div>

      <Show when={props.msg.content !== undefined}>
        <FieldLabel>content 원문</FieldLabel>
        <pre style={{
          margin: '4px 0 10px', padding: '10px 12px',
          background: '#0d1117', color: '#c9d1d9',
          'border-radius': '6px', 'white-space': 'pre-wrap',
          'word-break': 'break-word', 'font-size': '12px',
          'line-height': '1.55', 'max-height': '500px', overflow: 'auto',
        }}>{props.msg.content}</pre>
      </Show>

      <Show when={props.msg.tool_call_id !== undefined}>
        <FieldLabel>tool_call_id 원문</FieldLabel>
        <pre style={{
          margin: '4px 0 10px', padding: '10px 12px',
          background: '#0d1117', color: '#d29922',
          'border-radius': '6px', 'white-space': 'pre-wrap',
          'word-break': 'break-all', 'font-size': '12px',
        }}>{props.msg.tool_call_id}</pre>
      </Show>

      <Show when={props.msg.tool_calls !== undefined}>
        <FieldLabel>tool_calls 원문 JSON</FieldLabel>
        <pre style={{
          margin: '4px 0 10px', padding: '10px 12px',
          background: '#0d1117', color: '#58a6ff',
          'border-radius': '6px', 'white-space': 'pre-wrap',
          'word-break': 'break-word', 'font-size': '12px',
          'line-height': '1.55', 'max-height': '600px', overflow: 'auto',
        }}>{JSON.stringify(props.msg.tool_calls, null, 2)}</pre>
      </Show>

      <FieldLabel>메시지 전체 원문 JSON</FieldLabel>
      <pre style={{
        margin: '4px 0 0', padding: '10px 12px',
        background: '#090c10', color: '#8b949e',
        'border-radius': '6px', 'white-space': 'pre-wrap',
        'word-break': 'break-word', 'font-size': '11px',
        'line-height': '1.5', 'max-height': '600px', overflow: 'auto',
      }}>{JSON.stringify(props.msg, null, 2)}</pre>
    </div>
  );
}

function ContextSectionTitle(props: { title: string; subtitle: string }) {
  return (
    <div style={{ 'margin': '20px 0 8px' }}>
      <div style={{ color: '#58a6ff', 'font-size': '15px', 'font-weight': '700' }}>
        {props.title}
      </div>
      <div style={{ color: '#8b949e', 'font-size': '11px', 'margin-top': '3px' }}>
        {props.subtitle}
      </div>
    </div>
  );
}

function RawBlock(props: { value: string }) {
  return (
    <pre style={{
      margin: '0 0 10px', padding: '12px 14px',
      background: '#0d1117', color: '#c9d1d9',
      'border-radius': '8px', 'white-space': 'pre-wrap',
      'word-break': 'break-word', 'font-size': '12px',
      'line-height': '1.55', 'max-height': '600px', overflow: 'auto',
    }}>{props.value}</pre>
  );
}

function EmptyContext(props: { children: any }) {
  return (
    <div style={{
      padding: '12px 14px', color: '#8b949e', background: '#161b22',
      'border-radius': '8px', 'font-size': '12px',
    }}>{props.children}</div>
  );
}

function FieldLabel(props: { children: any }) {
  return (
    <div style={{ color: '#8b949e', 'font-size': '9px', 'font-weight': '600', 'text-transform': 'uppercase' }}>
      {props.children}
    </div>
  );
}
