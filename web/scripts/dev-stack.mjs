#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = resolve(webDir, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const backendPort = Number.parseInt(process.env.INLINE_PORT ?? '7878', 10);

export function isPortOpen(port = backendPort, host = '127.0.0.1') {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.once('error', () => resolveOpen(false));
  });
}

export async function waitForPort({
  port = backendPort,
  host = '127.0.0.1',
  timeoutMs = 30_000,
  intervalMs = 100,
  child,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return;
    if (child?.exitCode !== null) {
      throw new Error(`inline-agent backend exited before port ${port} became ready`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }

  throw new Error(`timed out waiting for inline-agent backend on ${host}:${port}`);
}

function spawnBackend() {
  return spawn(npmCommand, ['run', 'dev'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
}

function spawnWeb() {
  return spawn(npmCommand, ['run', 'dev:astro'], {
    cwd: webDir,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function attachLifecycle(backend, web) {
  let stopping = false;

  const stop = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    if (backend && !backend.killed) backend.kill(signal);
    if (!web.killed) web.kill(signal);
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stop(signal));
  }

  backend?.once('exit', (code) => {
    if (stopping) return;
    process.stderr.write(`\ninline-agent backend stopped (${code ?? 'signal'}); stopping Astro.\n`);
    stop();
    process.exitCode = code ?? 1;
  });

  web.once('exit', (code) => {
    if (stopping) return;
    stop();
    process.exitCode = code ?? 1;
  });

  return stop;
}

export async function runDevStack({
  isBackendReady = isPortOpen,
  startBackend = spawnBackend,
  waitForBackend = (child) => waitForPort({ child }),
  startWeb = spawnWeb,
  installSignalHandlers = true,
} = {}) {
  let backend;

  if (await isBackendReady()) {
    process.stderr.write(`Using inline-agent backend already running on port ${backendPort}.\n`);
  } else {
    process.stderr.write(`Starting inline-agent backend on port ${backendPort}...\n`);
    backend = startBackend();
    try {
      await waitForBackend(backend);
    } catch (error) {
      if (!backend.killed) backend.kill();
      throw error;
    }
  }

  const web = startWeb();
  const stop = installSignalHandlers ? attachLifecycle(backend, web) : () => {};
  return { backend, web, stop };
}

const isEntrypoint = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runDevStack().catch((error) => {
    process.stderr.write(`Failed to start development stack: ${error.message}\n`);
    process.exitCode = 1;
  });
}
