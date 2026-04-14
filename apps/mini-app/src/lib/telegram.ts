type TelegramBackButton = {
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
};

type TelegramHapticFeedback = {
  impactOccurred?: (
    style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft',
  ) => void;
  selectionChanged?: () => void;
  notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
};

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  initData?: string;
  themeParams?: {
    bg_color?: string;
    text_color?: string;
    button_color?: string;
  };
  BackButton?: TelegramBackButton;
  HapticFeedback?: TelegramHapticFeedback;
};

export function getTelegramWebApp(): TelegramWebApp | undefined {
  const candidate = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  return candidate;
}

export function impact(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'light'): void {
  getTelegramWebApp()?.HapticFeedback?.impactOccurred?.(style);
}

export function selectionChanged(): void {
  getTelegramWebApp()?.HapticFeedback?.selectionChanged?.();
}

export function notification(type: 'error' | 'success' | 'warning'): void {
  getTelegramWebApp()?.HapticFeedback?.notificationOccurred?.(type);
}

export function bindBackButton(onBack: () => void): VoidFunction {
  const button = getTelegramWebApp()?.BackButton;
  if (!button) return () => undefined;

  button.show?.();
  button.onClick?.(onBack);

  return () => {
    button.offClick?.(onBack);
    button.hide?.();
  };
}
