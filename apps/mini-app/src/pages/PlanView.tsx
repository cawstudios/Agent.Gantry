import { useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Placeholder, Spinner, Title } from '@telegram-apps/telegram-ui';

import { PlanProgress } from '../components/PlanProgress';
import { PlanSection } from '../components/PlanSection';
import { useAuth } from '../hooks/useAuth';
import { usePlan } from '../hooks/usePlan';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { bindBackButton, impact, notification } from '../lib/telegram';

export function PlanView() {
  const params = useParams<{ planId: string }>();
  const planId = params.planId || '';
  const navigate = useNavigate();
  const { initData } = useAuth();
  const {
    plan,
    loading,
    error,
    approveAll,
    rejectPlan,
    approveSection,
    rejectSection,
    editSection,
    refresh,
  } = usePlan(planId, initData);

  useEffect(() => {
    return bindBackButton(() => {
      if (window.history.length > 1) {
        navigate(-1);
      } else {
        navigate('/');
      }
    });
  }, [navigate]);

  const onPullToRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const { refreshing } = usePullToRefresh(onPullToRefresh, {
    enabled: Boolean(planId),
  });

  if (!planId) {
    return (
      <main className="page">
        <Placeholder header="Missing plan id" description="Open a valid plan link from Telegram." />
      </main>
    );
  }

  if (loading) {
    return (
      <main className="page">
        <div className="loading-block">
          <Spinner size="m" />
        </div>
      </main>
    );
  }

  if (error || !plan) {
    return (
      <main className="page">
        <Placeholder
          header="Unable to load plan"
          description={error || 'Plan not found'}
        />
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <Link to="/" onClick={() => impact('light')}>
          Back
        </Link>
        <Title level="1">{plan.title}</Title>
      </header>

      {refreshing ? <p className="refresh-indicator">Refreshing...</p> : null}
      <PlanProgress plan={plan} />

      <div className="plan-sections">
        {plan.sections.map((section) => (
          <PlanSection
            key={section.index}
            section={section}
            onApprove={approveSection}
            onReject={rejectSection}
            onEdit={editSection}
          />
        ))}
      </div>

      <footer className="plan-actions-footer">
        <Button
          type="button"
          mode="filled"
          onClick={() => {
            impact('medium');
            void approveAll()
              .then(() => notification('success'))
              .catch(() => notification('error'));
          }}
        >
          Approve All
        </Button>
        <Button
          type="button"
          mode="outline"
          onClick={() => {
            impact('light');
            void rejectPlan('Rejected from Mini App')
              .then(() => notification('warning'))
              .catch(() => notification('error'));
          }}
        >
          Reject Plan
        </Button>
      </footer>
    </main>
  );
}
