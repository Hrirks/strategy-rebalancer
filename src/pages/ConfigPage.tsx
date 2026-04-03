import { useState, useEffect, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { TargetAllocation, TargetSlot } from '../types';
import { validateSlots } from '../utils/rebalance';

const STORAGE_KEY = 'target-allocations';
const CE_URL_KEY = 'conviction-engine-url';

interface Props {
  ctx: AddonContext;
  accountId: string;
  onSaved: () => void;
}

function newSlot(): TargetSlot {
  return { symbol: '', label: '', targetPct: 0 };
}

/** Derive proportional targets from holdings, rounded to 1 decimal summing to 100 */
function deriveTargets(holdings: { symbol: string; name: string; value: number }[]): TargetSlot[] {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  if (total === 0) return holdings.map((h) => ({ symbol: h.symbol, label: h.name, targetPct: 0 }));
  const raw = holdings.map((h) => ({
    symbol: h.symbol,
    label: h.name,
    targetPct: Math.round((h.value / total) * 1000) / 10,
  }));
  const sum = raw.reduce((s, r) => s + r.targetPct, 0);
  const diff = Math.round((100 - sum) * 10) / 10;
  if (diff !== 0 && raw.length > 0) raw[0].targetPct = Math.round((raw[0].targetPct + diff) * 10) / 10;
  return raw;
}

export function ConfigPage({ ctx, accountId, onSaved }: Props) {
  const [slots, setSlots] = useState<TargetSlot[]>([newSlot()]);
  const [ceUrl, setCeUrl] = useState('');
  const [ceStatus, setCeStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probe CE URL and update status indicator
  const probeCe = useCallback(async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) { setCeStatus('idle'); return; }
    setCeStatus('checking');
    try {
      const res = await fetch(`${trimmed.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
      setCeStatus(res.ok ? 'ok' : 'error');
    } catch {
      setCeStatus('error');
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      ctx.api.secrets.get(STORAGE_KEY),
      ctx.api.secrets.get(CE_URL_KEY),
    ])
      .then(async ([raw, url]) => {
        if (url) {
          setCeUrl(url);
          probeCe(url);
        }

        if (raw) {
          const all: TargetAllocation[] = JSON.parse(raw);
          const saved = all.find((a) => a.accountId === accountId);
          if (saved) {
            setSlots(saved.slots);
            return; // saved config exists — don't auto-populate
          }
        }

        // No saved config for this account — pre-fill proportionally from holdings
        try {
          const holdings = await ctx.api.portfolio.getHoldings(accountId);
          const relevant = holdings
            .filter((h) => h.instrument?.symbol && (h.marketValue?.base ?? 0) > 0)
            .map((h) => ({
              symbol: h.instrument!.symbol,
              name: h.instrument!.name ?? h.instrument!.symbol,
              value: h.marketValue?.base ?? 0,
            }));
          if (relevant.length > 0) setSlots(deriveTargets(relevant));
        } catch {
          // silently fall back to a single empty slot
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [accountId]);

  const sum = slots.reduce((s, sl) => s + (Number(sl.targetPct) || 0), 0);

  async function handleSave() {
    const err = validateSlots(slots);
    if (err) { setError(err); return; }
    setIsSaving(true);
    setError(null);
    try {
      const raw = await ctx.api.secrets.get(STORAGE_KEY);
      const all: TargetAllocation[] = raw ? JSON.parse(raw) : [];
      const idx = all.findIndex((a) => a.accountId === accountId);
      const entry: TargetAllocation = { accountId, slots };
      if (idx >= 0) all[idx] = entry;
      else all.push(entry);
      await Promise.all([
        ctx.api.secrets.set(STORAGE_KEY, JSON.stringify(all)),
        ctx.api.secrets.set(CE_URL_KEY, ceUrl.trim()),
      ]);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }

  function updateSlot(i: number, field: keyof TargetSlot, value: string | number) {
    setSlots((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  }

  function removeSlot(i: number) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i));
  }

  if (isLoading) return <p className="p-6 text-muted-foreground">Loading saved config…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Target Allocation</h2>
        <p className="text-sm text-muted-foreground">
          Define your ideal portfolio weights. Percentages must sum to 100%.
          Rows are pre-filled from your current holdings — adjust the target % for each.
        </p>
      </div>

      <div className="space-y-2">
        {/* Header */}
        <div className="grid grid-cols-[1fr_1fr_100px_36px] gap-2 text-xs text-muted-foreground px-1">
          <span>Symbol / ISIN</span>
          <span>Label</span>
          <span>Target %</span>
          <span />
        </div>

        {slots.map((slot, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_100px_36px] gap-2 items-center">
            <input
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g. IE00B4L5Y983"
              value={slot.symbol}
              onChange={(e) => updateSlot(i, 'symbol', e.target.value.trim())}
            />
            <input
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g. MSCI World"
              value={slot.label}
              onChange={(e) => updateSlot(i, 'label', e.target.value)}
            />
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={slot.targetPct}
              onChange={(e) => updateSlot(i, 'targetPct', parseFloat(e.target.value) || 0)}
            />
            <button
              className="h-9 w-9 flex items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => removeSlot(i)}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Sum indicator */}
      <div className={`text-sm font-medium ${Math.abs(sum - 100) < 0.01 ? 'text-green-600' : 'text-amber-600'}`}>
        Total: {sum.toFixed(2)}% {Math.abs(sum - 100) < 0.01 ? '✓' : `(${(100 - sum).toFixed(2)}% remaining)`}
      </div>

      {/* Conviction Engine URL */}
      <div className="space-y-2 pt-2 border-t">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Conviction Engine (optional)</h3>
          {ceStatus === 'checking' && (
            <span className="text-xs text-muted-foreground">checking…</span>
          )}
          {ceStatus === 'ok' && (
            <span className="text-xs text-green-600 font-medium">● connected</span>
          )}
          {ceStatus === 'error' && (
            <span className="text-xs text-red-500 font-medium">● unreachable</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Enter the base URL of your self-hosted Conviction Engine backend to overlay conviction
          scores on your rebalance analysis. Leave blank to disable.
        </p>
        <input
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="e.g. https://ce.example.com or http://localhost:8000"
          value={ceUrl}
          onChange={(e) => setCeUrl(e.target.value)}
          onBlur={(e) => probeCe(e.target.value)}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
      )}

      <div className="flex gap-2">
        <button
          className="h-9 px-4 rounded-md border border-input text-sm hover:bg-accent"
          onClick={() => setSlots((prev) => [...prev, newSlot()])}
        >
          + Add Row
        </button>
        <button
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-50"
          disabled={isSaving}
          onClick={handleSave}
        >
          {isSaving ? 'Saving…' : 'Save & Analyse'}
        </button>
      </div>
    </div>
  );
}
