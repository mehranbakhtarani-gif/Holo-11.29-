import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import '@fontsource/vazirmatn/400.css';
import '@fontsource/vazirmatn/500.css';
import '@fontsource/vazirmatn/600.css';
import '@fontsource/vazirmatn/700.css';
import '@fontsource/vazirmatn/800.css';
import App from './App.tsx';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AccountingProvider } from './context/AccountingContext';
import { WorkspaceExtensionsProvider } from './context/WorkspaceExtensionsContext';
import { setOfflineSwState, setOfflineSwUpdater } from './lib/offlineStatus';
import { initUiThemeFromStorage } from './lib/uiThemeCustomizer';

// Hydrate user-customized brand & accent colors from localStorage immediately on boot
initUiThemeFromStorage();

// Register PWA service worker for full offline caching & installability
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    setOfflineSwState({
      registered: Boolean(registration),
      controlling:
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        Boolean(navigator.serviceWorker.controller),
      registrationError: null,
    });
  },
  onOfflineReady() {
    setOfflineSwState({
      registered: true,
      offlineReady: true,
      controlling:
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        Boolean(navigator.serviceWorker.controller),
    });
  },
  onNeedRefresh() {
    setOfflineSwState({ needRefresh: true });
  },
  onRegisterError(err) {
    setOfflineSwState({
      registrationError: err instanceof Error ? err.message : String(err),
    });
  },
});
setOfflineSwUpdater(updateSW);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <AccountingProvider>
      <WorkspaceExtensionsProvider>
        <App />
      </WorkspaceExtensionsProvider>
    </AccountingProvider>
  </ErrorBoundary>
);
