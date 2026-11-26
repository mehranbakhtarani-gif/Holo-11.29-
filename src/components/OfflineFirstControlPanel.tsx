import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Download,
  HardDrive,
  KeyRound,
  Lock,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Unlock,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { useOnlineStatus } from '../hooks/usePWAInstall';
import {
  buildIsolatedWorkspaceStorageKey,
  computeSnapshotSha256Hex,
  createLocalOfflinePasscodeRecord,
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
  hasBackupDigestBeenImported,
  inspectDeviceStorageHealth,
  loadOperatingMode,
  recordImportedBackupDigest,
  resolveEffectiveOperatingMode,
  saveOperatingMode,
  verifyLocalOfflinePasscode,
  type DeviceStorageHealth,
  type LocalOfflineCredentialRecord,
  type OperatingMode,
} from '../lib/offlineFirstCore';
import {
  OP_DB_VERSION,
  savePreUpdateSafetyBackup,
} from '../lib/operationalDb';
import {
  safeApplySwUpdateWithBackup,
  subscribeOfflineSwState,
  triggerSwUpdateCheck,
  type OfflineSwSnapshot,
} from '../lib/offlineStatus';
import { toPersianDigits } from '../lib/format';

const LOCAL_CRED_STORAGE_PREFIX = 'local_offline_credential_v1';

const MODE_OPTIONS: {
  id: OperatingMode;
  title: string;
  subtitle: string;
  detail: string;
}[] = [
  {
    id: 'local',
    title: 'حالت کاملاً محلی (Local)',
    subtitle: 'بدون هیچ اتصال ابری',
    detail: 'تمام عملیات، اسناد و گزارش‌ها صرفاً در IndexedDB دستگاه ذخیره می‌شوند و هیچ درخواستی به ابر ارسال نمی‌شود.',
  },
  {
    id: 'hybrid',
    title: 'حالت ترکیبی آفلاین-محور (Hybrid)',
    subtitle: 'پیشنهادی برای استفاده روزمره',
    detail: 'ثبت فوری روی دستگاه، صف‌بندی ایمن در Outbox هنگام قطعی نت و همگام‌سازی خودکار با محافظت تعارض مالی پس از اتصال.',
  },
  {
    id: 'online',
    title: 'حالت آنلاین ابری (Online)',
    subtitle: 'همگام‌سازی فوری + تداوم محلی',
    detail: 'ارسال و دریافت لحظه‌ای با Firebase/Supabase؛ در صورت قطعی ناگهانی نت، ثبت محلی متوقف نمی‌شود و در صف ذخیره می‌گردد.',
  },
];

function formatMb(bytes: number): string {
  if (!bytes || bytes <= 0) return '۰ مگابایت';
  return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
}

export const OfflineFirstControlPanel: React.FC<{
  highlighted?: boolean;
}> = ({ highlighted = false }) => {
  const {
    user,
    profile,
    deviceId,
    exportBackupJson,
    importBackupJson,
    logout,
    logActivity,
    showToast,
  } = useAccounting();

  const isOnline = useOnlineStatus();
  const [operatingMode, setOperatingMode] = useState<OperatingMode>(() => loadOperatingMode());
  const [storageHealth, setStorageHealth] = useState<DeviceStorageHealth | null>(null);
  const [swState, setSwState] = useState<OfflineSwSnapshot | null>(null);
  const [isUpdatingSw, setIsUpdatingSw] = useState(false);

  // Encrypted backup state
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const encryptedFileRef = useRef<HTMLInputElement | null>(null);

  // Offline local profile lock state
  const workspaceKey = buildIsolatedWorkspaceStorageKey(
    user?.uid || profile.companyName || 'default_local',
    LOCAL_CRED_STORAGE_PREFIX
  );
  const [localCred, setLocalCred] = useState<LocalOfflineCredentialRecord | null>(() => {
    try {
      const raw = localStorage.getItem(workspaceKey);
      return raw ? (JSON.parse(raw) as LocalOfflineCredentialRecord) : null;
    } catch {
      return null;
    }
  });
  const [newLocalPin, setNewLocalPin] = useState('');
  const [verifyPinInput, setVerifyPinInput] = useState('');
  const [localSessionLocked, setLocalSessionLocked] = useState(false);

  const effectiveCaps = resolveEffectiveOperatingMode(operatingMode, isOnline);

  const refreshStorage = useCallback(async () => {
    const health = await inspectDeviceStorageHealth();
    setStorageHealth(health);
  }, []);

  useEffect(() => {
    void refreshStorage();
    return subscribeOfflineSwState(setSwState);
  }, [refreshStorage]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(workspaceKey);
      setLocalCred(raw ? (JSON.parse(raw) as LocalOfflineCredentialRecord) : null);
    } catch {
      setLocalCred(null);
    }
  }, [workspaceKey]);

  const handleModeChange = (nextMode: OperatingMode) => {
    setOperatingMode(nextMode);
    saveOperatingMode(nextMode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('holoo:operating-mode-changed', { detail: nextMode }));
    }
    logActivity('معماری آفلاین', 'تغییر حالت کاری سامانه', `حالت عملکرد به ${nextMode} تغییر یافت (بدون حذف داده).`);
    showToast(`حالت کاری به «${MODE_OPTIONS.find((m) => m.id === nextMode)?.title}» تغییر یافت.`);
  };

  const handleExportEncryptedBackup = async () => {
    if (backupPassphrase.trim().length < 6) {
      showToast('رمز عبور پشتیبان رمزنگاری‌شده باید حداقل ۶ کاراکتر باشد.', 'error');
      return;
    }
    setIsEncrypting(true);
    try {
      const rawJson = exportBackupJson();
      const envelope = await encryptBackupEnvelope(rawJson, backupPassphrase);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `holoo-apex-encrypted-backup-${new Date().toISOString().slice(0, 10)}.holoo-enc.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupPassphrase('');
      logActivity(
        'پشتیبان رمزنگاری‌شده',
        'خروجی AES-256-GCM آفلاین',
        `پشتیبان رمزنگاری‌شده با امضای SHA-256 (${envelope.plaintextSha256.slice(0, 12)}…) تولید شد.`
      );
      showToast('فایل پشتیبان رمزنگاری‌شده AES-256-GCM با موفقیت دانلود شد.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'خطا در رمزنگاری پشتیبان.', 'error');
    } finally {
      setIsEncrypting(false);
    }
  };

  const handleImportEncryptedBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (restorePassphrase.trim().length < 6) {
      showToast('ابتدا رمز عبور فایل پشتیبان (حداقل ۶ کاراکتر) را وارد کنید.', 'error');
      return;
    }
    setIsDecrypting(true);
    try {
      const rawEnvelope = await file.text();
      const res = await decryptAndVerifyBackupEnvelope(rawEnvelope, restorePassphrase);
      if (!res.ok || !res.snapshotJson || !res.sha256) {
        showToast(res.error || 'رمزگشایی یا راستی‌آزمایی فایل پشتیبان ناموفق بود.', 'error');
        return;
      }
      if (hasBackupDigestBeenImported(res.sha256)) {
        showToast('این فایل پشتیبان دقیقاً قبلاً بازیابی شده است (محافظت ضدتکرار Import).', 'warning');
        return;
      }
      const imported = await importBackupJson(res.snapshotJson);
      if (imported) {
        recordImportedBackupDigest(res.sha256);
        setRestorePassphrase('');
        logActivity(
          'پشتیبان رمزنگاری‌شده',
          'بازیابی آفلاین AES-256-GCM',
          `پشتیبان معتبر (نسخه ${res.schemaVersion} · SHA-256: ${res.sha256.slice(0, 12)}…) با موفقیت بازیابی شد.`
        );
        showToast('پشتیبان رمزنگاری‌شده پس از تأیید کامل SHA-256 بازیابی شد.');
      }
    } catch {
      showToast('خواندن فایل پشتیبان رمزنگاری‌شده ناموفق بود.', 'error');
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleSetLocalOfflinePin = async () => {
    if (newLocalPin.trim().length < 4) {
      showToast('رمز ورود محلی آفلاین باید حداقل ۴ کاراکتر باشد.', 'error');
      return;
    }
    try {
      const record = await createLocalOfflinePasscodeRecord({
        workspaceId: user?.uid || profile.companyName || 'default_local',
        deviceId,
        passcode: newLocalPin,
        sessionTtlHours: 24 * 14,
      });
      localStorage.setItem(workspaceKey, JSON.stringify(record));
      setLocalCred(record);
      setNewLocalPin('');
      setLocalSessionLocked(false);
      logActivity('احراز هویت آفلاین', 'تنظیم رمز محلی PBKDF2-SHA-256', `پروفایل آفلاین با ایزوله‌سازی فضا فعال شد.`);
      showToast('رمز دسترسی آفلاین محلی (PBKDF2-SHA-256) با موفقیت ثبت شد.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ثبت رمز محلی ناموفق بود.', 'error');
    }
  };

  const handleVerifyLocalPin = async () => {
    if (!localCred) return;
    const res = await verifyLocalOfflinePasscode(localCred, verifyPinInput);
    if (res.expired) {
      showToast('اعتبار نشست محلی منقضی شده است؛ لطفاً رمز جدید تنظیم یا ورود مجدد کنید.', 'error');
      return;
    }
    if (!res.valid) {
      showToast('رمز محلی واردشده نادرست است.', 'error');
      return;
    }
    setLocalSessionLocked(false);
    setVerifyPinInput('');
    showToast('قفل نشست محلی آفلاین با موفقیت باز شد.');
  };

  const handleRequestPersistentStorage = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        await refreshStorage();
        showToast(
          granted
            ? 'حافظه پایدار مرورگر (Persistent Storage) فعال شد تا کش محلی پاک نشود.'
            : 'مرورگر مجوز پایدار خودکار را صادر نکرد؛ نصب PWA روی صفحه اصلی این مجوز را تقویت می‌کند.',
          granted ? 'success' : 'warning'
        );
      }
    } catch {
      showToast('بررسی مجوز حافظه پایدار در این مرورگر پشتیبانی نمی‌شود.', 'warning');
    }
  };

  const handleSafePwaUpdate = async () => {
    setIsUpdatingSw(true);
    try {
      if (!swState?.needRefresh) {
        await triggerSwUpdateCheck();
        showToast('بررسی نسخه جدید PWA انجام شد. اگر نسخه جدید آماده باشد، دکمه اعمال فعال می‌شود.');
        return;
      }
      const res = await safeApplySwUpdateWithBackup(async () => {
        const snap = exportBackupJson();
        const sha256 = await computeSnapshotSha256Hex(snap);
        return savePreUpdateSafetyBackup({
          id: `pre_update_${Date.now()}`,
          reason: 'pwa_update',
          schemaVersion: OP_DB_VERSION,
          sha256,
          snapshotJson: snap,
          createdAt: new Date().toISOString(),
        });
      });
      if (!res.applied && res.error) {
        showToast(`اعمال بروزرسانی متوقف شد (نسخه فعلی حفظ شد): ${res.error}`, 'error');
      }
    } finally {
      setIsUpdatingSw(false);
    }
  };

  return (
    <div
      className={`bg-white dark:bg-slate-900 border rounded-xl p-5 space-y-5 transition-all ${
        highlighted
          ? 'border-indigo-500 ring-2 ring-indigo-500/20'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shrink-0">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              مرکز کنترل معماری مستقل آفلاین-محور (Standalone Offline-First PWA)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-5">
              تغییر حالت کاری بدون حذف اطلاعات، پشتیبان رمزنگاری‌شده AES-256-GCM، قفل پروفایل آفلاین با ایزوله‌سازی فضا، پایش سهمیه حافظه و بروزرسانی امن PWA.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold shrink-0">
          {isOnline ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
              <Wifi className="w-3.5 h-3.5" />
              <span>شبکه متصل</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
              <WifiOff className="w-3.5 h-3.5" />
              <span>کاملاً آفلاین</span>
            </span>
          )}
        </div>
      </div>

      {/* 1. Operating Mode Selector (Local / Hybrid / Online) */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-bold text-slate-800 dark:text-slate-100">
            ۱. انتخاب حالت عملکرد سامانه (Local / Hybrid / Online)
          </span>
          <span className="text-slate-500 dark:text-slate-400 font-code">
            حالت مؤثر فعلی: {effectiveCaps.effectiveMode.toUpperCase()}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => {
            const active = operatingMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleModeChange(opt.id)}
                className={`text-right p-3.5 rounded-xl border transition-all ${
                  active
                    ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/40 ring-1 ring-indigo-500/30'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-white">{opt.title}</span>
                  {active && <CheckCircle2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />}
                </div>
                <div className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300 mt-1">
                  {opt.subtitle}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 leading-5">
                  {opt.detail}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. AES-256-GCM Encrypted Offline Backup & Restore */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>۲. پشتیبان آفلاین رمزنگاری‌شده (AES-256-GCM + SHA-256)</span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
            بدون نیاز به اینترنت، کل پایگاه داده حسابداری با رمز اختصاصی شما و امضای یکپارچگی SHA-256 رمزنگاری و در دستگاه ذخیره می‌شود.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              placeholder="رمز پشتیبان (حداقل ۶ کاراکتر)..."
              className="flex-1 px-3 py-2 rounded-lg text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
            />
            <button
              type="button"
              onClick={() => void handleExportEncryptedBackup()}
              disabled={isEncrypting}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isEncrypting ? 'در حال رمزنگاری...' : 'خروجی رمزنگاری‌شده'}</span>
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-slate-200/70 dark:border-slate-800">
            <input
              type="password"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              placeholder="رمز فایل برای بازیابی آفلاین..."
              className="flex-1 px-3 py-2 rounded-lg text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
            />
            <input
              ref={encryptedFileRef}
              type="file"
              accept=".json,.holoo-enc.json"
              onChange={(e) => void handleImportEncryptedBackup(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => encryptedFileRef.current?.click()}
              disabled={isDecrypting}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{isDecrypting ? 'در حال بررسی...' : 'بازیابی فایل رمزنگاری‌شده'}</span>
            </button>
          </div>
        </div>

        {/* 3. Offline Local Profile Auth & Separate Local / Cloud Logout */}
        <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
              <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>۳. احراز هویت محلی آفلاین و ایزوله‌سازی فضا</span>
            </div>
            <span className="text-[10.5px] font-code text-slate-500 dark:text-slate-400">
              {localCred ? 'PBKDF2 فعال' : 'بدون رمز محلی'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-5">
            رمز محلی به صورت هش‌شده (PBKDF2-SHA-256) ذخیره می‌شود و فقط برای ورود آفلاین دستگاه است (جدا از مجوز ابر). خروج ابری هرگز اطلاعات محلی را حذف نمی‌کند.
          </p>

          {localSessionLocked && localCred ? (
            <div className="flex gap-2">
              <input
                type="password"
                value={verifyPinInput}
                onChange={(e) => setVerifyPinInput(e.target.value)}
                placeholder="رمز محلی برای بازگشایی..."
                className="flex-1 px-3 py-2 rounded-lg text-xs bg-white dark:bg-slate-900 border border-amber-400 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => void handleVerifyLocalPin()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>باز کردن قفل</span>
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                value={newLocalPin}
                onChange={(e) => setNewLocalPin(e.target.value)}
                placeholder={localCred ? 'تغییر رمز محلی (حداقل ۴ کاراکتر)...' : 'تنظیم رمز ورود آفلاین (حداقل ۴ کاراکتر)...'}
                className="flex-1 px-3 py-2 rounded-lg text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => void handleSetLocalOfflinePin()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>ثبت رمز محلی</span>
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/70 dark:border-slate-800 text-[11px]">
            <span className="font-code text-slate-500 dark:text-slate-400 truncate max-w-[220px]" title={workspaceKey}>
              فضای ایزوله: {workspaceKey.slice(0, 26)}…
            </span>
            <div className="flex items-center gap-2">
              {localCred && !localSessionLocked && (
                <button
                  type="button"
                  onClick={() => setLocalSessionLocked(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold"
                >
                  <Lock className="w-3 h-3" />
                  <span>قفل نشست محلی</span>
                </button>
              )}
              {user && (
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-300/60 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 font-semibold"
                >
                  <LogOut className="w-3 h-3" />
                  <span>خروج ابری (حفظ داده محلی)</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 4. Storage Quota, Eviction Guard & Safe PWA Update */}
      <div className="p-4 rounded-xl bg-slate-50/80 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
              {storageHealth?.status === 'critical' ? (
                <AlertTriangle className="w-4 h-4 text-rose-600" />
              ) : (
                <Cloud className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              )}
              <span>۴. پایش ظرفیت حافظه محلی (Eviction Guard) و بروزرسانی کنترل‌شده PWA</span>
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
              {storageHealth?.supported ? (
                <>
                  <span>مصرف‌شده: {formatMb(storageHealth.usageBytes)}</span>
                  <span>·</span>
                  <span>سهمیه کل: {formatMb(storageHealth.quotaBytes)}</span>
                  <span>·</span>
                  <span>حافظه پایدار: {storageHealth.persisted ? 'فعال' : 'غیردائمی'}</span>
                </>
              ) : (
                <span>تخمین سهمیه حافظه در این مرورگر در دسترس نیست.</span>
              )}
              <span>·</span>
              <span>
                نسخه IndexedDB: v{toPersianDigits(OP_DB_VERSION)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleRequestPersistentStorage()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>محافظت از پاکشدن حافظه</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSafePwaUpdate()}
              disabled={isUpdatingSw}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 ${
                swState?.needRefresh
                  ? 'bg-indigo-600 hover:bg-indigo-700'
                  : 'bg-slate-700 hover:bg-slate-800'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isUpdatingSw ? 'animate-spin' : ''}`} />
              <span>
                {swState?.needRefresh
                  ? 'پشتیبان ایمنی و اعمال نسخه جدید'
                  : 'بررسی بروزرسانی PWA'}
              </span>
            </button>
          </div>
        </div>

        {storageHealth?.warningMessage && (
          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{storageHealth.warningMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
};
