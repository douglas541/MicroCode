import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { VERSION } from "./version.js";

const timings = new WeakMap();
export const requestTiming = (response) => timings.get(response);

export class APIError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = "APIError";
    this.status = status;
    Object.assign(this, details);
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value || !String(value).trim()) return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^-/.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function safeText(value, key) {
  let text = String(value || "").replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,
    "",
  );
  if (key) text = text.replaceAll(key, "[API KEY]");
  return text
    .replace(/sk-or-v1-[a-fA-F0-9]{64}/g, "[API KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [API KEY]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, 1600);
}

// Preserve the original upstream error, but not arbitrary headers, prompts or
// credentials that might be included in error.metadata.raw.
export function apiError(
  data,
  status,
  { key, retryAfter = null, requestId, streamStarted = false, url } = {},
) {
  const error =
    data?.error && typeof data.error === "object" ? data.error : data || {};
  const metadata = error.metadata || {};
  let raw = metadata.raw;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      /* plain upstream message */
    }
  }
  const main = safeText(
    error.message ||
      (typeof data?.error === "string" ? data.error : "") ||
      "Provider returned error",
    key,
  );
  const detail = safeText(
    typeof raw === "string"
      ? raw
      : raw?.error?.message ||
          (typeof raw?.error === "string" ? raw.error : "") ||
          raw?.message ||
          raw?.detail ||
          raw?.description,
    key,
  );
  const provider = safeText(
    metadata.provider_name || metadata.provider || error.provider_name,
    key,
  );
  const providerCode = safeText(
    metadata.provider_code || raw?.error?.code || raw?.error?.type,
    key,
  );
  const errorType = safeText(metadata.error_type || error.type, key);
  const permanent =
    /insufficient_quota|quota_exhausted|billing_hard_limit|daily[_ -](?:limit|quota)|requests? per day|(?:daily|weekly|monthly).*(?:limit|quota)|(?:credits?|balance).*(?:exhausted|depleted|insufficient)/i.test(
      [main, detail, providerCode, errorType].join(" "),
    );
  const actualStatus =
    status || (Number.isInteger(Number(error.code)) ? Number(error.code) : 0);
  const lines = [actualStatus ? `HTTP ${actualStatus}: ${main}` : main];
  if (provider) lines.push(`Provedor: ${provider}`);
  if (providerCode) lines.push(`Código original: ${providerCode}`);
  if (errorType && errorType !== "error" && errorType !== providerCode)
    lines.push(`Tipo: ${errorType}`);
  if (detail && detail !== main) lines.push(`Detalhe: ${detail}`);
  if (actualStatus === 429)
    lines.push(
      permanent
        ? "Cota esgotada: aguarde a renovação do limite ou selecione outro modelo em /models."
        : "Limitação de taxa ou capacidade. Se persistir, tente mais tarde ou selecione outro modelo em /models.",
    );
  if (retryAfter != null)
    lines.push(`Retry-After: ${(retryAfter / 1000).toFixed(1)}s`);
  if (actualStatus === 401 && url && new URL(url).hostname === "openrouter.ai")
    lines.push(
      "Autenticação recusada: use /connect openrouter com uma API key válida. /doctor verifica a credencial sem gerar tokens.",
    );
  return new APIError(lines.join("\n  "), actualStatus, {
    provider,
    providerCode,
    errorType,
    retryAfterMs: retryAfter,
    permanent,
    streamStarted,
    requestId: safeText(requestId, key),
    retryable: actualStatus === 429 && !permanent && !streamStarted,
  });
}

async function wait(ms, signal) {
  signal?.throwIfAborted();
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

export async function request(
  url,
  {
    key,
    headers = {},
    body,
    signal,
    fetchImpl = fetch,
    timeout = 180000,
    retry = {},
    onRetry = () => {},
    waitImpl = wait,
  } = {},
) {
  const requestedRetries = Number(retry.maxRetries ?? 0);
  const maxRetries = Number.isInteger(requestedRetries)
    ? Math.min(5, Math.max(0, requestedRetries))
    : 0;
  const requestedMaxDelay = Number(retry.maxDelayMs ?? 60000);
  const maxDelay = Number.isFinite(requestedMaxDelay)
    ? Math.min(120000, Math.max(0, requestedMaxDelay))
    : 60000;
  const requestedBaseDelay = Number(retry.baseDelayMs ?? 1500);
  const baseDelay = Number.isFinite(requestedBaseDelay)
    ? Math.min(maxDelay, Math.max(0, requestedBaseDelay))
    : Math.min(maxDelay, 1500);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const response = await fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: {
        "User-Agent": `microcode/${VERSION}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    });
    if (response.ok) {
      timings.set(response, { startedAt, retries: attempt });
      return response;
    }
    const text = await response.text();
    let data = { message: text.slice(0, 1600) };
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error */
    }
    const error = apiError(data, response.status, {
      key,
      url,
      retryAfter: retryAfterMs(response.headers.get("retry-after")),
      requestId: response.headers.get("x-request-id"),
    });
    error.attempts = attempt + 1;
    if (!error.retryable || attempt >= maxRetries) throw error;
    const backoff = Math.min(
      maxDelay,
      baseDelay * 2 ** attempt + Math.round(Math.random() * baseDelay * 0.1),
    );
    const waitMs = Math.max(error.retryAfterMs ?? 0, backoff);
    // A server-specified long delay must never be shortened to fit our cap.
    if (waitMs > maxDelay) {
      error.message += `\n  Espera solicitada de ${(waitMs / 1000).toFixed(1)}s supera o limite automático de ${(maxDelay / 1000).toFixed(1)}s. Nenhuma retentativa antecipada.`;
      throw error;
    }
    onRetry({ error, attempt: attempt + 1, maxRetries, waitMs });
    await waitImpl(waitMs, signal);
  }
}

// SSE frames can cross TCP chunks, contain CRLF, comments, or multiple data lines.
export async function* events(response, { key } = {}) {
  if (!response.body) throw new APIError("A API retornou um stream vazio.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function parse(frame) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return null;
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new APIError("Evento SSE inválido recebido da API.");
    }
    if (value.error || value.type === "error")
      throw apiError(value, 0, { key, streamStarted: true });
    return value;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parse(frame);
        if (parsed) yield parsed;
      }
      if (buffer.length > 8 * 1024 * 1024)
        throw new APIError("Evento SSE excedeu 8 MB.");
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parse(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
