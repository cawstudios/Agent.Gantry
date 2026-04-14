import { getTelegramWebApp } from './telegram';

export function applyTelegramTheme(): void {
  const webApp = getTelegramWebApp();
  if (!webApp?.themeParams) return;

  const root = document.documentElement;
  const background = webApp.themeParams.bg_color || '#f4f6f8';
  const text = webApp.themeParams.text_color || '#0b1523';
  const button = webApp.themeParams.button_color || '#2f8fdd';

  root.style.setProperty('--color-bg', background);
  root.style.setProperty('--color-text', text);
  root.style.setProperty('--color-primary', button);
}
