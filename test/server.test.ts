import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateTokens,
  getSnapshot,
  recordCompression,
  recordUsage,
} from "../src/server.js";
import type { Message } from "../src/compact.js";

test("tracks the cumulative number of tokens eliminated by compression", () => {
  const before: Message[] = [{ role: "user", content: "12345678" }];
  const after: Message[] = [{ role: "user", content: "1234" }];
  const eliminated = estimateTokens(before) - estimateTokens(after);

  recordCompression(before.length, after.length, eliminated);
  recordCompression(after.length, after.length, 3);

  const snapshot = getSnapshot();
  assert.equal(snapshot.stats.eliminatedTokens, 4);
  assert.deepEqual(
    snapshot.stats.compressionHistory.map((item) => item.eliminatedTokens),
    [1, 3],
  );
});

test("tracks cache-hit tokens against all prompt tokens", () => {
  recordUsage(100, 25);
  recordUsage(50, 5);

  const snapshot = getSnapshot();
  assert.equal(snapshot.stats.totalPromptTokens, 150);
  assert.equal(snapshot.stats.cacheHitTokens, 30);
});
