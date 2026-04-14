import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Spinner, Title } from '@telegram-apps/telegram-ui';

import { fetchPlans } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { impact } from '../lib/telegram';
import { Plan } from '../types/plan';

export function Home() {
  const { initData } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    await fetchPlans(initData)
      .then((next) => {
        setPlans(next);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [initData]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const onPullToRefresh = useCallback(async () => {
    await loadPlans();
  }, [loadPlans]);

  const { refreshing } = usePullToRefresh(onPullToRefresh);

  return (
    <main className="page">
      <header className="page-header">
        <Title level="1">Plans</Title>
        <Button
          mode="bezeled"
          size="s"
          loading={loading}
          onClick={() => {
            impact('light');
            void loadPlans();
          }}
        >
          Refresh
        </Button>
      </header>

      {refreshing ? <p className="refresh-indicator">Refreshing...</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {loading ? (
        <div className="loading-block">
          <Spinner size="m" />
        </div>
      ) : null}

      {!loading && plans.length === 0 ? (
        <Placeholder
          header="No plans yet"
          description="Plans will show up here once the agent creates them."
        />
      ) : null}

      {!loading && plans.length > 0 ? (
        <List className="plan-list">
          {plans.map((plan) => (
            <Link
              key={plan.id}
              to={`/plans/${plan.id}`}
              className="link-reset"
              onClick={() => impact('light')}
            >
              <Cell subtitle={`Status: ${plan.status}`}>{plan.title}</Cell>
            </Link>
          ))}
        </List>
      ) : null}
    </main>
  );
}
