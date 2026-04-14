import { useMemo } from 'react';
import { getTelegramWebApp } from '../lib/telegram';

export function useAuth(): { initData?: string } {
  const initData = useMemo(() => {
    const webApp = getTelegramWebApp();
    return typeof webApp?.initData === 'string' ? webApp.initData : undefined;
  }, []);

  return {
    ...(initData ? { initData } : {}),
  };
}
