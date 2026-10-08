export class APIError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}

export async function request(
  url,
  { key, headers = {}, body, signal, fetchImpl = fetch, timeout = 180000 } = {},
) {
  const response = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": "microcode/0.1.0",
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
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 1600);
    try {
      const data = JSON.parse(text);
      message = data.error?.message || data.message || message;
    } catch {
      /* non-JSON error */
    }
    if (key) message = message.replaceAll(key, "[API KEY]");
    throw new APIError(`HTTP ${response.status}: ${message}`, response.status);
  }
  return response;
}

// SSE frames can cross TCP chunks, contain CRLF, comments, or multiple data lines.
export async function* events(response) {
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
      throw new APIError(
        value.error?.message || value.message || "Erro durante o stream.",
      );
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
