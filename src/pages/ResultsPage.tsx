import { useState, useEffect, useCallback, useRef } from 'react';
import type { AddonContext, Holding } from '@wealthfolio/addon-sdk';
import type { TargetAllocation } from '../types';
import type {
  CeAlert,
  CeAlertsResponse,
  CeBacktestResponse,
  CeRiskResponse,
  CeSizingResponse,
} from '../types';
import type { ConvictionMap, RulesReport, SparklineMap } from '../utils/conviction';
import { computeRebalance, formatCurrency, formatPct } from '../utils/rebalance';
import {
  fetchAlerts,
  fetchBacktest,
  fetchConvictionScores,
  fetchRisk,
  fetchRulesCheck,
  fetchSizing,
  fetchSparklines,
} from '../utils/conviction';

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
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${colors[tier] ?? 'bg-gray-300'}`}
    />
  );
}

function ScorePill({ score }: { score: number | undefined }) {
  if (score == null) return null;
  const color = score >= 70 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-500';
  return <span className={`text-xs font-mono font-semibold ${color}`}>{score.toFixed(0)}</span>;
}

/** Three mini horizontal bars: F (green), S_ent (amber), L (purple) */
function SubScoreBars({
  f, s, l,
}: {
  f: number | undefined;
  s: number | undefined;
  l: number | undefined;
}) {
  if (f == null && s == null && l == null) return null;
  const bars = [
    { label: 'F', value: f ?? 0, color: '#3fb950' },
    { label: 'S', value: s ?? 0, color: '#d29922' },
    { label: 'L', value: l ?? 0, color: '#a371f7' },
  ];
  return (
    <div className="flex flex-col gap-0.5 mt-1 w-28">
      {bars.map(({ label, value, color }) => (
        <div key={label} className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground w-3 flex-shrink-0">{label}</span>
          <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, value)}%`, background: color }}
            />
          </div>
          <span className="text-[9px] text-muted-foreground w-5 text-right tabular-nums">
            {value.toFixed(0)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Play type chip */
function PlayTypeChip({ playType }: { playType: string | undefined }) {
  if (!playType || playType === 'Neutral') return null;
  const styles: Record<string, string> = {
    'High Conviction':    'bg-green-50 text-green-700 border-green-200',
    'Medium Opportunity': 'bg-amber-50 text-amber-700 border-amber-200',
    'Speculative Idea':   'bg-red-50 text-red-600 border-red-200',
  };
  const cls = styles[playType] ?? 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center rounded border px-1 py-px text-[9px] font-semibold leading-tight ${cls}`}>
      {playType}
    </span>
  );
}

/** RSI indicator — colour-coded value */
function RsiIndicator({ rsi }: { rsi: number | null | undefined }) {
  if (rsi == null) return null;
  const color = rsi > 70 ? 'text-red-500' : rsi < 30 ? 'text-green-600' : 'text-muted-foreground';
  const label = rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : '';
  return (
    <span
      className={`text-[9px] font-mono ${color}`}
      title={`RSI 14d: ${rsi.toFixed(1)}${label ? ` — ${label}` : ''}`}
    >
      RSI {rsi.toFixed(0)}
    </span>
  );
}

/** Inline SVG sparkline for score history */
function Sparkline({ values }: { values: number[] | undefined }) {
  if (!values || values.length < 2) return null;
  const w = 60, h = 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  });
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last >= first ? '#3fb950' : '#f85149';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <title>{`Score trend: ${first.toFixed(1)} → ${last.toFixed(1)}`}</title>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Behavioral Safeguards expandable row ──────────────────────────────────

function SafeguardRow({
  ticker,
  ceUrl,
}: {
  ticker: string;
  ceUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<RulesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  const load = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    const r = await fetchRulesCheck(ceUrl, ticker);
    setReport(r);
    setLoading(false);
  }, [ceUrl, ticker]);

  const toggle = () => {
    if (!open) load();
    setOpen((v) => !v);
  };

  if (!ceUrl) return null;

  return (
    <div className="border-t">
      <button
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-left"
        onClick={toggle}
      >
        {report != null && (
          <span className={report.all_passed ? 'text-green-600' : 'text-red-500'}>
            {report.all_passed ? '✓' : '✗'}
          </span>
        )}
        <span>{open ? '▾' : '▸'} Behavioral Safeguards</span>
        {report != null && !report.all_passed && (
          <span className="ml-1 inline-flex items-center rounded-full bg-red-100 px-1.5 py-px text-[9px] font-bold text-red-700">
            {report.rules.filter((r) => !r.passed).length} fail
          </span>
        )}
        {loading && <span className="ml-1 opacity-60">…</span>}
      </button>

      {open && report && (
        <div className="px-4 pb-3 space-y-1">
          {report.rules.map((rule) => (
            <div
              key={rule.rule_id}
              className={`flex items-start gap-2 text-xs rounded px-2 py-1 ${
                rule.passed ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
              }`}
            >
              <span className="font-bold flex-shrink-0 mt-px">{rule.passed ? '✓' : '✗'}</span>
              <div className="min-w-0">
                <span className="font-medium">{rule.label}</span>
                <span className="ml-1.5 text-[10px] opacity-70">{rule.threshold}</span>
                <div className="text-[10px] opacity-80 mt-px">{rule.verdict}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && !loading && !report && (
        <p className="px-4 pb-2 text-xs text-muted-foreground">Not in CE universe.</p>
      )}
    </div>
  );
}

// ── "What to do today" action card ────────────────────────────────────────

function ActionCard({
  conviction,
  heldSymbols,
}: {
  conviction: ConvictionMap;
  heldSymbols: Set<string>;
}) {
  // Prioritise: held positions that are oversold (RSI < 35) AND analyst gap > 15%
  // Fallback to top BUY items in execution list
  const picks: Array<{ ticker: string; score: number; action: string; reason: string; rsi: number | null; entryZone: boolean }> = [];

  for (const [ticker, ce] of Object.entries(conviction)) {
    if (ce.action !== 'BUY') continue;
    const isHeld = heldSymbols.has(ticker);
    const oversold = ce.rsi != null && ce.rsi < 35;
    const highScore = ce.s_total >= 65;
    const entryZone = isHeld && oversold && highScore;
    if (entryZone || (ce.tier <= 2 && ce.s_total >= 70)) {
      picks.push({ ticker, score: ce.s_total, action: ce.action, reason: ce.reason, rsi: ce.rsi, entryZone });
    }
  }

  // Sort: entry-zone first, then by score desc
  picks.sort((a, b) => {
    if (a.entryZone !== b.entryZone) return a.entryZone ? -1 : 1;
    return b.score - a.score;
  });

  const top = picks.slice(0, 2);
  if (top.length === 0) return null;

  return (
    <div className="rounded-lg border border-green-300 bg-green-50 p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-green-700 uppercase tracking-wide">What to do today</span>
      </div>
      {top.map((p) => (
        <div key={p.ticker} className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold bg-green-200 text-green-800">
            BUY
          </span>
          <div className="min-w-0">
            <span className="font-semibold text-sm text-green-900">{p.ticker}</span>
            {p.entryZone && (
              <span className="ml-1.5 text-[10px] font-semibold text-green-700">
                Entry zone {p.rsi != null ? `· RSI ${p.rsi.toFixed(0)}` : ''}
              </span>
            )}
            <p className="text-xs text-green-800 mt-0.5 leading-tight">{p.reason}</p>
          </div>
          <ScorePill score={p.score} />
        </div>
      ))}
    </div>
  );
}

// ── Alerts banner ─────────────────────────────────────────────────────────

const ALERT_LABELS: Record<string, string> = {
  MOAT_BREACH:           'Moat Breach',
  RANKING_DRIFT:         'Ranking Drift',
  SENTIMENT_DECOUPLING:  'Sentiment Decoupling',
};

function AlertsBanner({
  alerts,
  heldSymbols,
}: {
  alerts: CeAlert[];
  heldSymbols: Set<string>;
}) {
  const relevant = alerts.filter((a) => heldSymbols.has(a.ticker.toUpperCase()));
  if (relevant.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1.5">
      <p className="text-xs font-bold text-amber-700 uppercase tracking-wide">
        CE Alerts — {relevant.length} held position{relevant.length > 1 ? 's' : ''}
      </p>
      {relevant.map((a) => (
        <div key={a.id} className="flex items-start gap-2 text-xs text-amber-900">
          <span className="mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-200 text-amber-800 whitespace-nowrap">
            {ALERT_LABELS[a.alert_type] ?? a.alert_type}
          </span>
          <span className="font-semibold">{a.ticker}</span>
          <span className="text-amber-700 truncate">
            {a.alert_type === 'RANKING_DRIFT' && typeof a.details.drift === 'number'
              ? `Rank drifted ${(a.details.direction as string) ?? ''} by ${Math.abs(a.details.drift as number)} positions`
              : a.alert_type === 'MOAT_BREACH' && typeof a.details.drop_pct_pts === 'number'
              ? `Margin down ${Math.abs(a.details.drop_pct_pts as number).toFixed(1)} ppt YoY`
              : a.alert_type === 'SENTIMENT_DECOUPLING' && typeof a.details.price_change_pct === 'number'
              ? `Price ${(a.details.price_change_pct as number) >= 0 ? '+' : ''}${(a.details.price_change_pct as number).toFixed(1)}% vs sentiment`
              : 'Active alert'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Entry timing signal helpers ───────────────────────────────────────────

function EntrySignal({ rsi, score }: { rsi: number | null | undefined; score: number | undefined }) {
  if (rsi == null || score == null) return null;
  if (rsi < 35 && score >= 65) {
    return (
      <span
        title="Entry zone: oversold RSI + strong conviction"
        className="text-[9px] font-bold text-green-700 bg-green-100 rounded px-1 py-px"
      >
        ENTRY ZONE
      </span>
    );
  }
  if (rsi > 65) {
    return (
      <span
        title="Wait zone: overbought RSI"
        className="text-[9px] font-bold text-amber-700 bg-amber-100 rounded px-1 py-px"
      >
        WAIT
      </span>
    );
  }
  return null;
}

// ── Conviction-weighted suggestion (display helper) ───────────────────────

function computeConvictionSuggestions(
  slots: TargetAllocation['slots'],
  conviction: ConvictionMap,
): Map<string, number> | null {
  const entries = slots
    .map((s) => ({ symbol: s.symbol, ce: conviction[s.symbol.toUpperCase()] }))
    .filter((e) => e.ce != null);

  if (entries.length < 2) return null;

  const totalScore = entries.reduce((sum, e) => sum + Math.max(10, e.ce!.s_total), 0);
  const result = new Map<string, number>();
  for (const e of entries) {
    result.set(e.symbol, (Math.max(10, e.ce!.s_total) / totalScore) * 100);
  }
  return result;
}

// ── Position sizing panel ─────────────────────────────────────────────────

function SizingPanel({ sizing }: { sizing: CeSizingResponse }) {
  const sorted = [...sizing.holdings].sort((a, b) => b.recommended_pct - a.recommended_pct);
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Position Sizing — Kelly Recommendations</h3>
      <p className="text-xs text-muted-foreground">
        Kelly-inspired recommendations from CE. Based on s_total as edge proxy and 60-day annualised volatility.
      </p>
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Ticker</th>
              <th className="text-right px-4 py-2 font-medium">Score</th>
              <th className="text-right px-4 py-2 font-medium">Rec %</th>
              <th className="text-right px-4 py-2 font-medium">Vol</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((h) => (
              <tr key={h.ticker} className="border-t">
                <td className="px-4 py-2 font-medium">{h.ticker}</td>
                <td className="px-4 py-2 text-right">
                  <ScorePill score={h.s_total ?? undefined} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-primary">
                  {h.recommended_pct.toFixed(1)}%
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground text-xs">
                  {(h.volatility_annual * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Risk tab ──────────────────────────────────────────────────────────────

function RiskTab({ risk }: { risk: CeRiskResponse }) {
  return (
    <div className="space-y-6">
      {risk.drawdown_flags.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-red-700">Drawdown Flags</h3>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Ticker</th>
                  <th className="text-right px-4 py-2 font-medium">Current DD</th>
                  <th className="text-right px-4 py-2 font-medium">Hist. Mean DD</th>
                  <th className="text-right px-4 py-2 font-medium">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {risk.drawdown_flags.map((f) => (
                  <tr key={f.ticker} className="border-t">
                    <td className="px-4 py-2 font-medium">{f.ticker}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-600">
                      {(f.current_drawdown * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {(f.historical_mean_drawdown * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {f.ratio.toFixed(2)}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {risk.replacements.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-amber-700">Correlation Warnings</h3>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Remove</th>
                  <th className="text-left px-4 py-2 font-medium">Add</th>
                  <th className="text-right px-4 py-2 font-medium">Corr with</th>
                  <th className="text-right px-4 py-2 font-medium">r</th>
                </tr>
              </thead>
              <tbody>
                {risk.replacements.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-4 py-2 font-medium text-red-600">{r.removed_ticker}</td>
                    <td className="px-4 py-2 font-medium text-green-600">{r.added_ticker}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.correlation_with}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {r.correlation_value.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {risk.final_tier1.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Final Tier 1 Universe</h3>
          <div className="flex flex-wrap gap-1.5">
            {risk.final_tier1.map((t) => (
              <span key={t} className="inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {risk.drawdown_flags.length === 0 && risk.replacements.length === 0 && (
        <p className="text-sm text-muted-foreground">No risk flags at this time.</p>
      )}
    </div>
  );
}

// ── Backtest panel ────────────────────────────────────────────────────────

function pct(v: number | null | undefined, decimals = 1) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(decimals)}%`;
}

function BacktestPanel({ backtest }: { backtest: CeBacktestResponse }) {
  const { model, benchmark } = backtest;
  const metrics = [
    { label: 'Total Return',  model: pct(model.total_return, 1),  bench: pct(benchmark.total_return, 1) },
    { label: 'Sharpe',        model: model.sharpe_ratio?.toFixed(2) ?? '—',    bench: benchmark.sharpe_ratio?.toFixed(2) ?? '—' },
    { label: 'Sortino',       model: model.sortino_ratio?.toFixed(2) ?? '—',   bench: benchmark.sortino_ratio?.toFixed(2) ?? '—' },
    { label: 'Max Drawdown',  model: pct(model.max_drawdown, 1),  bench: pct(benchmark.max_drawdown, 1) },
    { label: 'Hit Rate',      model: model.hit_rate != null ? `${(model.hit_rate * 100).toFixed(1)}%` : '—', bench: '—' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Backtest Results</h3>
        <span className="text-xs text-muted-foreground">
          {backtest.period_start} – {backtest.period_end}
        </span>
      </div>

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Metric</th>
              <th className="text-right px-4 py-2 font-medium">Model</th>
              <th className="text-right px-4 py-2 font-medium">S&P 500</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label} className="border-t">
                <td className="px-4 py-2 text-muted-foreground">{m.label}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums">{m.model}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{m.bench}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {backtest.monthly_returns.length > 1 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Monthly return trend (model vs benchmark)</p>
          <MiniBarChart
            data={backtest.monthly_returns.slice(-24).map((r) => ({
              label: r.date.slice(0, 7),
              model: r.model_return,
              bench: r.benchmark_return,
            }))}
          />
        </div>
      )}
    </div>
  );
}

function MiniBarChart({
  data,
}: {
  data: Array<{ label: string; model: number; bench: number }>;
}) {
  if (data.length === 0) return null;
  const maxAbs = Math.max(...data.map((d) => Math.max(Math.abs(d.model), Math.abs(d.bench))), 0.01);
  const W = 400;
  const H = 80;
  const barW = Math.max(3, Math.floor(W / data.length / 2) - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 80 }}>
      {data.map((d, i) => {
        const x = (i / data.length) * W;
        const cx = x + barW / 2;
        const midY = H / 2;

        const mH = Math.abs(d.model / maxAbs) * (H / 2 - 2);
        const bH = Math.abs(d.bench / maxAbs) * (H / 2 - 2);

        return (
          <g key={d.label}>
            {/* Model */}
            <rect
              x={cx - barW}
              y={d.model >= 0 ? midY - mH : midY}
              width={barW - 1}
              height={mH}
              fill={d.model >= 0 ? '#3fb950' : '#f85149'}
              opacity={0.85}
            />
            {/* Benchmark */}
            <rect
              x={cx}
              y={d.bench >= 0 ? midY - bH : midY}
              width={barW - 1}
              height={bH}
              fill={d.bench >= 0 ? '#58a6ff' : '#d29922'}
              opacity={0.6}
            />
          </g>
        );
      })}
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="currentColor" strokeOpacity={0.2} />
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function ResultsPage({ ctx, accountId, currency, onEditConfig }: Props) {
  const [mode, setMode] = useState<'drift' | 'inflow' | 'full' | 'risk' | 'backtest'>('drift');
  const [inflowInput, setInflowInput] = useState('');

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingsLoading, setHoldingsLoading] = useState(true);

  const [config, setConfig] = useState<TargetAllocation | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  const [conviction, setConviction] = useState<ConvictionMap>({});
  const [ceLoading, setCeLoading] = useState(false);
  const [ceError, setCeError] = useState<string | null>(null);
  const [ceUrl, setCeUrl] = useState('');

  const [sparklines, setSparklines] = useState<SparklineMap>({});

  const [alerts, setAlerts] = useState<CeAlertsResponse | null>(null);
  const [sizing, setSizing] = useState<CeSizingResponse | null>(null);
  const [risk, setRisk] = useState<CeRiskResponse | null>(null);
  const [backtest, setBacktest] = useState<CeBacktestResponse | null>(null);

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
      .then(async (url) => {
        const resolvedUrl = url ?? '';
        setCeUrl(resolvedUrl);
        const map = await fetchConvictionScores(resolvedUrl);
        setConviction(map);
        if (Object.keys(map).length === 0) setCeError(null);
        return { map, resolvedUrl };
      })
      .then(async ({ map, resolvedUrl }) => {
        const tickers = Object.keys(map);
        // Parallel: sparklines + alerts + sizing + risk + backtest
        const [sparks, alertsData, sizingData, riskData, backtestData] = await Promise.all([
          tickers.length > 0 && resolvedUrl ? fetchSparklines(resolvedUrl, tickers) : Promise.resolve({} as SparklineMap),
          resolvedUrl ? fetchAlerts(resolvedUrl) : Promise.resolve(null),
          resolvedUrl ? fetchSizing(resolvedUrl) : Promise.resolve(null),
          resolvedUrl ? fetchRisk(resolvedUrl) : Promise.resolve(null),
          resolvedUrl ? fetchBacktest(resolvedUrl) : Promise.resolve(null),
        ]);
        setSparklines(sparks);
        setAlerts(alertsData);
        setSizing(sizingData);
        setRisk(riskData);
        setBacktest(backtestData);
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

  const ceConfirmedSells = result.fullRebalanceOrders.filter(
    (o) => o.action === 'SELL' && o.convictionConfirmsSell,
  ).length;

  // Held symbols (uppercase) for alert filtering
  const heldSymbols = new Set(config.slots.map((s) => s.symbol.toUpperCase()));

  return (
    <div className="space-y-6">
      {/* Mode tabs */}
      <div className="flex gap-1 border-b flex-wrap">
        {(['drift', 'inflow', 'full', 'risk', 'backtest'] as const).map((m) => (
          <button
            key={m}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              mode === m
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setMode(m)}
          >
            {m === 'drift'    ? 'Drift Analysis'  :
             m === 'inflow'   ? 'Inflow Mode'     :
             m === 'full'     ? 'Full Rebalance'  :
             m === 'risk'     ? 'Risk'            :
                                'Backtest'}
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
        <p className="text-xs text-muted-foreground">Fetching conviction data…</p>
      )}
      {ceError && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">
          {ceError} — showing drift only.
        </p>
      )}

      {/* "What to do today" — always visible when CE data available */}
      {hasConviction && !ceLoading && (
        <ActionCard conviction={conviction} heldSymbols={heldSymbols} />
      )}

      {/* Alerts banner — always visible when CE data available */}
      {alerts && alerts.items.length > 0 && (
        <AlertsBanner alerts={alerts.items} heldSymbols={heldSymbols} />
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
                {showConvictionSuggestions ? 'Hide' : 'Show'} conviction-weighted targets
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
                      <span title="Tier · Score · F/S/L bars · Play type · RSI · Action">Conviction</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {result.driftRows.map((row) => {
                  const suggestion = convictionSuggestions?.get(row.symbol);
                  const sparks = sparklines[row.symbol.toUpperCase()];
                  return (
                    <tr key={row.symbol} className="border-t">
                      <td className="px-4 py-2">
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.symbol}</div>
                        {row.convictionHighRisk && (
                          <span className="text-[10px] text-red-500 font-semibold">HIGH RISK</span>
                        )}
                        {/* Entry timing signal */}
                        <div className="mt-0.5">
                          <EntrySignal rsi={row.convictionRsi} score={row.convictionScore} />
                        </div>
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
                        <td className="px-4 py-2 text-right align-top">
                          {row.convictionTier != null ? (
                            <div className="flex flex-col items-end gap-1">
                              {/* Row 1: tier · score · badge */}
                              <div className="flex items-center gap-1.5">
                                <TierDot tier={row.convictionTier} />
                                <ScorePill score={row.convictionScore} />
                                <ConvictionBadge action={row.convictionAction} />
                              </div>
                              {/* Row 2: play type chip */}
                              <PlayTypeChip playType={row.convictionPlayType} />
                              {/* Row 3: F/S/L bars */}
                              <SubScoreBars
                                f={row.convictionFScore}
                                s={row.convictionSentScore}
                                l={row.convictionLScore}
                              />
                              {/* Row 4: RSI + sparkline */}
                              <div className="flex items-center gap-2 mt-0.5">
                                <RsiIndicator rsi={row.convictionRsi} />
                                <Sparkline values={sparks} />
                              </div>
                              {/* Row 5: reason text */}
                              {row.convictionReason && (
                                <div className="text-[10px] text-muted-foreground text-right max-w-[180px] leading-tight">
                                  {row.convictionReason}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Behavioral safeguards — one collapsible per row */}
            {hasConviction && result.driftRows.map((row) => (
              conviction[row.symbol.toUpperCase()] ? (
                <SafeguardRow key={row.symbol} ticker={row.symbol.toUpperCase()} ceUrl={ceUrl} />
              ) : null
            ))}
          </div>

          {/* Position sizing inline — show if sizing data available */}
          {sizing && sizing.holdings.length > 0 && (
            <SizingPanel sizing={sizing} />
          )}

          {hasConviction && (
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> T1</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> T2</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> T3</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" /> T4</span>
              <span>·</span>
              <span className="flex items-center gap-1"><span style={{ color: '#3fb950' }}>■</span> F=Fundamentals</span>
              <span className="flex items-center gap-1"><span style={{ color: '#d29922' }}>■</span> S=Sentiment</span>
              <span className="flex items-center gap-1"><span style={{ color: '#a371f7' }}>■</span> L=Long-term</span>
              <span>· Score 0–100 · Action &amp; sparkline from Conviction Engine</span>
            </div>
          )}
          {!hasConviction && (
            <p className="text-xs text-muted-foreground">
              Red drift = overweight (consider selling or under-buying). Green = underweight.
            </p>
          )}

          {/* Pre-trade checklist launchers */}
          {hasConviction && ceUrl && (
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="text-xs text-muted-foreground self-center">Pre-trade checklist:</span>
              {result.driftRows.map((row) => {
                const ce = conviction[row.symbol.toUpperCase()];
                if (!ce) return null;
                const ceAppUrl = ceUrl.replace(':8000', ':5174');
                return (
                  <a
                    key={row.symbol}
                    href={`${ceAppUrl}/checklist?ticker=${row.symbol.toUpperCase()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary transition-colors"
                    title={`Open pre-trade checklist for ${row.symbol} in Conviction Engine`}
                  >
                    ✓ {row.symbol}
                  </a>
                );
              })}
            </div>
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

          {hasConviction && (
            <p className="text-xs text-muted-foreground">
              Inflow is allocated using conviction-weighted targets (s_total · min floor 10) where CE data is available.
            </p>
          )}

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
                    const sparks = sparklines[o.symbol.toUpperCase()];
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
                            <div className="flex flex-col items-end gap-1 mt-0.5">
                              <div className="flex items-center gap-1">
                                <TierDot tier={ce.tier} />
                                <ScorePill score={ce.s_total} />
                                <ConvictionBadge action={ce.action} />
                              </div>
                              <PlayTypeChip playType={ce.play_type} />
                              <SubScoreBars f={ce.f_score} s={ce.s_ent_score} l={ce.l_score} />
                              <div className="flex items-center gap-2">
                                <RsiIndicator rsi={ce.rsi} />
                                <Sparkline values={sparks} />
                              </div>
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
            {hasConviction && (
              <span className="block mt-1 text-xs text-amber-700">
                Target amounts adjusted by conviction weighting (s_total) where CE data is available.
              </span>
            )}
          </div>

          {ceConfirmedSells > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              Conviction Engine confirms {ceConfirmedSells} of the sell order{ceConfirmedSells > 1 ? 's' : ''} — flagged as TRIM or high-risk.
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
                  {result.fullRebalanceOrders.map((o) => {
                    const sparks = sparklines[o.symbol.toUpperCase()];
                    return (
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
                          <td className="px-4 py-2 text-right align-top">
                            <div className="flex flex-col items-end gap-1">
                              <div className="flex items-center gap-1.5">
                                <TierDot tier={o.convictionTier} />
                                <ScorePill score={o.convictionScore} />
                              </div>
                              <Sparkline values={sparks} />
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── RISK TAB ───────────────────────────────────────────────────── */}
      {mode === 'risk' && (
        risk
          ? <RiskTab risk={risk} />
          : <p className="text-sm text-muted-foreground">
              {ceLoading ? 'Loading risk data…' : ceUrl ? 'Risk data unavailable.' : 'Configure CE URL to see risk data.'}
            </p>
      )}

      {/* ── BACKTEST TAB ───────────────────────────────────────────────── */}
      {mode === 'backtest' && (
        backtest
          ? <BacktestPanel backtest={backtest} />
          : <p className="text-sm text-muted-foreground">
              {ceLoading ? 'Loading backtest data…' : ceUrl ? 'No backtest data available yet — run a backtest from the CE backend.' : 'Configure CE URL to see backtest results.'}
            </p>
      )}
    </div>
  );
}
