import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { request, events, APIError, requestTiming, apiError } from "./http.js";
import { textHistory } from "./text-tools.js";

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

export function chatMessages(system, messages, native) {
  if (!native)
    return [{ role: "system", content: system }, ...textHistory(messages)];
  return [
    { role: "system", content: system },
    ...messages.map((m) => {
      if (m.role === "tool")
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      return {
        role: m.role,
        content: m.content || (m.toolCalls?.length ? null : ""),
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.arguments),
                },
              })),
            }
          : {}),
        ...(m.reasoningDetails?.length
          ? { reasoning_details: m.reasoningDetails }
          : {}),
        ...(m.reasoningContent
          ? { reasoning_content: m.reasoningContent }
          : {}),
      };
    }),
  ];
}

export function anthropicMessages(messages, native) {
  const source = native ? messages : textHistory(messages);
  const output = [];
  for (const m of source) {
    const role = m.role === "assistant" ? "assistant" : "user";
    let content;
    if (m.role === "tool")
      content = [
        { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
      ];
    else if (native && m.anthropicContent) content = m.anthropicContent;
    else
      content = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...(native
          ? (m.toolCalls || []).map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.arguments,
            }))
          : []),
      ];
    if (!content.length) continue;
    if (output.at(-1)?.role === role) output.at(-1).content.push(...content);
    else output.push({ role, content: [...content] });
  }
  return output;
}

export function responseInput(messages, native) {
  if (!native)
    return textHistory(messages).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  return messages.flatMap((m) => {
    if (m.role === "tool")
      return [
        {
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        },
      ];
    if (m.responseOutput) return m.responseOutput;
    return [
      ...(m.content ? [{ role: m.role, content: m.content }] : []),
      ...(m.toolCalls || []).map((c) => ({
        type: "function_call",
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments),
      })),
    ];
  });
}

export function googleContents(messages, native) {
  const source = native ? messages : textHistory(messages);
  const output = [];
  for (const m of source) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts =
      m.role === "tool"
        ? [
            {
              functionResponse: {
                name: m.name,
                response: { result: m.content },
              },
            },
          ]
        : native && m.googleParts
          ? m.googleParts
          : [
              ...(m.content ? [{ text: m.content }] : []),
              ...(native
                ? (m.toolCalls || []).map((c) => ({
                    functionCall: { name: c.name, args: c.arguments },
                  }))
                : []),
            ];
    if (!parts.length) continue;
    if (output.at(-1)?.role === role) output.at(-1).parts.push(...parts);
    else output.push({ role, parts: [...parts] });
  }
  return output;
}

export function buildRequest({
  model,
  system,
  messages,
  tools,
  mode,
  maxTokens,
}) {
  const native = mode === "native" && tools.length > 0;
  const max = Math.min(maxTokens, model.maxOutput || maxTokens);
  switch (model.protocol) {
    case "messages":
      return {
        endpoint: "/messages",
        body: {
          model: model.id,
          system,
          messages: anthropicMessages(messages, native),
          max_tokens: max,
          stream: true,
          ...(native
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
        },
      };
    case "responses":
      return {
        endpoint: "/responses",
        body: {
          model: model.id,
          instructions: system,
          input: responseInput(messages, native),
          max_output_tokens: max,
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          ...(native
            ? {
                tools: tools.map((t) => ({
                  type: "function",
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                  strict: false,
                })),
              }
            : {}),
        },
      };
    case "google":
      return {
        endpoint: `/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: googleContents(messages, native),
          generationConfig: { maxOutputTokens: max },
          ...(native
            ? {
                tools: [
                  {
                    functionDeclarations: tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.parameters,
                    })),
                  },
                ],
              }
            : {}),
        },
      };
    default:
      return {
        endpoint: "/chat/completions",
        body: {
          model: model.id,
          messages: chatMessages(system, messages, native),
          max_tokens: max,
          stream: true,
          ...(native
            ? {
                tools: tools.map((t) => ({ type: "function", function: t })),
                tool_choice: "auto",
              }
            : {}),
        },
      };
  }
}

export async function complete({
  provider,
  key,
  model,
  system,
  messages,
  tools = [],
  mode = "text",
  maxTokens = 8192,
  sessionId,
  signal,
  onToken = () => {},
  fetchImpl = fetch,
  retry,
  onRetry,
}) {
  const { endpoint, body } = buildRequest({
    model,
    system,
    messages,
    tools,
    mode,
    maxTokens,
  });
  const start = performance.now();
  const headers = { "x-opencode-session": sessionId, "X-Title": "MicroCode" };
  if (model.protocol === "messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  }
  if (model.protocol === "google" && key) headers["x-goog-api-key"] = key;
  const response = await request(provider.baseURL + endpoint, {
    key,
    headers,
    body,
    signal,
    fetchImpl,
    retry,
    onRetry,
  });
  const result = {
    content: "",
    reasoning: "",
    toolCalls: [],
    usage: null,
    finishReason: null,
  };
  const toolMap = new Map();
  const blocks = new Map();
  const responseItems = new Map();
  let ended = false;
  let received = 0;
  const emit = (text) => {
    if (text) {
      result.content += text;
      onToken(text);
    }
  };
  const iterable = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? events(response, { key })
    : [await response.json()];
  for await (const e of iterable) {
    if (signal?.aborted) throw signal.reason;
    if (e.error || e.type === "error")
      throw apiError(e, 0, { key, streamStarted: true });
    if ((received += JSON.stringify(e).length) > 8 * 1024 * 1024)
      throw new APIError("Resposta excedeu 8 MB.");
    if (model.protocol === "messages") {
      if (e.type === "message_start") result.usage = { ...e.message?.usage };
      if (e.type === "content_block_start")
        blocks.set(e.index, { ...e.content_block, json: "" });
      if (e.type === "content_block_delta") {
        const b = blocks.get(e.index);
        if (e.delta.type === "text_delta") {
          emit(e.delta.text);
          if (b) b.text = (b.text || "") + e.delta.text;
        }
        if (e.delta.type === "input_json_delta" && b)
          b.json += e.delta.partial_json;
        if (e.delta.type === "thinking_delta" && b) {
          b.thinking = (b.thinking || "") + e.delta.thinking;
          result.reasoning += e.delta.thinking;
        }
        if (e.delta.type === "signature_delta" && b)
          b.signature = (b.signature || "") + e.delta.signature;
      }
      if (e.type === "message_delta") {
        result.usage = { ...result.usage, ...e.usage };
        result.finishReason = e.delta?.stop_reason;
      }
      if (e.type === "message_stop") ended = true;
      if (e.type === "message" && e.content) {
        for (const [i, b] of e.content.entries()) blocks.set(i, b);
        result.usage = e.usage;
        result.finishReason = e.stop_reason;
        ended = true;
      }
    } else if (model.protocol === "responses") {
      if (e.type === "response.output_text.delta") emit(e.delta);
      if (e.type === "response.reasoning_summary_text.delta")
        result.reasoning += e.delta;
      if (e.type === "response.output_item.added")
        responseItems.set(e.output_index, { ...e.item });
      if (e.type === "response.function_call_arguments.delta") {
        const item = responseItems.get(e.output_index);
        if (item) item.arguments = (item.arguments || "") + e.delta;
      }
      if (e.type === "response.output_item.done")
        responseItems.set(e.output_index, e.item);
      if (
        e.type === "response.completed" ||
        e.type === "response.incomplete" ||
        e.object === "response"
      ) {
        const data = e.response || e;
        result.responseOutput = data.output || [...responseItems.values()];
        result.usage = data.usage;
        result.finishReason = data.incomplete_details?.reason || data.status;
        ended = true;
      }
      if (e.type === "response.failed")
        throw apiError(
          {
            error: e.response?.error || {
              message: "Falha no endpoint Responses.",
            },
          },
          0,
          { key, streamStarted: true },
        );
    } else if (model.protocol === "google") {
      const candidate = e.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      result.googleParts ||= [];
      for (const part of parts) {
        result.googleParts.push(part);
        if (part.text && !part.thought) emit(part.text);
        if (part.thought) result.reasoning += part.text || "";
        if (part.functionCall)
          result.toolCalls.push({
            id: randomUUID(),
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
          });
      }
      if (e.usageMetadata) result.usage = e.usageMetadata;
      if (candidate?.finishReason) {
        result.finishReason = candidate.finishReason;
        ended = true;
      }
      if (e.promptFeedback?.blockReason)
        throw new APIError(
          `Geração bloqueada: ${e.promptFeedback.blockReason}`,
        );
    } else {
      const choice = e.choices?.[0];
      const delta = choice?.delta || choice?.message;
      if (delta?.content) emit(delta.content);
      if (delta?.reasoning) result.reasoning += delta.reasoning;
      if (delta?.reasoning_content) {
        result.reasoningContent =
          (result.reasoningContent || "") + delta.reasoning_content;
        result.reasoning += delta.reasoning_content;
      }
      if (delta?.reasoning_details) {
        result.reasoningDetails ||= [];
        for (const d of delta.reasoning_details) {
          const found = result.reasoningDetails.find(
            (x) => x.index === d.index && x.type === d.type && x.id === d.id,
          );
          if (found && (d.text || d.data)) {
            if (d.text) found.text = (found.text || "") + d.text;
            if (d.data) found.data = (found.data || "") + d.data;
          } else result.reasoningDetails.push({ ...d });
        }
      }
      for (const [i, t] of (delta?.tool_calls || []).entries()) {
        const index = t.index ?? i;
        const previous = toolMap.get(index) || { id: "", name: "", raw: "" };
        previous.id += t.id || "";
        previous.name += t.function?.name || "";
        previous.raw += t.function?.arguments || "";
        toolMap.set(index, previous);
      }
      if (e.usage) result.usage = e.usage;
      if (choice?.finish_reason) {
        result.finishReason = choice.finish_reason;
        ended = true;
      }
    }
  }
  if (!ended)
    throw new APIError(
      "Stream interrompido antes do término; nenhuma ferramenta dessa resposta foi executada.",
    );
  if (model.protocol === "messages") {
    result.anthropicContent = [...blocks.values()].map(({ json, ...b }) =>
      b.type === "tool_use"
        ? { ...b, input: json ? parseArguments(json) : b.input }
        : b,
    );
    result.toolCalls = result.anthropicContent
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
    if (!result.content)
      result.content = result.anthropicContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
  } else if (model.protocol === "responses") {
    result.toolCalls = (result.responseOutput || [])
      .filter((b) => b.type === "function_call")
      .map((b) => ({
        id: b.call_id,
        name: b.name,
        arguments: parseArguments(b.arguments),
      }));
    if (!result.content)
      result.content = (result.responseOutput || [])
        .filter((b) => b.type === "message")
        .flatMap((b) => b.content || [])
        .filter((b) => b.type === "output_text")
        .map((b) => b.text)
        .join("");
  } else if (model.protocol === "chat")
    result.toolCalls = [...toolMap.values()].map((t) => ({
      id: t.id || randomUUID(),
      name: t.name,
      arguments: parseArguments(t.raw),
    }));
  const timing = requestTiming(response);
  result.durationMs = performance.now() - (timing?.startedAt ?? start);
  result.retries = timing?.retries ?? 0;
  return result;
}
