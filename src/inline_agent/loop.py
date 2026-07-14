"""The agent loop. As thin as it gets."""
from __future__ import annotations

import json
import sys

from openai import OpenAI

from .shell import ShellSession

# The entire system prompt. One line. The LLM already knows how to code.
SYSTEM_PROMPT = "You are a coding agent with one tool: shell. Use it to accomplish the user's task."

SHELL_TOOL = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Execute a shell command. Returns stdout, stderr, and exit code.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute.",
                }
            },
            "required": ["command"],
        },
    },
}


def run(
    client: OpenAI,
    model: str,
    user_message: str,
    messages: list[dict],
    session: ShellSession,
    max_iterations: int = 50,
) -> str:
    """Run the agent loop until the LLM stops calling tools."""

    messages.append({"role": "user", "content": user_message})

    for _ in range(max_iterations):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[SHELL_TOOL],
        )

        msg = response.choices[0].message

        # Serialize assistant message for the next turn.
        entry: dict = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            entry["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
        messages.append(entry)

        if not msg.tool_calls:
            return msg.content or ""

        for tc in msg.tool_calls:
            command = json.loads(tc.function.arguments)["command"]
            print(f"  $ {command}", file=sys.stderr)
            result = session.run(command)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                }
            )

    return "[max iterations reached]"
