import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getDevCommands, runDevStack } from '../scripts/dev-stack.mjs';

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

test('dashboard shows the cumulative number of eliminated tokens', () => {
  const component = readFileSync(
    new URL('../src/components/ContextApp.tsx', import.meta.url),
    'utf8',
  );

  assert.match(component, /label="소거한 불필요토큰"/);
  assert.match(component, /snapshot\(\)\.stats\.eliminatedTokens/);
  assert.match(component, /label="캐시히트"/);
  assert.match(component, /snapshot\(\)\.stats\.cacheHitTokens/);
  assert.match(component, /label="전체 캐시 비율"/);
  assert.match(component, /s\.cacheHitTokens \/ s\.totalPromptTokens/);
  assert.match(component, /setSnapshot\(normalizeSnapshot/);
  assert.match(component, /eliminatedTokens: next\.stats\.eliminatedTokens \?\? 0/);
  assert.match(component, /실제 SYSTEM PROMPT/);
  assert.match(component, /시스템 프롬프트 없음/);
  assert.match(component, /실제 TOOL DEFINITIONS/);
  assert.match(component, /JSON\.stringify\(snapshot\(\)\.apiTools/);
  assert.match(component, /label="Model"/);
  assert.match(component, /snapshot\(\)\.apiModel/);
  assert.match(component, /label="Reasoning"/);
  assert.match(component, /snapshot\(\)\.apiReasoningEffort/);
  assert.match(component, /실제 LLM 컨텍스트/);
  assert.match(component, /<For each=\{snapshot\(\)\.apiMessages\}>/);
  assert.match(component, /props\.msg\.content/);
  assert.match(component, /props\.msg\.tool_call_id/);
  assert.match(component, /JSON\.stringify\(props\.msg\.tool_calls/);
});

test('root dev command launches the combined CLI and web stack without recursion', () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const script = readFileSync(
    new URL('../scripts/dev-stack.mjs', import.meta.url),
    'utf8',
  );
  const commands = getDevCommands();

  assert.equal(rootPackage.scripts.dev, 'node web/scripts/dev-stack.mjs');
  assert.equal(rootPackage.scripts['dev:agent'], 'tsx src/index.ts');
  assert.deepEqual(commands.build.args, ['run', 'build']);
  assert.deepEqual(commands.backend.args, ['run', 'dev:agent']);
  assert.deepEqual(commands.web.args, ['run', 'dev:astro']);
  assert.match(
    script,
    /function spawnWeb\(\)[\s\S]*?stdio: \['ignore', 'ignore', 'ignore'\]/,
  );
});

test('starts the backend and waits for SSE before starting Astro', async () => {
  const calls = [];
  const backend = child('backend');
  const web = child('web');

  const result = await runDevStack({
    buildWeb: async () => {
      calls.push('build-web');
    },
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
    'build-web',
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
    buildWeb: async () => {
      calls.push('build-web');
    },
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

  assert.deepEqual(calls, ['build-web', 'start-web']);
  assert.equal(result.backend, undefined);
  assert.equal(result.web, web);
});
