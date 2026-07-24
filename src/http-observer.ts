/**
 * HTTP request observation — the "camera" that snapshots what actually goes
 * over the wire to the LLM API.
 *
 * The OpenAI SDK accepts a custom `fetch` in its constructor options. We
 * inject a wrapper here so that when the SDK has fully assembled the request
 * (serialized JSON body, auth headers attached, retry-count stamped) and is
 * about to send it, we capture a safe copy *first*, then hand off to the
 * real fetch unchanged.
 *
 * Each attempt — original and every retry — passes through this wrapper, so
 * we record them as separate captures. The SDK stamps `x-stainless-retry-count`
 * (`'0'` for the first attempt) which we read to label the attempt number.
 *
 * Crucially: if the observation logic itself throws, we swallow the error and
 * still call the real fetch. Observation is a side concern; it must never
 * block or break the actual API request.
 */

export interface HttpRequestCapture {
  /** Monotonic id so the dashboard can label each capture. */
  id: number;
  /** ISO-8601 timestamp of when the fetch was invoked. */
  timestamp: string;
  /** Request URL (the endpoint the SDK built, including baseURL). */
  url: string;
  /** HTTP method, uppercased by the SDK before it reaches us. */
  method: string;
  /** The fully serialized request body (JSON string), exactly as sent. */
  body: string | null;
  /** Headers with all auth/secret fields stripped. Safe to display. */
  headers: Record<string, string>;
  /** 0 for the original attempt, 1+ for retries. */
  attempt: number;
  /** HTTP status code of the response, if one was received. */
  status: number | null;
  /** Round-trip duration in milliseconds, if measured. */
  durationMs: number | null;
  /** Error message if the fetch itself threw (network failure, etc.). */
  error: string | null;
}

export type FetchLike = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CaptureSink = (capture: HttpRequestCapture) => void;

export { RETRY_COUNT_HEADER };

/** Header keys that carry secrets and must never be recorded. */
const SECRET_HEADER_KEYS = [
  "authorization",
  "api-key",
  "x-api-key",
  "openai-organization",
  "openai-project",
  "set-cookie",
  "cookie",
];

let nextCaptureId = 1;

/**
 * Header the OpenAI SDK stamps on each fetch attempt to indicate the retry
 * count ('0' for the original, '1' for the first retry, etc.). If the SDK
 * ever renames this, captures will silently all read as attempt 0 — the
 * integration test pins this contract.
 */
const RETRY_COUNT_HEADER = "x-stainless-retry-count";

/**
 * Wrap a real fetch so every call (original + retries) produces a safe
 * capture handed to `onCapture`. The real fetch is always invoked regardless
 * of observation errors.
 *
 * @param onCapture  Sink for each capture. Called synchronously per attempt.
 * @param realFetch  The underlying fetch to delegate to. Defaults to global.
 */
export function createObservableFetch(
  onCapture: CaptureSink,
  realFetch: FetchLike = fetch,
): FetchLike {
  return async (url, init) => {
    const startedAt = Date.now();
    const timestamp = new Date().toISOString();

    // Parse everything we need up front. If this throws, we still must call
    // the real fetch — observation failure must not break the request.
    let attempt = 0;
    let safeHeaders: Record<string, string> = {};
    let bodySnapshot: string | null = null;
    try {
      attempt = parseRetryCount(init?.headers);
      safeHeaders = stripSecretHeaders(init?.headers);
      bodySnapshot = typeof init?.body === "string" ? init.body : null;
    } catch {
      // Swallow — we'll record what we have (possibly partial) after the call.
    }

    let status: number | null = null;
    let errorMessage: string | null = null;

    try {
      const response = await realFetch(url, init);
      status = response.status;
      return response;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      // Record the capture whether the request succeeded or failed.
      const capture: HttpRequestCapture = {
        id: nextCaptureId++,
        timestamp,
        url: scrubUrl(urlString(url)),
        method: (init?.method ?? "GET").toUpperCase(),
        body: bodySnapshot,
        headers: safeHeaders,
        attempt,
        status,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
      };
      try {
        onCapture(capture);
      } catch {
        // The sink is best-effort. Never let it propagate.
      }
    }
  };
}

/** Read the SDK's retry-count header to determine the attempt number. */
function parseRetryCount(headers: HeadersInit | undefined): number {
  if (!headers) return 0;
  const value = headerValue(headers, RETRY_COUNT_HEADER);
  if (value === null) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Return a headers object with every secret key removed. */
function stripSecretHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (!SECRET_HEADER_KEYS.includes(key.toLowerCase())) {
        out[key] = value;
      }
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (!SECRET_HEADER_KEYS.includes(key.toLowerCase())) {
        out[key] = value;
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!SECRET_HEADER_KEYS.includes(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}

/** Look up a single header value case-insensitively across header shapes. */
function headerValue(
  headers: HeadersInit,
  name: string,
): string | null {
  const target = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(target);
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === target) return value;
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** Coerce a RequestInfo/URL into a string for display. */
function urlString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  if (url instanceof Request) return url.url;
  return String(url);
}

/**
 * Strip credentials from a URL before recording it:
 * - userinfo (user:pass@host) is removed
 * - secret-looking query params (api_key, key, token, ...) are dropped
 *
 * Custom OpenAI-compatible providers may embed credentials in the baseURL,
 * and these would otherwise land in the dashboard capture verbatim.
 */
const SECRET_QUERY_KEYS = ["api_key", "apikey", "key", "token", "secret", "password", "access_token"];

function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    // Not a parseable URL — return as-is rather than risk mangling it.
    return raw;
  }
}
