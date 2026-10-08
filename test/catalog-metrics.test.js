import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  catalog,
  openRouterModel,
  zenModel,
  chooseMode,
} from "../src/providers.js";
import { recordUsage, normalizeUsage, totals } from "../src/metrics.js";
import { Store, PRESETS, newSession } from "../src/store.js";
import { temp } from "./helpers.js";

test("Dolphin/Cydonia metadata selects text tools; prices convert to USD/1M", () => {
  for (const id of [
    "cognitivecomputations/dolphin-mistral-24b-venice-edition",
    "thedrummer/cydonia-24b-v4.1",
  ]) {
    const model = openRouterModel({
      id,
      supported_parameters: ["temperature", "max_tokens"],
      pricing: { prompt: "0.0000001", completion: "0.0000005" },
    });
    assert.equal(chooseMode("auto", model), "text");
    assert.ok(Math.abs(model.inputPrice - 0.1) < 1e-12);
    assert.equal(model.outputPrice, 0.5);
    assert.throws(() => chooseMode("native", model), /não suporta/);
  }
  assert.equal(openRouterModel({ id: "unknown" }).inputPrice, null);
  assert.equal(openRouterModel({ id: "unknown" }).nativeTools, null);
});

test("Zen maps provider SDK to protocol and preserves zero prices", () => {
  assert.equal(
    zenModel({ id: "x" }, { provider: { npm: "@ai-sdk/anthropic" } }).protocol,
    "messages",
  );
  assert.equal(
    zenModel({ id: "x" }, { provider: { npm: "@ai-sdk/openai" } }).protocol,
    "responses",
  );
  assert.equal(
    zenModel({ id: "x" }, { provider: { npm: "@ai-sdk/google" } }).protocol,
    "google",
  );
  assert.equal(
    zenModel({ id: "x" }, { cost: { input: 0, output: 0 } }).inputPrice,
    0,
  );
});

test("Catalog pagination, cache and offline fallback retain explicit metadata", async (t) => {
  const store = new Store(path.join(await temp(t), "home"));
  let calls = 0;
  const provider = { baseURL: "https://test/v1", catalog: "openrouter" };
  const fetchImpl = async (url) => {
    calls++;
    return new Response(
      JSON.stringify(
        url.includes("offset")
          ? { data: [{ id: "second", supported_parameters: ["tools"] }] }
          : {
              data: [{ id: "first", supported_parameters: [] }],
              links: { next: "/v1/models?offset=1" },
            },
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const result = await catalog("test", provider, store, { fetchImpl });
  assert.equal(result.models.length, 2);
  assert.equal(calls, 2);
  await catalog("test", provider, store, { fetchImpl });
  assert.equal(calls, 2);
  const offline = await catalog("test", provider, store, {
    refresh: true,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.stale, true);
  assert.equal(offline.models.length, 2);
});

test("Catalog never forwards credentials to cross-origin pagination URLs", async (t) => {
  const store = new Store(path.join(await temp(t), "home"));
  await assert.rejects(
    catalog(
      "test",
      { baseURL: "https://test/v1", catalog: "openrouter" },
      store,
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: [],
              links: { next: "https://other/models" },
            }),
          ),
      },
    ),
    /Paginação inválida/,
  );
});

test("Reported usage/cost overrides estimates; TPS uses inference duration only", () => {
  const usage = recordUsage(
    {
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0002 },
      durationMs: 2000,
      content: "hi",
    },
    { protocol: "chat", inputPrice: 1, outputPrice: 2, id: "demo" },
    "input",
  );
  assert.equal(usage.cost, 0.0002);
  assert.equal(usage.tps, 50);
  assert.equal(usage.estimatedTokens, false);
  assert.equal(usage.estimatedCost, false);
  const estimate = recordUsage(
    { durationMs: 1000, content: "hello" },
    { protocol: "chat", inputPrice: null, outputPrice: null },
    "hi",
  );
  assert.equal(estimate.cost, null);
  assert.equal(estimate.estimatedTokens, true);
  assert.equal(totals([usage, estimate]).unknownCost, true);
});

test("Anthropic cached input counts and estimated costs include cache read/write", () => {
  const result = {
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
    },
    durationMs: 1000,
    content: "x",
  };
  const usage = recordUsage(
    result,
    {
      protocol: "messages",
      inputPrice: 1,
      outputPrice: 2,
      cacheReadPrice: 0.1,
      cacheWritePrice: 1.25,
    },
    "",
  );
  assert.equal(usage.input, 600);
  assert.equal(usage.cost, (100 + 20 + 375 + 20) / 1e6);
  assert.equal(
    normalizeUsage(
      { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
      "google",
    ).output,
    8,
  );
});

test("Store configuration merges compaction defaults and serializes concurrent snapshots", async (t) => {
  const store = new Store(path.join(await temp(t), "home"));
  await store.write("config.json", { compaction: { threshold: 0.7 } });
  const config = await store.config();
  assert.equal(config.compaction.threshold, 0.7);
  assert.equal(config.compaction.keepTurns, 4);
  const session = newSession("/project", null);
  const first = store.saveSession(session);
  session.title = "updated";
  const second = store.saveSession(session);
  await Promise.all([first, second]);
  assert.equal(
    (await store.read(`sessions/${session.id}.json`)).title,
    "updated",
  );
  assert.ok(PRESETS.openrouter.baseURL);
  assert.ok(PRESETS.opencode.baseURL);
});
