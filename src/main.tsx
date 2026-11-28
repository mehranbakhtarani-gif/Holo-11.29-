import React, { useState } from 'react';
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
import { unlockBackupSession } from './lib/backupSession';
import { resumePendingCompleteBackupRestore } from './lib/completeBackupRestore';
import {
  getActiveOperationalRestoreJournal,
  setOperationalRestoreBarrier,
  type OperationalRestoreJournalRecord,
} from './lib/operationalDb';
import { setDocumentVaultRestoreBarrier } from './lib/documentVault';

function RestoreRecoveryGate({
  journal,
  readError,
}: {
  journal: OperationalRestoreJournalRecord | null;
  readError: string | null;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(readError);
  const [showPassphrase, setShowPassphrase] = useState(false);

  const resume = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || readError) return;
    setBusy(true);
    setError(null);
    try {
      unlockBackupSession(passphrase);
      await resumePendingCompleteBackupRestore();
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ادامه بازیابی ناموفق بود.');
      setBusy(false);
    }
  };

  return (
    <main dir="rtl" className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-5">
      <section className="w-full max-w-lg rounded-2xl border border-amber-500/40 bg-slate-900 p-6 shadow-2xl space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-bold tracking-wide text-amber-400">HOLOO · RESTORE RECOVERY</p>
          <h1 className="text-xl font-extrabold">بازیابی پشتیبان ناتمام</h1>
          <p className="text-sm leading-7 text-slate-300">
            یک عملیات بازیابی نیمه‌تمام در حافظه پایدار پیدا شد. برای جلوگیری از نمایش یا تغییر داده‌های ناسازگار،
            بارگذاری محیط حسابداری و همگام‌سازی تا تکمیل بازیابی متوقف شده است.
          </p>
        </div>
        {journal && (
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-950/70 p-3 text-xs">
            <div><dt className="text-slate-400">شناسه بازیابی</dt><dd className="mt-1 break-all">{journal.restoreId}</dd></div>
            <div><dt className="text-slate-400">وضعیت ثبت‌شده</dt><dd className="mt-1">{journal.state}</dd></div>
          </dl>
        )}
        <form onSubmit={resume} className="space-y-3">
          <label className="block text-sm font-semibold" htmlFor="restore-passphrase">رمز قفل پشتیبان</label>
          <div className="flex gap-2">
            <input
              id="restore-passphrase"
              type={showPassphrase ? 'text' : 'password'}
              autoComplete="current-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              disabled={busy || Boolean(readError)}
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
              placeholder="رمز استفاده‌شده برای تهیه نسخه پشتیبان"
            />
            <button type="button" onClick={() => setShowPassphrase((value) => !value)} className="rounded-lg border border-slate-700 px-3 text-xs">
              {showPassphrase ? 'پنهان' : 'نمایش'}
            </button>
          </div>
          {error && <p role="alert" className="rounded-lg bg-red-950/60 p-3 text-sm text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={busy || Boolean(readError) || passphrase.trim().length < 6}
            className="w-full rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'در حال ادامه بازیابی…' : 'تأیید رمز و ادامه بازیابی'}
          </button>
        </form>
        <p className="text-xs leading-6 text-slate-400">
          {readError
            ? 'خواندن ژورنال بازیابی ممکن نشد. برنامه عمداً در وضعیت قفل باقی مانده است؛ خطای بالا را برای بررسی فنی نگه دارید.'
            : 'این صفحه تا پایان بازیابی یا رفع خطا، ورود به محیط عادی برنامه را مسدود می‌کند. پس از موفقیت، برنامه دوباره بارگذاری خواهد شد.'}
        </p>
      </section>
    </main>
  );
}

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

const root = createRoot(document.getElementById('root')!);
const renderApplication = () => root.render(
  <ErrorBoundary>
    <AccountingProvider>
      <WorkspaceExtensionsProvider>
        <App />
      </WorkspaceExtensionsProvider>
    </AccountingProvider>
  </ErrorBoundary>
);

// A durable restore journal must be inspected before either provider can hydrate
// workspace data or start background persistence/synchronization.
void (async () => {
  try {
    const journal = await getActiveOperationalRestoreJournal();
    if (journal) {
      setOperationalRestoreBarrier(true);
      setDocumentVaultRestoreBarrier(true);
      root.render(<ErrorBoundary><RestoreRecoveryGate journal={journal} readError={null} /></ErrorBoundary>);
      return;
    }
    renderApplication();
  } catch (cause) {
    setOperationalRestoreBarrier(true);
    setDocumentVaultRestoreBarrier(true);
    root.render(
      <ErrorBoundary>
        <RestoreRecoveryGate
          journal={null}
          readError={cause instanceof Error ? cause.message : 'وضعیت بازیابی قابل بررسی نیست.'}
        />
      </ErrorBoundary>
    );
  }
})();
