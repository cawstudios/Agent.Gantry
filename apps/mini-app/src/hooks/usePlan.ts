import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  approveAll,
  approveSection,
  editSection,
  fetchPlan,
  rejectPlan,
  rejectSection,
  resolveApiBase,
} from '../api/client';
import { Plan } from '../types/plan';

export function usePlan(planId: string, initData?: string) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      if (!planId) {
        setPlan(null);
        setError('Plan id is missing');
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const next = await fetchPlan(planId, initData);
        setPlan(next);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [planId, initData],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;

    const params = new URLSearchParams();
    if (initData) params.set('initData', initData);

    const query = params.toString();
    const streamUrl = `${resolveApiBase()}/plans/${encodeURIComponent(planId)}/stream${query ? `?${query}` : ''}`;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const closeSource = () => {
      if (!source) return;
      source.close();
      source = null;
    };

    const scheduleReconnect = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      clearReconnect();
      const delayMs = Math.min(
        10_000,
        1_000 * 2 ** Math.min(reconnectAttempts, 4),
      );
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(() => {
        connect();
      }, delayMs);
    };

    const onPlanUpdated = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          plan?: Plan;
        };
        if (payload.plan) {
          setPlan(payload.plan);
          setError(null);
        }
      } catch {
        // ignore malformed event
      }
    };

    const connect = () => {
      if (!planId || stopped || document.visibilityState === 'hidden') return;
      closeSource();
      clearReconnect();
      source = new EventSource(streamUrl);
      source.addEventListener('plan_updated', onPlanUpdated);
      source.onopen = () => {
        reconnectAttempts = 0;
      };
      source.onerror = () => {
        closeSource();
        scheduleReconnect();
      };
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reconnectAttempts = 0;
        connect();
        void refresh(true);
      } else {
        closeSource();
        clearReconnect();
      }
    };

    if (!planId) return;
    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      closeSource();
      clearReconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [planId, initData, refresh]);

  const actions = useMemo(
    () => ({
      approveSection: async (sectionIndex: number) => {
        const next = await approveSection(planId, sectionIndex, initData);
        setPlan(next);
      },
      rejectSection: async (sectionIndex: number, reason: string) => {
        const next = await rejectSection(
          planId,
          sectionIndex,
          reason,
          initData,
        );
        setPlan(next);
      },
      editSection: async (sectionIndex: number, content: string) => {
        const next = await editSection(planId, sectionIndex, content, initData);
        setPlan(next);
      },
      approveAll: async () => {
        const next = await approveAll(planId, initData);
        setPlan(next);
      },
      rejectPlan: async (reason: string) => {
        const next = await rejectPlan(planId, reason, initData);
        setPlan(next);
      },
      refresh: async () => {
        await refresh(true);
      },
    }),
    [planId, initData, refresh],
  );

  return {
    plan,
    loading,
    error,
    ...actions,
  };
}
