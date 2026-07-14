"""Shell execution — the only tool.

Persistent session: cwd and env survive between calls.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field

MAX_OUTPUT = 30_000  # chars — protect context budget


@dataclass
class ShellSession:
    cwd: str = field(default_factory=os.getcwd)
    env: dict = field(default_factory=lambda: dict(os.environ))

    def run(self, command: str, timeout: int = 120) -> str:
        """Execute a command in the persistent session.

        Returns stdout + stderr + exit code as a single string.
        Truncates output beyond MAX_OUTPUT with a clear signal.
        """
        result = subprocess.run(
            command,
            shell=True,
            cwd=self.cwd,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        # Track cwd changes (cd, pushd, etc.)
        if command.strip().startswith(("cd ", "cd\t")):
            target = command.strip()[3:].strip()
            new_dir = os.path.join(self.cwd, target) if not os.path.isabs(target) else target
            if os.path.isdir(new_dir):
                self.cwd = new_dir

        output = result.stdout
        if result.stderr:
            output += f"\n[stderr]\n{result.stderr}" if output else result.stderr

        output += f"\n[exit: {result.returncode}]"

        if len(output) > MAX_OUTPUT:
            half = MAX_OUTPUT // 2
            output = (
                output[:half]
                + f"\n\n[...truncated {len(output) - MAX_OUTPUT} chars...]\n\n"
                + output[-half:]
            )

        return output if output.strip() else "[no output]"
