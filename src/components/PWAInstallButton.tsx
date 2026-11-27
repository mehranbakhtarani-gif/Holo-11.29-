import React, { useState } from 'react';
import { Download, Monitor, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuide(true);
    }
  };

  return (
    <>
      <button
        onClick={handleClick}
        title="نصب نسخه موبایل (PWA) و اپلیکیشن دسکتاپ"
        className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-3 py-1.5 text-xs font-medium' : 'px-4 py-2 text-sm font-medium'
        }`}
      >
        <Download className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0" />
        <span>{isInstallable ? 'نصب اپلیکیشن' : 'نسخه دسکتاپ و موبایل'}</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-3 sm:p-4">
          <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                نصب نسخه دسکتاپ و موبایل (PWA) هلو Apex
              </h3>
              <button
                onClick={() => setShowGuide(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="بستن"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                  <Monitor className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                  <span>اپلیکیشن دسکتاپ (Windows / macOS / Linux)</span>
                </div>
                <p className="text-xs leading-6">
                  در مرورگر Chrome یا Edge، روی آیکون <strong>نصب (Install)</strong> در نوار آدرس کلیک کنید یا از منوی مرورگر گزینه <strong>Save and share ← Install page as app</strong> را انتخاب نمایید تا آیکون مستقل هلو Apex روی دسکتاپ کارکنان ایجاد شود.
                </p>
              </div>

              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                  <Smartphone className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                  <span>{isIOS ? 'نصب روی آیفون و آیپد (Safari iOS)' : 'نصب روی گوشی موبایل (Android / iOS)'}</span>
                </div>
                <p className="text-xs leading-6">
                  در آیفون (Safari) دکمه <strong>Share</strong> را لمس کرده و <strong>Add to Home Screen</strong> را انتخاب کنید. در اندروید (Chrome) از منوی سه‌نقطه گزینه <strong>Install App</strong> را بزنید تا سامانه به‌صورت تمام‌صفحه و با پشتیبانی آفلاین اجرا شود.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowGuide(false)}
              className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors"
            >
              متوجه شدم
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC<{ onOpenHealth?: () => void }> = ({ onOpenHealth }) => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-24 lg:bottom-4 right-3 left-3 sm:left-auto sm:right-4 sm:max-w-md z-[60] flex flex-wrap items-center gap-2.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-lg no-print">
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>حالت کاملاً آفلاین فعال است — تمام ثبت‌ها روی حافظه دستگاه ذخیره می‌شوند.</span>
      {onOpenHealth && (
        <button
          type="button"
          onClick={onOpenHealth}
          className="underline font-bold text-amber-100 hover:text-white whitespace-nowrap"
        >
          بررسی وضعیت آفلاین
        </button>
      )}
    </div>
  );
};

export const PwaUpdateBanner: React.FC<{
  onCreatePreUpdateBackup?: () => Promise<boolean> | boolean;
}> = ({ onCreatePreUpdateBackup }) => {
  const [needRefresh, setNeedRefresh] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    void import('../lib/offlineStatus').then(({ subscribeOfflineSwState }) => {
      unsub = subscribeOfflineSwState((st) => {
        setNeedRefresh(st.needRefresh);
      });
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

  if (!needRefresh || dismissed) return null;

  const handleApply = async () => {
    setApplying(true);
    try {
      const { safeApplySwUpdateWithBackup } = await import('../lib/offlineStatus');
      await safeApplySwUpdateWithBackup(onCreatePreUpdateBackup);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed bottom-24 lg:bottom-4 right-3 left-3 sm:right-auto sm:left-4 sm:max-w-md z-[60] flex flex-wrap items-center gap-3 rounded-xl bg-indigo-700 px-4 py-2.5 text-xs font-semibold text-white shadow-xl border border-indigo-400/30 no-print">
      <span>نسخه جدید هلو Apex آماده نصب است (اطلاعات محلی محفوظ می‌ماند).</span>
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={applying}
        className="px-3 py-1 rounded-lg bg-white text-indigo-800 hover:bg-indigo-50 font-bold disabled:opacity-60 whitespace-nowrap"
      >
        {applying ? 'پشتیبان ایمنی و بروزرسانی...' : 'پشتیبان و بروزرسانی'}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-indigo-200 hover:text-white"
        aria-label="بستن اعلان بروزرسانی"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
