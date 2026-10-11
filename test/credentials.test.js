import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeApiKey, validateCredential } from "../src/credentials.js";
import { Store, newSession } from "../src/store.js";
import { Application } from "../src/cli.js";
import { request } from "../src/http.js";
import { temp, server } from "./helpers.js";

const key = "sk-or-v1-" + "a".repeat(64);

test("Zen and Go validate keys with GET usage; Zen accepts authenticated keys without Go entitlement", async () => {
  for (const kind of ["opencode", "opencode-go"]) {
    const checked = await validateCredential(
      {
        name: kind,
        catalog: kind,
        baseURL:
          kind === "opencode"
            ? "https://test/zen/v1"
            : "https://test/zen/go/v1",
      },
      "secret",
      {
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://test/zen/go/v1/usage");
          assert.equal(init.method, "GET");
          assert.equal(init.headers.Authorization, "Bearer secret");
          assert.ok(!init.body);
          return Response.json({ usage: { monthly: { percent: 0 } } });
        },
      },
    );
    assert.equal(checked.verified, true);
  }
  const denied = async () =>
    Response.json(
      {
        error: {
          type: "EntitlementError",
          message: "Go subscription required",
        },
      },
      { status: 403 },
    );
  assert.equal(
    (
      await validateCredential(
        { catalog: "opencode", baseURL: "https://test/zen/v1" },
        "secret",
        { fetchImpl: denied },
      )
    ).verified,
    true,
  );
  await assert.rejects(
    validateCredential(
      { catalog: "opencode-go", baseURL: "https://test/zen/go/v1" },
      "secret",
      { fetchImpl: denied },
    ),
    /subscription/,
  );
  await assert.rejects(
    validateCredential(
      { catalog: "opencode", baseURL: "https://test/zen/v1" },
      "secret",
      {
        fetchImpl: async () =>
          Response.json(
            { error: { type: "AuthError", message: "Unauthorized" } },
            { status: 401 },
          ),
      },
    ),
    /Unauthorized/,
  );
});

test("Custom providers prove authentication only when anonymous access is rejected", async () => {
  const provider = { catalog: "custom", baseURL: "https://test/v1" };
  const protectedResult = await validateCredential(provider, "secret", {
    fetchImpl: async (_url, init) =>
      init.headers.Authorization
        ? Response.json({ data: [] })
        : Response.json({ error: { message: "Missing key" } }, { status: 401 }),
  });
  assert.equal(protectedResult.verified, true);
  const publicResult = await validateCredential(provider, "secret", {
    fetchImpl: async () => Response.json({ data: [] }),
  });
  assert.equal(publicResult.verified, false);
  assert.match(publicResult.note, /público/);
  await assert.rejects(
    validateCredential(provider, "secret", {
      fetchImpl: async () =>
        Response.json(
          { error: { message: "secret invalid" } },
          { status: 401 },
        ),
    }),
    (error) => !error.message.includes("secret") && error.status === 401,
  );
});

test("Exact repeated OpenRouter pastes, quotes and Bearer prefixes normalize safely", () => {
  assert.equal(normalizeApiKey(key + key), key);
  assert.equal(normalizeApiKey(key.repeat(3)), key);
  assert.equal(normalizeApiKey(` Bearer "${key}" `), key);
  assert.equal(normalizeApiKey(key + "b"), key + "b");
  assert.equal(normalizeApiKey("abcabc"), "abcabc");
});

test("Validation uses free GET /key with one Bearer header and diagnoses User not found", async () => {
  const provider = {
    name: "OpenRouter",
    catalog: "openrouter",
    baseURL: "https://test/v1",
  };
  const valid = await validateCredential(provider, key + key, {
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://test/v1/key");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.ok(!init.body);
      return new Response('{"data":{"limit":null}}');
    },
  });
  assert.equal(valid.key, key);
  assert.equal(valid.verified, true);
  await assert.rejects(
    validateCredential(provider, key, {
      fetchImpl: async () =>
        new Response('{"error":{"message":"User not found."}}', {
          status: 401,
        }),
    }),
    /connect openrouter/,
  );
});

test("Saved key can explicitly override stale environment, while default/env preferences remain supported", async (t) => {
  const store = new Store(path.join(await temp(t), "home"));
  const env = "MICROCODE_TEST_AUTH_SOURCE";
  const previous = process.env[env];
  process.env[env] = "environment-key";
  t.after(() => {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  });
  await store.setKey("test", key + key);
  assert.equal((await store.read("auth.json")).test, key);
  assert.equal(await store.key("test", { env }), "environment-key");
  assert.equal(await store.key("test", { env, keySource: "saved" }), key);
  assert.equal(
    (await store.credential("test", { env, keySource: "saved" })).source,
    "saved",
  );
});

test("Connection rejects invalid keys without overwriting a previous valid credential", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const gateway = await server(t, () => ({
    status: 401,
    error: "User not found.",
  }));
  config.providers.openrouter = {
    name: "OpenRouter",
    baseURL: gateway.url,
    catalog: "openrouter",
  };
  await store.setKey("openrouter", "previous-valid-key");
  const app = new Application({
    cwd,
    config,
    store,
    session: newSession(cwd, null),
    ui: { ask: async () => key, notice() {}, print() {} },
  });
  await assert.rejects(app.connect("openrouter"), /User not found/);
  assert.equal(
    (await store.read("auth.json")).openrouter,
    "previous-valid-key",
  );
  assert.equal(config.selected, null);
});

test("Connection validates and saves the normalized key and explicitly selects saved credentials", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  const gateway = await server(t, (_body, req) => {
    assert.equal(req.url, "/key");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    return { json: { data: {} } };
  });
  config.providers.openrouter = {
    name: "OpenRouter",
    baseURL: gateway.url,
    catalog: "openrouter",
  };
  const app = new Application({
    cwd,
    config,
    store,
    session: newSession(cwd, null),
    ui: { ask: async () => key + key, notice() {}, print() {} },
  });
  await app.connect("openrouter");
  assert.equal((await store.read("auth.json")).openrouter, key);
  assert.equal(config.providers.openrouter.keySource, "saved");
});

test("HTTP authentication errors redact key content and provide an actionable reconnect instruction", async () => {
  await assert.rejects(
    request("https://openrouter.ai/api/v1/chat/completions", {
      key,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "User not found " + key } }),
          { status: 401 },
        ),
    }),
    (error) =>
      !error.message.includes(key) && /connect openrouter/.test(error.message),
  );
});

test("/doctor verifies and repairs a legacy duplicated saved key without exposing it", async (t) => {
  const cwd = await temp(t);
  const store = new Store(path.join(cwd, "home"));
  const config = await store.config();
  let printed = "";
  const gateway = await server(t, (_body, req) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    return req.url === "/key" ? { json: { data: {} } } : { json: { data: [] } };
  });
  config.providers.openrouter = {
    name: "OpenRouter",
    baseURL: gateway.url,
    catalog: "openrouter",
  };
  config.selected = { provider: "openrouter", model: null };
  await store.write("auth.json", { openrouter: key + key });
  const ui = {
    print: (value) => (printed += value),
    notice: (value) => (printed += value),
  };
  const app = new Application({
    cwd,
    store,
    config,
    session: newSession(cwd, config.selected),
    ui,
  });
  await app.command("/doctor");
  assert.equal((await store.read("auth.json")).openrouter, key);
  assert.ok(!printed.includes(key));
  assert.match(printed, /autenticação confirmada/);
});
