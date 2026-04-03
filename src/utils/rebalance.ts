import type { Holding } from '@wealthfolio/addon-sdk';
import type {
  DriftRow,
  InflowOrder,
  RebalanceOrder,
  RebalanceResult,
  TargetSlot,
} from '../types';
import type { ConvictionMap } from './conviction';

/**
 * Build the full rebalance result from current holdings + target allocation.
 *
 * @param holdings      Holdings from ctx.api.portfolio.getHoldings()
 * @param slots         Target allocation slots (must sum to 100)
 * @param currency      Base currency string, e.g. "EUR"
 * @param inflowAmount  New cash to deploy (Inflow mode), 0 for Full Rebalance only
 * @param conviction    Optional map of ticker→conviction score from the Conviction Engine
 */
export function computeRebalance(
  holdings: Holding[],
  slots: TargetSlot[],
  currency: string,
  inflowAmount: number,
  conviction: ConvictionMap = {},
): RebalanceResult {
  // Build a map of symbol -> current market value (base currency) from holdings
  const valueBySymbol = new Map<string, number>();
  for (const h of holdings) {
    const sym = h.instrument?.symbol;
    if (!sym) continue;
    const prev = valueBySymbol.get(sym) ?? 0;
    valueBySymbol.set(sym, prev + h.marketValue.base);
  }

  // Total portfolio value (including inflow for inflow-mode calculations)
  const portfolioValue = [...valueBySymbol.values()].reduce((s, v) => s + v, 0);
  const totalWithInflow = portfolioValue + inflowAmount;

  // --- Drift rows (based on current portfolio, no inflow) ---
  const driftRows: DriftRow[] = slots.map((slot) => {
    const currentValue = valueBySymbol.get(slot.symbol) ?? 0;
    const currentPct = portfolioValue > 0 ? (currentValue / portfolioValue) * 100 : 0;
    const ce = conviction[slot.symbol.toUpperCase()];
    return {
      symbol: slot.symbol,
      label: slot.label,
      targetPct: slot.targetPct,
      currentValue,
      currentPct,
      driftPct: currentPct - slot.targetPct,
      ...(ce && {
        convictionScore: ce.s_total,
        convictionTier: ce.tier,
        convictionAction: ce.action,
        convictionReason: ce.reason,
        convictionHighRisk: ce.is_high_risk,
      }),
    };
  });

  // --- Full rebalance orders (buy/sell to reach target from current total) ---
  const fullRebalanceOrders: RebalanceOrder[] = [];
  for (const row of driftRows) {
    const targetValue = (row.targetPct / 100) * portfolioValue;
    const delta = targetValue - row.currentValue;
    if (Math.abs(delta) < 0.01) continue;
    const ce = conviction[row.symbol.toUpperCase()];
    fullRebalanceOrders.push({
      symbol: row.symbol,
      label: row.label,
      action: delta > 0 ? 'BUY' : 'SELL',
      amount: Math.abs(delta),
      ...(ce && {
        convictionScore: ce.s_total,
        convictionTier: ce.tier,
        // Sell is CE-confirmed if CE also says TRIM, or tier >= 3, or high risk
        convictionConfirmsSell: delta < 0
          ? (ce.action === 'TRIM' || ce.tier >= 3 || ce.is_high_risk)
          : undefined,
      }),
    });
  }
  // Sort: sells first (free up cash), then buys largest-first
  fullRebalanceOrders.sort((a, b) => {
    if (a.action !== b.action) return a.action === 'SELL' ? -1 : 1;
    return b.amount - a.amount;
  });

  // --- Inflow orders (deploy new cash to fix drift, no selling) ---
  const inflowOrders: InflowOrder[] = [];
  if (inflowAmount > 0 && totalWithInflow > 0) {
    // For each slot, compute how much it needs to reach target in the new total
    const needs: { slot: TargetSlot; need: number }[] = [];
    let totalNeed = 0;
    for (const slot of slots) {
      const currentValue = valueBySymbol.get(slot.symbol) ?? 0;
      const targetValue = (slot.targetPct / 100) * totalWithInflow;
      const need = Math.max(0, targetValue - currentValue);
      needs.push({ slot, need });
      totalNeed += need;
    }
    // Scale needs proportionally to the available inflow
    for (const { slot, need } of needs) {
      if (need < 0.01) continue;
      const amount = totalNeed > 0 ? (need / totalNeed) * inflowAmount : 0;
      if (amount < 0.01) continue;
      inflowOrders.push({ symbol: slot.symbol, label: slot.label, amount });
    }
    inflowOrders.sort((a, b) => b.amount - a.amount);
  }

  return {
    totalValue: portfolioValue,
    currency,
    driftRows,
    fullRebalanceOrders,
    inflowOrders,
    inflowAmount,
  };
}

/** Validate that slots sum to exactly 100 (±0.01 tolerance). */
export function validateSlots(slots: TargetSlot[]): string | null {
  if (slots.length === 0) return 'Add at least one allocation slot.';
  const sum = slots.reduce((s, sl) => s + sl.targetPct, 0);
  if (Math.abs(sum - 100) > 0.01) {
    return `Allocations must sum to 100% (currently ${sum.toFixed(2)}%).`;
  }
  return null;
}

/** Format a number as currency string */
export function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format a number as percentage string */
export function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
