/**
 * Conviction Engine API client.
 *
 * The /scores/execution-list endpoint is public (no auth required).
 * The baseUrl is stored by the user in addon config (secrets).
 */

export interface ConvictionScore {
  ticker: string;
  name: string;
  sector: string | null;
  tier: number;           // 1–4 (1 = highest conviction)
  play_type: string;      // "High Conviction" | "Medium Opportunity" | "Speculative Idea" | "Neutral"
  rank: number;
  s_total: number;        // composite score 0–100
  f_score: number;        // fundamentals sub-score 0–100
  s_ent_score: number;    // sentiment sub-score 0–100
  l_score: number;        // long-term sub-score 0–100
  action: 'BUY' | 'WATCH' | 'TRIM';
  reason: string;
  is_high_risk: boolean;
  rsi: number | null;
}

export interface ConvictionMap {
  /** Keyed by uppercase ticker symbol, e.g. "AAPL" */
  [ticker: string]: ConvictionScore;
}

/**
 * Fetch the execution list from the Conviction Engine and return a ticker→score map.
 * Returns an empty map (no-op) if baseUrl is blank or the request fails.
 *
 * Uses /scores endpoint (limit=100) rather than /scores/execution-list so that
 * ALL tracked tickers are returned, not just the top-10 execution list.
 */
export async function fetchConvictionScores(baseUrl: string): Promise<ConvictionMap> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return {};

  try {
    const res = await fetch(`${url}/scores?limit=100`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json() as { items: ConvictionScore[] };

    // Also fetch the execution list for the BUY/WATCH/TRIM action hints
    const execRes = await fetch(`${url}/scores/execution-list?limit=50`, {
      signal: AbortSignal.timeout(8000),
    });
    const execData = execRes.ok
      ? (await execRes.json() as { items: ConvictionScore[] })
      : { items: [] as ConvictionScore[] };

    // Build a map from execution list first (has action + reason)
    const map: ConvictionMap = {};
    for (const item of execData.items) {
      map[item.ticker.toUpperCase()] = item;
    }
    // Fill in any tickers from /scores that aren't in the execution list
    // (they won't have action/reason, so we synthesise defaults)
    for (const item of data.items) {
      const key = item.ticker.toUpperCase();
      if (!map[key]) {
        map[key] = {
          ...item,
          action: item.tier <= 2 ? 'WATCH' : 'TRIM',
          reason: item.tier <= 2
            ? `Tier ${item.tier} — not in top execution list`
            : `Tier ${item.tier} — below quality threshold`,
        };
      }
    }
    return map;
  } catch {
    return {};
  }
}
