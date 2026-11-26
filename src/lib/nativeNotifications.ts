import { ActiveModule, CurrencyUnit, Voucher } from '../types/accounting';
import { ChequeAlertItem, ChequeAlertSummary } from './chequeAlerts';
import { formatMoney, toPersianDigits } from './format';

export type NativeNotificationPermissionState =
  | 'granted'
  | 'denied'
  | 'default'
  | 'unsupported';

export type NativeNotificationCategory = 'cheque' | 'voucher' | 'system';

export interface NativeNotificationTarget {
  module: ActiveModule;
  intent?: string;
  subKey?: string;
}

export interface NativeNotificationPayload {
  title: string;
  body: string;
  tag: string;
  category: NativeNotificationCategory;
  requireInteraction?: boolean;
  renotify?: boolean;
  target?: NativeNotificationTarget;
}

export interface NativeNotificationPrefs {
  enabled: boolean;
  chequeDueReminders: boolean;
  voucherApprovals: boolean;
  periodicIntervalMinutes: 15 | 30 | 60;
  requireInteractionForCritical: boolean;
  silent: boolean;
  onlyWhenBackgrounded: boolean;
}

export interface NativeNotificationHistoryItem {
  id: string;
  timestamp: string;
  category: NativeNotificationCategory;
  title: string;
  body: string;
  delivered: boolean;
  target?: NativeNotificationTarget;
}

export interface VoucherNotificationEvent {
  type: 'finalized' | 'created_permanent' | 'created_draft' | 'batch_finalized';
  voucher?: Voucher;
  batchCount?: number;
  unit: CurrencyUnit;
  operatorName?: string;
}

const PREFS_STORAGE_KEY = 'holoo_apex_native_notifications_prefs_v1';
const SENT_CHEQUE_KEYS_STORAGE_KEY = 'holoo_apex_native_notifications_sent_cheques_v1';
const HISTORY_STORAGE_KEY = 'holoo_apex_native_notifications_history_v1';

const PREFS_CHANGED_EVENT = 'holoo-native-notification-prefs-changed';
const PERMISSION_CHANGED_EVENT = 'holoo-native-notification-permission-changed';
const HISTORY_CHANGED_EVENT = 'holoo-native-notification-history-changed';
const VOUCHER_NOTIFICATION_EVENT = 'holoo-native-notification-voucher-event';
const NOTIFICATION_NAVIGATE_EVENT = 'holoo-native-notification-navigate';

const MAX_HISTORY_ITEMS = 25;
const PWA_ICON_URL = '/pwa-192x192.png';

export const DEFAULT_NATIVE_NOTIFICATION_PREFS: NativeNotificationPrefs = {
  enabled: true,
  chequeDueReminders: true,
  voucherApprovals: true,
  periodicIntervalMinutes: 30,
  requireInteractionForCritical: true,
  silent: false,
  onlyWhenBackgrounded: false,
};

export function isNativeNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

export function getNativeNotificationPermission(): NativeNotificationPermissionState {
  if (!isNativeNotificationsSupported()) return 'unsupported';
  return window.Notification.permission as NativeNotificationPermissionState;
}

export async function requestNativeNotificationPermission(): Promise<NativeNotificationPermissionState> {
  if (!isNativeNotificationsSupported()) return 'unsupported';
  try {
    let result: NotificationPermission;
    const req = window.Notification.requestPermission;
    if (req.length >= 1) {
      result = await new Promise<NotificationPermission>((resolve) => {
        const maybePromise = window.Notification.requestPermission((perm) => resolve(perm));
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(resolve).catch(() => resolve(window.Notification.permission));
        }
      });
    } else {
      result = await window.Notification.requestPermission();
    }
    const state = result as NativeNotificationPermissionState;
    window.dispatchEvent(new CustomEvent(PERMISSION_CHANGED_EVENT, { detail: state }));
    return state;
  } catch {
    return getNativeNotificationPermission();
  }
}

export function loadNativeNotificationPrefs(): NativeNotificationPrefs {
  if (typeof window === 'undefined') return DEFAULT_NATIVE_NOTIFICATION_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_NATIVE_NOTIFICATION_PREFS;
    const parsed = JSON.parse(raw) as Partial<NativeNotificationPrefs>;
    const validIntervals = new Set([15, 30, 60]);
    const interval = validIntervals.has(Number(parsed.periodicIntervalMinutes))
      ? (Number(parsed.periodicIntervalMinutes) as 15 | 30 | 60)
      : 30;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      chequeDueReminders:
        typeof parsed.chequeDueReminders === 'boolean' ? parsed.chequeDueReminders : true,
      voucherApprovals:
        typeof parsed.voucherApprovals === 'boolean' ? parsed.voucherApprovals : true,
      periodicIntervalMinutes: interval,
      requireInteractionForCritical:
        typeof parsed.requireInteractionForCritical === 'boolean'
          ? parsed.requireInteractionForCritical
          : true,
      silent: typeof parsed.silent === 'boolean' ? parsed.silent : false,
      onlyWhenBackgrounded:
        typeof parsed.onlyWhenBackgrounded === 'boolean' ? parsed.onlyWhenBackgrounded : false,
    };
  } catch {
    return DEFAULT_NATIVE_NOTIFICATION_PREFS;
  }
}

export function saveNativeNotificationPrefs(next: NativeNotificationPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: next }));
  } catch {
    // ignore quota errors in private mode
  }
}

export function loadNotificationHistory(): NativeNotificationHistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NativeNotificationHistoryItem[]).slice(0, MAX_HISTORY_ITEMS) : [];
  } catch {
    return [];
  }
}

function appendNotificationHistory(item: NativeNotificationHistoryItem): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = loadNotificationHistory();
    const next = [item, ...existing].slice(0, MAX_HISTORY_ITEMS);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: next }));
  } catch {
    // ignore storage errors
  }
}

export function clearNotificationHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: [] }));
  } catch {
    // ignore storage errors
  }
}

export function loadSentChequeNotificationKeys(todayShamsi: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(SENT_CHEQUE_KEYS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { date?: string; keys?: string[] };
    if (parsed.date !== todayShamsi || !Array.isArray(parsed.keys)) {
      return new Set();
    }
    return new Set(parsed.keys);
  } catch {
    return new Set();
  }
}

export function saveSentChequeNotificationKeys(todayShamsi: string, keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SENT_CHEQUE_KEYS_STORAGE_KEY,
      JSON.stringify({ date: todayShamsi, keys: Array.from(keys).slice(-200) })
    );
  } catch {
    // ignore storage errors
  }
}

export function clearSentChequeNotificationKeys(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SENT_CHEQUE_KEYS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function makeChequeAlertDedupKey(todayShamsi: string, alert: ChequeAlertItem): string {
  return `${todayShamsi}:${alert.cheque.id}:${alert.severity}`;
}

export function buildChequeDueNotificationPayload(
  alert: ChequeAlertItem,
  unit: CurrencyUnit,
  companyName?: string
): NativeNotificationPayload {
  const ch = alert.cheque;
  const dirLabel = ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی';
  const amountText = formatMoney(ch.amount, unit);
  const dueText = toPersianDigits(ch.dueDate);
  const sayadiShort = ch.sayadiId ? toPersianDigits(ch.sayadiId.slice(-6)) : '';

  let title: string;
  if (alert.severity === 'bounced') {
    title = `چک ${dirLabel} برگشتی — ${ch.partyName}`;
  } else if (alert.severity === 'overdue') {
    title = `چک ${dirLabel} معوق (${toPersianDigits(Math.abs(alert.daysRemaining))} روز تاخیر)`;
  } else if (alert.severity === 'today') {
    title = `سررسید امروز چک ${dirLabel} — ${ch.partyName}`;
  } else {
    title = `یادآوری سررسید چک ${dirLabel} (${alert.urgencyLabel})`;
  }

  const parts: string[] = [
    `${ch.partyName} · مبلغ ${amountText}`,
    `بانک ${ch.bankName} · سررسید ${dueText}${sayadiShort ? ` · صیادی …${sayadiShort}` : ''}`,
  ];

  if (ch.direction === 'payable' && alert.bankSufficient === false && alert.matchedBankTitle) {
    parts.push(`هشدار: موجودی ${alert.matchedBankTitle} برای پاس شدن کافی نیست.`);
  } else if (companyName) {
    parts.push(alert.recommendation);
  }

  const isCritical =
    alert.severity === 'bounced' ||
    alert.severity === 'overdue' ||
    alert.severity === 'today' ||
    alert.bankSufficient === false;

  return {
    title,
    body: parts.join('\n'),
    tag: `holoo-cheque-${ch.id}`,
    category: 'cheque',
    requireInteraction: isCritical,
    renotify: true,
    target: {
      module: 'treasury',
      intent: `cheque:${ch.id}`,
      subKey: 'tr-cheques',
    },
  };
}

export function buildChequeDigestNotificationPayload(
  summary: ChequeAlertSummary,
  remainingCount: number,
  unit: CurrencyUnit
): NativeNotificationPayload {
  const parts: string[] = [
    `جمع دریافتی ضروری: ${formatMoney(summary.urgentReceivableAmount, unit)}`,
    `جمع پرداختی ضروری: ${formatMoney(summary.urgentPayableAmount, unit)}`,
  ];
  if (summary.bankShortfallForPayables > 0) {
    parts.push(`کسری بانکی پرداختی‌ها: ${formatMoney(summary.bankShortfallForPayables, unit)}`);
  }

  return {
    title: `${toPersianDigits(remainingCount)} فقره چک ضروری دیگر در بازه ${toPersianDigits(summary.leadDays)} روزه`,
    body: parts.join('\n'),
    tag: `holoo-cheque-digest-${summary.todayShamsi}`,
    category: 'cheque',
    requireInteraction: summary.overdueCount > 0 || summary.dueTodayCount > 0 || summary.bouncedCount > 0,
    renotify: true,
    target: {
      module: 'treasury',
      intent: 'cheques',
      subKey: 'tr-cheques',
    },
  };
}

export function buildVoucherApprovalNotificationPayload(
  event: VoucherNotificationEvent
): NativeNotificationPayload | null {
  const { type, voucher, batchCount, unit, operatorName } = event;

  if (type === 'batch_finalized') {
    const count = batchCount ?? 0;
    if (count <= 0) return null;
    return {
      title: `تأییدیه دائم‌سازی ${toPersianDigits(count)} سند حسابداری`,
      body: `${toPersianDigits(count)} سند موقت تراز با موفقیت به وضعیت دائم تبدیل و قفل اصالت ثبت شد.${operatorName ? `\nاپراتور: ${operatorName}` : ''}`,
      tag: `holoo-voucher-batch-${Date.now()}`,
      category: 'voucher',
      requireInteraction: false,
      renotify: true,
      target: {
        module: 'vouchers',
        intent: 'journal',
        subKey: 'fin-vouchers',
      },
    };
  }

  if (!voucher) return null;
  const numStr = toPersianDigits(voucher.voucherNumber);
  const dateStr = toPersianDigits(voucher.date);
  const amountStr = formatMoney(voucher.totalDebit, unit);
  const shortDesc =
    voucher.description.length > 72
      ? `${voucher.description.slice(0, 72)}…`
      : voucher.description;

  if (type === 'finalized') {
    return {
      title: `تأییدیه قطعی‌سازی سند حسابداری #${numStr}`,
      body: `سند شماره ${numStr} (${dateStr}) به مبلغ ${amountStr} دائم شد و مُهر اصالت گرفت.\n${shortDesc}`,
      tag: `holoo-voucher-finalized-${voucher.id}`,
      category: 'voucher',
      requireInteraction: false,
      renotify: true,
      target: {
        module: 'vouchers',
        intent: `voucher:${voucher.id}`,
        subKey: 'fin-vouchers',
      },
    };
  }

  if (type === 'created_permanent') {
    return {
      title: `تأییدیه ثبت سند دائم #${numStr}`,
      body: `سند حسابداری #${numStr} (${dateStr}) به مبلغ ${amountStr} تراز و ثبت قطعی شد.\n${shortDesc}`,
      tag: `holoo-voucher-created-${voucher.id}`,
      category: 'voucher',
      requireInteraction: false,
      renotify: true,
      target: {
        module: 'vouchers',
        intent: `voucher:${voucher.id}`,
        subKey: 'fin-vouchers',
      },
    };
  }

  return {
    title: `سند موقت #${numStr} ثبت شد (در انتظار تأیید)`,
    body: `سند پیش‌نویس #${numStr} (${dateStr}) به مبلغ ${amountStr} آماده بررسی و دائم‌سازی است.\n${shortDesc}`,
    tag: `holoo-voucher-draft-${voucher.id}`,
    category: 'voucher',
    requireInteraction: false,
    renotify: true,
    target: {
      module: 'vouchers',
      intent: `voucher:${voucher.id}`,
      subKey: 'fin-vouchers',
    },
  };
}

export function emitVoucherNotificationEvent(event: VoucherNotificationEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VOUCHER_NOTIFICATION_EVENT, { detail: event }));
}

export function subscribeVoucherNotificationEvents(
  handler: (event: VoucherNotificationEvent) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<VoucherNotificationEvent>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(VOUCHER_NOTIFICATION_EVENT, listener);
  return () => window.removeEventListener(VOUCHER_NOTIFICATION_EVENT, listener);
}

export function subscribeNotificationNavigation(
  handler: (target: NativeNotificationTarget) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<NativeNotificationTarget>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, listener);
  return () => window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, listener);
}

export function subscribeNativeNotificationState(callbacks: {
  onPrefs?: (prefs: NativeNotificationPrefs) => void;
  onPermission?: (perm: NativeNotificationPermissionState) => void;
  onHistory?: (items: NativeNotificationHistoryItem[]) => void;
}): () => void {
  if (typeof window === 'undefined') return () => {};

  const handlePrefs = (ev: Event) => {
    const detail = (ev as CustomEvent<NativeNotificationPrefs>).detail;
    callbacks.onPrefs?.(detail ?? loadNativeNotificationPrefs());
  };
  const handlePermission = (ev: Event) => {
    const detail = (ev as CustomEvent<NativeNotificationPermissionState>).detail;
    callbacks.onPermission?.(detail ?? getNativeNotificationPermission());
  };
  const handleHistory = (ev: Event) => {
    const detail = (ev as CustomEvent<NativeNotificationHistoryItem[]>).detail;
    callbacks.onHistory?.(detail ?? loadNotificationHistory());
  };
  const handleStorage = () => {
    callbacks.onPrefs?.(loadNativeNotificationPrefs());
    callbacks.onHistory?.(loadNotificationHistory());
  };

  window.addEventListener(PREFS_CHANGED_EVENT, handlePrefs);
  window.addEventListener(PERMISSION_CHANGED_EVENT, handlePermission);
  window.addEventListener(HISTORY_CHANGED_EVENT, handleHistory);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(PREFS_CHANGED_EVENT, handlePrefs);
    window.removeEventListener(PERMISSION_CHANGED_EVENT, handlePermission);
    window.removeEventListener(HISTORY_CHANGED_EVENT, handleHistory);
    window.removeEventListener('storage', handleStorage);
  };
}

function formatNowTimestamp(): string {
  try {
    return new Date().toLocaleTimeString('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return new Date().toTimeString().slice(0, 8);
  }
}

/**
 * Dispatches a genuine OS/Native notification via the Web Notifications API
 * while the PWA is open, with automatic ServiceWorkerRegistration.showNotification
 * fallback for mobile Chromium/Android standalone PWAs where `new Notification()`
 * throws a TypeError.
 */
export async function dispatchNativeNotification(
  payload: NativeNotificationPayload,
  options?: { force?: boolean; prefs?: NativeNotificationPrefs }
): Promise<{ delivered: boolean; reason?: string }> {
  const prefs = options?.prefs ?? loadNativeNotificationPrefs();
  const force = Boolean(options?.force);

  if (!isNativeNotificationsSupported()) {
    return { delivered: false, reason: 'unsupported' };
  }

  const permission = getNativeNotificationPermission();
  if (permission !== 'granted') {
    return { delivered: false, reason: `permission_${permission}` };
  }

  if (!force && !prefs.enabled) {
    return { delivered: false, reason: 'disabled' };
  }

  if (
    !force &&
    prefs.onlyWhenBackgrounded &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  ) {
    return { delivered: false, reason: 'window_focused' };
  }

  const notifOptions: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    icon: PWA_ICON_URL,
    badge: PWA_ICON_URL,
    dir: 'rtl',
    lang: 'fa',
    tag: payload.tag,
    silent: prefs.silent,
    requireInteraction: Boolean(payload.requireInteraction && prefs.requireInteractionForCritical),
    renotify: payload.renotify ?? true,
    data: payload.target ?? null,
  };

  let delivered = false;

  try {
    const nativeNotif = new window.Notification(payload.title, notifOptions);
    nativeNotif.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore focus restriction
      }
      if (payload.target) {
        window.dispatchEvent(
          new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, { detail: payload.target })
        );
      }
      nativeNotif.close();
    };
    delivered = true;
  } catch {
    // On Android Chrome standalone PWAs, `new Notification()` throws Illegal constructor;
    // fall back seamlessly to the active PWA Service Worker's showNotification API.
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg && typeof reg.showNotification === 'function') {
          await reg.showNotification(payload.title, notifOptions);
          delivered = true;
        }
      } catch {
        delivered = false;
      }
    }
  }

  appendNotificationHistory({
    id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: formatNowTimestamp(),
    category: payload.category,
    title: payload.title,
    body: payload.body,
    delivered,
    target: payload.target,
  });

  return { delivered, reason: delivered ? undefined : 'dispatch_failed' };
}
