export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text || "", "utf8") / 4);
}

export function normalizeUsage(raw, protocol = "chat") {
  if (!raw) return null;
  if (protocol === "google")
    return {
      input: raw.promptTokenCount ?? 0,
      output: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0),
      cached: raw.cachedContentTokenCount ?? 0,
      cacheWrite: 0,
      cost: null,
    };
  if (protocol === "messages")
    return {
      input:
        (raw.input_tokens ?? 0) +
        (raw.cache_read_input_tokens ?? 0) +
        (raw.cache_creation_input_tokens ?? 0),
      output: raw.output_tokens ?? 0,
      cached: raw.cache_read_input_tokens ?? 0,
      cacheWrite: raw.cache_creation_input_tokens ?? 0,
      cost: raw.cost ?? null,
    };
  return {
    input: raw.prompt_tokens ?? raw.input_tokens ?? 0,
    output: raw.completion_tokens ?? raw.output_tokens ?? 0,
    cached:
      raw.prompt_tokens_details?.cached_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      0,
    cacheWrite: 0,
    cost: raw.cost ?? null,
  };
}

export function recordUsage(result, model, inputText) {
  const counts = normalizeUsage(result.usage, model.protocol);
  const usage = counts || {
    input: estimateTokens(inputText),
    output: estimateTokens(
      result.content +
        JSON.stringify(result.toolCalls || []) +
        (result.reasoning || ""),
    ),
    cached: 0,
    cacheWrite: 0,
    cost: null,
  };
  let rates = model;
  for (const tier of model.tiers || [])
    if (tier.tier?.type === "context" && usage.input > tier.tier.size)
      rates = {
        ...rates,
        inputPrice: tier.input,
        outputPrice: tier.output,
        cacheReadPrice: tier.cache_read,
        cacheWritePrice: tier.cache_write,
      };
  const canEstimate = rates.inputPrice != null && rates.outputPrice != null;
  const cost =
    usage.cost ??
    (canEstimate
      ? (Math.max(0, usage.input - usage.cached - usage.cacheWrite) *
          rates.inputPrice +
          usage.cached * (rates.cacheReadPrice ?? rates.inputPrice) +
          usage.cacheWrite * (rates.cacheWritePrice ?? rates.inputPrice) +
          usage.output * rates.outputPrice) /
        1e6
      : null);
  const duration = Math.max(0.001, result.durationMs / 1000);
  // End-to-end inference rate includes time to first token, but excludes tools/user input.
  return {
    ...usage,
    cost,
    estimatedTokens: !counts,
    estimatedCost: usage.cost == null && cost != null,
    seconds: duration,
    tps: usage.output / duration,
    model: model.id,
    retries: result.retries || 0,
    at: new Date().toISOString(),
  };
}

export function totals(records) {
  return records.reduce(
    (t, r) => ({
      input: t.input + r.input,
      output: t.output + r.output,
      cost: t.cost + (r.cost ?? 0),
      unknownCost: t.unknownCost || r.cost == null,
      estimatedCost: t.estimatedCost || r.estimatedCost,
      estimatedTokens: t.estimatedTokens || r.estimatedTokens,
      seconds: t.seconds + r.seconds,
      requests: t.requests + 1,
    }),
    {
      input: 0,
      output: 0,
      cost: 0,
      unknownCost: false,
      estimatedCost: false,
      estimatedTokens: false,
      seconds: 0,
      requests: 0,
    },
  );
}
