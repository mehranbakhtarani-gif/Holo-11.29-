import { useCallback, useEffect, useRef, useState } from 'react';
import { ActiveModule, CurrencyUnit } from '../types/accounting';
import { ChequeAlertSummary } from '../lib/chequeAlerts';
import {
  buildChequeDigestNotificationPayload,
  buildChequeDueNotificationPayload,
  buildVoucherApprovalNotificationPayload,
  clearNotificationHistory,
  clearSentChequeNotificationKeys,
  dispatchNativeNotification,
  getNativeNotificationPermission,
  isNativeNotificationsSupported,
  loadNativeNotificationPrefs,
  loadNotificationHistory,
  loadSentChequeNotificationKeys,
  makeChequeAlertDedupKey,
  NativeNotificationHistoryItem,
  NativeNotificationPermissionState,
  NativeNotificationPrefs,
  requestNativeNotificationPermission,
  saveNativeNotificationPrefs,
  saveSentChequeNotificationKeys,
  subscribeNativeNotificationState,
  subscribeNotificationNavigation,
  subscribeVoucherNotificationEvents,
} from '../lib/nativeNotifications';
import { toPersianDigits } from '../lib/format';

export interface NativeNotificationsController {
  isSupported: boolean;
  permission: NativeNotificationPermissionState;
  prefs: NativeNotificationPrefs;
  history: NativeNotificationHistoryItem[];
  requestPermission: () => Promise<NativeNotificationPermissionState>;
  updatePrefs: (patch: Partial<NativeNotificationPrefs>) => void;
  sendChequeRemindersNow: (options?: { bypassDedup?: boolean }) => Promise<number>;
  sendTestNotification: () => Promise<boolean>;
  clearHistory: () => void;
}

export function useNativeNotifications(params: {
  chequeAlertSummary: ChequeAlertSummary;
  companyName: string;
  currencyUnit: CurrencyUnit;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  showToast?: (msg: string) => void;
}): NativeNotificationsController {
  const { chequeAlertSummary, companyName, currencyUnit, onNavigate, showToast } = params;

  const isSupported = isNativeNotificationsSupported();
  const [permission, setPermission] = useState<NativeNotificationPermissionState>(() =>
    getNativeNotificationPermission()
  );
  const [prefs, setPrefs] = useState<NativeNotificationPrefs>(() => loadNativeNotificationPrefs());
  const [history, setHistory] = useState<NativeNotificationHistoryItem[]>(() =>
    loadNotificationHistory()
  );

  // Latest state refs so intervals and event listeners stay fresh without tearing down timers
  const latestRef = useRef({
    chequeAlertSummary,
    companyName,
    currencyUnit,
    prefs,
    permission,
    onNavigate,
    showToast,
  });
  latestRef.current = {
    chequeAlertSummary,
    companyName,
    currencyUnit,
    prefs,
    permission,
    onNavigate,
    showToast,
  };

  // Sync prefs, permission, and history across components and browser tabs
  useEffect(() => {
    const unsubState = subscribeNativeNotificationState({
      onPrefs: setPrefs,
      onPermission: setPermission,
      onHistory: setHistory,
    });

    const handleVisibility = () => {
      setPermission(getNativeNotificationPermission());
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsubState();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Clicking a native notification brings the open PWA into focus and navigates directly
  useEffect(() => {
    return subscribeNotificationNavigation((target) => {
      latestRef.current.onNavigate(target.module, target.intent, target.subKey);
    });
  }, []);

  // Listen to voucher creation/finalization approval events from AccountingContext
  useEffect(() => {
    return subscribeVoucherNotificationEvents((event) => {
      const { prefs: currentPrefs, permission: currentPerm } = latestRef.current;
      if (currentPerm !== 'granted' || !currentPrefs.enabled || !currentPrefs.voucherApprovals) {
        return;
      }
      const payload = buildVoucherApprovalNotificationPayload(event);
      if (!payload) return;
      void dispatchNativeNotification(payload, { prefs: currentPrefs });
    });
  }, []);

  const sendChequeRemindersNow = useCallback(
    async (options?: { bypassDedup?: boolean }): Promise<number> => {
      const {
        chequeAlertSummary: summary,
        companyName: coName,
        currencyUnit: unit,
        prefs: currentPrefs,
      } = latestRef.current;

      const currentPerm = getNativeNotificationPermission();
      setPermission(currentPerm);
      if (currentPerm !== 'granted') return 0;

      const bypassDedup = Boolean(options?.bypassDedup);
      if (!bypassDedup && (!currentPrefs.enabled || !currentPrefs.chequeDueReminders)) {
        return 0;
      }

      if (summary.urgentAlerts.length === 0) return 0;

      const sentKeys = bypassDedup
        ? new Set<string>()
        : loadSentChequeNotificationKeys(summary.todayShamsi);

      const pendingAlerts = summary.urgentAlerts.filter(
        (al) => bypassDedup || !sentKeys.has(makeChequeAlertDedupKey(summary.todayShamsi, al))
      );

      if (pendingAlerts.length === 0) return 0;

      // Avoid flooding OS tray: send up to 2 individual top-priority cheque notifications + 1 digest
      const directList = pendingAlerts.length > 3 ? pendingAlerts.slice(0, 2) : pendingAlerts;
      const overflowCount = pendingAlerts.length > 3 ? pendingAlerts.length - 2 : 0;

      let sentCount = 0;

      for (const alert of directList) {
        const payload = buildChequeDueNotificationPayload(alert, unit, coName);
        const res = await dispatchNativeNotification(payload, {
          force: bypassDedup,
          prefs: currentPrefs,
        });
        if (res.delivered) {
          sentCount += 1;
          sentKeys.add(makeChequeAlertDedupKey(summary.todayShamsi, alert));
        }
      }

      if (overflowCount > 0) {
        const digestPayload = buildChequeDigestNotificationPayload(summary, overflowCount, unit);
        const res = await dispatchNativeNotification(digestPayload, {
          force: bypassDedup,
          prefs: currentPrefs,
        });
        if (res.delivered) {
          sentCount += 1;
          for (const alert of pendingAlerts.slice(2)) {
            sentKeys.add(makeChequeAlertDedupKey(summary.todayShamsi, alert));
          }
        }
      }

      if (sentCount > 0) {
        const merged = loadSentChequeNotificationKeys(summary.todayShamsi);
        sentKeys.forEach((k) => merged.add(k));
        saveSentChequeNotificationKeys(summary.todayShamsi, merged);
      }

      return sentCount;
    },
    []
  );

  // Automatic initial & periodic cheque due-date scan while the PWA is open
  useEffect(() => {
    if (permission !== 'granted' || !prefs.enabled || !prefs.chequeDueReminders) {
      return;
    }

    const initialTimer = window.setTimeout(() => {
      void sendChequeRemindersNow({ bypassDedup: false });
    }, 2200);

    const intervalMs = Math.max(15, prefs.periodicIntervalMinutes) * 60 * 1000;
    const periodicTimer = window.setInterval(() => {
      void sendChequeRemindersNow({ bypassDedup: false });
    }, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void sendChequeRemindersNow({ bypassDedup: false });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    permission,
    prefs.enabled,
    prefs.chequeDueReminders,
    prefs.periodicIntervalMinutes,
    chequeAlertSummary.urgentAlerts.length,
    chequeAlertSummary.todayShamsi,
    sendChequeRemindersNow,
  ]);

  const requestPermission = useCallback(async () => {
    const nextPerm = await requestNativeNotificationPermission();
    setPermission(nextPerm);
    if (nextPerm === 'granted') {
      const nextPrefs = { ...loadNativeNotificationPrefs(), enabled: true };
      saveNativeNotificationPrefs(nextPrefs);
      setPrefs(nextPrefs);
      latestRef.current.showToast?.(
        'اعلان‌های بومی سیستم (PWA) فعال شد. یادآوری سررسید چک‌ها و تأییدیه اسناد به‌صورت آنی ارسال می‌شود.'
      );
      void dispatchNativeNotification(
        {
          title: 'اعلان‌های بومی هلو Apex فعال شد',
          body: 'یادآوری سررسید چک‌های صیادی و تأییدیه قطعی‌سازی اسناد حسابداری از این پس به‌صورت بومی نمایش داده می‌شود.',
          tag: 'holoo-notifications-enabled',
          category: 'system',
          target: { module: 'dashboard' },
        },
        { force: true, prefs: nextPrefs }
      );
    } else if (nextPerm === 'denied') {
      latestRef.current.showToast?.(
        'مجوز اعلان در مرورگر مسدود شده است. برای فعال‌سازی، از آیکون قفل کنار آدرس سایت مجوز Notifications را روی Allow بگذارید.'
      );
    }
    return nextPerm;
  }, []);

  const updatePrefs = useCallback((patch: Partial<NativeNotificationPrefs>) => {
    const current = loadNativeNotificationPrefs();
    const next: NativeNotificationPrefs = { ...current, ...patch };
    saveNativeNotificationPrefs(next);
    setPrefs(next);
  }, []);

  const sendTestNotification = useCallback(async (): Promise<boolean> => {
    let currentPerm = getNativeNotificationPermission();
    if (currentPerm === 'default') {
      currentPerm = await requestPermission();
    }
    if (currentPerm !== 'granted') return false;

    const urgentCount = latestRef.current.chequeAlertSummary.urgentAlerts.length;
    const res = await dispatchNativeNotification(
      {
        title: `اعلان آزمایشی — ${latestRef.current.companyName || 'هلو Apex'}`,
        body:
          urgentCount > 0
            ? `اتصال Notifications API برقرار است. هم‌اکنون ${toPersianDigits(urgentCount)} فقره چک ضروری در صف پایش قرار دارد.`
            : 'اتصال Notifications API برقرار است. هنگام سررسید چک‌ها یا قطعی‌سازی اسناد، اعلان بومی نمایش داده خواهد شد.',
        tag: `holoo-test-${Date.now()}`,
        category: 'system',
        target: { module: 'settings', intent: 'notifications', subKey: 'tool-notifications' },
      },
      { force: true, prefs: latestRef.current.prefs }
    );
    if (res.delivered) {
      latestRef.current.showToast?.('اعلان بومی آزمایشی با موفقیت به سیستم‌عامل ارسال شد.');
    }
    return res.delivered;
  }, [requestPermission]);

  const handleClearHistory = useCallback(() => {
    clearNotificationHistory();
    clearSentChequeNotificationKeys();
    setHistory([]);
    latestRef.current.showToast?.('تاریخچه اعلان‌های بومی پاکسازی شد.');
  }, []);

  return {
    isSupported,
    permission,
    prefs,
    history,
    requestPermission,
    updatePrefs,
    sendChequeRemindersNow,
    sendTestNotification,
    clearHistory: handleClearHistory,
  };
}
