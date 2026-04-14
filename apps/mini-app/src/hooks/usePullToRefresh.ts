import { useEffect, useState } from 'react';

interface PullToRefreshOptions {
  enabled?: boolean;
  threshold?: number;
}

export function usePullToRefresh(
  onRefresh: () => Promise<void> | void,
  options: PullToRefreshOptions = {},
): { refreshing: boolean } {
  const { enabled = true, threshold = 72 } = options;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let startY: number | null = null;
    let triggered = false;

    const onTouchStart = (event: TouchEvent) => {
      if (window.scrollY > 0 || refreshing) {
        startY = null;
        return;
      }
      startY = event.touches[0]?.clientY ?? null;
      triggered = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startY === null || triggered) return;
      const currentY = event.touches[0]?.clientY;
      if (typeof currentY !== 'number') return;
      const delta = currentY - startY;
      if (delta <= 0) return;

      if (delta > 12 && window.scrollY <= 0) {
        event.preventDefault();
      }

      if (delta >= threshold) {
        triggered = true;
        setRefreshing(true);
        Promise.resolve(onRefresh())
          .catch(() => {
            // refresh errors are handled by callers
          })
          .finally(() => {
            setRefreshing(false);
          });
      }
    };

    const onTouchEnd = () => {
      startY = null;
      triggered = false;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled, onRefresh, refreshing, threshold]);

  return { refreshing };
}
