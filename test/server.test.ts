import test from "node:test";
import assert from "node:assert/strict";

import {
  getSnapshot,
  recordApiContext,
  recordCompression,
  recordSafetyTruncation,
  recordUsage,
} from "../src/server.js";
import { estimateTokens } from "../src/tokenize.js";
import type { Message } from "../src/compact.js";

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
