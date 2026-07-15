/**
 * Compaction — invisible context protection.
 *
 * Trigger: 50% of context window used.
 * Keeps: last 10 turns (original).
 * Compacts: everything before that via sanitization LLM.
 * Marks: [compacted history] so LLM knows.
 */

const COMPACTION_PROMPT = `Summarize this conversation for continuation. Preserve:
- What was accomplished
- Current work in progress
- Key files and their state
- Next steps
- User requests and constraints`;

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += JSON.stringify(tc).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Find the index where the last N turns start. */
function findTurnBoundary(messages: Message[], keepTurns: number): number {
  // Count user messages from the end — each is a turn start.
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > keepTurns) return i;
    }
  }
  return -1; // not enough turns to compact
}

export function needsCompaction(
  messages: Message[],
  contextWindow: number,
  threshold = 0.5
): boolean {
  return estimateTokens(messages) > contextWindow * threshold;
}

export async function compact(
  client: any,
  model: string,
  messages: Message[],
  keepTurns = 10
): Promise<Message[]> {
  const boundary = findTurnBoundary(messages, keepTurns);
  if (boundary <= 0) return messages; // nothing to compact

  // Separate old messages (to compact) from recent (to keep).
  const toCompact = messages.slice(0, boundary);
  const toKeep = messages.slice(boundary);

  // Serialize old messages to text.
  const transcript = toCompact
    .map((m) => {
      let line = `[${m.role}]`;
      if (m.content) line += ` ${m.content}`;
      if (m.tool_calls) line += ` ${JSON.stringify(m.tool_calls)}`;
      return line;
    })
    .join("\n\n");

  // Call sanitization LLM — plain text, no tools.
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "user", content: `${COMPACTION_PROMPT}\n\n${transcript}` },
    ],
  });

  const summary = resp.choices[0].message.content ?? "[compaction failed]";

  // Rebuild: compacted summary as a user message, then recent turns.
  const compacted: Message[] = [
    {
      role: "user",
      content: `[compacted history]\n${summary}`,
    },
    ...toKeep,
  ];

  return compacted;
}
