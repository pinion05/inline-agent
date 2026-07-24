import test from "node:test";
import assert from "node:assert/strict";

import {
  createObservableFetch,
  type HttpRequestCapture,
} from "../src/http-observer.js";

/** A fake fetch that records what it was called with and returns a fixed response. */
function makeFakeFetch(
  responses: Response[] = [new Response("{}", { status: 200 })],
) {
  const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetch = async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return res;
  };
  return { fetch, calls };
}

test("forwards the body and init unchanged to the real fetch", async () => {
  const fake = makeFakeFetch();
  const captures: HttpRequestCapture[] = [];
  const wrapped = createObservableFetch((c) => captures.push(c), fake.fetch);

  await wrapped("https://api.test/v1", {
    method: "POST",
    body: '{"hello":"world"}',
    headers: { "content-type": "application/json" },
  });

  // The real fetch saw the exact body, unmodified.
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].init?.body, '{"hello":"world"}');
  // And the capture recorded it too.
  assert.equal(captures[0].body, '{"hello":"world"}');
  assert.equal(captures[0].method, "POST");
  assert.equal(captures[0].status, 200);
});

test("strips authorization and api-key headers from the capture", async () => {
  const fake = makeFakeFetch();
  const captures: HttpRequestCapture[] = [];
  const wrapped = createObservableFetch((c) => captures.push(c), fake.fetch);

  await wrapped("https://api.test/v1", {
    headers: {
      Authorization: "Bearer secret-key-123",
      "api-key": "another-secret",
      "x-api-key": "third-secret",
      "openai-organization": "org-secret",
      "content-type": "application/json",
    },
  });

  const headers = captures[0].headers;
  assert.equal(headers["Authorization"], undefined);
  assert.equal(headers["api-key"], undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers["openai-organization"], undefined);
  // Non-secret headers are kept.
  assert.equal(headers["content-type"], "application/json");
});

test("records each retry as a separate capture using x-stainless-retry-count", async () => {
  const fake = makeFakeFetch([
    new Response("rate limited", { status: 429 }),
    new Response("{}", { status: 200 }),
  ]);
  const captures: HttpRequestCapture[] = [];
  const wrapped = createObservableFetch((c) => captures.push(c), fake.fetch);

  // First call: original attempt (no retry header).
  await wrapped("https://api.test/v1", {
    headers: { "x-stainless-retry-count": "0" },
  });
  // Second call: retry attempt.
  await wrapped("https://api.test/v1", {
    headers: { "x-stainless-retry-count": "1" },
  });

  assert.equal(captures.length, 2);
  assert.equal(captures[0].attempt, 0);
  assert.equal(captures[0].status, 429);
  assert.equal(captures[1].attempt, 1);
  assert.equal(captures[1].status, 200);
});

test("still calls the real fetch and captures the error when fetch throws", async () => {
  const realFetch = async () => {
    throw new Error("network down");
  };
  const captures: HttpRequestCapture[] = [];
  const wrapped = createObservableFetch((c) => captures.push(c), realFetch);

  await assert.rejects(() => wrapped("https://api.test/v1", {}));

  // The capture was still recorded, with the error message.
  assert.equal(captures.length, 1);
  assert.equal(captures[0].error, "network down");
  assert.equal(captures[0].status, null);
});

test("swallows errors from the capture sink so the request still proceeds", async () => {
  const fake = makeFakeFetch();
  const brokenSink = () => {
    throw new Error("sink exploded");
  };
  const wrapped = createObservableFetch(brokenSink, fake.fetch);

  // Must not throw — the request proceeds despite the sink failure.
  const response = await wrapped("https://api.test/v1", {});
  assert.equal(response.status, 200);
  // And the real fetch was still called.
  assert.equal(fake.calls.length, 1);
});

test("forwards the signal to the real fetch", async () => {
  const fake = makeFakeFetch();
  const wrapped = createObservableFetch(() => undefined, fake.fetch);
  const controller = new AbortController();

  await wrapped("https://api.test/v1", { signal: controller.signal });

  assert.strictEqual(fake.calls[0].init?.signal, controller.signal);
});
