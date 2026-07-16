import type { Message } from "./compact.js";
import {
  MAX_MAX_TOOL_CALLS_PER_RESPONSE,
  MIN_MAX_TOOL_CALLS_PER_RESPONSE,
} from "./config.js";

export const RUNTIME_TOOL_POLICY_PREFIX = "[runtime tool policy]";

export class MissingUserAnchorError extends Error {
  constructor() {
    super("Cannot insert runtime tool policy because the request has no user message.");
    this.name = "MissingUserAnchorError";
  }
}

export function createRuntimeToolPolicy(
  maxToolCallsPerResponse: number,
): Message {
  assertMaxToolCallsPerResponse(maxToolCallsPerResponse);
  return {
    role: "system",
    content: `${RUNTIME_TOOL_POLICY_PREFIX}\nIn this assistant response, emit at most ${maxToolCallsPerResponse} shell tool calls.\nIf more work is needed, wait for the tool results and continue in the next response.`,
  };
}

export function insertRuntimeToolPolicy(
  messages: Message[],
  maxToolCallsPerResponse: number,
): Message[] {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) throw new MissingUserAnchorError();

  return [
    ...messages.slice(0, userIndex),
    createRuntimeToolPolicy(maxToolCallsPerResponse),
    ...messages.slice(userIndex),
  ];
}

function assertMaxToolCallsPerResponse(value: number): void {
  if (
    !Number.isInteger(value)
    || value < MIN_MAX_TOOL_CALLS_PER_RESPONSE
    || value > MAX_MAX_TOOL_CALLS_PER_RESPONSE
  ) {
    throw new Error(
      `maxToolCallsPerResponse must be an integer from ${MIN_MAX_TOOL_CALLS_PER_RESPONSE} to ${MAX_MAX_TOOL_CALLS_PER_RESPONSE}`,
    );
  }
}
