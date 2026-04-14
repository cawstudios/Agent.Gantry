import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRoot } from '@telegram-apps/telegram-ui';

import { App } from './App';
import { useTelegram } from './hooks/useTelegram';
import { applyTelegramTheme } from './lib/theme';
import '@telegram-apps/telegram-ui/dist/styles.css';
import './styles.css';

function RootApp() {
  useTelegram();
  React.useEffect(() => {
    applyTelegramTheme();
  }, []);
  return (
    <AppRoot>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppRoot>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
