import React, { useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  Clock,
  FileCheck2,
  Send,
  ShieldCheck,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { NativeNotificationsController } from '../hooks/useNativeNotifications';
import { ActiveModule } from '../types/accounting';
import { toPersianDigits } from '../lib/format';

interface NativeNotificationsPanelProps {
  controller: NativeNotificationsController;
  urgentChequeCount: number;
  draftVoucherCount: number;
  highlighted?: boolean;
  onNavigate?: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  showToast?: (msg: string) => void;
}

const INTERVAL_OPTIONS: Array<{ value: 15 | 30 | 60; label: string }> = [
  { value: 15, label: 'هر ۱۵ دقیقه' },
  { value: 30, label: 'هر ۳۰ دقیقه' },
  { value: 60, label: 'هر ۱ ساعت' },
];

export const NativeNotificationsPanel: React.FC<NativeNotificationsPanelProps> = ({
  controller,
  urgentChequeCount,
  draftVoucherCount,
  highlighted = false,
  onNavigate,
  showToast,
}) => {
  const {
    isSupported,
    permission,
    prefs,
    history,
    requestPermission,
    updatePrefs,
    sendChequeRemindersNow,
    sendTestNotification,
    clearHistory,
  } = controller;

  const [isSendingCheques, setIsSendingCheques] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);

  const isGranted = permission === 'granted';
  const isDenied = permission === 'denied';

  const handleTriggerCheques = async () => {
    setIsSendingCheques(true);
    try {
      if (permission === 'default') {
        const perm = await requestPermission();
        if (perm !== 'granted') return;
      }
      const sent = await sendChequeRemindersNow({ bypassDedup: true });
      if (sent > 0) {
        showToast?.(`${toPersianDigits(sent)} اعلان بومی یادآوری سررسید چک ارسال شد.`);
      } else {
        showToast?.('در بازه پایش فعلی، چک ضروری برای ارسال اعلان وجود ندارد.');
      }
    } finally {
      setIsSendingCheques(false);
    }
  };

  const handleTest = async () => {
    setIsSendingTest(true);
    try {
      await sendTestNotification();
    } finally {
      setIsSendingTest(false);
    }
  };

  return (
    <section
      aria-label="تنظیمات اعلان‌های بومی سیستم (Notifications API)"
      className={`bg-white dark:bg-slate-900 border rounded-xl p-5 sm:p-6 space-y-5 scroll-mt-20 transition-all ${
        highlighted
          ? 'border-indigo-500 ring-2 ring-indigo-500/20'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* Header & Permission Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              isGranted && prefs.enabled
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-900/60'
                : isDenied
                  ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 border border-rose-200/80 dark:border-rose-900/60'
                  : 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-400 border border-indigo-200/80 dark:border-indigo-900/60'
            }`}
          >
            {isGranted && prefs.enabled ? (
              <BellRing className="w-5 h-5" />
            ) : isDenied || !prefs.enabled ? (
              <BellOff className="w-5 h-5" />
            ) : (
              <Bell className="w-5 h-5" />
            )}
          </div>

          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              اعلان‌های بومی سیستم‌عامل در حالت PWA (Notifications API)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-5">
              ارسال نوتیفیکیشن بومی روی دسکتاپ و موبایل هنگام باز بودن برنامه برای یادآوری سررسید چک‌های صیادی و تأییدیه ثبت یا قطعی‌سازی اسناد حسابداری.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!isSupported ? (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              این مرورگر از Notifications API پشتیبانی نمی‌کند
            </span>
          ) : isGranted ? (
            <button
              type="button"
              onClick={() => updatePrefs({ enabled: !prefs.enabled })}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                prefs.enabled
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              {prefs.enabled ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>اعلان بومی فعال است</span>
                </>
              ) : (
                <>
                  <BellOff className="w-4 h-4" />
                  <span>اعلان بومی متوقف است (فعال‌سازی)</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              disabled={isDenied}
              onClick={() => void requestPermission()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              <BellRing className="w-4 h-4" />
              <span>{isDenied ? 'مجوز در مرورگر مسدود است' : 'فعال‌سازی اعلان‌های بومی'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Denied / Unsupported Guidance */}
      {isDenied && (
        <div className="p-3.5 rounded-xl bg-rose-50/80 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="leading-5">
            دسترسی ارسال اعلان (Notifications) توسط مرورگر مسدود شده است. برای فعال‌سازی، روی آیکون تنظیمات/قفل در کنار نوار آدرس مرورگر کلیک کنید و گزینه <strong>اعلان‌ها (Notifications)</strong> را روی <strong>اجازه دادن (Allow)</strong> قرار دهید، سپس صفحه را بازنشانی نمایید.
          </div>
        </div>
      )}

      {/* Live Status Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
          <div className="text-slate-500 dark:text-slate-400">وضعیت مجوز مرورگر</div>
          <div className="mt-1 font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
            {isGranted ? (
              <>
                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>تأیید شده (Granted)</span>
              </>
            ) : isDenied ? (
              <>
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <span>مسدود شده (Denied)</span>
              </>
            ) : !isSupported ? (
              <span>پشتیبانی نمی‌شود</span>
            ) : (
              <>
                <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>در انتظار مجوز کاربر</span>
              </>
            )}
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
          <div className="text-slate-500 dark:text-slate-400">چک‌های ضروری در صف پایش</div>
          <div className="mt-1 font-bold font-code tabular-nums text-slate-900 dark:text-white">
            {toPersianDigits(urgentChequeCount)} فقره چک
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800">
          <div className="text-slate-500 dark:text-slate-400">اسناد موقت در انتظار تأیید</div>
          <div className="mt-1 font-bold font-code tabular-nums text-slate-900 dark:text-white">
            {toPersianDigits(draftVoucherCount)} سند حسابداری
          </div>
        </div>
      </div>

      {/* Granular Notification Rules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <label className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-800/70 transition-colors">
          <div className="space-y-0.5">
            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <BellRing className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span>یادآوری سررسید چک‌های صیادی</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
              ارسال اعلان بومی برای چک‌های دریافتی و پرداختی معوق، سررسید امروز، برگشتی و چک‌های نزدیک به سررسید.
            </p>
          </div>
          <input
            type="checkbox"
            checked={prefs.chequeDueReminders}
            onChange={(e) => updatePrefs({ chequeDueReminders: e.target.checked })}
            className="mt-1 w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
          />
        </label>

        <label className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-800/70 transition-colors">
          <div className="space-y-0.5">
            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <FileCheck2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>تأییدیه ثبت و قطعی‌سازی اسناد حسابداری</span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
              ارسال اعلان بومی بلافاصله پس از ثبت سند دائم، دائم‌سازی سند موقت یا قطعی‌سازی گروهی اسناد.
            </p>
          </div>
          <input
            type="checkbox"
            checked={prefs.voucherApprovals}
            onChange={(e) => updatePrefs({ voucherApprovals: e.target.checked })}
            className="mt-1 w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
          />
        </label>

        <label className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-800/70 transition-colors">
          <div className="space-y-0.5">
            <div className="font-semibold text-slate-900 dark:text-white">
              نمایش ماندگار برای چک‌های بحرانی
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
              اعلان چک‌های معوق، برگشتی یا دارای کسری بانکی تا زمان کلیک کاربر روی صفحه باقی می‌ماند.
            </p>
          </div>
          <input
            type="checkbox"
            checked={prefs.requireInteractionForCritical}
            onChange={(e) => updatePrefs({ requireInteractionForCritical: e.target.checked })}
            className="mt-1 w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
          />
        </label>

        <label className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-800/70 transition-colors">
          <div className="space-y-0.5">
            <div className="font-semibold text-slate-900 dark:text-white">
              فقط در زمان پس‌زمینه بودن پنجره PWA
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
              اگر غیرفعال باشد، حتی زمانی که مستقیماً داخل پنجره برنامه کار می‌کنید نیز اعلان بومی نمایش داده می‌شود.
            </p>
          </div>
          <input
            type="checkbox"
            checked={prefs.onlyWhenBackgrounded}
            onChange={(e) => updatePrefs({ onlyWhenBackgrounded: e.target.checked })}
            className="mt-1 w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0"
          />
        </label>
      </div>

      {/* Periodic Scan Interval + Silent Mode + Action Triggers */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-600 dark:text-slate-400 font-medium">پایش دوره‌ای چک‌ها:</span>
            <div
              role="group"
              aria-label="بازه بررسی دوره‌ای سررسید چک‌ها"
              className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => updatePrefs({ periodicIntervalMinutes: opt.value })}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    prefs.periodicIntervalMinutes === opt.value
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => updatePrefs({ silent: !prefs.silent })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            {prefs.silent ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
            <span>{prefs.silent ? 'اعلان بی‌صدا' : 'همراه با صدای سیستم'}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!isSupported || isDenied || isSendingTest}
            onClick={() => void handleTest()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Send className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>ارسال اعلان آزمایشی</span>
          </button>

          <button
            type="button"
            disabled={!isSupported || isDenied || isSendingCheques}
            onClick={() => void handleTriggerCheques()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-teal-700 hover:bg-teal-800 text-white transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <BellRing className="w-3.5 h-3.5" />
            <span>ارسال یادآوری چک‌های ضروری الان</span>
          </button>
        </div>
      </div>

      {/* Recent Native Notifications History */}
      {history.length > 0 && (
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              آخرین اعلان‌های بومی ارسال‌شده ({toPersianDigits(history.length)})
            </span>
            <button
              type="button"
              onClick={clearHistory}
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>پاک کردن تاریخچه</span>
            </button>
          </div>

          <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl">
            {history.slice(0, 10).map((item) => (
              <div
                key={item.id}
                className="px-3.5 py-2.5 flex items-start justify-between gap-3 text-xs hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-bold whitespace-nowrap ${
                        item.category === 'cheque'
                          ? 'text-amber-700 dark:text-amber-400'
                          : item.category === 'voucher'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-indigo-700 dark:text-indigo-400'
                      }`}
                    >
                      {item.category === 'cheque'
                        ? 'سررسید چک'
                        : item.category === 'voucher'
                          ? 'تأییدیه سند'
                          : 'سیستم'}
                    </span>
                    <span className="font-semibold text-slate-900 dark:text-white truncate">
                      {item.title}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-pre-line line-clamp-2">
                    {item.body}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="font-code tabular-nums text-[10px] text-slate-400">
                    {toPersianDigits(item.timestamp)}
                  </span>
                  {item.target && onNavigate && (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate(item.target!.module, item.target!.intent, item.target!.subKey)
                      }
                      className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                    >
                      مشاهده
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
