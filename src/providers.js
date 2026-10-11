import { PRESETS } from "./store.js";
import { request } from "./http.js";

const optionalNumber = (value) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);

export function openRouterModel(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    context: m.context_length || null,
    maxOutput: m.top_provider?.max_completion_tokens || null,
    nativeTools: Array.isArray(m.supported_parameters)
      ? m.supported_parameters.includes("tools")
      : null,
    protocol: "chat",
    inputPrice:
      optionalNumber(m.pricing?.prompt) == null
        ? null
        : Number(m.pricing.prompt) * 1e6,
    outputPrice:
      optionalNumber(m.pricing?.completion) == null
        ? null
        : Number(m.pricing.completion) * 1e6,
    cacheReadPrice:
      optionalNumber(m.pricing?.input_cache_read) == null
        ? null
        : Number(m.pricing.input_cache_read) * 1e6,
    source: "OpenRouter",
  };
}

export function zenModel(m, meta = {}) {
  const npm = meta.provider?.npm || "@ai-sdk/openai-compatible";
  const protocol =
    npm === "@ai-sdk/anthropic"
      ? "messages"
      : npm === "@ai-sdk/openai"
        ? "responses"
        : npm === "@ai-sdk/google"
          ? "google"
          : "chat";
  return {
    id: m.id,
    name: meta.name || m.name || m.id,
    context: meta.limit?.context || null,
    maxOutput: meta.limit?.output || null,
    nativeTools: typeof meta.tool_call === "boolean" ? meta.tool_call : null,
    protocol,
    inputPrice: optionalNumber(meta.cost?.input),
    outputPrice: optionalNumber(meta.cost?.output),
    cacheReadPrice: optionalNumber(meta.cost?.cache_read),
    cacheWritePrice: optionalNumber(meta.cost?.cache_write),
    tiers: meta.cost?.tiers || [],
    source: "models.dev + OpenCode",
  };
}

export async function catalog(
  id,
  provider,
  store,
  { refresh = false, fetchImpl = fetch, signal } = {},
) {
  const cacheName = `catalogs/${id}.json`;
  const cached = await store.read(cacheName, null);
  if (
    !refresh &&
    cached?.baseURL === provider.baseURL &&
    Date.now() - cached.fetchedAt < 3600000
  )
    return { ...cached, stale: false };
  try {
    const key = await store.key(id, provider);
    const headers = {};
    const response = await request(`${provider.baseURL}/models`, {
      key,
      headers,
      timeout: 30000,
      fetchImpl,
      signal,
    });
    const data = await response.json();
    if (!Array.isArray(data.data))
      throw new Error("Catálogo de modelos inválido.");
    let next = data.links?.next;
    const visited = new Set();
    while (next) {
      const url = new URL(next, provider.baseURL + "/");
      if (
        url.origin !== new URL(provider.baseURL).origin ||
        visited.has(url.href) ||
        visited.size >= 20
      )
        throw new Error("Paginação inválida no catálogo.");
      visited.add(url.href);
      const page = await (
        await request(url.href, { key, timeout: 30000, fetchImpl, signal })
      ).json();
      if (!Array.isArray(page.data))
        throw new Error("Página de catálogo inválida.");
      data.data.push(...page.data);
      next = page.links?.next;
    }
    let models;
    if (provider.catalog === "openrouter")
      models = data.data.map(openRouterModel);
    else if (
      provider.catalog === "opencode" ||
      provider.catalog === "opencode-go"
    ) {
      let metadata = {};
      try {
        const res = await request("https://models.dev/api.json", {
          timeout: 30000,
          fetchImpl,
          signal,
        });
        metadata = (await res.json())[provider.catalog]?.models || {};
      } catch {
        /* unknown metadata is shown as unknown, never as free */
      }
      models = data.data
        .filter((m) => !m.id.startsWith("jev-"))
        .map((m) => zenModel(m, metadata[m.id]));
      // Protocol cannot be guessed for Zen when metadata is unavailable.
      models = models.map((m) => ({
        ...m,
        protocolKnown: Boolean(metadata[m.id]),
      }));
    } else models = data.data.map(openRouterModel);
    models.sort((a, b) => a.name.localeCompare(b.name));
    const result = { baseURL: provider.baseURL, fetchedAt: Date.now(), models };
    await store.write(cacheName, result);
    return { ...result, stale: false };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (cached?.baseURL === provider.baseURL)
      return { ...cached, stale: true, warning: error.message };
    throw error;
  }
}

export function configuredProviders(config) {
  return Object.fromEntries(
    Object.entries(PRESETS)
      .filter(([, p]) => process.env[p.env])
      .concat(Object.entries(config.providers)),
  );
}

export function chooseMode(requested, model) {
  if (requested === "native" && model.nativeTools === false)
    throw new Error(
      "Este modelo não suporta tools nativas. Use /tools text ou /tools auto.",
    );
  return requested === "auto"
    ? model.nativeTools === true
      ? "native"
      : "text"
    : requested;
}

export function unsupportedTools(error) {
  return (
    [400, 404, 422].includes(error.status) &&
    /(?:no endpoints.*tool|does not support.*tool|tools?.*(?:unsupported|not supported)|unsupported.*tools?)/i.test(
      error.message,
    )
  );
}
