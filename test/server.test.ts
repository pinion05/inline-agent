import test from "node:test";
import assert from "node:assert/strict";

import {
  getSnapshot,
  recordApiContext,
  recordCompression,
  recordHttpRequest,
  recordSafetyTruncation,
  recordUsage,
} from "../src/server.js";
import { estimateTokens } from "../src/tokenize.js";
import type { Message } from "../src/compact.js";
import type { HttpRequestCapture } from "../src/http-observer.js";

test("records canonical recovery compaction without mixing it into safety metrics", () => {
  const before: Message[] = [{ role: "user", content: "12345678" }];
  const after: Message[] = [{ role: "user", content: "1234" }];
  const eliminated = estimateTokens(before) - estimateTokens(after);
  const initialHistoryLength = getSnapshot().stats.compressionHistory.length;
  const initialSafety = getSnapshot().stats.safetyTruncatedTokens;

  recordCompression(before.length, after.length, eliminated);

  const snapshot = getSnapshot();
  assert.equal(
    snapshot.stats.compressionHistory.length,
    initialHistoryLength + 1,
  );
  assert.equal(snapshot.stats.safetyTruncatedTokens, initialSafety);
});

test("tracks safety truncation separately from current request projection", () => {
  const initialSafety = getSnapshot().stats.safetyTruncatedTokens;
  recordSafetyTruncation(12);
  recordApiContext([], [], {
    model: "test-model",
    reasoningEffort: "high",
    configuredRawActions: 3,
    effectiveRawActions: 1,
    projectionTokens: 34,
  });

  const snapshot = getSnapshot();
  assert.equal(snapshot.stats.safetyTruncatedTokens, initialSafety + 12);
  assert.equal(snapshot.stats.currentProjectionTokens, 34);
  assert.equal(snapshot.stats.configuredRawActions, 3);
  assert.equal(snapshot.stats.effectiveRawActions, 1);
  assert.equal(
    snapshot.stats.eliminatedTokens,
    snapshot.stats.safetyTruncatedTokens + snapshot.stats.currentProjectionTokens,
  );
});

test("tracks cache-hit tokens against all prompt tokens", () => {
  recordUsage(100, 25);
  recordUsage(50, 5);

  const snapshot = getSnapshot();
  assert.equal(snapshot.stats.totalPromptTokens, 150);
  assert.equal(snapshot.stats.cacheHitTokens, 30);
});

function makeCapture(id: number): HttpRequestCapture {
  return {
    id,
    timestamp: new Date().toISOString(),
    url: `https://api.test/v1/call-${id}`,
    method: "POST",
    body: `{"id":${id}}`,
    headers: {},
    attempt: 0,
    status: 200,
    durationMs: 10,
    error: null,
  };
}

test("records HTTP request captures and exposes them newest-first", () => {
  recordHttpRequest(makeCapture(1));
  recordHttpRequest(makeCapture(2));

  const snapshot = getSnapshot();
  assert.ok(snapshot.httpRequests.length >= 2);
  // Newest first (most recent id on top).
  assert.equal(snapshot.httpRequests[0].id, 2);
  assert.equal(snapshot.httpRequests[1].id, 1);
});

test("drops the oldest capture once the ring buffer limit is exceeded", () => {
  // Fill well past the limit (20).
  for (let id = 100; id < 130; id++) {
    recordHttpRequest(makeCapture(id));
  }
  const snapshot = getSnapshot();
  assert.equal(snapshot.httpRequests.length, 20);
  // The newest 20 are kept (129 down to 110).
  assert.equal(snapshot.httpRequests[0].id, 129);
  assert.equal(snapshot.httpRequests[19].id, 110);
});
