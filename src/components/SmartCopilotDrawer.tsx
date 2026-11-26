import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Cpu,
  Loader2,
  RefreshCw,
  ScanLine,
  Send,
  ShieldCheck,
  Sliders,
  Sparkles,
  TrendingUp,
  WifiOff,
  X,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { useWorkspaceExtensions } from '../context/WorkspaceExtensionsContext';
import { ActiveModule } from '../types/accounting';
import { formatCompactMoney, formatMoney, toPersianDigits } from '../lib/format';
import {
  buildCopilotFinancialSnapshot,
  computeCashFlowLiquidityRadar,
  SmartCopilotSuggestedAction,
} from '../lib/smartIntelligence';
import {
  localCopilotRespond,
  LocalSlmOptimizationResult,
  runAutonomousAiOptimization,
} from '../lib/localSmallLlm';
import {
  buildPendingApprovalItems,
  computePendingApprovalsSummary,
} from '../lib/pendingApprovalsSummary';
import {
  auditPendingApprovalItems,
  buildDebtorReminderMessages,
  type DebtorReminderItem,
} from '../lib/smartAutomationEngine';

type CopilotEngineMode = 'online_gemini' | 'offline_local';

interface CopilotExecutableAction {
  type:
    | 'finalize_clean_drafts'
    | 'generate_debtor_reminders'
    | 'open_vision_scanner'
    | 'open_whatif_simulator'
    | 'navigate';
  label: string;
  description?: string;
  module?: ActiveModule;
  intent?: string;
}

interface CopilotMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  engineLabel?: string;
  suggestedActions?: SmartCopilotSuggestedAction[];
  executableActions?: CopilotExecutableAction[];
  debtorReminders?: DebtorReminderItem[];
  isError?: boolean;
}

const VALID_MODULES: Set<string> = new Set([
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
  'reports',
  'studio',
  'finance-ops',
  'warehouse-crm',
  'settings',
]);

const STARTER_PROMPTS = [
  'اسناد موقت کارتابل را ممیزی کن و موارد بدون خطا را برای دائم‌سازی آماده کن',
  'برای ۳ مشتری با بیشترین بدهی متن یادآوری پرداخت رسمی آماده کن',
  'تحلیل وضعیت نقدینگی ۳۰ روز آینده، چک‌ها و پیشنهاد شبیه‌سازی ریسک',
  'گزارش حسابرسی هوشمند دفاتر، تراز کل و معین و تطبیق انبار با ۱۰۵۰۱',
  'کدام کالاها در خطر اتمام موجودی هستند و چقدر سفارش دهم؟',
  'بدهی مالیات ارزش افزوده این دوره چقدر است و چه کارهایی برای سامانه مودیان انجام دهم؟',
];

function inferLocalExecutableActions(
  prompt: string,
  safeDraftCount: number,
  debtorsCount: number
): CopilotExecutableAction[] {
  const q = prompt.trim();
  const actions: CopilotExecutableAction[] = [];

  if (/(موقت|تأیید|تایید|دائم|کارتابل|سند)/.test(q) && safeDraftCount > 0) {
    actions.push({
      type: 'finalize_clean_drafts',
      label: `تأیید و دائم‌سازی ${toPersianDigits(safeDraftCount)} سند موقت بدون خطا`,
      description: 'فقط اسناد تراز و بدون هشدار ممیزی دائم می‌شوند',
    });
  }

  if (/(بدهی|بدهکار|یادآوری|وصول|مطالبات|پیام|واتساپ|مشتری)/.test(q) && debtorsCount > 0) {
    actions.push({
      type: 'generate_debtor_reminders',
      label: 'تولید پیام یادآوری پرداخت برای ۳ بدهکار اول',
      description: 'متن رسمی آماده کپی با مانده دقیق هر مشتری',
    });
  }

  if (/(اسکن|عکس|تصویر|فیش|قبض|ocr)/i.test(q)) {
    actions.push({
      type: 'open_vision_scanner',
      label: 'باز کردن اسکنر هوشمند تصویر (OCR)',
    });
  }

  if (/(شبیه|ارز|نقدینگی|سناریو|تأخیر|تاخیر|چه می‌شود|چه میشود)/.test(q)) {
    actions.push({
      type: 'open_whatif_simulator',
      label: 'باز کردن شبیه‌ساز «چه می‌شود اگر؟»',
    });
  }

  return actions;
}

export const SmartCopilotDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}> = ({ open, onClose, onNavigate }) => {
  const {
    profile,
    accounts,
    trialBalance,
    incomeStatement,
    balanceSheet,
    products,
    parties,
    partyBalances,
    cheques,
    vouchers,
    invoices,
    salesOrders,
    importDossiers,
    subcontractJobs,
    auditReport,
    activeOperator,
    finalizeVoucher,
    showToast,
  } = useAccounting();

  const { reservedInvoices, warehouseSlips, pettyCashItems } = useWorkspaceExtensions();

  const unit = profile.currencyUnit;
  const [engineMode, setEngineMode] = useState<CopilotEngineMode>(() =>
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline_local' : 'online_gemini'
  );
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [executingActionKey, setExecutingActionKey] = useState<string | null>(null);
  const [copiedReminderId, setCopiedReminderId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [aiOptResult, setAiOptResult] = useState<LocalSlmOptimizationResult | null>(null);
  const [showAiOptPanel, setShowAiOptPanel] = useState(false);
  const [optimizingAi, setOptimizingAi] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const executeAutonomousEvaluation = () => {
    setOptimizingAi(true);
    try {
      const res = runAutonomousAiOptimization({
        workspaceAccountTitles: accounts.map((a) => a.title),
        workspacePartyNames: parties.map((p) => p.name),
        workspaceProductNames: products.map((p) => p.name),
        persist: true,
      });
      setAiOptResult(res);
    } finally {
      setOptimizingAi(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    executeAutonomousEvaluation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accounts.length, parties.length, products.length]);

  const liquidity = useMemo(
    () =>
      trialBalance
        .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
        .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0),
    [trialBalance]
  );

  const radar = useMemo(
    () => computeCashFlowLiquidityRadar({ currentLiquidity: liquidity, cheques }),
    [liquidity, cheques]
  );

  const pendingSummary = useMemo(
    () =>
      computePendingApprovalsSummary({
        vouchers,
        invoices,
        reservedInvoices,
        importDossiers,
        salesOrders,
        subcontractJobs,
        warehouseSlips,
        pettyCashItems,
      }),
    [
      vouchers,
      invoices,
      reservedInvoices,
      importDossiers,
      salesOrders,
      subcontractJobs,
      warehouseSlips,
      pettyCashItems,
    ]
  );

  const pendingItems = useMemo(() => buildPendingApprovalItems(pendingSummary), [pendingSummary]);

  const riskAuditMap = useMemo(
    () =>
      auditPendingApprovalItems(pendingItems, {
        vouchers,
        invoices,
        parties,
        partyBalances,
        products,
      }),
    [pendingItems, vouchers, invoices, parties, partyBalances, products]
  );

  const safeDraftVoucherIds = useMemo(
    () =>
      pendingItems
        .filter((i) => riskAuditMap.get(i.id)?.eligibleForBatchAutoApprove)
        .map((i) => i.id),
    [pendingItems, riskAuditMap]
  );

  const topDebtorReminders = useMemo(
    () =>
      buildDebtorReminderMessages({
        parties,
        partyBalances,
        companyName: profile.companyName,
        unit,
        limit: 3,
      }),
    [parties, partyBalances, profile.companyName, unit]
  );

  const draftVouchersCount = pendingSummary.draftVouchersCount;
  const lowStockCount = useMemo(
    () => products.filter((p) => p.stock <= p.reorderPoint).length,
    [products]
  );

  const snapshot = useMemo(
    () =>
      buildCopilotFinancialSnapshot({
        companyName: profile.companyName,
        fiscalYear: profile.fiscalYear,
        currencyUnit: profile.currencyUnit,
        liquidity,
        netSales: incomeStatement.netSales,
        grossProfit: incomeStatement.grossProfit,
        netProfit: incomeStatement.netProfit,
        grossMarginPct: incomeStatement.grossMarginPct,
        netMarginPct: incomeStatement.netMarginPct,
        totalAssets: balanceSheet.totalAssets,
        totalLiabilities: balanceSheet.totalLiabilities,
        totalEquity: balanceSheet.totalEquity,
        trialBalance,
        products,
        parties,
        partyBalances,
        cheques,
        vouchers,
        invoices,
        auditScore: auditReport.score,
        auditErrors: auditReport.errorCount,
        auditWarnings: auditReport.warningCount,
        auditFindings: auditReport.checks
          .filter((c) => c.status !== 'pass')
          .map((c) => ({
            id: c.id,
            title: c.title,
            severity: c.status === 'error' ? ('error' as const) : ('warning' as const),
            details: c.details.length > 0 ? c.details.join('؛ ') : c.summary,
          })),
        openSalesOrdersCount: salesOrders.filter(
          (o) => o.status !== 'invoiced' && o.status !== 'cancelled'
        ).length,
        dispatchedUninvoicedOrdersCount: salesOrders.filter((o) => o.status === 'dispatched').length,
        openImportDossiersCount: importDossiers.filter((d) => d.status !== 'cleared').length,
        activeSubcontractJobsCount: subcontractJobs.filter((j) => j.status === 'sent').length,
      }),
    [
      profile,
      liquidity,
      incomeStatement,
      balanceSheet,
      trialBalance,
      products,
      parties,
      partyBalances,
      cheques,
      vouchers,
      invoices,
      salesOrders,
      importDossiers,
      subcontractJobs,
      auditReport,
    ]
  );

  if (!open) return null;

  const scrollToBottom = () => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);
  };

  const handleCopyReminder = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedReminderId(id);
      showToast('متن یادآوری پرداخت در حافظه کپی شد.', 'success');
      setTimeout(() => setCopiedReminderId((p) => (p === id ? null : p)), 2000);
    } catch {
      showToast('دسترسی به حافظه کلیپ‌بورد مسدود است.', 'warning');
    }
  };

  const handleExecuteAction = async (action: CopilotExecutableAction, actionKey: string) => {
    if (action.type === 'navigate') {
      const targetMod =
        action.module && VALID_MODULES.has(action.module) ? action.module : 'dashboard';
      onClose();
      onNavigate(targetMod, action.intent);
      return;
    }

    if (action.type === 'open_vision_scanner') {
      onClose();
      onNavigate('dashboard', 'vision-scan', 'dashboard');
      return;
    }

    if (action.type === 'open_whatif_simulator') {
      onClose();
      onNavigate('dashboard', 'intelligence', 'dashboard');
      return;
    }

    if (action.type === 'generate_debtor_reminders') {
      if (topDebtorReminders.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `act-${Date.now()}`,
            role: 'model',
            text: 'در حال حاضر مشتری با مانده بدهی فعال برای ارسال یادآوری یافت نشد.',
            engineLabel: 'اجرای مستقیم اکشن',
          },
        ]);
        scrollToBottom();
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `rem-${Date.now()}`,
          role: 'model',
          text: `متن رسمی یادآوری پرداخت برای ${toPersianDigits(topDebtorReminders.length)} مشتری با بیشترین مانده بدهی آماده شد (روی دکمه کپی کلیک کنید):`,
          engineLabel: 'اجرای مستقیم اکشن',
          debtorReminders: topDebtorReminders,
        },
      ]);
      scrollToBottom();
      return;
    }

    if (action.type === 'finalize_clean_drafts') {
      if (!activeOperator.permissions.canFinalizeVoucher) {
        showToast('کاربر فعلی مجوز دائم‌سازی اسناد حسابداری را ندارد.', 'warning');
        return;
      }
      if (safeDraftVoucherIds.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `act-${Date.now()}`,
            role: 'model',
            text:
              draftVouchersCount > 0
                ? 'تمامی اسناد موقت فعلی دارای هشدار ممیزی (نامتوازن، تکراری یا ریسک اعتبار) هستند و نیاز به بررسی دستی دارند.'
                : 'هیچ سند موقتی برای دائم‌سازی در کارتابل وجود ندارد.',
            engineLabel: 'ممیزی پیش از تأیید',
          },
        ]);
        scrollToBottom();
        return;
      }

      setExecutingActionKey(actionKey);
      try {
        let finalizedCount = 0;
        for (const vid of safeDraftVoucherIds) {
          await finalizeVoucher(vid);
          finalizedCount += 1;
        }
        const remainingRisky = Math.max(0, draftVouchersCount - finalizedCount);
        const msg =
          remainingRisky > 0
            ? `${toPersianDigits(finalizedCount)} سند موقت بدون خطا با موفقیت دائم‌سازی شد. ${toPersianDigits(remainingRisky)} سند دارای هشدار ممیزی برای بررسی دستی باقی ماند.`
            : `${toPersianDigits(finalizedCount)} سند موقت بدون خطا با موفقیت دائم‌سازی شد و کارتابل اسناد موقت پاک شد.`;
        showToast(msg, 'success');
        setMessages((prev) => [
          ...prev,
          {
            id: `fin-${Date.now()}`,
            role: 'model',
            text: msg,
            engineLabel: 'اجرای مستقیم اکشن',
          },
        ]);
        scrollToBottom();
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'خطا در دائم‌سازی گروهی اسناد.',
          'warning'
        );
      } finally {
        setExecutingActionKey(null);
      }
    }
  };

  const sendQuestion = async (questionText: string, overrideMode?: CopilotEngineMode) => {
    const trimmed = questionText.trim();
    if (!trimmed || loading) return;

    const activeMode = overrideMode ?? engineMode;
    const userMsg: CopilotMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setLoading(true);
    scrollToBottom();

    try {
      if (activeMode === 'online_gemini') {
        const enrichedSnapshot = {
          ...snapshot,
          pendingApprovals: {
            totalPendingCount: pendingSummary.totalPendingCount,
            draftVouchersCount: pendingSummary.draftVouchersCount,
            safeDraftVouchersCount: safeDraftVoucherIds.length,
            unbalancedDraftCount: pendingSummary.unbalancedDraftCount,
            pendingInvoicesCount: pendingSummary.pendingInvoicesCount,
            pendingImportsCount: pendingSummary.pendingImportsCount,
          },
          topDebtors: topDebtorReminders.map((d) => ({
            name: d.partyName,
            balanceIrr: d.balanceIrr,
            overCreditLimit: d.overCreditLimit,
          })),
        };

        const resp = await fetch('/api/ai/copilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            history: messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
            snapshot: enrichedSnapshot,
          }),
        });

        const payload = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          reply?: string;
          error?: string;
          actions?: Array<{
            type?: string;
            label?: string;
            description?: string;
            module?: string;
            intent?: string;
          }>;
        };

        if (!resp.ok) {
          setMessages((prev) => [
            ...prev,
            {
              id: `e-${Date.now()}`,
              role: 'model',
              text:
                payload.error ||
                'ارتباط با موتور هوش مصنوعی آنلاین برقرار نشد. می‌توانید از دکمه «موتور بومی (آفلاین)» در بالای پنجره استفاده کنید.',
              isError: true,
            },
          ]);
          return;
        }

        const parsedActions: CopilotExecutableAction[] = Array.isArray(payload.actions)
          ? payload.actions
              .filter(
                (a): a is Required<Pick<typeof a, 'type' | 'label'>> & typeof a =>
                  Boolean(a && typeof a.type === 'string' && typeof a.label === 'string')
              )
              .map((a) => ({
                type:
                  a.type === 'finalize_clean_drafts' ||
                  a.type === 'generate_debtor_reminders' ||
                  a.type === 'open_vision_scanner' ||
                  a.type === 'open_whatif_simulator' ||
                  a.type === 'navigate'
                    ? a.type
                    : 'navigate',
                label: a.label,
                description: a.description,
                module:
                  a.module && VALID_MODULES.has(a.module)
                    ? (a.module as ActiveModule)
                    : undefined,
                intent: a.intent,
              }))
          : [];

        const fallbackLocalActions =
          parsedActions.length === 0
            ? inferLocalExecutableActions(trimmed, safeDraftVoucherIds.length, topDebtorReminders.length)
            : [];

        setMessages((prev) => [
          ...prev,
          {
            id: `m-${Date.now()}`,
            role: 'model',
            text: payload.reply || 'پاسخی تولید نشد.',
            engineLabel: 'هوش مصنوعی آنلاین (Gemini)',
            executableActions: parsedActions.length > 0 ? parsedActions : fallbackLocalActions,
          },
        ]);
      } else {
        const data = localCopilotRespond({
          message: trimmed,
          snapshot,
        });
        const localExecActions = inferLocalExecutableActions(
          trimmed,
          safeDraftVoucherIds.length,
          topDebtorReminders.length
        );
        setMessages((prev) => [
          ...prev,
          {
            id: `m-${Date.now()}`,
            role: 'model',
            text: data.reply || 'پاسخی تولید نشد.',
            engineLabel: 'موتور بومی آفلاین (Local-SLM)',
            suggestedActions: Array.isArray(data.suggestedActions)
              ? data.suggestedActions
              : undefined,
            executableActions: localExecActions.length > 0 ? localExecActions : undefined,
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'model',
          text:
            activeMode === 'online_gemini'
              ? 'خطا در اتصال به سرویس هوش مصنوعی آنلاین. می‌توانید با تغییر حالت به «موتور بومی (آفلاین)» بدون نیاز به اینترنت ادامه دهید.'
              : 'خطا در تحلیل محلی دفاتر مالی.',
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end no-print">
      <div
        className="flex-1 bg-slate-950/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="w-full max-w-lg bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 h-full flex flex-col shadow-2xl">
        {/* Header + Hybrid Online / Offline Mode Switcher */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  دستیار هوشمند اجرایی هلو Apex
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  تحلیل زنده دفاتر + اجرای مستقیم عملیات مالی و تأیید اسناد
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="بستن دستیار هوشمند"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            role="tablist"
            aria-label="انتخاب موتور پردازش دستیار هوشمند"
            className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={engineMode === 'online_gemini'}
              onClick={() => setEngineMode('online_gemini')}
              className={`h-8 px-2.5 rounded-lg text-[11px] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                engineMode === 'online_gemini'
                  ? 'bg-white dark:bg-slate-800 text-indigo-700 dark:text-indigo-300 font-bold shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 font-medium hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Cloud className="w-3.5 h-3.5 shrink-0" />
              <span>هوش مصنوعی پیشرفته (آنلاین)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={engineMode === 'offline_local'}
              onClick={() => setEngineMode('offline_local')}
              className={`h-8 px-2.5 rounded-lg text-[11px] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                engineMode === 'offline_local'
                  ? 'bg-white dark:bg-slate-800 text-teal-700 dark:text-teal-300 font-bold shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 font-medium hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <WifiOff className="w-3.5 h-3.5 shrink-0" />
              <span>موتور بومی (آفلاین)</span>
            </button>
          </div>
        </div>

        {/* Live Deterministic Executive Radar Strip */}
        <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 space-y-2 text-xs">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 dark:text-slate-400">
            <span>پایش لحظه‌ای دفاتر و کارتابل</span>
            <span className="font-code text-teal-700 dark:text-teal-400">
              امتیاز حسابرسی {toPersianDigits(auditReport.score)}٪
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('dashboard', 'intelligence', 'dashboard');
              }}
              className={`p-2 rounded-lg border text-right transition-colors cursor-pointer ${
                radar.earliestDeficitDate
                  ? 'border-rose-300 dark:border-rose-800 bg-rose-50/70 dark:bg-rose-950/40'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
              }`}
            >
              <div className="text-[10.5px] text-slate-500">نقدینگی ۳۰ روزه</div>
              <div
                className={`font-code tabular-nums font-bold mt-0.5 ${
                  radar.earliestDeficitDate
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {formatCompactMoney(radar.horizons[2].projectedBalance, unit)}
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('inventory', 'kardex', 'inv-kardex');
              }}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-right hover:border-teal-400 transition-colors cursor-pointer"
            >
              <div className="text-[10.5px] text-slate-500">کالای زیر نقطه سفارش</div>
              <div className="font-code tabular-nums font-bold mt-0.5 text-amber-700 dark:text-amber-400">
                {toPersianDigits(lowStockCount)} قلم
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigate('vouchers', 'cartable', 'voucher-cartable');
              }}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-right hover:border-teal-400 transition-colors cursor-pointer"
            >
              <div className="text-[10.5px] text-slate-500">سند موقت سالم</div>
              <div className="font-code tabular-nums font-bold mt-0.5 text-indigo-700 dark:text-indigo-400">
                {toPersianDigits(safeDraftVoucherIds.length)} از {toPersianDigits(draftVouchersCount)}
              </div>
            </button>
          </div>

          {radar.earliestDeficitDate && (
            <div className="flex items-center gap-2 text-[11px] text-rose-700 dark:text-rose-400 font-medium pt-0.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                هشدار شکاف نقدینگی در تاریخ {toPersianDigits(radar.earliestDeficitDate)} به مبلغ{' '}
                {formatCompactMoney(radar.earliestDeficitAmount, unit)}
              </span>
            </div>
          )}

          {/* Autonomous Offline AI Self-Evaluation Card (when Offline engine is active) */}
          {engineMode === 'offline_local' && aiOptResult && (
            <div className="mt-1.5 rounded-lg border border-indigo-200/80 dark:border-indigo-900/70 bg-white dark:bg-slate-900 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAiOptPanel((p) => !p)}
                className="w-full px-3 py-2 flex items-center justify-between gap-2 text-[11px] hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Cpu className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span className="font-bold text-slate-800 dark:text-slate-100 truncate">
                    خودارزیابی مدل آفلاین (نسل {toPersianDigits(aiOptResult.weights.generation)})
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="inline-flex items-center gap-1 font-code font-bold text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" />
                    دقت {toPersianDigits(aiOptResult.after.overallScorePct)}٪
                  </span>
                  {showAiOptPanel ? (
                    <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  )}
                </div>
              </button>

              {showAiOptPanel && (
                <div className="px-3 pb-3 pt-1.5 border-t border-slate-100 dark:border-slate-800 space-y-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
                    <span>
                      آزمون‌های موفق: {toPersianDigits(aiOptResult.after.passedCases)} از{' '}
                      {toPersianDigits(aiOptResult.after.totalCases)} · زمان:{' '}
                      {toPersianDigits(aiOptResult.after.avgLatencyMs)} ms
                    </span>
                    <button
                      type="button"
                      disabled={optimizingAi}
                      onClick={executeAutonomousEvaluation}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-semibold hover:bg-indigo-100 dark:hover:bg-indigo-900/50 disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`w-3 h-3 ${optimizingAi ? 'animate-spin' : ''}`} />
                      <span>بهینه‌سازی مجدد</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Conversation Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-indigo-50/60 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-900 text-xs leading-6 text-slate-700 dark:text-slate-300">
                <div className="font-bold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5 mb-1">
                  <Bot className="w-4 h-4" />
                  <span>دستیار اجرایی متصل به دفاتر واقعی و کارتابل</span>
                </div>
                علاوه بر پاسخ تحلیلی، می‌توانید از دستیار بخواهید اسناد موقت سالم را یکجا دائم‌سازی کند، پیام یادآوری پرداخت بدهکاران را آماده کند یا اسکنر OCR و شبیه‌ساز را باز کند.
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-500">
                  دستورات و سؤالات آماده (کلیک کنید):
                </div>
                {STARTER_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void sendQuestion(q)}
                    className="w-full text-right p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-xs text-slate-700 dark:text-slate-200 flex items-center justify-between gap-2 transition-colors cursor-pointer"
                  >
                    <span>{q}</span>
                    <ArrowUpLeft className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === 'user' ? 'items-start' : 'items-end'}`}
              >
                <div
                  className={`max-w-[94%] rounded-xl px-3.5 py-2.5 text-xs leading-6 whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : msg.isError
                        ? 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-700'
                  }`}
                >
                  {msg.engineLabel && (
                    <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      {msg.engineLabel}
                    </div>
                  )}
                  {msg.text}
                </div>

                {/* Quick Switch to Offline Mode if Online Failed */}
                {msg.isError && engineMode === 'online_gemini' && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEngineMode('offline_local');
                        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
                        if (lastUser) void sendQuestion(lastUser.text, 'offline_local');
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[11px] font-semibold cursor-pointer transition-colors"
                    >
                      <WifiOff className="w-3.5 h-3.5" />
                      <span>پاسخ همین سؤال با موتور بومی (آفلاین)</span>
                    </button>
                  </div>
                )}

                {/* Executable Action Cards */}
                {msg.executableActions && msg.executableActions.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-2 w-[94%]">
                    {msg.executableActions.map((act, idx) => {
                      const actionKey = `${msg.id}-${idx}`;
                      const isBusy = executingActionKey === actionKey;
                      const ActionIcon =
                        act.type === 'finalize_clean_drafts'
                          ? ShieldCheck
                          : act.type === 'open_vision_scanner'
                            ? ScanLine
                            : act.type === 'open_whatif_simulator'
                              ? Sliders
                              : act.type === 'generate_debtor_reminders'
                                ? Copy
                                : TrendingUp;
                      return (
                        <button
                          key={actionKey}
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleExecuteAction(act, actionKey)}
                          className="w-full text-right px-3 py-2 rounded-xl border border-indigo-200 dark:border-indigo-800/80 bg-indigo-50/75 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200 text-xs font-semibold flex items-center justify-between gap-2 transition-colors cursor-pointer disabled:opacity-60"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {isBusy ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                              ) : (
                                <ActionIcon className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <span className="truncate">{act.label}</span>
                            </div>
                            {act.description && (
                              <div className="text-[10.5px] font-normal text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                                {act.description}
                              </div>
                            )}
                          </div>
                          <ArrowUpLeft className="w-3.5 h-3.5 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Inline Ready-to-Copy Debtor Reminders */}
                {msg.debtorReminders && msg.debtorReminders.length > 0 && (
                  <div className="mt-2 w-[94%] space-y-2">
                    {msg.debtorReminders.map((rem) => (
                      <div
                        key={rem.partyId}
                        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-900 dark:text-white truncate">
                            {rem.partyName}
                          </span>
                          <span className="font-code tabular-nums font-bold text-rose-600 dark:text-rose-400 shrink-0">
                            {formatMoney(rem.balanceIrr, unit)}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-5 whitespace-pre-wrap">
                          {rem.messageText}
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleCopyReminder(rem.partyId, rem.messageText)}
                          className="h-8 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          {copiedReminderId === rem.partyId ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>کپی شد</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>کپی پیام برای واتساپ / پیامک</span>
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Legacy Suggested Navigation Actions (Local-SLM) */}
                {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {msg.suggestedActions.map((act, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          onClose();
                          onNavigate(act.module, act.intent);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-950/70 transition-colors cursor-pointer"
                      >
                        <TrendingUp className="w-3 h-3" />
                        <span>{act.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-indigo-700 dark:text-indigo-400 py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                {engineMode === 'online_gemini'
                  ? 'در حال تحلیل هوشمند دفاتر و آماده‌سازی اکشن‌های اجرایی...'
                  : 'در حال تحلیل محلی دفاتر مالی...'}
              </span>
            </div>
          )}
        </div>

        {/* Prompt Input Footer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendQuestion(input);
          }}
          className="p-3.5 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="دستور اجرایی یا سؤال مالی خود را بنویسید..."
            className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 focus:outline-none focus:border-indigo-600"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>ارسال</span>
          </button>
        </form>
      </aside>
    </div>
  );
};
