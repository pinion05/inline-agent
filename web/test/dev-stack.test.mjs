import test from 'node:test';
import assert from 'node:assert/strict';

import { runDevStack } from '../scripts/dev-stack.mjs';

function child(name) {
  return {
    name,
    killed: false,
    listeners: new Map(),
    once(event, listener) {
      this.listeners.set(event, listener);
      return this;
    },
    kill() {
      this.killed = true;
      return true;
    },
  };
}

test('starts the backend and waits for SSE before starting Astro', async () => {
  const calls = [];
  const backend = child('backend');
  const web = child('web');

  const result = await runDevStack({
    isBackendReady: async () => {
      calls.push('check-backend');
      return false;
    },
    startBackend: () => {
      calls.push('start-backend');
      return backend;
    },
    waitForBackend: async () => {
      calls.push('wait-backend');
    },
    startWeb: () => {
      calls.push('start-web');
      return web;
    },
    installSignalHandlers: false,
  });

  assert.deepEqual(calls, [
    'check-backend',
    'start-backend',
    'wait-backend',
    'start-web',
  ]);
  assert.equal(result.backend, backend);
  assert.equal(result.web, web);
});

test('reuses an already running backend', async () => {
  const calls = [];
  const web = child('web');

  const result = await runDevStack({
    isBackendReady: async () => true,
    startBackend: () => {
      calls.push('start-backend');
      return child('backend');
    },
    waitForBackend: async () => {
      calls.push('wait-backend');
    },
    startWeb: () => {
      calls.push('start-web');
      return web;
    },
    installSignalHandlers: false,
  });

  assert.deepEqual(calls, ['start-web']);
  assert.equal(result.backend, undefined);
  assert.equal(result.web, web);
});
