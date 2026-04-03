/**
 * Conviction Engine API client.
 *
 * The /scores/execution-list endpoint is public (no auth required).
 * The baseUrl is stored by the user in addon config (secrets).
 */

import type {
  CeAlertsResponse,
  CeBacktestResponse,
  CeRiskResponse,
  CeSizingResponse,
} from '../types';

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

export interface RuleResult {
  rule_id: string;
  label: string;
  description: string;
  passed: boolean;
  value: number | null;
  threshold: string;
  verdict: string;
}

export interface RulesReport {
  ticker: string;
  all_passed: boolean;
  rules: RuleResult[];
}

/** Map of ticker → array of s_total values (oldest first) */
export type SparklineMap = Record<string, number[]>;

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

/**
 * Fetch behavioral safeguard rules for a single ticker.
 * Returns null on any error or if the ticker is not in the CE universe.
 */
export async function fetchRulesCheck(baseUrl: string, ticker: string): Promise<RulesReport | null> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  try {
    const res = await fetch(`${url}/rules/check/${encodeURIComponent(ticker)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json() as RulesReport;
  } catch {
    return null;
  }
}

/**
 * Fetch 30-day score history for multiple tickers in one call.
 * Returns a map of ticker → array of s_total values (oldest→newest).
 */
export async function fetchSparklines(baseUrl: string, tickers: string[]): Promise<SparklineMap> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url || tickers.length === 0) return {};
  try {
    const params = tickers.map((t) => `tickers=${encodeURIComponent(t)}`).join('&');
    const res = await fetch(`${url}/scores/history/batch?${params}&days=30`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    return await res.json() as SparklineMap;
  } catch {
    return {};
  }
}

/**
 * Fetch active CE alerts (MOAT_BREACH / RANKING_DRIFT / SENTIMENT_DECOUPLING).
 * Returns null on any error.
 */
export async function fetchAlerts(baseUrl: string): Promise<CeAlertsResponse | null> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  try {
    const res = await fetch(`${url}/alerts?active_only=true&limit=50`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as CeAlertsResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch Kelly-inspired position sizing recommendations from CE.
 * Returns null on any error.
 */
export async function fetchSizing(baseUrl: string): Promise<CeSizingResponse | null> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  try {
    const res = await fetch(`${url}/portfolio/sizing`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json() as CeSizingResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch risk overlay data (drawdown flags + correlation warnings).
 * Returns null on any error.
 */
export async function fetchRisk(baseUrl: string): Promise<CeRiskResponse | null> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  try {
    const res = await fetch(`${url}/risk`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json() as CeRiskResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch backtest metrics (Sharpe, Sortino, hit rate vs benchmark).
 * Returns null on any error.
 */
export async function fetchBacktest(baseUrl: string): Promise<CeBacktestResponse | null> {
  const url = baseUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  try {
    const res = await fetch(`${url}/backtest`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json() as CeBacktestResponse;
  } catch {
    return null;
  }
}

