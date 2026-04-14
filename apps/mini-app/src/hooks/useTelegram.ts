import { useEffect } from 'react';
import { getTelegramWebApp } from '../lib/telegram';

export function useTelegram(): void {
  useEffect(() => {
    const webApp = getTelegramWebApp();
    if (!webApp) return;
    webApp.ready?.();
    webApp.expand?.();
  }, []);
}
