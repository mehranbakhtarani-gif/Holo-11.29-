import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  BellOff,
  BellRing,
  Calculator,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Cloud,
  CloudOff,
  Database,
  FileCheck2,
  FileSpreadsheet,
  GitCompareArrows,
  HardDrive,
  HelpCircle,
  KeyRound,
  Keyboard,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  LogIn,
  LogOut,
  Menu,
  Moon,
  Package,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Volume2,
  VolumeX,
  Wallet,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { ActiveModule } from './types/accounting';
import { useAccounting } from './context/AccountingContext';
import { useWorkspaceExtensions } from './context/WorkspaceExtensionsContext';
import { DashboardView } from './components/DashboardView';
import { MeshInitialSetupModal } from './components/MeshInitialSetupModal';
import { PeerMeshSyncButton } from './components/PeerMeshSyncButton';
import { SyncConflictResolutionModal } from './components/SyncConflictResolutionModal';
import { OfflineIndicator, PwaUpdateBanner } from './components/PWAInstallButton';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { useDualCloudSync } from './hooks/useDualCloudSync';
import { useLocalFirstMeshSync } from './hooks/useLocalFirstMeshSync';
import financeDirectorAvatar from './assets/images/avatar_finance_director_1795265732394.jpg';

// Lazy-loaded secondary views and heavy on-demand drawers (keeps initial bundle lean)
const InvoicesView = lazy(() => import('./components/InvoicesView').then((m) => ({ default: m.InvoicesView })));
const VouchersView = lazy(() => import('./components/VouchersView').then((m) => ({ default: m.VouchersView })));
const AuditView = lazy(() => import('./components/AuditView').then((m) => ({ default: m.AuditView })));
const AccountsView = lazy(() => import('./components/AccountsView').then((m) => ({ default: m.AccountsView })));
const PartiesView = lazy(() => import('./components/PartiesView').then((m) => ({ default: m.PartiesView })));
const InventoryView = lazy(() => import('./components/InventoryView').then((m) => ({ default: m.InventoryView })));
const TreasuryView = lazy(() => import('./components/TreasuryView').then((m) => ({ default: m.TreasuryView })));
const CorporateView = lazy(() => import('./components/CorporateView').then((m) => ({ default: m.CorporateView })));
const ReportsView = lazy(() => import('./components/ReportsView').then((m) => ({ default: m.ReportsView })));
const BrandStudioView = lazy(() => import('./components/BrandStudioView').then((m) => ({ default: m.BrandStudioView })));
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const CurrenciesView = lazy(() => import('./components/CurrenciesView').then((m) => ({ default: m.CurrenciesView })));
const ImportAndSubcontractView = lazy(() =>
  import('./components/ImportAndSubcontractView').then((m) => ({ default: m.ImportAndSubcontractView }))
);
const FinanceOpsView = lazy(() => import('./components/FinanceOpsView').then((m) => ({ default: m.FinanceOpsView })));
const WarehouseCrmOpsView = lazy(() =>
  import('./components/WarehouseCrmOpsView').then((m) => ({ default: m.WarehouseCrmOpsView }))
);
const SmartCopilotDrawer = lazy(() =>
  import('./components/SmartCopilotDrawer').then((m) => ({ default: m.SmartCopilotDrawer }))
);
const SystemHealthDrawer = lazy(() =>
  import('./components/SystemHealthDrawer').then((m) => ({ default: m.SystemHealthDrawer }))
);
const OfflineQueueMonitorDrawer = lazy(() =>
  import('./components/OfflineQueueMonitorDrawer').then((m) => ({ default: m.OfflineQueueMonitorDrawer }))
);
const OfflineSmartGuideDrawer = lazy(() =>
  import('./components/OfflineSmartGuideDrawer').then((m) => ({ default: m.OfflineSmartGuideDrawer }))
);
const UniversalExcelImportModal = lazy(() =>
  import('./components/UniversalExcelImportModal').then((m) => ({ default: m.UniversalExcelImportModal }))
);

function mapActiveModuleToExcelEntity(
  mod: ActiveModule
): 'parties' | 'products' | 'accounts' | 'vouchers' | 'invoices' | 'cheques' | 'employees' | 'costCenters' {
  switch (mod) {
    case 'parties':
      return 'parties';
    case 'inventory':
    case 'warehouse-crm':
      return 'products';
    case 'accounts':
      return 'accounts';
    case 'vouchers':
    case 'audit':
    case 'finance-ops':
      return 'vouchers';
    case 'invoices':
    case 'commercial':
      return 'invoices';
    case 'treasury':
    case 'currencies':
      return 'cheques';
    case 'corporate':
      return 'employees';
    default:
      return 'parties';
  }
}

const ModuleLoadingFallback: React.FC = () => (
  <div className="min-h-[320px] flex items-center justify-center">
    <div className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-300 shadow-sm">
      <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
      <span>در حال بارگذاری ماژول...</span>
    </div>
  </div>
);
import { useNativeNotifications } from './hooks/useNativeNotifications';
import {
  QuickCalculatorModal,
  ShortcutHelpModal,
} from './components/ShortcutHelpModal';
import { SmartGlobalSearchModal } from './components/SmartGlobalSearch';
import {
  HOLOO_MENU_TREE,
  findGroupIdForModule,
  getBreadcrumbLabel,
} from './lib/holooMenuTree';
import { formatCompactMoney, toPersianDigits } from './lib/format';
import { computeChequeAlerts, useChequeAlertPreferences } from './lib/chequeAlerts';
import { RBAC_ROLE_LABELS } from './lib/enterpriseAccounting';

// HOLOO_MENU_TREE is imported from ./lib/holooMenuTree (single source of truth for Sidebar + Smart Search)

const ALL_MODULES: ActiveModule[] = [
  'dashboard',
  'invoices',
  'vouchers',
  'audit',
  'accounts',
  'parties',
  'inventory',
  'treasury',
  'currencies',
  'commercial',
  'corporate',
  'finance-ops',
  'warehouse-crm',
  'reports',
  'studio',
  'settings',
];



export default function App() {
  const {
    user,
    profile,
    updateProfilePhoto,
    accounts,
    parties,
    cheques,
    vouchers,
    trialBalance,
    balanceSheet,
    auditReport,
    activeOperator,
    isCloudMode,
    isSyncing,
    isSigningIn,
    deviceId,
    deviceLabel,
    localSnapshots,
    lastLocalBackupAt,
    triggerLocalBackupNow,
    toast,
    showToast,
    audioEnabled,
    setAudioEnabled,
    loginWithGoogle,
    logout,
    setCurrencyUnit,
    exportBackupJson,
  } = useAccounting();

  const { onlineDevices, otherOnlineDevices, setPresenceModule } =
    useWorkspaceExtensions();

  const isOnline = useOnlineStatus();
  const dualCloud = useDualCloudSync();
  const localMesh = useLocalFirstMeshSync();
  const {
    supabaseStatus,
    supabaseBackups,
    supabaseWorkspaceId,
    setSupabaseWorkspaceId,
    supabaseWorkspaceInitialized,
    isSupabaseAuthenticated,
    supabaseAuthMode,
    isSupabaseAuthLoading,
    supabaseAutoBackupEnabled,
    setSupabaseAutoBackupEnabled,
    lastSupabaseError,
    setupIndependentSupabase,
    loginIndependentSupabase,
    logoutIndependentSupabase,
    conflictPolicy,
    conflictDefaultMode,
    setConflictDefaultMode,
    pendingConflict,
    isResolvingConflict,
    resolvePendingConflict,
    dismissPendingConflict,
    pendingQueueCount,
    flushOutboxNow,
    clearPendingOutbox,
    lastSupabaseRevision,
    lastSupabaseSyncAt,
    isSupabaseSyncing,
    lastConflictNote,
    syncSupabaseNow,
    pullFromSupabase,
    refreshSupabaseStatus,
    isTestingServer,
    runServerTest,
    firebaseBackups,
    isFirebaseBackingUp,
    lastFirebaseBackupAt,
    lastFirebaseRevision,
    pushToFirebaseNow,
    pullFromFirebaseNow,
    refreshFirebaseBackups,
    maxCloudBackups,
  } = dualCloud;

  const [sbPasscode, setSbPasscode] = useState('');

  const { prefs: chequeAlertPrefs } = useChequeAlertPreferences();

  const chequeAlertSummary = useMemo(
    () =>
      computeChequeAlerts({
        cheques,
        accounts,
        trialBalance,
        parties,
        leadDays: chequeAlertPrefs.leadDays,
        snoozedMap: chequeAlertPrefs.snoozedMap,
      }),
    [cheques, accounts, trialBalance, parties, chequeAlertPrefs.leadDays, chequeAlertPrefs.snoozedMap]
  );

  const pendingDraftVouchers = useMemo(
    () =>
      vouchers
        .filter((v) => v.status === 'draft')
        .sort((a, b) => b.voucherNumber - a.voucherNumber)
        .slice(0, 4),
    [vouchers]
  );
  const totalDraftVoucherCount = useMemo(
    () => vouchers.filter((v) => v.status === 'draft').length,
    [vouchers]
  );

  const [activeModule, setActiveModule] = useState<ActiveModule>('dashboard');
  const [moduleIntent, setModuleIntent] = useState<string | undefined>(undefined);
  const [activeSubKey, setActiveSubKey] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    finance: false,
    inventory: false,
    operations: false,
    activity: false,
    settings: false,
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('holoo_theme_mode');
    if (saved === 'light') return false;
    return true; // Dark Mode Default matching Zenith reference
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  const [showHealthDrawer, setShowHealthDrawer] = useState(false);
  const [showQueueMonitor, setShowQueueMonitor] = useState(false);
  const [showOfflineGuide, setShowOfflineGuide] = useState(false);
  const [showUniversalExcelImport, setShowUniversalExcelImport] = useState(false);
  const [showChequePopover, setShowChequePopover] = useState(false);
  const [showCloudPopover, setShowCloudPopover] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('لطفاً یک فایل تصویری انتخاب کنید.');
      return;
    }
    try {
      const imageUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('خواندن تصویر ناموفق بود.'));
        reader.onerror = () => reject(new Error('خواندن تصویر ناموفق بود.'));
        reader.readAsDataURL(file);
      });
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('فایل تصویر معتبر نیست.'));
        element.src = imageUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('پردازش تصویر در این مرورگر پشتیبانی نمی‌شود.');
      const side = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 256, 256);
      let quality = 0.82;
      let photoData = canvas.toDataURL('image/jpeg', quality);
      while (photoData.length > 200_000 && quality > 0.45) {
        quality -= 0.08;
        photoData = canvas.toDataURL('image/jpeg', quality);
      }
      if (photoData.length > 200_000) throw new Error('حجم عکس انتخابی بیش از حد مجاز است.');
      await updateProfilePhoto(photoData);
      setAvatarError(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ذخیره عکس پروفایل ناموفق بود.');
    }
  }, [showToast, updateProfilePhoto]);

  const combinedPendingQueueCount = localMesh.pendingOutboxCount + pendingQueueCount;

  const systemHealthHasCritical = auditReport.errorCount > 0 || !balanceSheet.isBalanced;
  const systemHealthHasWarning = auditReport.warningCount > 0 || !isOnline;

  // Sync Tailwind v4 dark class on <html> and persist preference
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem('holoo_theme_mode', darkMode ? 'dark' : 'light');
    } catch {
      // ignore storage quota errors
    }
  }, [darkMode]);

  useEffect(() => {
    setPresenceModule(activeModule);
  }, [activeModule, setPresenceModule]);

  const navigate = useCallback((mod: ActiveModule, intent?: string, subKey?: string) => {
    setActiveModule(mod);
    setModuleIntent(intent);
    setActiveSubKey(subKey ?? null);
    const gid = findGroupIdForModule(mod, intent);
    if (gid !== 'dashboard') {
      setOpenGroups((prev) => ({ ...prev, [gid]: true }));
    }
    setMobileMenuOpen(false);
  }, []);

  const nativeNotifications = useNativeNotifications({
    chequeAlertSummary,
    companyName: profile.companyName,
    currencyUnit: profile.currencyUnit,
    onNavigate: navigate,
    showToast,
  });

  // Read PWA deep-link shortcut URL params on initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') as ActiveModule | null;
    const action = params.get('action') || undefined;
    if (view && ALL_MODULES.includes(view)) {
      navigate(view, action);
    }
  }, [navigate]);

  // Global Holoo Sherkati Apex Keyboard Shortcuts (F1 - F10, Ctrl+K, Ctrl+J, Alt+C, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowShortcuts(false);
        setShowCommandPalette(false);
        setShowCopilot(false);
        setShowHealthDrawer(false);
        setShowQueueMonitor(false);
        setShowOfflineGuide(false);
        setShowChequePopover(false);
        setShowCloudPopover(false);
        setMobileMenuOpen(false);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setShowCopilot((prev) => !prev);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setShowHealthDrawer((prev) => !prev);
        return;
      }

      if (e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        setShowOfflineGuide((prev) => !prev);
        return;
      }

      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowCalculator((prev) => !prev);
        return;
      }

      switch (e.key) {
        case 'F1':
          e.preventDefault();
          setShowShortcuts((prev) => !prev);
          break;
        case 'F2':
          e.preventDefault();
          navigate('invoices', 'new-sale', 'inv-sale');
          break;
        case 'F3':
          e.preventDefault();
          navigate('vouchers', 'new-voucher', 'voucher-new');
          break;
        case 'F4':
          e.preventDefault();
          navigate('invoices', 'new-purchase', 'inv-purchase');
          break;
        case 'F5':
          e.preventDefault();
          navigate('parties', undefined, 'parties');
          break;
        case 'F6':
          e.preventDefault();
          navigate('inventory', undefined, 'inventory-base');
          break;
        case 'F7':
          e.preventDefault();
          navigate('treasury', 'cheques', 'tr-cheques');
          break;
        case 'F8':
          e.preventDefault();
          navigate('corporate', 'payroll', 'corp-payroll');
          break;
        case 'F9':
          e.preventDefault();
          navigate('reports', 'trial', 'rep-trial');
          break;
        case 'F10':
          e.preventDefault();
          navigate('dashboard');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderMenuTree = () => (
    <div className="space-y-1.5">
      {HOLOO_MENU_TREE.map((group) => {
        const Icon = group.icon;
        if (group.directModule) {
          const isActive = activeModule === group.directModule;
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => navigate(group.directModule!)}
              className={`relative w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-xl text-[13px] transition-colors cursor-pointer ${
                isActive
                  ? 'text-[#0F172A] dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-white/[0.05] hover:text-[#0F172A] dark:hover:text-white font-medium'
              }`}
            >
              {isActive && (
                <motion.div
                  layoutId="desktopActiveNav"
                  transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.8 }}
                  className="absolute inset-0 rounded-xl bg-indigo-50/90 dark:bg-white/[0.10] border border-indigo-200/70 dark:border-white/[0.09]"
                />
              )}
              <span className="flex items-center gap-3 min-w-0 relative z-10">
                <Icon
                  className={`w-[18px] h-[18px] shrink-0 ${
                    isActive ? 'text-indigo-600 dark:text-white' : 'text-slate-500 dark:text-slate-400'
                  }`}
                />
                <span className="truncate">{group.label}</span>
              </span>
              {group.shortcut && (
                <span className="font-code text-[10px] text-slate-400 dark:text-slate-500 shrink-0 relative z-10">
                  {group.shortcut}
                </span>
              )}
            </button>
          );
        }

        const isOpen = !!openGroups[group.id];
        const groupHasActive = group.items?.some((it) =>
          activeSubKey ? it.key === activeSubKey : it.module === activeModule
        );

        return (
          <div key={group.id} className="space-y-0.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className={`relative w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-xl text-[13px] transition-colors cursor-pointer ${
                groupHasActive
                  ? 'text-[#0F172A] dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-white/[0.05] hover:text-[#0F172A] dark:hover:text-white font-medium'
              }`}
            >
              {groupHasActive && (
                <motion.div
                  layoutId="desktopActiveNav"
                  transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.8 }}
                  className="absolute inset-0 rounded-xl bg-indigo-50/90 dark:bg-white/[0.10] border border-indigo-200/70 dark:border-white/[0.09]"
                />
              )}
              <span className="flex items-center gap-3 min-w-0 relative z-10">
                <Icon
                  className={`w-[18px] h-[18px] shrink-0 ${
                    groupHasActive
                      ? 'text-indigo-600 dark:text-white'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                />
                <span className="truncate">{group.label}</span>
              </span>
              <span className="relative z-10">
                {isOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                ) : (
                  <ChevronLeft className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                )}
              </span>
            </button>

            {isOpen && group.items && (
              <div className="pr-5 pl-1 pt-1 pb-1.5 space-y-0.5 border-r border-slate-200/80 dark:border-white/[0.07] mr-5">
                {group.items.map((sub) => {
                  const isSubActive = activeSubKey
                    ? activeSubKey === sub.key
                    : activeModule === sub.module && !sub.intent;
                  const showAuditAlert =
                    sub.module === 'audit' &&
                    (auditReport.errorCount > 0 || auditReport.warningCount > 0);
                  const showChequeAlert =
                    sub.key === 'tr-cheques' && chequeAlertSummary.urgentAlerts.length > 0;
                  return (
                    <button
                      key={sub.key}
                      type="button"
                      onClick={() => navigate(sub.module, sub.intent, sub.key)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11.5px] transition-colors text-right cursor-pointer ${
                        isSubActive
                          ? 'bg-indigo-500/15 text-indigo-700 dark:text-[#818CF8] font-semibold'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/70 dark:hover:bg-white/[0.05] hover:text-[#0F172A] dark:hover:text-white'
                      }`}
                    >
                      <span className="truncate">{sub.label}</span>
                      {showAuditAlert ? (
                        <span
                          className={`font-code text-[10px] font-bold shrink-0 ${
                            auditReport.errorCount > 0
                              ? 'text-red-500 dark:text-red-400'
                              : 'text-amber-500 dark:text-amber-400'
                          }`}
                        >
                          {toPersianDigits(
                            auditReport.errorCount > 0
                              ? auditReport.errorCount
                              : auditReport.warningCount
                          )}
                        </span>
                      ) : showChequeAlert ? (
                        <span
                          className={`font-code text-[10px] font-bold shrink-0 ${
                            chequeAlertSummary.overdueCount > 0 ||
                            chequeAlertSummary.dueTodayCount > 0 ||
                            chequeAlertSummary.bouncedCount > 0
                              ? 'text-red-500 dark:text-red-400'
                              : 'text-amber-500 dark:text-amber-400'
                          }`}
                        >
                          {toPersianDigits(chequeAlertSummary.urgentAlerts.length)}
                        </span>
                      ) : sub.shortcut ? (
                        <span className="font-code text-[10px] text-slate-400 dark:text-slate-500 shrink-0">
                          {sub.shortcut}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const breadcrumbText = getBreadcrumbLabel(activeModule, activeSubKey);

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen flex bg-[#F8FAFC] dark:bg-[#0B0F17] dark:bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.12),transparent_48%),radial-gradient(ellipse_at_bottom_left,rgba(16,185,129,0.08),transparent_45%)] text-[#0F172A] dark:text-slate-100 transition-colors">
      <a
        href="#main-accounting-viewport"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:right-2 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-indigo-600 focus:text-white focus:text-xs focus:font-semibold"
      >
        پرش به محتوای اصلی
      </a>

      {/* Floating Frosted-Glass Desktop RTL Sidebar (Matches Reference Aesthetic) */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 my-3 mr-3 h-[calc(100vh-1.5rem)] sticky top-3 rounded-2xl bg-white/85 dark:bg-[#161B26]/80 backdrop-blur-xl border border-slate-200/80 dark:border-white/[0.08] shadow-[0_8px_32px_-12px_rgba(15,23,42,0.12)] dark:shadow-[0_20px_50px_-16px_rgba(0,0,0,0.75)] overflow-hidden no-print">
        {/* Brand Header */}
        <div className="px-4 py-4 flex items-center justify-between border-b border-slate-200/70 dark:border-white/[0.07]">
          <button
            type="button"
            onClick={() => navigate('dashboard')}
            className="flex items-center gap-3 min-w-0 text-right cursor-pointer"
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 flex items-center justify-center text-white font-black text-base shadow-lg shadow-indigo-500/30 shrink-0">
              هـ
            </div>
            <div className="min-w-0">
              <div className="text-sm font-extrabold tracking-tight text-[#0F172A] dark:text-white truncate">
                هلو آپکس
              </div>
              <div className="text-[10.5px] font-medium text-slate-500 dark:text-slate-400 tabular-nums font-code">
                سال مالی {toPersianDigits(profile.fiscalYear)}
              </div>
            </div>
          </button>
        </div>

        {/* Clean 6-Group Navigation */}
        <nav className="flex-1 overflow-y-auto p-3" aria-label="منوی اصلی هلو آپکس">
          {renderMenuTree()}
        </nav>

        {/* Compact Sidebar Utilities Footer (Zero Lost Features, Zero Header Clutter) */}
        <div className="p-3 border-t border-slate-200/70 dark:border-white/[0.07] space-y-2 bg-slate-50/50 dark:bg-white/[0.02]">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setShowCopilot(true)}
              title="دستیار هوشمند مالی (Ctrl+J)"
              className="inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-xl border border-indigo-200/80 dark:border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-[#818CF8] hover:bg-indigo-500/15 transition-colors whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>دستیار AI</span>
            </button>
            <button
              type="button"
              onClick={() => setShowUniversalExcelImport(true)}
              title="ورود گروهی داده از اکسل (.xlsx / .csv)"
              className="inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-xl border border-emerald-200/80 dark:border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
              <span>ورود اکسل</span>
            </button>
            <button
              type="button"
              onClick={() => setShowHealthDrawer(true)}
              title="پایش هوشمند سلامت و آفلاین (Ctrl+Shift+H)"
              className={`inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-xl border transition-colors whitespace-nowrap cursor-pointer ${
                systemHealthHasCritical
                  ? 'border-red-300 dark:border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
                  : 'border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.07]'
              }`}
            >
              <Activity className="w-3.5 h-3.5 shrink-0" />
              <span>سلامت</span>
            </button>
            <button
              type="button"
              onClick={() => setShowQueueMonitor(true)}
              title="مانیتور صف آفلاین (sync_outbox)"
              className={`inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-xl border transition-colors whitespace-nowrap cursor-pointer ${
                combinedPendingQueueCount > 0
                  ? 'border-amber-300 dark:border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-slate-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.07]'
              }`}
            >
              <Database className="w-3.5 h-3.5 shrink-0" />
              <span>صف آفلاین</span>
              {combinedPendingQueueCount > 0 && (
                <span className="font-code tabular-nums text-[10px] font-bold">
                  {toPersianDigits(combinedPendingQueueCount)}
                </span>
              )}
            </button>
          </div>

          <div className="flex items-center justify-between gap-1.5">
            <button
              type="button"
              onClick={() => setShowOfflineGuide(true)}
              title="راهنمای هوشمند آفلاین (Alt+G)"
              className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 text-[10.5px] font-medium rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100/80 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5 shrink-0" />
              <span>راهنما</span>
            </button>
            <button
              type="button"
              onClick={() => setShowCalculator((p) => !p)}
              title="ماشین‌حساب (Alt+C)"
              className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 text-[10.5px] font-medium rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100/80 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Calculator className="w-3.5 h-3.5 shrink-0" />
              <span>حساب</span>
            </button>
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              title="میانبرهای صفحه‌کلید (F1)"
              className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 text-[10.5px] font-medium rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100/80 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              <Keyboard className="w-3.5 h-3.5 shrink-0" />
              <span>F1</span>
            </button>
            <button
              type="button"
              onClick={() => setAudioEnabled(!audioEnabled)}
              title={audioEnabled ? 'قطع صدای برنامه' : 'وصل صدای برنامه'}
              aria-label={audioEnabled ? 'قطع صدای برنامه' : 'وصل صدای برنامه'}
              className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100/80 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
            >
              {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </button>
          </div>

          <div className="pt-0.5">
            <PeerMeshSyncButton
              variant="header"
              isMeshActive={localMesh.meshSelfOnline || localMesh.connectedPeerCount > 0}
              isSyncing={localMesh.isP2PSyncing}
              connectedPeerCount={localMesh.connectedPeerCount}
              isConfigured={Boolean(localMesh.selectedPeerId)}
              onClick={() => {
                if (!localMesh.selectedPeerId) {
                  localMesh.setNeedsInitialSetup(true);
                } else {
                  navigate('audit', 'p2p_mesh_log', 'audit-center');
                }
              }}
            />
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div className="w-72 max-w-[84vw] bg-white/95 dark:bg-[#161B26]/95 backdrop-blur-2xl h-full border-l border-slate-200 dark:border-white/10 flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-white/[0.08]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 flex items-center justify-center text-white font-black text-sm shadow-md shadow-indigo-500/30">
                  هـ
                </div>
                <span className="font-extrabold text-sm text-[#0F172A] dark:text-white">
                  هلو آپکس
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 cursor-pointer"
                aria-label="بستن منو"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">{renderMenuTree()}</nav>
            <div className="p-3 border-t border-slate-200 dark:border-white/10 space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setShowHealthDrawer(true);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-lg border ${
                    systemHealthHasCritical
                      ? 'border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
                      : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5 shrink-0" />
                  <span>سلامت سیستم</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setShowQueueMonitor(true);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-lg border ${
                    combinedPendingQueueCount > 0
                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                      : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <Database className="w-3.5 h-3.5 shrink-0" />
                  <span>صف آفلاین</span>
                  {combinedPendingQueueCount > 0 && (
                    <span className="px-1 rounded bg-amber-600 text-white font-code text-[10px]">
                      {toPersianDigits(combinedPendingQueueCount)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setCurrencyUnit(profile.currencyUnit === 'IRT' ? 'IRR' : 'IRT')}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-2 text-[11px] font-semibold rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-slate-200"
                >
                  <span>واحد: {profile.currencyUnit === 'IRT' ? 'تومان' : 'ریال'}</span>
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDarkMode((d) => !d)}
                    className="flex-1 inline-flex items-center justify-center gap-1 py-2 px-2 text-[11px] font-semibold rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-slate-200"
                    aria-label="تغییر پوسته"
                  >
                    {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                    <span>{darkMode ? 'روشن' : 'تاریک'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAudioEnabled(!audioEnabled)}
                    className="p-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300"
                    aria-label={audioEnabled ? 'قطع صدای برنامه' : 'وصل صدای برنامه'}
                  >
                    {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  if (!localMesh.selectedPeerId) {
                    localMesh.setNeedsInitialSetup(true);
                  } else {
                    navigate('audit', 'p2p_mesh_log', 'audit-center');
                  }
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg border border-indigo-200 dark:border-indigo-800/80 bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-300"
              >
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>
                  همگام‌سازی P2P Mesh ({toPersianDigits(localMesh.connectedPeerCount)} دستگاه متصل)
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setShowOfflineGuide(true);
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300"
              >
                <HelpCircle className="w-4 h-4 shrink-0" />
                <span>راهنمای هوشمند آفلاین</span>
              </button>
            </div>
          </div>
          <div
            className="flex-1 bg-slate-950/50 dark:backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Floating Frosted-Glass Top Utility Bar (Exact Reference Structure) */}
        <header className="sticky top-3 z-30 mx-3 sm:mx-4 lg:mx-6 mt-3 h-14 px-4 sm:px-5 rounded-2xl bg-white/85 dark:bg-[#161B26]/80 backdrop-blur-xl border border-slate-200/80 dark:border-white/[0.08] shadow-[0_6px_24px_-12px_rgba(15,23,42,0.12)] dark:shadow-[0_14px_36px_-14px_rgba(0,0,0,0.7)] flex items-center justify-between gap-3 sm:gap-4 no-print">
          {/* Start Zone: Mobile Menu + Clean Page Title */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 cursor-pointer"
              aria-label="منو"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-sm sm:text-base font-bold text-[#0F172A] dark:text-white tracking-tight truncate">
              {breadcrumbText}
            </h1>
          </div>

          {/* Center Zone: Smart Global Search Trigger (جستجوی هوشمند منوها، اسناد و حساب‌ها Ctrl+K) */}
          <button
            type="button"
            onClick={() => setShowCommandPalette(true)}
            className="hidden md:flex items-center justify-between gap-4 w-72 lg:w-88 px-3.5 py-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-100/85 dark:bg-[#0B0F17]/65 hover:bg-slate-100 dark:hover:bg-[#0B0F17]/85 rounded-xl border border-slate-200/80 dark:border-white/10 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2 truncate">
              <Search className="w-3.5 h-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
              <span>جستجوی هوشمند منوها، اسناد و حساب‌ها...</span>
            </span>
            <kbd className="font-code text-[10px] px-1.5 py-0.5 rounded-md bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 shrink-0">
              Ctrl+K
            </kbd>
          </button>

          {/* End Zone: Mobile Search + Bell + Theme Toggle + Cloud Sync + Settings + Profile + Logout */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowCommandPalette(true)}
              title="جستجوی هوشمند منوها، اسناد و حساب‌ها (Ctrl+K)"
              aria-label="جستجوی هوشمند منوها، اسناد و حساب‌ها"
              className="md:hidden p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <Search className="w-[18px] h-[18px]" />
            </button>
            {/* Notification Bell with Indigo Badge Count */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowCloudPopover(false);
                  setShowChequePopover((p) => !p);
                }}
                title="اعلان‌های هوشمند سررسید چک"
                aria-label="اعلان‌های هوشمند سررسید چک"
                aria-expanded={showChequePopover}
                className="relative p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                <Bell className="w-[18px] h-[18px]" />
                {chequeAlertSummary.urgentAlerts.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold font-code tabular-nums flex items-center justify-center shadow-sm shadow-indigo-500/40">
                    {toPersianDigits(chequeAlertSummary.urgentAlerts.length)}
                  </span>
                )}
              </button>

              {showChequePopover && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowChequePopover(false)}
                    aria-hidden="true"
                  />
                  <div className="fixed inset-x-3 top-20 sm:absolute sm:inset-x-auto sm:left-0 sm:top-auto sm:mt-2 sm:w-96 max-h-[80dvh] overflow-y-auto z-[70] bg-white dark:bg-[#151A24]/95 backdrop-blur-xl border border-slate-200 dark:border-white/12 rounded-2xl shadow-2xl text-right">
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-[#0F172A] dark:text-white">
                          مرکز اعلان‌های چک و اسناد ({toPersianDigits(chequeAlertSummary.leadDays)} روز آینده)
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-code tabular-nums">
                          امروز {toPersianDigits(chequeAlertSummary.todayShamsi)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowChequePopover(false)}
                        className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                        aria-label="بستن اعلان‌ها"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Native Web Notifications API Quick Activation / Control Strip */}
                    {nativeNotifications.isSupported && (
                      <div className="px-4 py-2.5 bg-indigo-50/70 dark:bg-indigo-950/35 border-b border-indigo-200/70 dark:border-indigo-900/50 flex items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-2 min-w-0">
                          {nativeNotifications.permission === 'granted' && nativeNotifications.prefs.enabled ? (
                            <BellRing className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          ) : (
                            <BellOff className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                          )}
                          <span className="text-slate-700 dark:text-slate-200 font-medium truncate">
                            {nativeNotifications.permission === 'granted'
                              ? nativeNotifications.prefs.enabled
                                ? 'اعلان بومی PWA فعال است'
                                : 'اعلان بومی PWA متوقف است'
                              : nativeNotifications.permission === 'denied'
                                ? 'مجوز اعلان مرورگر مسدود است'
                                : 'اعلان بومی سیستم‌عامل غیرفعال'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {nativeNotifications.permission === 'default' && (
                            <button
                              type="button"
                              onClick={() => void nativeNotifications.requestPermission()}
                              className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold transition-colors cursor-pointer whitespace-nowrap"
                            >
                              فعال‌سازی
                            </button>
                          )}
                          {nativeNotifications.permission === 'granted' && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  nativeNotifications.updatePrefs({
                                    enabled: !nativeNotifications.prefs.enabled,
                                  })
                                }
                                className="px-2 py-1 rounded-lg border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium cursor-pointer"
                              >
                                {nativeNotifications.prefs.enabled ? 'توقف' : 'فعال'}
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const sent = await nativeNotifications.sendChequeRemindersNow({
                                    bypassDedup: true,
                                  });
                                  if (sent > 0) {
                                    showToast(
                                      `${toPersianDigits(sent)} اعلان بومی سررسید چک ارسال شد.`
                                    );
                                  } else {
                                    await nativeNotifications.sendTestNotification();
                                  }
                                }}
                                className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium cursor-pointer whitespace-nowrap"
                              >
                                ارسال الان
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setShowChequePopover(false);
                              navigate('settings', 'notifications', 'tool-notifications');
                            }}
                            className="text-indigo-700 dark:text-indigo-300 font-medium hover:underline cursor-pointer"
                          >
                            تنظیمات
                          </button>
                        </div>
                      </div>
                    )}

                    {chequeAlertSummary.urgentAlerts.length === 0 ? (
                      <div className="px-4 py-5 text-center text-xs text-slate-500 dark:text-slate-400">
                        چک ضروری در بازه {toPersianDigits(chequeAlertSummary.leadDays)} روز آینده وجود ندارد.
                      </div>
                    ) : (
                      <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.06]">
                        {chequeAlertSummary.urgentAlerts.map((al) => {
                          const ch = al.cheque;
                          const isCritical =
                            al.severity === 'bounced' ||
                            al.severity === 'overdue' ||
                            al.severity === 'today';
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              onClick={() => {
                                setShowChequePopover(false);
                                navigate('treasury', `cheque:${ch.id}`, 'tr-cheques');
                              }}
                              className="w-full px-4 py-3 text-right hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span
                                  className={
                                    isCritical
                                      ? 'font-bold text-red-600 dark:text-red-400'
                                      : 'font-semibold text-amber-600 dark:text-amber-400'
                                  }
                                >
                                  {al.urgencyLabel}
                                </span>
                                <span className="font-code tabular-nums font-bold text-[#0F172A] dark:text-white">
                                  {formatCompactMoney(ch.amount, profile.currencyUnit)}
                                </span>
                              </div>
                              <div className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate mt-1">
                                {ch.partyName}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                                <span
                                  className={
                                    ch.direction === 'receivable'
                                      ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                      : 'text-red-600 dark:text-red-400 font-medium'
                                  }
                                >
                                  {ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی'}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-code tabular-nums">
                                  سررسید {toPersianDigits(ch.dueDate)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{ch.bankName}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Pending Draft Vouchers Awaiting Approval */}
                    {pendingDraftVouchers.length > 0 && (
                      <div className="border-t border-slate-200 dark:border-white/[0.08]">
                        <div className="px-4 py-2 bg-slate-50/80 dark:bg-[#0B0F17]/40 flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <FileCheck2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>
                              اسناد موقت در انتظار تأیید ({toPersianDigits(totalDraftVoucherCount)})
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setShowChequePopover(false);
                              navigate('vouchers', 'drafts', 'fin-vouchers');
                            }}
                            className="text-indigo-600 dark:text-[#818CF8] font-medium hover:underline cursor-pointer"
                          >
                            مشاهده همه
                          </button>
                        </div>
                        <div className="divide-y divide-slate-100 dark:divide-white/[0.06] max-h-36 overflow-y-auto">
                          {pendingDraftVouchers.map((v) => (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => {
                                setShowChequePopover(false);
                                navigate('vouchers', `voucher:${v.id}`, 'fin-vouchers');
                              }}
                              className="w-full px-4 py-2 text-right hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-colors cursor-pointer flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-slate-800 dark:text-slate-100 truncate">
                                  سند #{toPersianDigits(v.voucherNumber)} — {v.description}
                                </div>
                                <div className="text-[10px] text-slate-500 font-code tabular-nums">
                                  {toPersianDigits(v.date)}
                                </div>
                              </div>
                              <span className="font-code tabular-nums font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                                {formatCompactMoney(v.totalDebit, profile.currencyUnit)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0B0F17]/50 border-t border-slate-200 dark:border-white/[0.08] flex items-center justify-between text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setShowChequePopover(false);
                          navigate('settings', 'notifications', 'tool-notifications');
                        }}
                        className="font-medium text-slate-600 dark:text-slate-300 hover:underline cursor-pointer"
                      >
                        تنظیمات اعلان بومی
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowChequePopover(false);
                          navigate('treasury', 'cheques', 'tr-cheques');
                        }}
                        className="font-semibold text-indigo-600 dark:text-[#818CF8] hover:underline cursor-pointer"
                      >
                        مدیریت چک‌ها
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Dual-Cloud Sync Trigger (Preserves Full Firebase + Supabase Popover) */}
            <div className="relative">
              {(() => {
                const anySyncing = isSyncing || isFirebaseBackingUp || isSupabaseSyncing;
                const sbReady =
                  supabaseStatus.configured &&
                  supabaseStatus.connected &&
                  supabaseStatus.tableReady;
                const sbConnectedActive = sbReady && isSupabaseAuthenticated;

                return (
                  <button
                    type="button"
                    onClick={() => {
                      setShowChequePopover(false);
                      setShowCloudPopover((p) => !p);
                    }}
                    title="همگام‌سازی ابری دوگانه (Firebase + Supabase) و صف آفلاین"
                    aria-label="وضعیت همگام‌سازی ابری"
                    aria-expanded={showCloudPopover}
                    className={`relative p-2 rounded-xl transition-colors cursor-pointer ${
                      !isOnline
                        ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                        : anySyncing
                          ? 'text-indigo-600 dark:text-[#818CF8] bg-indigo-500/10'
                          : isCloudMode || sbConnectedActive
                            ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08]'
                    }`}
                  >
                    {!isOnline ? (
                      <CloudOff className="w-[18px] h-[18px]" />
                    ) : anySyncing ? (
                      <RefreshCw className="w-[18px] h-[18px] animate-spin" />
                    ) : (
                      <Cloud className="w-[18px] h-[18px]" />
                    )}
                    {pendingQueueCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold font-code tabular-nums flex items-center justify-center">
                        {toPersianDigits(pendingQueueCount)}
                      </span>
                    )}
                  </button>
                );
              })()}

              {showCloudPopover && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowCloudPopover(false)}
                    aria-hidden="true"
                  />
                  <div className="fixed inset-x-3 top-20 sm:absolute sm:inset-x-auto sm:left-0 sm:top-auto sm:mt-2 sm:w-[368px] max-h-[80dvh] overflow-y-auto z-[70] bg-white dark:bg-slate-900/95 dark:backdrop-blur-xl border border-slate-200 dark:border-white/12 rounded-xl shadow-xl text-right">
                    {/* Popover Header */}
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {isOnline ? (
                          <Wifi className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        ) : (
                          <WifiOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                            همگام‌سازی ابری دوگانه (Firebase + Supabase)
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-code">
                            {isCloudMode
                              ? user?.email || profile.email
                              : `حالت آفلاین-اول روی ${deviceLabel}`}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCloudPopover(false)}
                        className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        aria-label="بستن"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="p-3.5 space-y-3 text-xs max-h-[75dvh] overflow-y-auto">
                      {/* 1. Firebase Cloud Block (Auto-Sync + Symmetrical Push/Pull + Last 3 Backups) */}
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                            <Cloud className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                            <span>Firebase Firestore</span>
                            <span className="text-[10px] font-normal text-slate-500">(خودکار · {toPersianDigits(maxCloudBackups)} نسخه)</span>
                          </span>
                          <span
                            className={`text-[11px] font-semibold ${
                              !isOnline
                                ? 'text-amber-700 dark:text-amber-400'
                                : isSyncing || isFirebaseBackingUp
                                  ? 'text-sky-700 dark:text-sky-400'
                                  : isCloudMode
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {!isOnline
                              ? 'آفلاین · کش IndexedDB'
                              : isSyncing || isFirebaseBackingUp
                                ? 'در حال تبادل...'
                                : isCloudMode
                                  ? 'متصل و خودکار'
                                  : 'حالت محلی'}
                          </span>
                        </div>

                        {!isCloudMode ? (
                          <button
                            type="button"
                            onClick={() => {
                              setShowCloudPopover(false);
                              void loginWithGoogle();
                            }}
                            disabled={isSigningIn}
                            className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-70 text-white text-[11px] font-semibold transition-colors"
                          >
                            {isSigningIn ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <LogIn className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {isSigningIn
                                ? 'در حال ورود ابری...'
                                : 'ورود با گوگل و فعال‌سازی همگام‌سازی ابری'}
                            </span>
                          </button>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
                              <span>
                                نسخه بکاپ:{' '}
                                <strong className="font-code text-slate-800 dark:text-slate-200">
                                  #{toPersianDigits(lastFirebaseRevision)}
                                </strong>
                                <span className="mr-1.5 text-[10px] text-teal-700 dark:text-teal-400 font-code">
                                  ({toPersianDigits(firebaseBackups.length)}/{toPersianDigits(maxCloudBackups)} نسخه)
                                </span>
                              </span>
                              <span className="font-code text-[10.5px]">
                                {lastFirebaseBackupAt
                                  ? toPersianDigits(lastFirebaseBackupAt)
                                  : 'آماده ثبت خودکار'}
                              </span>
                            </div>

                            {/* Symmetrical Push / Pull / Refresh for Firebase */}
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void pushToFirebaseNow(false)}
                                disabled={isFirebaseBackingUp || !isOnline}
                                className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-50 transition-colors"
                              >
                                <ArrowUpFromLine className="w-3 h-3 text-teal-600 dark:text-teal-400" />
                                <span>ارسال به Firebase</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void pullFromFirebaseNow()}
                                disabled={isFirebaseBackingUp || !isOnline}
                                className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-50 transition-colors"
                              >
                                <ArrowDownToLine className="w-3 h-3 text-sky-600 dark:text-sky-400" />
                                <span>دریافت از Firebase</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void refreshFirebaseBackups(true)}
                                title="بروزرسانی و پاکسازی نسخه‌های قدیمی Firebase"
                                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
                              >
                                <RefreshCw
                                  className={`w-3.5 h-3.5 ${isFirebaseBackingUp ? 'animate-spin' : ''}`}
                                />
                              </button>
                            </div>

                            {firebaseBackups.length > 0 && (
                              <div className="space-y-1 pt-0.5">
                                {firebaseBackups.map((bak, idx) => (
                                  <div
                                    key={bak.id}
                                    className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-[10.5px]"
                                  >
                                    <span className="truncate text-slate-700 dark:text-slate-300 font-code">
                                      #{toPersianDigits(bak.revision)} · {toPersianDigits(bak.savedAtShamsi)}
                                      {idx === 0 ? ' (آخرین)' : ''}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => void pullFromFirebaseNow(bak.id)}
                                      disabled={isFirebaseBackingUp}
                                      className="text-teal-700 dark:text-teal-400 font-semibold hover:underline shrink-0"
                                    >
                                      بازیابی
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="flex items-center justify-between text-[10.5px] text-slate-500 dark:text-slate-400 pt-0.5 border-t border-slate-200/60 dark:border-slate-800">
                              <span className="inline-flex items-center gap-1">
                                <Users className="w-3 h-3 text-teal-600 dark:text-teal-400" />
                                <span>دستگاه‌های آنلاین:</span>
                              </span>
                              <span className="font-code font-bold text-teal-700 dark:text-teal-400">
                                {toPersianDigits(Math.max(1, onlineDevices.length))} دستگاه
                              </span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 2. Supabase PostgreSQL Block (100% Independent of Firebase Google Login!) */}
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                            <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>Supabase PostgreSQL</span>
                            <span className="text-[10px] font-normal text-slate-500">(مستقل · {toPersianDigits(maxCloudBackups)} نسخه)</span>
                          </span>
                          <span
                            className={`text-[11px] font-semibold ${
                              !isOnline
                                ? 'text-amber-700 dark:text-amber-400'
                                : isSupabaseSyncing
                                  ? 'text-sky-700 dark:text-sky-400'
                                  : supabaseStatus.configured &&
                                      supabaseStatus.connected &&
                                      supabaseStatus.tableReady &&
                                      isSupabaseAuthenticated
                                    ? 'text-emerald-700 dark:text-emerald-400'
                                    : supabaseStatus.configured
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {!isOnline
                              ? 'آفلاین · صف محلی'
                              : isSupabaseSyncing
                                ? 'در حال تبادل...'
                                : supabaseStatus.configured &&
                                    supabaseStatus.connected &&
                                    supabaseStatus.tableReady &&
                                    isSupabaseAuthenticated
                                  ? `${supabaseAuthMode === 'independent' ? 'متصل مستقل' : 'متصل و خودکار'}${supabaseStatus.latencyMs ? ` (${toPersianDigits(supabaseStatus.latencyMs)}ms)` : ''}`
                                  : supabaseStatus.configured && supabaseStatus.errorCode === 'INVALID_ANON_KEY'
                                    ? 'کلید اشتباه (نیاز به Secret/Service Role)'
                                    : supabaseStatus.configured && supabaseStatus.tableReady
                                      ? 'آماده اتصال مستقل'
                                      : supabaseStatus.configured
                                        ? 'نیاز به اجرای SQL'
                                        : 'در انتظار تنظیم کلیدها'}
                          </span>
                        </div>

                        <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                          {!supabaseStatus.configured ? (
                            <span>
                              متغیرهای <span className="font-code font-semibold">SUPABASE_URL</span> و{' '}
                              <span className="font-code font-semibold">SUPABASE_SERVICE_ROLE_KEY</span>{' '}
                              در تنظیمات سرور قرار گیرند تا سینک مستقل فعال شود.
                            </span>
                          ) : supabaseStatus.errorCode === 'INVALID_ANON_KEY' ? (
                            <div className="px-2.5 py-2 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-200 space-y-1">
                              <div className="font-bold">کلید عمومی (Publishable/Anon) شناسایی شد</div>
                              <div>
                                در تنظیمات Secrets، مقدار{' '}
                                <span className="font-code font-semibold">SUPABASE_SERVICE_ROLE_KEY</span>{' '}
                                را با کلید مخفی{' '}
                                <span className="font-code font-semibold">Secret key (sb_secret_...)</span>{' '}
                                یا <span className="font-code font-semibold">service_role</span> از بخش{' '}
                                <span className="font-code">Project Settings → API Keys</span> در پنل Supabase
                                جایگزین کنید (جداول SQL شما آماده است).
                              </div>
                            </div>
                          ) : !supabaseStatus.tableReady ? (
                            <span>
                              پروژه <span className="font-code">{supabaseStatus.projectRef}</span> متصل
                              است؛ فایل <span className="font-code">supabase/schema.sql</span> را در SQL
                              Editor اجرا کنید.
                            </span>
                          ) : !isSupabaseAuthenticated ? (
                            <div className="space-y-2 pt-1">
                              <div className="text-[10.5px] text-emerald-800 dark:text-emerald-300 font-medium">
                                اتصال مستقیم و مستقل به Supabase (بدون نیاز به ورود گوگل یا Firebase):
                              </div>
                              <div className="grid grid-cols-2 gap-1.5" dir="ltr">
                                <input
                                  type="text"
                                  value={supabaseWorkspaceId}
                                  onChange={(e) => setSupabaseWorkspaceId(e.target.value)}
                                  placeholder="Workspace ID (e.g. atlasris_main)"
                                  className="px-2 py-1.5 text-[11px] font-code rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                                />
                                <input
                                  type="password"
                                  value={sbPasscode}
                                  onChange={(e) => setSbPasscode(e.target.value)}
                                  placeholder="رمز فضای کاری (حداقل ۶ کاراکتر)"
                                  className="px-2 py-1.5 text-[11px] font-code rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                {supabaseWorkspaceInitialized === false ? (
                                  <button
                                    type="button"
                                    disabled={isSupabaseAuthLoading || sbPasscode.trim().length < 6}
                                    onClick={() =>
                                      void setupIndependentSupabase(supabaseWorkspaceId, sbPasscode).then((ok) => {
                                        if (ok) setSbPasscode('');
                                      })
                                    }
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-semibold disabled:opacity-50"
                                  >
                                    <KeyRound className="w-3 h-3" />
                                    <span>ایجاد و فعال‌سازی مستقل Supabase</span>
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      disabled={isSupabaseAuthLoading || sbPasscode.trim().length < 6}
                                      onClick={() =>
                                        void loginIndependentSupabase(supabaseWorkspaceId, sbPasscode).then((ok) => {
                                          if (ok) setSbPasscode('');
                                        })
                                      }
                                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-semibold disabled:opacity-50"
                                    >
                                      <KeyRound className="w-3 h-3" />
                                      <span>ورود مستقل</span>
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isSupabaseAuthLoading || sbPasscode.trim().length < 6}
                                      onClick={() =>
                                        void setupIndependentSupabase(supabaseWorkspaceId, sbPasscode).then((ok) => {
                                          if (ok) setSbPasscode('');
                                        })
                                      }
                                      className="px-2.5 py-1.5 rounded-md border border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-[11px] font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
                                    >
                                      فضای جدید
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <span>
                                نسخه سرور:{' '}
                                <strong className="font-code text-slate-800 dark:text-slate-200">
                                  #{toPersianDigits(lastSupabaseRevision)}
                                </strong>
                                <span className="mr-1.5 text-[10px] text-emerald-700 dark:text-emerald-400 font-code">
                                  ({toPersianDigits(supabaseBackups.length)}/{toPersianDigits(maxCloudBackups)} نسخه)
                                </span>
                              </span>
                              <span className="font-code text-[10.5px]">
                                {lastSupabaseSyncAt
                                  ? toPersianDigits(lastSupabaseSyncAt)
                                  : 'در حال سینک خودکار...'}
                              </span>
                            </div>
                          )}
                        </div>

                        {lastSupabaseError && (
                          <div className="px-2.5 py-2 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-[10.5px] text-rose-700 dark:text-rose-300 leading-4 space-y-1.5">
                            <div>{lastSupabaseError}</div>
                            <div className="flex items-center justify-between gap-2 pt-1 border-t border-rose-200/70 dark:border-rose-900/60">
                              <span className="text-[10px] text-rose-600/90 dark:text-rose-400">
                                عیب‌یابی خودکار شبکه و کلید API اجرا شد
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowCloudPopover(false);
                                  setActiveModule('settings');
                                }}
                                className="font-bold underline hover:text-rose-900 dark:hover:text-rose-100 cursor-pointer"
                              >
                                مشاهده راهکارها
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between gap-1.5 pt-0.5 text-[10.5px]">
                          <button
                            type="button"
                            onClick={() => void runServerTest()}
                            disabled={isTestingServer}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-950/70 disabled:opacity-50"
                          >
                            <Activity className={`w-3 h-3 ${isTestingServer ? 'animate-pulse' : ''}`} />
                            <span>{isTestingServer ? 'در حال عیب‌یابی...' : 'عیب‌یابی خودکار سرور'}</span>
                          </button>
                          <div className="flex items-center gap-2">
                            {isSupabaseAuthenticated && (
                              <button
                                type="button"
                                onClick={() => setSupabaseAutoBackupEnabled(!supabaseAutoBackupEnabled)}
                                className={`px-2 py-1 rounded-md font-semibold transition-colors ${
                                  supabaseAutoBackupEnabled
                                    ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                                    : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                                }`}
                              >
                                {supabaseAutoBackupEnabled ? 'بکاپ خودکار: روشن' : 'بکاپ خودکار: خاموش'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setShowCloudPopover(false);
                                setActiveModule('settings');
                              }}
                              className="text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                            >
                              پنل کامل سرور
                            </button>
                          </div>
                        </div>

                        {isSupabaseAuthenticated && (
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <button
                              type="button"
                              onClick={() => void syncSupabaseNow(false)}
                              disabled={isSupabaseSyncing}
                              className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-50 transition-colors"
                            >
                              <ArrowUpFromLine className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                              <span>ارسال به Supabase</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void pullFromSupabase()}
                              disabled={
                                isSupabaseSyncing ||
                                !isOnline ||
                                !supabaseStatus.tableReady
                              }
                              className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-50 transition-colors"
                            >
                              <ArrowDownToLine className="w-3 h-3 text-sky-600 dark:text-sky-400" />
                              <span>دریافت از Supabase</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void refreshSupabaseStatus()}
                              title="بررسی اتصال و پاکسازی نسخه‌های قدیمی Supabase"
                              className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
                            >
                              <RefreshCw
                                className={`w-3.5 h-3.5 ${isSupabaseSyncing ? 'animate-spin' : ''}`}
                              />
                            </button>
                            {supabaseAuthMode === 'independent' && (
                              <button
                                type="button"
                                onClick={logoutIndependentSupabase}
                                title="قطع اتصال مستقل Supabase"
                                className="p-1.5 rounded-md border border-rose-200 dark:border-rose-900 bg-white dark:bg-slate-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                              >
                                <LogOut className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        )}

                        {isSupabaseAuthenticated && supabaseBackups.length > 0 && (
                          <div className="space-y-1 pt-0.5">
                            {supabaseBackups.map((bak, idx) => (
                              <div
                                key={bak.id}
                                className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-[10.5px]"
                              >
                                <span className="truncate text-slate-700 dark:text-slate-300 font-code">
                                  #{toPersianDigits(bak.revision)} · {toPersianDigits(bak.savedAtShamsi)}
                                  {idx === 0 ? ' (آخرین)' : ''}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void pullFromSupabase(bak.id)}
                                  disabled={isSupabaseSyncing}
                                  className="text-emerald-700 dark:text-emerald-400 font-semibold hover:underline shrink-0"
                                >
                                  بازیابی
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 3. Offline-First Outbox & Conflict Resolution Policy */}
                      <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/40 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                            <GitCompareArrows className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                            <span>سیاست حل تداخل ویرایش همزمان</span>
                          </span>
                          <div className="inline-flex items-center gap-1.5">
                            <span
                              className={`font-code text-[10.5px] font-semibold ${
                                pendingQueueCount === 0
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-amber-700 dark:text-amber-400'
                              }`}
                            >
                              صف آفلاین: {toPersianDigits(pendingQueueCount)}
                              {pendingQueueCount === 0 ? ' (پاک)' : ''}
                            </span>
                            {pendingQueueCount > 0 && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void flushOutboxNow()}
                                  className="px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 text-[10px] font-semibold hover:bg-teal-100 dark:hover:bg-teal-900/60"
                                >
                                  ارسال صف
                                </button>
                                <button
                                  type="button"
                                  onClick={clearPendingOutbox}
                                  className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-semibold hover:text-rose-600 dark:hover:text-rose-400"
                                >
                                  پاکسازی
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-1.5">
                          <button
                            type="button"
                            onClick={() => setConflictDefaultMode('ask')}
                            className={`px-2 py-1.5 rounded-md border text-[10.5px] font-semibold transition-colors text-center ${
                              conflictDefaultMode === 'ask'
                                ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/60 text-teal-900 dark:text-teal-200'
                                : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                            }`}
                          >
                            پرسش از من
                          </button>
                          <button
                            type="button"
                            onClick={() => setConflictDefaultMode('keep_local')}
                            className={`px-2 py-1.5 rounded-md border text-[10.5px] font-semibold transition-colors text-center ${
                              conflictDefaultMode === 'keep_local'
                                ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/60 text-teal-900 dark:text-teal-200'
                                : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                            }`}
                          >
                            حفظ محلی
                          </button>
                          <button
                            type="button"
                            onClick={() => setConflictDefaultMode('restore_remote')}
                            className={`px-2 py-1.5 rounded-md border text-[10.5px] font-semibold transition-colors text-center ${
                              conflictDefaultMode === 'restore_remote'
                                ? 'border-sky-600 bg-sky-50 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200'
                                : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                            }`}
                          >
                            نسخه ابری
                          </button>
                        </div>

                        <p className="text-[10.5px] text-slate-500 dark:text-slate-400 leading-relaxed">
                          {conflictDefaultMode === 'ask'
                            ? 'هنگام بروز تداخل در اسناد حسابداری، پنجره انتخاب باز می‌شود تا تصمیم بگیرید آخرین تغییر محلی حفظ یا نسخه ابری بازگردانی شود و آن را پیش‌فرض آینده کنید.'
                            : conflictDefaultMode === 'keep_local'
                              ? 'پیش‌فرض ذخیره‌شده: در صورت تداخل، آخرین تغییر محلی به‌صورت خودکار حفظ و جایگزین نسخه ابری/همتا می‌شود.'
                              : 'پیش‌فرض ذخیره‌شده: در صورت تداخل، نسخه ابری / همتا به‌صورت خودکار بازگردانی می‌شود تا از بازنویسی ناخواسته جلوگیری گردد.'}
                        </p>

                        {lastConflictNote && (
                          <div className="px-2.5 py-1.5 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[10.5px] text-amber-800 dark:text-amber-200">
                            {lastConflictNote}
                          </div>
                        )}
                      </div>

                      {/* 4. Local Backup Quick Trigger */}
                      <div className="pt-1 flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-slate-500 dark:text-slate-400">آخرین پشتیبان دستگاه:</span>
                        <span className="font-code font-semibold text-slate-700 dark:text-slate-200">
                          {lastLocalBackupAt
                            ? toPersianDigits(lastLocalBackupAt)
                            : `${toPersianDigits(localSnapshots.length)} نسخه داخلی`}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          void triggerLocalBackupNow(false);
                          setShowCloudPopover(false);
                        }}
                        className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-950/80 font-semibold transition-colors"
                      >
                        <HardDrive className="w-3.5 h-3.5" />
                        <span>ذخیره پشتیبان فوری روی حافظه دستگاه</span>
                      </button>
                    </div>

                    {/* Footer links */}
                    <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setShowCloudPopover(false);
                          navigate('settings', 'local-backup', 'tool-local-backup');
                        }}
                        className="font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                      >
                        مدیریت پشتیبان‌ها و RBAC
                      </button>
                      {isCloudMode ? (
                        <button
                          type="button"
                          onClick={() => {
                            setShowCloudPopover(false);
                            void logout();
                          }}
                          className="inline-flex items-center gap-1 font-medium text-rose-600 dark:text-rose-400 hover:underline"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>خروج از ابر</span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-400">
                          {otherOnlineDevices.length > 0
                            ? `${toPersianDigits(otherOnlineDevices.length)} دستگاه دیگر`
                            : 'آفلاین-اول آماده'}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Dark / Light Theme Toggle Switch */}
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? 'تغییر به حالت روشن' : 'تغییر به حالت تاریک'}
              aria-label={darkMode ? 'تغییر به حالت روشن' : 'تغییر به حالت تاریک'}
              className="p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              {darkMode ? <Sun className="w-[18px] h-[18px] text-amber-400" /> : <Moon className="w-[18px] h-[18px]" />}
            </button>

            {/* Settings Gear Icon */}
            <button
              type="button"
              onClick={() => navigate('settings', undefined, 'tool-settings')}
              title="تنظیمات سیستم"
              aria-label="تنظیمات سیستم"
              className="hidden sm:inline-flex p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <Settings className="w-[18px] h-[18px]" />
            </button>

            <span className="hidden sm:block h-5 w-px bg-slate-200 dark:bg-white/10 mx-0.5" aria-hidden="true" />

            {/* User Profile Avatar & Name */}
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="انتخاب عکس پروفایل"
              onChange={handleAvatarFileChange}
            />
            <div className="relative flex items-center">
              <button
                type="button"
                onClick={() => navigate('settings', 'rbac', 'tool-rbac')}
                title="پروفایل کاربر و مدیریت دسترسی‌ها"
                className="flex items-center gap-2.5 pl-1 pr-1.5 py-1 rounded-xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <span className="relative block w-8 h-8 shrink-0">
                  {profile.profilePhotoData && !avatarError ? (
                    <img
                      src={profile.profilePhotoData}
                      alt={`عکس پروفایل ${profile.displayName || activeOperator.fullName}`}
                      onError={() => setAvatarError(true)}
                      className="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-white/15"
                    />
                  ) : !avatarError ? (
                    <img
                      src={financeDirectorAvatar}
                      alt={activeOperator.fullName}
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarError(true)}
                      className="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-white/15"
                    />
                  ) : (
                    <span className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold">
                      {(profile.displayName || activeOperator.fullName).slice(0, 1)}
                    </span>
                  )}
                </span>
                <span className="hidden xl:flex flex-col text-right leading-tight">
                  <span className="text-xs font-semibold text-[#0F172A] dark:text-white whitespace-nowrap">
                    {activeOperator.fullName}
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {RBAC_ROLE_LABELS[activeOperator.role].split('(')[0].trim()}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                title="انتخاب یا تغییر عکس پروفایل"
                aria-label="تغییر عکس پروفایل"
                className="absolute -bottom-0.5 left-0 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 dark:border-[#161B26] dark:bg-indigo-500 dark:hover:bg-indigo-400"
              >
                <Camera className="h-2.5 w-2.5" />
              </button>
            </div>

            {/* Logout / Cloud Sign-In Action */}
            {isCloudMode ? (
              <button
                type="button"
                onClick={() => void logout()}
                title="خروج از حساب ابری"
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-red-600 dark:hover:text-red-400 transition-colors whitespace-nowrap cursor-pointer"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span className="hidden md:inline">خروج</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={loginWithGoogle}
                disabled={isSigningIn}
                title="ورود با حساب گوگل برای ذخیره ابری"
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-indigo-600 dark:hover:text-[#818CF8] disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <LogIn className="w-4 h-4 shrink-0" />
                <span className="hidden md:inline">ورود</span>
              </button>
            )}
          </div>
        </header>

        {/* Active Module Viewport with GPU-composited crisp transition */}
        <main
          id="main-accounting-viewport"
          tabIndex={-1}
          className="flex-1 px-3 sm:px-4 lg:px-6 pt-4 pb-26 lg:pb-6 max-w-[1440px] w-full mx-auto focus:outline-none"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeModule}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <Suspense fallback={<ModuleLoadingFallback />}>
                {activeModule === 'dashboard' && (
                  <DashboardView
                    onNavigate={navigate}
                    onOpenCopilot={() => setShowCopilot(true)}
                    dualCloud={dualCloud}
                    localMesh={localMesh}
                    onOpenQueueMonitor={() => setShowQueueMonitor(true)}
                    onOpenSystemHealth={() => setShowHealthDrawer(true)}
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'invoices' && (
                  <InvoicesView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'vouchers' && (
                  <VouchersView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'audit' && (
                  <AuditView
                    onNavigate={navigate}
                    onOpenSystemHealth={() => setShowHealthDrawer(true)}
                    onOpenQueueMonitor={() => setShowQueueMonitor(true)}
                    localMesh={localMesh}
                    dualCloud={dualCloud}
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'accounts' && (
                  <AccountsView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'parties' && (
                  <PartiesView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'inventory' && (
                  <InventoryView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'treasury' && (
                  <TreasuryView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'currencies' && (
                  <CurrenciesView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                    onNavigate={navigate}
                  />
                )}
                {activeModule === 'commercial' && (
                  <ImportAndSubcontractView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'corporate' && (
                  <CorporateView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'finance-ops' && (
                  <FinanceOpsView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'warehouse-crm' && (
                  <WarehouseCrmOpsView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'reports' && (
                  <ReportsView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                  />
                )}
                {activeModule === 'studio' && <BrandStudioView />}
                {activeModule === 'settings' && (
                  <SettingsView
                    initialIntent={moduleIntent}
                    clearIntent={() => setModuleIntent(undefined)}
                    dualCloud={dualCloud}
                    localMesh={localMesh}
                    nativeNotifications={nativeNotifications}
                    urgentChequeCount={chequeAlertSummary.urgentAlerts.length}
                    onNavigate={navigate}
                    onOpenQueueMonitor={() => setShowQueueMonitor(true)}
                  />
                )}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Floating Glassmorphic Mobile Dock (< lg only, matching #161B26 / #FFFFFF frosted glass) */}
      <nav
        aria-label="دسترسی سریع موبایل"
        className="lg:hidden fixed bottom-3 sm:bottom-4 mb-[env(safe-area-inset-bottom)] inset-x-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:w-[420px] max-w-[460px] mx-auto z-30 rounded-2xl bg-white/85 dark:bg-[#161B26]/90 backdrop-blur-2xl border border-slate-200/80 dark:border-white/10 shadow-[0_14px_38px_-10px_rgba(15,23,42,0.22)] dark:shadow-[0_16px_42px_-10px_rgba(0,0,0,0.75)] px-1.5 py-1.5 no-print"
      >
        <div className="grid grid-cols-5 gap-1">
          {[
            {
              id: 'dashboard' as const,
              label: 'داشبورد',
              icon: LayoutDashboard,
              isActive: activeModule === 'dashboard',
              onClick: () => navigate('dashboard', undefined, 'dashboard'),
            },
            {
              id: 'invoices' as const,
              label: 'مالی',
              icon: Wallet,
              isActive: activeModule === 'invoices' || activeModule === 'vouchers',
              onClick: () => navigate('invoices', 'new-sale', 'inv-sale'),
            },
            {
              id: 'inventory' as const,
              label: 'انبار',
              icon: Package,
              isActive: activeModule === 'inventory',
              onClick: () => navigate('inventory', undefined, 'inv-products'),
            },
            {
              id: 'treasury' as const,
              label: 'چک و خزانه',
              icon: Landmark,
              isActive: activeModule === 'treasury',
              onClick: () => navigate('treasury', 'cheques', 'tr-cheques'),
            },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <motion.button
                key={tab.id}
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={tab.onClick}
                aria-current={tab.isActive ? 'page' : undefined}
                className={`relative min-h-[44px] flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-xl text-[10px] font-semibold transition-colors cursor-pointer ${
                  tab.isActive
                    ? 'text-indigo-600 dark:text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-900/5 dark:hover:bg-white/[0.06]'
                }`}
              >
                {tab.isActive && (
                  <motion.div
                    layoutId="mobileActiveNav"
                    transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.8 }}
                    className="absolute inset-0 rounded-xl bg-indigo-500/15 dark:bg-white/[0.11] border border-indigo-500/20 dark:border-white/10"
                  />
                )}
                <Icon className="w-4 h-4 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
              </motion.button>
            );
          })}
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            onClick={() => setMobileMenuOpen(true)}
            className="min-h-[44px] flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-xl text-[10px] font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-900/5 dark:hover:bg-white/[0.06] hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
          >
            <Menu className="w-4 h-4" />
            <span>منوها</span>
          </motion.button>
        </div>
      </nav>

      {/* Global Transaction Feedback Toast with smooth micro-interaction */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-24 lg:bottom-5 left-1/2 -translate-x-1/2 z-[95] max-w-[92vw] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900/90 dark:bg-teal-800/90 backdrop-blur-xl border border-white/15 text-white text-xs font-medium shadow-xl no-print"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="leading-relaxed">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Global Overlays */}
      <ShortcutHelpModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        onNavigate={navigate}
      />
      <SmartGlobalSearchModal
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onNavigate={navigate}
      />
      <QuickCalculatorModal
        open={showCalculator}
        onClose={() => setShowCalculator(false)}
      />
      <Suspense fallback={null}>
        {showCopilot && (
          <SmartCopilotDrawer
            open={showCopilot}
            onClose={() => setShowCopilot(false)}
            onNavigate={navigate}
          />
        )}
        {showHealthDrawer && (
          <SystemHealthDrawer
            open={showHealthDrawer}
            onClose={() => setShowHealthDrawer(false)}
            onNavigate={navigate}
            supabaseStatus={supabaseStatus}
            pendingOfflineQueueCount={combinedPendingQueueCount}
            conflictPolicy={conflictPolicy}
            dualCloud={dualCloud}
            localMesh={localMesh}
            onOpenQueueMonitor={() => setShowQueueMonitor(true)}
          />
        )}
        {showQueueMonitor && (
          <OfflineQueueMonitorDrawer
            open={showQueueMonitor}
            onClose={() => setShowQueueMonitor(false)}
            localMesh={localMesh}
            dualCloud={dualCloud}
            onOpenAuditLog={() => navigate('audit', 'p2p_mesh_log', 'audit-center')}
          />
        )}
        {showOfflineGuide && (
          <OfflineSmartGuideDrawer
            open={showOfflineGuide}
            onClose={() => setShowOfflineGuide(false)}
            activeModule={activeModule}
            onNavigate={navigate}
            localMesh={localMesh}
            dualCloud={dualCloud}
            onOpenQueueMonitor={() => setShowQueueMonitor(true)}
          />
        )}
        {showUniversalExcelImport && (
          <UniversalExcelImportModal
            open={showUniversalExcelImport}
            initialEntity={mapActiveModuleToExcelEntity(activeModule)}
            onClose={() => setShowUniversalExcelImport(false)}
          />
        )}
      </Suspense>
      <MeshInitialSetupModal localMesh={localMesh} />
      <SyncConflictResolutionModal
        conflict={pendingConflict || localMesh.pendingMeshConflict}
        isResolving={isResolvingConflict || localMesh.isResolvingMeshConflict}
        onResolve={async (choice, rememberAsDefault) => {
          if (pendingConflict) {
            return resolvePendingConflict(choice, rememberAsDefault);
          }
          const ok = await localMesh.resolvePendingMeshConflict(choice, rememberAsDefault);
          if (ok && rememberAsDefault) {
            setConflictDefaultMode(choice, true);
          }
          return ok;
        }}
        onDismiss={() => {
          if (pendingConflict) {
            dismissPendingConflict();
          } else {
            localMesh.dismissPendingMeshConflict();
          }
        }}
      />
      <OfflineIndicator onOpenHealth={() => setShowHealthDrawer(true)} />
      <PwaUpdateBanner
        onCreatePreUpdateBackup={async () => {
          const [{ computeSnapshotSha256Hex }, { OP_DB_VERSION, savePreUpdateSafetyBackup }] = await Promise.all([
            import('./lib/offlineFirstCore'),
            import('./lib/operationalDb'),
          ]);
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
        }}
      />
    </div>
    </MotionConfig>
  );
}
