const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const USER_STYLE = "\x1b[48;5;24m\x1b[38;5;255m";
const TOOL_STYLE = "\x1b[48;5;58m\x1b[38;5;230m";
const AGENT_STYLE = "\x1b[48;5;22m\x1b[38;5;194m";

interface ColorStream {
  isTTY?: boolean;
}

export function supportsColor(
  stream: ColorStream,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(stream.isTTY) && !("NO_COLOR" in env);
}

export function formatUserPrompt(enabled: boolean): string {
  const prompt = "USER │ ";
  return enabled ? `${USER_STYLE}${BOLD}${prompt}` : prompt;
}

export function formatToolLine(command: string, enabled: boolean): string {
  return command
    .split("\n")
    .map((line) => formatLine(`TOOL │ $ ${line}`, TOOL_STYLE, enabled))
    .join("\n");
}

export function formatAgentReply(reply: string, enabled: boolean): string {
  return reply
    .split("\n")
    .map((line) => formatLine(`AGENT │ ${line}`, AGENT_STYLE, enabled))
    .join("\n");
}

export function resetStyle(enabled: boolean): string {
  return enabled ? RESET : "";
}

function formatLine(text: string, style: string, enabled: boolean): string {
  return enabled ? `${style}${BOLD}${text}${RESET}` : text;
}
