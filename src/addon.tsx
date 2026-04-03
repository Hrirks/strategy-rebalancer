import React, { useState, useEffect } from 'react';
import type { AddonContext, Account } from '@wealthfolio/addon-sdk';
import { Icons, Page, PageHeader, PageContent } from '@wealthfolio/ui';
import { ConfigPage } from './pages/ConfigPage';
import { ResultsPage } from './pages/ResultsPage';
import type { TargetAllocation, TargetSlot } from './types';

const STORAGE_KEY = 'target-allocations';
const CE_URL_KEY = 'conviction-engine-url';
const CE_CANDIDATES = ['http://localhost:8000', 'http://127.0.0.1:8000'];

/** Probe a CE URL — returns true if /health responds OK within 3s */
async function probeUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Derive targets from holdings proportionally, rounded to 1 decimal, summing to 100 */
function deriveTargets(holdings: { symbol: string; name?: string; totalValue: number }[]): TargetSlot[] {
  const total = holdings.reduce((s, h) => s + h.totalValue, 0);
  if (total === 0) return holdings.map((h) => ({ symbol: h.symbol, label: h.name ?? h.symbol, targetPct: 0 }));

  const raw = holdings.map((h) => ({
    symbol: h.symbol,
    label: h.name ?? h.symbol,
    targetPct: Math.round((h.totalValue / total) * 1000) / 10,
  }));

  // Fix rounding drift so sum === 100
  const sum = raw.reduce((s, r) => s + r.targetPct, 0);
  const diff = Math.round((100 - sum) * 10) / 10;
  if (diff !== 0 && raw.length > 0) raw[0].targetPct = Math.round((raw[0].targetPct + diff) * 10) / 10;
  return raw;
}

// ─── Main app component ───────────────────────────────────────────────────────

interface AppProps {
  ctx: AddonContext;
}

function RebalancerApp({ ctx }: AppProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [view, setView] = useState<'results' | 'config'>('results');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currency, setCurrency] = useState('EUR');

  useEffect(() => {
    async function bootstrap() {
      try {
        // Load accounts + settings in parallel
        const [data, settingsRaw] = await Promise.all([
          ctx.api.accounts.getAll(),
          ctx.api.settings.get().catch(() => ({})),
        ]);

        setAccounts(data);
        const c = (settingsRaw as { baseCurrency?: string }).baseCurrency;
        if (c) setCurrency(c);

        if (data.length === 0) { setIsLoading(false); return; }

        const firstAccount = data[0];
        setSelectedAccountId(firstAccount.id);

        // Load saved config + CE URL in parallel
        const [rawConfig, savedCeUrl] = await Promise.all([
          ctx.api.secrets.get(STORAGE_KEY).catch(() => null),
          ctx.api.secrets.get(CE_URL_KEY).catch(() => null),
        ]);

        // Auto-detect CE backend if not already saved
        if (!savedCeUrl) {
          for (const candidate of CE_CANDIDATES) {
            if (await probeUrl(candidate)) {
              await ctx.api.secrets.set(CE_URL_KEY, candidate).catch(() => {});
              ctx.api.logger.info(`Auto-detected CE backend at ${candidate}`);
              break;
            }
          }
        }

        // If no saved allocation for this account, auto-derive from current holdings
        const allConfigs: TargetAllocation[] = rawConfig ? JSON.parse(rawConfig) : [];
        const existing = allConfigs.find((a) => a.accountId === firstAccount.id);

        if (!existing) {
          try {
            const holdings = await ctx.api.portfolio.getHoldings(firstAccount.id);
            const relevant = holdings
              .filter((h) => h.instrument?.symbol && (h.marketValue?.base ?? 0) > 0)
              .map((h) => ({
                symbol: h.instrument!.symbol,
                name: h.instrument!.name ?? h.instrument!.symbol,
                totalValue: h.marketValue?.base ?? 0,
              }));

            if (relevant.length > 0) {
              const slots = deriveTargets(relevant);
              const newEntry: TargetAllocation = { accountId: firstAccount.id, slots };
              allConfigs.push(newEntry);
              await ctx.api.secrets.set(STORAGE_KEY, JSON.stringify(allConfigs)).catch(() => {});
              ctx.api.logger.info(`Auto-bootstrapped allocation for account ${firstAccount.id}`);
            }
          } catch (e) {
            ctx.api.logger.warn('Could not auto-derive targets: ' + (e as Error).message);
          }
        }

        // Always open results view directly — config reachable via "Edit Target →"
        setView('results');
      } catch (e) {
        ctx.api.logger.error('Bootstrap error: ' + (e as Error).message);
      } finally {
        setIsLoading(false);
      }
    }

    bootstrap();
  }, []);

  return (
    <Page>
      <PageHeader>
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold sm:text-xl">Strategy Rebalancer</h1>
          <p className="text-muted-foreground text-sm sm:text-base">
            Keep your portfolio aligned with your target allocation.
          </p>
        </div>
      </PageHeader>
      <PageContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading portfolio…</p>
        ) : accounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No accounts found in Wealthfolio.</p>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium">Account</label>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={selectedAccountId}
                onChange={(e) => {
                  setSelectedAccountId(e.target.value);
                  setView('results');
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>

            {selectedAccountId && (
              <div className="rounded-xl border bg-card p-6">
                {view === 'config' ? (
                  <ConfigPage
                    ctx={ctx}
                    accountId={selectedAccountId}
                    onSaved={() => setView('results')}
                  />
                ) : (
                  <ResultsPage
                    ctx={ctx}
                    accountId={selectedAccountId}
                    currency={currency}
                    onEditConfig={() => setView('config')}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </PageContent>
    </Page>
  );
}

// ─── Addon entry point ────────────────────────────────────────────────────────

export default function enable(ctx: AddonContext) {
  ctx.api.logger.info('Strategy Rebalancer addon is being enabled!');

  const addedItems: Array<{ remove: () => void }> = [];

  try {
    const sidebarItem = ctx.sidebar.addItem({
      id: 'strategy-rebalancer',
      label: 'Rebalancer',
      icon: <Icons.Presentation className="h-5 w-5" />,
      route: '/addon/strategy-rebalancer',
      order: 90,
    });
    addedItems.push(sidebarItem);

    const RebalancerWrapper = () => <RebalancerApp ctx={ctx} />;

    ctx.router.add({
      path: '/addon/strategy-rebalancer',
      component: React.lazy(() =>
        Promise.resolve({
          default: RebalancerWrapper,
        }),
      ),
    });

    ctx.api.logger.info('Strategy Rebalancer addon enabled successfully');
  } catch (error) {
    ctx.api.logger.error('Failed to initialize addon: ' + (error as Error).message);
    throw error;
  }

  ctx.onDisable(() => {
    addedItems.forEach((item) => {
      try {
        item.remove();
      } catch (e) {
        ctx.api.logger.error('Error removing sidebar item: ' + (e as Error).message);
      }
    });
    ctx.api.logger.info('Strategy Rebalancer addon disabled');
  });
}
