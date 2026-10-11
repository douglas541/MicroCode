import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  webFetch,
  webSearch,
  readWeb,
  htmlToReadable,
  parseSearch,
} from "../src/web.js";
import { ToolRunner } from "../src/tools.js";
import { fixture, temp, server, chatReply } from "./helpers.js";

const SEARCH_HTML = `<html><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=tracking">Docs &amp; examples</a><a class="result__snippet">Official <b>documentation</b>.</a><a class="result__a" href="https://example.com/other">Other source</a><div class="result__snippet">Second source.</div></html>`;
const PAGE_HTML = `<html><head><title>Docs &amp; examples</title><style>.hidden{}</style></head><body><nav>Navigation junk</nav><main><h1>Docs</h1><p>Read <a href="/reference">the reference</a>.</p><pre><code class="language-js">const x = 1 &lt; 2;\n  console.log(x);</code></pre><script>doNotExecute()</script></main></body></html>`;
const html = (text) =>
  new Response(text, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

test("HTML extraction retains headings, code and absolute source links while excluding scripts/navigation", () => {
  const parsed = htmlToReadable(PAGE_HTML, "https://example.com/docs");
  assert.equal(parsed.title, "Docs & examples");
  assert.match(parsed.content, /# Docs/);
  assert.match(
    parsed.content,
    /\[the reference\]\(https:\/\/example.com\/reference\)/,
  );
  assert.match(parsed.content, /const x = 1 < 2;\n  console.log\(x\);/);
  assert.ok(!parsed.content.includes("Navigation junk"));
  assert.ok(!parsed.content.includes("doNotExecute"));
  assert.deepEqual(parsed.links, [
    { text: "the reference", url: "https://example.com/reference" },
  ]);
  const plain = htmlToReadable(PAGE_HTML, "https://example.com/docs", "text");
  assert.ok(!plain.content.includes("```"));
});

test("Named documentation containers retain nested sections without including the sidebar", () => {
  const content = htmlToReadable(
    '<aside>Sidebar</aside><div id="apicontent"><div>First section</div><div>Second section</div></div><footer>Footer</footer>',
    "https://example.com",
  ).content;
  assert.match(content, /First section/);
  assert.match(content, /Second section/);
  assert.ok(!content.includes("Sidebar"));
  assert.ok(!content.includes("Footer"));
});

test("Code alternatives such as ESM/CommonJS remain separate and copy controls are excluded", () => {
  const html =
    '<main><pre><code class="language-js">import fs from "node:fs";</code><code class="language-js">const fs = require("node:fs");</code><button>copy</button></pre></main>';
  const content = htmlToReadable(html, "https://example.com").content;
  assert.match(content, /```js\nimport fs from "node:fs";\n```/);
  assert.match(content, /```js\nconst fs = require\("node:fs"\);\n```/);
  assert.ok(!content.includes("copy"));
});

test("web_search parses live-style DuckDuckGo links/snippets and does not send API credentials", async () => {
  const result = await webSearch(
    { query: "Node.js docs", limit: 1 },
    {
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).searchParams.get("q"), "Node.js docs");
        assert.equal(init.headers.Authorization, undefined);
        return html(SEARCH_HTML);
      },
    },
  );
  assert.equal(result.provider, "duckduckgo");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, "https://example.com/docs");
  assert.equal(result.results[0].title, "Docs & examples");
  assert.equal(result.results[0].snippet, "Official documentation.");
  assert.equal(result.untrusted, true);
});

test("Search falls back to Bing RSS on anti-bot challenges without inventing results", async () => {
  const calls = [];
  const result = await webSearch(
    { query: "example" },
    {
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes("duckduckgo"))
          return html(
            '<form class="challenge-form">bots use DuckDuckGo too</form>',
          );
        return new Response(
          "<rss><channel><item><title><![CDATA[Docs & examples]]></title><link>https://example.com/docs</link><description>Useful source</description></item></channel></rss>",
          { headers: { "Content-Type": "application/rss+xml" } },
        );
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.provider, "bing");
  assert.equal(result.fallback, true);
  assert.match(result.warnings[0], /anti-bot/);
  assert.equal(result.results[0].title, "Docs & examples");
});

test("Valid empty search results are distinguished from blocked or broken search pages", async () => {
  const empty = await webSearch(
    { query: "no results" },
    {
      fetchImpl: async () =>
        html('<div class="no-results">No results found</div>'),
    },
  );
  assert.equal(empty.results.length, 0);
  assert.equal(empty.ok, true);
  await assert.rejects(
    webSearch(
      { query: "query" },
      { fetchImpl: async () => new Response("blocked", { status: 429 }) },
    ),
    /Busca web indisponível/,
  );
  assert.equal(
    parseSearch(
      "<html>not a search page</html>",
      "duckduckgo",
      "https://duckduckgo.com",
    ).valid,
    false,
  );
});

test("web_fetch reads HTML/JSON, obeys character limits and rejects invalid protocols/binary files", async () => {
  const result = await webFetch(
    { url: "https://example.com/docs", max_chars: 1000 },
    {
      fetchImpl: async () =>
        html(PAGE_HTML + "<p>" + "x".repeat(2000) + "</p>"),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.title, "Docs & examples");
  assert.equal(result.untrusted, true);
  const truncated = await webFetch(
    { url: "https://example.com/plain", max_chars: 1000 },
    {
      fetchImpl: async () =>
        new Response("x".repeat(3000), {
          headers: { "Content-Type": "text/plain" },
        }),
    },
  );
  assert.equal(truncated.content.length, 1000);
  assert.equal(truncated.truncated, true);
  const json = await webFetch(
    { url: "https://example.com/api" },
    {
      fetchImpl: async () =>
        new Response('{"ok":true}', {
          headers: { "Content-Type": "application/json" },
        }),
    },
  );
  assert.equal(json.content, '{"ok":true}');
  for (const url of [
    "file:///tmp/secret",
    "data:text/plain,secret",
    "https://user:pass@example.com",
  ])
    await assert.rejects(webFetch({ url }), /HTTP|credenciais/);
  await assert.rejects(
    webFetch(
      { url: "https://example.com/image" },
      {
        fetchImpl: async () =>
          new Response("fake binary", {
            headers: { "Content-Type": "image/png" },
          }),
      },
    ),
    /não é textual/,
  );
});

test("Body downloads are bounded and the remaining stream is cancelled", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(20000)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "text/plain" } },
  );
  const result = await readWeb("https://example.com/large", {
    maxBytes: 1000,
    fetchImpl: async () => response,
  });
  assert.equal(result.bytesRead, 1000);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("Redirects are resolved with a bounded chain, and unsafe redirects/loops are rejected", async () => {
  const calls = [];
  const result = await webFetch(
    { url: "https://example.com/start" },
    {
      fetchImpl: async (url) => {
        calls.push(url);
        return url.endsWith("/start")
          ? new Response("", { status: 302, headers: { Location: "/docs" } })
          : html(PAGE_HTML);
      },
    },
  );
  assert.deepEqual(calls, [
    "https://example.com/start",
    "https://example.com/docs",
  ]);
  assert.equal(result.url, "https://example.com/docs");
  await assert.rejects(
    readWeb("https://example.com/start", {
      fetchImpl: async () =>
        new Response("", { status: 302, headers: { Location: "/start" } }),
    }),
    /Loop/,
  );
  await assert.rejects(
    readWeb("https://example.com/start", {
      fetchImpl: async () =>
        new Response("", {
          status: 302,
          headers: { Location: "file:///secret" },
        }),
    }),
    /HTTP/,
  );
});

test("HTTP timeouts and user cancellation terminate web requests", async (t) => {
  const instance = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("still loading");
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${instance.address().port}`;
  await assert.rejects(readWeb(url, { timeoutMs: 80 }), /Tempo limite/);
  const controller = new AbortController();
  const pending = webFetch({ url }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("user cancelled")), 30);
  await assert.rejects(pending, /user cancelled/);
});

test("Web tools stay available in plan mode, do not ask for write permission, and validate enum arguments", async (t) => {
  const cwd = await temp(t);
  const runner = new ToolRunner({
    cwd,
    plan: true,
    confirm: async () => assert.fail("web is read-only"),
    webFetchImpl: async () => html(PAGE_HTML),
  });
  assert.ok(runner.definitions().some((d) => d.name === "web_search"));
  assert.ok(runner.definitions().some((d) => d.name === "web_fetch"));
  assert.equal(
    (
      await runner.execute({
        name: "web_fetch",
        arguments: { url: "https://example.com", format: "markdown" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await runner.execute({
        name: "web_fetch",
        arguments: { url: "https://example.com", format: "unsupported" },
      })
    ).ok,
    false,
  );
});

for (const native of [false, true])
  test(`Agent uses web_search then web_fetch in ${native ? "native" : "text"} mode`, async (t) => {
    let step = 0;
    const calls = [
      { name: "web_search", arguments: { query: "Docs" } },
      { name: "web_fetch", arguments: { url: "https://example.com/docs" } },
    ];
    const gateway = await server(t, (body) => {
      assert.equal(Boolean(body.tools), native);
      if (step < calls.length) {
        const call = calls[step++];
        return native
          ? chatReply("", [call])
          : chatReply("```microcode_tool\n" + JSON.stringify(call) + "\n```");
      }
      assert.match(JSON.stringify(body.messages), /Official documentation/);
      assert.match(JSON.stringify(body.messages), /const x/);
      return chatReply("Fonte consultada: https://example.com/docs");
    });
    const { agent, runner, session } = await fixture(t, {
      native,
      url: gateway.url,
    });
    runner.webFetchImpl = async (url, init) => {
      assert.equal(init.headers.Authorization, undefined);
      return html(url.includes("duckduckgo") ? SEARCH_HTML : PAGE_HTML);
    };
    assert.match(
      await agent.run("Pesquise e leia a documentação"),
      /Fonte consultada/,
    );
    assert.deepEqual(
      session.messages.filter((m) => m.role === "tool").map((m) => m.name),
      ["web_search", "web_fetch"],
    );
  });
