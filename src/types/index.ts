// All domain types used across the addon.

export interface TargetSlot {
  /** Unique id — ISIN, ticker, or "$CASH-EUR" */
  symbol: string;
  /** Human-readable label shown in the UI */
  label: string;
  /** Target weight 0-100 */
  targetPct: number;
}

export interface TargetAllocation {
  /** Account id this allocation belongs to */
  accountId: string;
  slots: TargetSlot[];
}

/** One row in the drift table, optionally enriched with conviction data */
export interface DriftRow {
  symbol: string;
  label: string;
  targetPct: number;
  currentValue: number;
  currentPct: number;
  driftPct: number; // currentPct - targetPct
  /** Composite conviction score 0–100 from Conviction Engine (undefined if CE not configured) */
  convictionScore?: number;
  /** Conviction tier 1–4 (1 = highest) */
  convictionTier?: number;
  /** CE action hint for this ticker */
  convictionAction?: 'BUY' | 'WATCH' | 'TRIM';
  /** Plain-English reason from CE */
  convictionReason?: string;
  /** Whether CE flags this ticker as high-risk */
  convictionHighRisk?: boolean;
  /** Fundamentals sub-score 0–100 */
  convictionFScore?: number;
  /** Sentiment sub-score 0–100 */
  convictionSentScore?: number;
  /** Long-term sub-score 0–100 */
  convictionLScore?: number;
  /** RSI 14-day (null if unavailable) */
  convictionRsi?: number | null;
  /** Analyst price target gap % — positive = upside remaining */
  convictionAnalystGap?: number | null;
  /** Play type label from CE */
  convictionPlayType?: string;
}

export interface RebalanceOrder {
  symbol: string;
  label: string;
  action: 'BUY' | 'SELL';
  amount: number; // in base currency
  /** True when CE also flags this position as a TRIM candidate */
  convictionConfirmsSell?: boolean;
  /** CE s_total score if available */
  convictionScore?: number;
  /** CE tier if available */
  convictionTier?: number;
}

export interface InflowOrder {
  symbol: string;
  label: string;
  amount: number; // how much of the new cash to put here
}

export interface RebalanceResult {
  totalValue: number;
  currency: string;
  driftRows: DriftRow[];
  fullRebalanceOrders: RebalanceOrder[];
  inflowOrders: InflowOrder[];
  inflowAmount: number;
}

// ── Conviction Engine supplementary types ─────────────────────────────────────

export interface CeAlert {
  id: number;
  ticker: string;
  alert_type: 'MOAT_BREACH' | 'RANKING_DRIFT' | 'SENTIMENT_DECOUPLING';
  triggered_at: string;
  resolved_at: string | null;
  is_active: boolean;
  details: Record<string, unknown>;
}

export interface CeAlertsResponse {
  total: number;
  items: CeAlert[];
}

export interface CeSizingHolding {
  ticker: string;
  current_value: number | null;
  current_pct: number | null;
  recommended_pct: number;
  recommended_value: number | null;
  recommended_shares: number | null;
  over_under_pct: number | null;
  kelly_fraction: number;
  volatility_annual: number;
  s_total: number | null;
  current_price: number | null;
}

export interface CeSizingResponse {
  total_portfolio_value: number | null;
  holdings: CeSizingHolding[];
}

export interface CeDrawdownFlag {
  ticker: string;
  current_drawdown: number;
  historical_mean_drawdown: number;
  ratio: number;
}

export interface CeCorrelationReplacement {
  removed_ticker: string;
  added_ticker: string;
  correlation_with: string;
  correlation_value: number;
}

export interface CeRiskResponse {
  date: string;
  drawdown_flags: CeDrawdownFlag[];
  final_tier1: string[];
  replacements: CeCorrelationReplacement[];
  correlation_matrix: Record<string, Record<string, number>>;
}

export interface CeBacktestMetrics {
  total_return: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown: number;
  hit_rate?: number;
}

export interface CeBacktestMonthlyReturn {
  date: string;
  model_return: number;
  benchmark_return: number;
}

export interface CeBacktestHitEntry {
  ticker: string;
  entry_date: string;
  return_12m: number;
  was_positive: boolean;
}

export interface CeBacktestResponse {
  computed_at: string;
  period_start: string;
  period_end: string;
  model: CeBacktestMetrics;
  benchmark: Omit<CeBacktestMetrics, 'hit_rate'>;
  monthly_returns: CeBacktestMonthlyReturn[];
  hit_history: CeBacktestHitEntry[];
}

// ── Journal types ─────────────────────────────────────────────────────────────

export interface CeJournalEntry {
  id: number;
  ticker: string;
  action: 'BUY' | 'SELL' | 'TRIM' | 'WATCH' | 'NOTE';
  date: string; // ISO date e.g. "2024-01-15"
  thesis: string | null;
  score_at_entry: number | null;
  f_score_at_entry: number | null;
  s_ent_score_at_entry: number | null;
  l_score_at_entry: number | null;
  entry_price: number | null;
  exit_price: number | null;
  pnl_pct: number | null;
  planned_holding_months: number | null;
  tags: string[];
  outcome: string | null;
  thesis_played_out: boolean | null;
  created_at: string;
  updated_at: string | null;
}

export interface CeJournalEntryIn {
  ticker: string;
  action: 'BUY' | 'SELL' | 'TRIM' | 'WATCH' | 'NOTE';
  date: string;
  thesis?: string;
  score_at_entry?: number | null;
  f_score_at_entry?: number | null;
  s_ent_score_at_entry?: number | null;
  l_score_at_entry?: number | null;
  entry_price?: number | null;
  exit_price?: number | null;
  planned_holding_months?: number | null;
  tags?: string[];
  outcome?: string | null;
  thesis_played_out?: boolean | null;
}

export interface CeJournalStats {
  total_entries: number;
  unique_tickers: number;
  action_counts: Record<string, number>;
  reviewed_count: number;
  win_count: number;
  win_rate_pct: number | null;
  avg_score_at_buy: number | null;
}
