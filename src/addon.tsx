import React, { useState, useEffect } from 'react';
import type { AddonContext, Account } from '@wealthfolio/addon-sdk';
import { Icons, Page, PageHeader, PageContent } from '@wealthfolio/ui';
import { ConfigPage } from './pages/ConfigPage';
import { ResultsPage } from './pages/ResultsPage';

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
    ctx.api.accounts.getAll().then((data) => {
      setAccounts(data);
      if (data.length > 0) setSelectedAccountId(data[0].id);
      setIsLoading(false);
    }).catch(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    ctx.api.settings.get().then((s) => {
      const c = (s as { baseCurrency?: string }).baseCurrency;
      if (c) setCurrency(c);
    }).catch(() => {});
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
          <p className="text-muted-foreground text-sm">Loading accounts…</p>
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
