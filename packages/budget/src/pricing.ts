/** Token counts for one model call. `input` excludes cached tokens. */
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** USD per million tokens. Cache rates fall back to the input rate when unset. Operations data: the factory does not ship a price table (M3). */
export type Price = { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };

/** Exact model id wins; otherwise the longest `prefix*` entry. No match means the model is unpriced. */
export function priceFor(prices: Record<string, Price>, model: string | undefined): Price | undefined {
  if (!model) return undefined;
  if (prices[model]) return prices[model];
  let best: [string, Price] | undefined;
  for (const [k, p] of Object.entries(prices)) {
    if (k.endsWith('*') && model.startsWith(k.slice(0, -1)) && (!best || k.length > best[0].length)) best = [k, p];
  }
  return best?.[1];
}

export function costUsd(u: TokenUsage, p: Price): number {
  const usd =
    u.input * p.inputPerMTok +
    u.output * p.outputPerMTok +
    u.cacheRead * (p.cacheReadPerMTok ?? p.inputPerMTok) +
    u.cacheWrite * (p.cacheWritePerMTok ?? p.inputPerMTok);
  return Math.round((usd / 1_000_000) * 1e8) / 1e8;
}
