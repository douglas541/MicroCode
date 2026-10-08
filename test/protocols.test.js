import test from "node:test";
import assert from "node:assert/strict";
import { events } from "../src/http.js";
import { buildRequest, complete } from "../src/protocols.js";
import { TOOL_DEFINITIONS } from "../src/tools.js";
import {
  parseTextTools,
  textHistory,
  flattenHistory,
} from "../src/text-tools.js";
import { sseResponse, chatReply } from "./helpers.js";

test("SSE decodes fragmented CRLF, comments, UTF-8 and final usage", async () => {
  const values = [];
  for await (const event of events(
    sseResponse(chatReply("Olá 🌱"), { fragment: 1 }),
  ))
    values.push(event);
  assert.equal(values[0].choices[0].delta.content, "Olá 🌱");
  assert.equal(values.at(-1).usage.prompt_tokens, 100);
});

test("SSE propagates midstream provider errors", async () => {
  await assert.rejects(async () => {
    for await (const event of events(
      sseResponse([{ error: { message: "quota exhausted" } }]),
    ))
      void event;
  }, /quota exhausted/);
});

const history = [
  { role: "user", content: "Read this" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.js" } }],
  },
  { role: "tool", toolCallId: "t1", name: "read_file", content: '{"ok":true}' },
];
for (const protocol of ["chat", "messages", "responses", "google"]) {
  test(`${protocol}: text mode removes all native tool fields, including old native history`, () => {
    const request = buildRequest({
      model: { id: "demo", protocol },
      system: "test",
      messages: history,
      tools: TOOL_DEFINITIONS,
      mode: "text",
      maxTokens: 1024,
    });
    const raw = JSON.stringify(request.body);
    assert.ok(!("tools" in request.body));
    assert.ok(!("tool_choice" in request.body));
    assert.ok(!raw.includes('"function_call"'));
    assert.ok(!raw.includes('"tool_result"'));
    assert.ok(raw.includes("MICROCODE_TOOL_RESULTS"));
    assert.ok(raw.includes("microcode_tool"));
  });
  test(`${protocol}: native mode transmits tool schemas and correct history`, () => {
    const request = buildRequest({
      model: { id: "demo", protocol },
      system: "test",
      messages: history,
      tools: TOOL_DEFINITIONS,
      mode: "native",
      maxTokens: 1024,
    });
    assert.ok(request.body.tools.length);
  });
}

test("Ordinary code, quoted examples, and nested markers cannot become tool calls", () => {
  const text =
    'Example:\n```json\n{"name":"shell","arguments":{"command":"bad"}}\n```\n````markdown\n```microcode_tool\n{"name":"shell","arguments":{"command":"bad"}}\n```\n````\n> <tool_call>{"name":"shell","arguments":{}}</tool_call>';
  assert.deepEqual(parseTextTools(text).calls, []);
  assert.equal(parseTextTools(text).display, text);
});

test("Dedicated fences and XML decode arguments, escaped newlines, and reject entire malformed batch", () => {
  const valid =
    "Edit:\n```microcode_tool\n" +
    JSON.stringify({
      name: "write_file",
      arguments: { path: "a.js", content: "one\ntwo" },
    }) +
    "\n```";
  const parsed = parseTextTools(valid);
  assert.equal(parsed.calls[0].arguments.content, "one\ntwo");
  assert.equal(parsed.display, "Edit:");
  assert.equal(
    parseTextTools(
      '<tool_call>{"name":"shell","arguments":{"command":"pwd"}}</tool_call>',
    ).calls[0].name,
    "shell",
  );
  const mixed = parseTextTools(valid + "\n```microcode_tool\nINVALID\n```");
  assert.equal(mixed.calls.length, 0);
  assert.equal(mixed.errors.length, 1);
  assert.equal(
    parseTextTools(valid + "\n```microcode_tool\n{}").calls.length,
    0,
  );
});

test("Plain history conversion keeps call/result order", () => {
  const converted = textHistory(history);
  assert.deepEqual(
    converted.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.match(converted[1].content, /read_file/);
  assert.match(converted[2].content, /MICROCODE_TOOL_RESULTS/);
});

test("Model changes flatten signed native history and retain internal turn markers", () => {
  const signed = history.map((m) => ({
    ...m,
    ...(m.role === "assistant"
      ? {
          googleParts: [{ thoughtSignature: "old-signature" }],
          responseOutput: [{ encrypted_content: "old" }],
        }
      : {}),
  }));
  const flat = flattenHistory(signed);
  assert.equal(flat[2].internal, true);
  assert.ok(!JSON.stringify(flat).includes("old-signature"));
  const request = buildRequest({
    model: { id: "different", protocol: "google" },
    system: "s",
    messages: flat,
    tools: TOOL_DEFINITIONS,
    mode: "native",
    maxTokens: 1024,
  });
  assert.ok(request.body.tools.length);
  assert.ok(!JSON.stringify(request.body.contents).includes("functionCall"));
});

test("Chat assembles fragmented native arguments and preserves reasoning", async () => {
  const result = await complete({
    provider: { baseURL: "http://test" },
    model: { id: "m", protocol: "chat" },
    system: "s",
    messages: [],
    tools: TOOL_DEFINITIONS,
    mode: "native",
    sessionId: "session",
    fetchImpl: async () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                reasoning_content: "think",
                tool_calls: [
                  {
                    index: 0,
                    id: "call1",
                    function: { name: "read_file", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"a.js"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
  });
  assert.equal(result.toolCalls[0].arguments.path, "a.js");
  assert.equal(result.reasoningContent, "think");
});

test("Incomplete stream never yields executable tool calls", async () => {
  await assert.rejects(
    complete({
      provider: { baseURL: "http://test" },
      model: { id: "m", protocol: "chat" },
      system: "s",
      messages: [],
      sessionId: "s",
      fetchImpl: async () =>
        sseResponse([{ choices: [{ delta: { content: "partial" } }] }]),
    }),
    /Stream interrompido/,
  );
});

test("Anthropic adapter assembles tool input and signed thinking blocks", async () => {
  const result = await complete({
    provider: { baseURL: "http://test" },
    model: { id: "m", protocol: "messages" },
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    sessionId: "s",
    fetchImpl: async () =>
      sseResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 50, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "reason" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signature" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path":"test.js"}',
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 10 },
        },
        { type: "message_stop" },
      ]),
  });
  assert.equal(result.toolCalls[0].arguments.path, "test.js");
  assert.equal(result.anthropicContent[0].signature, "signature");
  assert.equal(result.usage.input_tokens, 50);
  assert.equal(result.usage.output_tokens, 10);
});

test("Responses adapter preserves reasoning items and function call IDs", async () => {
  const output = [
    { type: "reasoning", id: "r1", encrypted_content: "abc", summary: [] },
    {
      type: "function_call",
      id: "fc1",
      call_id: "t1",
      name: "read_file",
      arguments: '{"path":"test.js"}',
    },
  ];
  const result = await complete({
    provider: { baseURL: "http://test" },
    model: { id: "m", protocol: "responses" },
    system: "s",
    messages: [],
    sessionId: "s",
    fetchImpl: async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            call_id: "t1",
            name: "read_file",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"path":"test.js"}',
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output,
            usage: { input_tokens: 50, output_tokens: 10 },
          },
        },
      ]),
  });
  assert.deepEqual(result.responseOutput, output);
  assert.equal(result.toolCalls[0].id, "t1");
});

test("Google adapter preserves thought signatures and function calls", async () => {
  const result = await complete({
    provider: { baseURL: "http://test" },
    model: { id: "gemini", protocol: "google" },
    system: "s",
    messages: [],
    sessionId: "s",
    fetchImpl: async () =>
      sseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "read_file", args: { path: "x" } },
                    thoughtSignature: "sig",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
        },
      ]),
  });
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.equal(result.googleParts[0].thoughtSignature, "sig");
});
