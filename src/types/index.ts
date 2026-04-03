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
