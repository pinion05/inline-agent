"""Entry point."""
from __future__ import annotations

import os
import sys

from openai import OpenAI
from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory

from .loop import SYSTEM_PROMPT, run
from .shell import ShellSession


def main():
    model = os.environ.get("INLINE_MODEL", "gpt-5")
    base_url = os.environ.get("INLINE_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY", "")

    client = OpenAI(base_url=base_url, api_key=api_key) if base_url else OpenAI(api_key=api_key)
    session = ShellSession()

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    history_path = os.path.expanduser("~/.inline_agent_history")
    prompt = PromptSession(history=FileHistory(history_path))

    print(f"inline-agent | model={model}", file=sys.stderr)
    print(f"cwd={session.cwd}", file=sys.stderr)
    print(file=sys.stderr)

    while True:
        try:
            user_input = prompt.prompt(">>> ")
        except (EOFError, KeyboardInterrupt):
            print(file=sys.stderr)
            break

        if not user_input.strip():
            continue

        if user_input.strip() in ("/exit", "/quit"):
            break

        reply = run(client, model, user_input, messages, session)
        print(reply)
        print(file=sys.stderr)
