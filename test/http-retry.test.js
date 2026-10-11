import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { request, retryAfterMs, requestTiming, events } from "../src/http.js";
import { fixture, server, chatReply, sseResponse } from "./helpers.js";
import { Application } from "../src/cli.js";
import { complete } from "../src/protocols.js";

const rateLimited = (metadata = {}, headers = {}) =>
  new Response(
    JSON.stringify({
      error: { code: 429, message: "Provider returned error", metadata },
    }),
    { status: 429, headers },
  );

test("Retry-After parses seconds, fractional seconds and HTTP dates, ignoring invalid values", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(retryAfterMs("30", now), 30000);
  assert.equal(retryAfterMs("0.25", now), 250);
  assert.equal(retryAfterMs("Thu, 08 Oct 2026 12:00:05 GMT", now), 5000);
  assert.equal(retryAfterMs("Thu, 08 Oct 2026 11:59:55 GMT", now), 0);
  for (const value of [null, "", "bad", "-5"])
    assert.equal(retryAfterMs(value, now), null);
});

test("429 diagnostics preserve provider and original JSON error while redacting credentials", async () => {
  const key = "sk-or-v1-" + "b".repeat(64);
  await assert.rejects(
    request("https://test", {
      key,
      fetchImpl: async () =>
        rateLimited(
          {
            provider_name: "Parasail",
            provider_code: "rate_limit",
            raw: JSON.stringify({
              error: { message: "Too many requests " + key },
            }),
          },
          { "retry-after": "2" },
        ),
    }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.provider, "Parasail");
      assert.equal(error.retryAfterMs, 2000);
      assert.match(error.message, /Too many requests/);
      assert.match(error.message, /rate_limit/);
      assert.ok(!error.message.includes(key));
      return true;
    },
  );
});

test("A transient 429 retries identical requests and honors server wait before succeeding", async () => {
  const bodies = [];
  const waits = [];
  const notices = [];
  let attempt = 0;
  const response = await request("https://test", {
    body: { model: "cydonia", messages: [{ role: "user", content: "oi" }] },
    retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 5000 },
    waitImpl: async (ms) => waits.push(ms),
    onRetry: (info) => notices.push(info),
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      return ++attempt === 1
        ? rateLimited({}, { "retry-after": "2" })
        : new Response('{"ok":true}');
    },
  });
  assert.equal(response.status, 200);
  assert.equal(attempt, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(notices[0].attempt, 1);
  assert.equal(requestTiming(response).retries, 1);
});

test("Backoff grows, max retries are bounded, and a final error keeps original diagnostics", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    request("https://test", {
      retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
      waitImpl: async (ms) => waits.push(ms),
      fetchImpl: async () => {
        calls++;
        return rateLimited({
          provider_name: "Parasail",
          raw: "Capacity exceeded",
        });
      },
    }),
    (error) => error.attempts === 3 && /Capacity exceeded/.test(error.message),
  );
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] >= waits[0] * 1.8);
});

test("Long Retry-After is not shortened, and no premature retry is sent", async () => {
  let calls = 0;
  await assert.rejects(
    request("https://test", {
      retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 60000 },
      waitImpl: async () => assert.fail("must not wait"),
      fetchImpl: async () => {
        calls++;
        return rateLimited({}, { "retry-after": "600" });
      },
    }),
    /Nenhuma retentativa antecipada/,
  );
  assert.equal(calls, 1);
});

test("Daily quota exhaustion, authentication, payment and network errors are not retried", async () => {
  for (const status of [401, 402, 403, 429]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return status === 429
        ? rateLimited({
            raw: JSON.stringify({
              error: {
                code: "insufficient_quota",
                message: "Daily limit reached",
              },
            }),
          })
        : new Response('{"error":{"message":"denied"}}', { status });
    };
    await assert.rejects(
      request("https://test", { retry: { maxRetries: 5 }, fetchImpl }),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    request("https://test", {
      retry: { maxRetries: 5 },
      fetchImpl: async () => {
        calls++;
        throw new Error("network down");
      },
    }),
    /network down/,
  );
  assert.equal(calls, 1);
});

test("Ctrl+C/abort interrupts the retry wait without sending another API request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    request("https://test", {
      signal: controller.signal,
      retry: { maxRetries: 2, baseDelayMs: 1000 },
      onRetry: () => controller.abort(new Error("Cancelled by user")),
      fetchImpl: async () => {
        calls++;
        return rateLimited();
      },
    }),
    /Cancelled by user/,
  );
  assert.equal(calls, 1);
});

test("Retry timings exclude rejected attempt latency from the successful inference start", async () => {
  let calls = 0;
  const start = performance.now();
  const response = await request("https://test", {
    retry: { maxRetries: 1, baseDelayMs: 0 },
    waitImpl: async () => {},
    fetchImpl: async () => {
      if (++calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return rateLimited();
      }
      return new Response("ok");
    },
  });
  assert.ok(requestTiming(response).startedAt - start >= 30);
});

test("Midstream 429 propagates provider details and is never marked safe to retry", async () => {
  await assert.rejects(
    async () => {
      for await (const chunk of events(
        sseResponse([
          {
            error: {
              code: 429,
              message: "stream rate limit",
              metadata: {
                provider_name: "Parasail",
                raw: "stream already started",
              },
            },
          },
        ]),
      ))
        void chunk;
    },
    (error) =>
      error.status === 429 &&
      error.streamStarted &&
      !error.retryable &&
      /Parasail/.test(error.message),
  );
});

test("Agent retries before a response without duplicating messages, tools or token accounting", async (t) => {
  let requests = 0;
  const gateway = await server(t, () =>
    ++requests === 1
      ? { status: 429, error: "rate limited" }
      : chatReply("Olá!"),
  );
  const notices = [];
  const { agent, session } = await fixture(t, {
    url: gateway.url,
    config: { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 } },
    ui: { notice: (value) => notices.push(value) },
  });
  assert.equal(await agent.run("oi"), "Olá!");
  assert.equal(requests, 2);
  assert.equal(session.messages.filter((m) => m.role === "user").length, 1);
  assert.equal(
    session.messages.filter((m) => m.role === "assistant").length,
    1,
  );
  assert.equal(session.usage.length, 1);
  assert.equal(session.usage[0].retries, 1);
  assert.equal(session.lastError, undefined);
  assert.match(notices[0], /retentativa 1\/1/);
});

test("A final HTTP 429 is retained in the saved session with no fabricated token usage", async (t) => {
  const gateway = await server(t, () => ({
    status: 429,
    error: "rate limited",
  }));
  const { agent, session, store, cwd } = await fixture(t, {
    url: gateway.url,
    config: { retry: { maxRetries: 0 } },
  });
  await assert.rejects(agent.run("oi"), /429/);
  assert.equal(session.usage.length, 0);
  assert.equal(session.lastError.status, 429);
  assert.equal(
    (await store.loadSession(session.id, cwd)).lastError.status,
    429,
  );
});

test("Provider JSON errors using a string error field remain visible", async () => {
  await assert.rejects(
    request("https://test", {
      fetchImpl: async () =>
        rateLimited({
          error_type: "rate_limit_exceeded",
          raw: '{"error":"Too many parallel requests"}',
        }),
    }),
    (error) =>
      /Too many parallel requests/.test(error.message) &&
      /rate_limit_exceeded/.test(error.message),
  );
});

test("Retry configuration can be changed and disabled through /config", async (t) => {
  const { cwd, store, config, session } = await fixture(t);
  const app = new Application({
    cwd,
    store,
    config,
    session,
    ui: { print() {}, notice() {} },
  });
  await app.configCommand("retry.maxRetries 0");
  await app.configCommand("retry.baseDelayMs 500");
  await app.configCommand("retry.maxDelayMs 10000");
  assert.deepEqual((await store.config()).retry, {
    maxRetries: 0,
    baseDelayMs: 500,
    maxDelayMs: 10000,
  });
  await assert.rejects(app.configCommand("retry.maxRetries 6"), /entre/);
});

test("Responses failed events preserve 429 details without retrying an already-started stream", async () => {
  let requests = 0;
  await assert.rejects(
    complete({
      provider: { baseURL: "https://test" },
      model: { id: "m", protocol: "responses" },
      system: "test",
      messages: [],
      sessionId: "test",
      retry: { maxRetries: 3 },
      fetchImpl: async () => {
        requests++;
        return sseResponse([
          {
            type: "response.failed",
            response: {
              error: {
                code: 429,
                message: "limited",
                metadata: { provider_name: "provider", raw: "upstream error" },
              },
            },
          },
        ]);
      },
    }),
    (error) =>
      error.status === 429 &&
      error.streamStarted &&
      /upstream error/.test(error.message),
  );
  assert.equal(requests, 1);
});
