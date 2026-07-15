export type AgentEvent =
  | { type: "run-start"; input: string }
  | { type: "tool-start"; id: string; name: string; command: string }
  | {
      type: "tool-complete";
      id: string;
      name: string;
      command: string;
      output: string;
      exitCode: number;
      truncated: boolean;
      eliminatedTokens: number;
    }
  | {
      type: "compression";
      before: number;
      after: number;
      eliminatedTokens: number;
    }
  | { type: "assistant-complete"; content: string }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;
