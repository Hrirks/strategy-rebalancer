import { useState, useEffect, useCallback } from 'react';
import type { AddonContext, Holding } from '@wealthfolio/addon-sdk';
import type { TargetAllocation } from '../types';
import type { ConvictionMap } from '../utils/conviction';
import { computeRebalance, formatCurrency, formatPct } from '../utils/rebalance';
import { fetchConvictionScores } from '../utils/conviction';

const STORAGE_KEY = 'target-allocations';
const CE_URL_KEY = 'conviction-engine-url';

interface Props {
  ctx: AddonContext;
  accountId: string;
  currency: string;
  onEditConfig: () => void;
}

// ── Conviction badge helpers ───────────────────────────────────────────────

function ConvictionBadge({ action }: { action: 'BUY' | 'WATCH' | 'TRIM' | undefined }) {
  if (!action) return null;
  const styles: Record<string, string> = {
    BUY:   'bg-green-100 text-green-700',
    WATCH: 'bg-blue-100 text-blue-700',
    TRIM:  'bg-red-100 text-red-700',
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${styles[action]}`}>
      {action}
    </span>
  );
}

function TierDot({ tier }: { tier: number | undefined }) {
  if (tier == null) return null;
  const colors = ['', 'bg-purple-500', 'bg-blue-500', 'bg-amber-400', 'bg-gray-400'];
  return (
    <span
      title={`Conviction Tier ${tier}`}
      className={`inline-block w-2 h-2 rounded-full ${colors[tier] ?? 'bg-gray-300'}`}
    />
  );
}

function ScorePill({ score }: { score: number | undefined }) {
  if (score == null) return null;
  const color = score >= 70 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-500';
  return <span className={`text-xs font-mono font-semibold ${color}`}>{score.toFixed(0)}</span>;
}

// ── Conviction-weighted suggestion ────────────────────────────────────────

/**
 * Compute suggested target percentages using conviction scores as weights.
 * Returns a map of symbol → suggestedPct, or null if no conviction data is available.
 */
function computeConvictionSuggestions(
  slots: TargetAllocation['slots'],
  conviction: ConvictionMap,
): Map<string, number> | null {
  const entries = slots
    .map((s) => ({ symbol: s.symbol, ce: conviction[s.symbol.toUpperCase()] }))
    .filter((e) => e.ce != null);

  if (entries.length < 2) return null;

  // Use s_total as weight, with a floor of 10 so nothing gets zeroed out
  const totalScore = entries.reduce((sum, e) => sum + Math.max(10, e.ce!.s_total), 0);
  const result = new Map<string, number>();
  for (const e of entries) {
    result.set(e.symbol, (Math.max(10, e.ce!.s_total) / totalScore) * 100);
  }
  return result;
}

export function ResultsPage({ ctx, accountId, currency, onEditConfig }: Props) {
  const [mode, setMode] = useState<'drift' | 'inflow' | 'full'>('drift');
  const [inflowInput, setInflowInput] = useState('');

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);

  const [config, setConfig] = useState<TargetAllocation | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  const [conviction, setConviction] = useState<ConvictionMap>({});
  const [ceLoading, setCeLoading] = useState(false);
  const [ceError, setCeError] = useState<string | null>(null);

  const [showConvictionSuggestions, setShowConvictionSuggestions] = useState(false);

  const loadData = useCallback(() => {
    setHoldingsLoading(true);
    setConfigLoading(true);
    setCeLoading(true);
    setCeError(null);

    ctx.api.portfolio.getHoldings(accountId)
      .then((data) => setHoldings(data))
      .catch(() => setHoldings([]))
      .finally(() => setHoldingsLoading(false));

    ctx.api.secrets.get(STORAGE_KEY)
      .then((raw) => {
        if (!raw) { setConfig(null); return; }
        const all: TargetAllocation[] = JSON.parse(raw);
        setConfig(all.find((a) => a.accountId === accountId) ?? null);
      })
      .catch(() => setConfig(null))
      .finally(() => setConfigLoading(false));

    ctx.api.secrets.get(CE_URL_KEY)
      .then((url) => fetchConvictionScores(url ?? ''))
      .then((map) => {
        setConviction(map);
        if (Object.keys(map).length === 0) setCeError(null); // no URL configured — silent
      })
      .catch(() => setCeError('Could not reach Conviction Engine'))
      .finally(() => setCeLoading(false));
  }, [accountId]);

  useEffect(() => {
    setMode('drift');
    setInflowInput('');
    setShowConvictionSuggestions(false);
    loadData();
  }, [loadData]);

  if (holdingsLoading || configLoading) {
    return <p className="text-muted-foreground">Loading portfolio data…</p>;
  }

  if (!config || config.slots.length === 0) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-muted-foreground">No target allocation configured yet.</p>
        <button
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90"
          onClick={onEditConfig}
        >
          Set Up Allocation
        </button>
      </div>
    );
  }

  const inflow = parseFloat(inflowInput) || 0;
  const result = computeRebalance(holdings, config.slots, currency, inflow, conviction);
  const hasConviction = Object.keys(conviction).length > 0;
  const convictionSuggestions = hasConviction
    ? computeConvictionSuggestions(config.slots, conviction)
    : null;

  // Count CE-confirmed sells
  const ceConfirmedSells = result.fullRebalanceOrders.filter(
    (o) => o.action === 'SELL' && o.convictionConfirmsSell,
  ).length;

  return (
    <div className="space-y-6">
      {/* Mode tabs */}
      <div className="flex gap-1 border-b">
        {(['drift', 'inflow', 'full'] as const).map((m) => (
          <button
            key={m}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              mode === m
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode(m)}
          >
            {m === 'drift' ? 'Drift Analysis' : m === 'inflow' ? 'Inflow Mode' : 'Full Rebalance'}
            {m === 'full' && ceConfirmedSells > 0 && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                {ceConfirmedSells}
              </span>
            )}
          </button>
        ))}
        <button
          className="ml-auto px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onEditConfig}
        >
          Edit Target →
        </button>
      </div>

      {/* CE status */}
      {ceLoading && (
        <p className="text-xs text-muted-foreground">Fetching conviction scores…</p>
      )}
      {ceError && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
          {ceError} — showing drift only.
        </p>
      )}

      {/* Portfolio summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Portfolio Value</p>
          <p className="text-2xl font-semibold">{formatCurrency(result.totalValue, currency)}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Tracked Positions</p>
          <p className="text-2xl font-semibold">{config.slots.length}</p>
        </div>
      </div>

      {/* ── DRIFT ANALYSIS ─────────────────────────────────────────────── */}
      {mode === 'drift' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Current vs. Target</h3>
            {convictionSuggestions && (
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => setShowConvictionSuggestions((v) => !v)}
              >
                {showConvictionSuggestions ? 'Hide' : 'Show'} conviction-weighted suggestions
              </button>
            )}
          </div>

          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Asset</th>
                  <th className="text-right px-4 py-2 font-medium">Value</th>
                  <th className="text-right px-4 py-2 font-medium">Current %</th>
                  <th className="text-right px-4 py-2 font-medium">Target %</th>
                  <th className="text-right px-4 py-2 font-medium">Drift</th>
                  {hasConviction && (
                    <th className="text-right px-4 py-2 font-medium">
                      <span title="Conviction tier dot, score, action">Conviction</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {result.driftRows.map((row) => {
                  const suggestion = convictionSuggestions?.get(row.symbol);
                  return (
                    <tr key={row.symbol} className="border-t">
                      <td className="px-4 py-2">
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.symbol}</div>
                        {row.convictionHighRisk && (
                          <span className="text-[10px] text-red-500 font-semibold">HIGH RISK</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatCurrency(row.currentValue, currency)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.currentPct.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <div>{row.targetPct.toFixed(2)}%</div>
                        {showConvictionSuggestions && suggestion != null && (
                          <div className="text-[10px] text-purple-600 font-medium">
                            → {suggestion.toFixed(1)}% CE
                          </div>
                        )}
                      </td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums font-medium ${
                          Math.abs(row.driftPct) < 1
                            ? 'text-muted-foreground'
                            : row.driftPct > 0
                            ? 'text-red-500'
                            : 'text-green-600'
                        }`}
                      >
                        {formatPct(row.driftPct)}
                      </td>
                      {hasConviction && (
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <TierDot tier={row.convictionTier} />
                            <ScorePill score={row.convictionScore} />
                            <ConvictionBadge action={row.convictionAction} />
                          </div>
                          {row.convictionReason && (
                            <div className="text-[10px] text-muted-foreground text-right mt-0.5 max-w-[160px] ml-auto leading-tight">
                              {row.convictionReason}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasConviction && (
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> T1</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> T2</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> T3</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" /> T4</span>
              <span>· Score 0–100 · Action from Conviction Engine</span>
            </div>
          )}
          {!hasConviction && (
            <p className="text-xs text-muted-foreground">
              Red drift = overweight (consider selling or under-buying). Green = underweight.
            </p>
          )}
        </div>
      )}

      {/* ── INFLOW MODE ────────────────────────────────────────────────── */}
      {mode === 'inflow' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium whitespace-nowrap">New cash to deploy ({currency})</label>
            <input
              type="number"
              min={0}
              step={10}
              className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g. 500"
              value={inflowInput}
              onChange={(e) => setInflowInput(e.target.value)}
            />
          </div>

          {inflow > 0 && result.inflowOrders.length > 0 ? (
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Asset</th>
                    <th className="text-right px-4 py-2 font-medium">Invest</th>
                    <th className="text-right px-4 py-2 font-medium">% of inflow</th>
                  </tr>
                </thead>
                <tbody>
                  {result.inflowOrders.map((o) => {
                    const ce = conviction[o.symbol.toUpperCase()];
                    return (
                      <tr key={o.symbol} className="border-t">
                        <td className="px-4 py-2">
                          <div className="font-medium">{o.label}</div>
                          <div className="text-xs text-muted-foreground">{o.symbol}</div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-green-600">
                          {formatCurrency(o.amount, currency)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="tabular-nums text-muted-foreground">
                            {((o.amount / inflow) * 100).toFixed(1)}%
                          </div>
                          {ce && (
                            <div className="flex items-center justify-end gap-1 mt-0.5">
                              <TierDot tier={ce.tier} />
                              <ScorePill score={ce.s_total} />
                              <ConvictionBadge action={ce.action} />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : inflow > 0 ? (
            <p className="text-sm text-muted-foreground">Portfolio is already perfectly balanced — no reallocation needed.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Enter the amount you want to invest to see where to put it.</p>
          )}
        </div>
      )}

      {/* ── FULL REBALANCE ─────────────────────────────────────────────── */}
      {mode === 'full' && (
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            Full rebalance requires selling. Review carefully before placing orders.
          </div>

          {ceConfirmedSells > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              Conviction Engine confirms {ceConfirmedSells} of the sell order{ceConfirmedSells > 1 ? 's' : ''} — flagged as TRIM, Tier 3+, or high-risk.
            </div>
          )}

          {result.fullRebalanceOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Portfolio is already within target. No trades needed.</p>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Asset</th>
                    <th className="text-left px-4 py-2 font-medium">Action</th>
                    <th className="text-right px-4 py-2 font-medium">Amount</th>
                    {hasConviction && (
                      <th className="text-right px-4 py-2 font-medium">Conviction</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.fullRebalanceOrders.map((o) => (
                    <tr
                      key={o.symbol}
                      className={`border-t ${
                        o.action === 'SELL' && o.convictionConfirmsSell
                          ? 'bg-red-50/60'
                          : ''
                      }`}
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium">{o.label}</div>
                        <div className="text-xs text-muted-foreground">{o.symbol}</div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${
                              o.action === 'BUY'
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {o.action}
                          </span>
                          {o.action === 'SELL' && o.convictionConfirmsSell && (
                            <span
                              title="Conviction Engine also recommends reducing this position"
                              className="text-[10px] font-bold text-red-600"
                            >
                              CE ✓
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {formatCurrency(o.amount, currency)}
                      </td>
                      {hasConviction && (
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <TierDot tier={o.convictionTier} />
                            <ScorePill score={o.convictionScore} />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
