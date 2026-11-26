import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Plus,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ActiveModule, CurrencyUnit } from '../../types/accounting';
import { formatCompactMoney, formatMoney, toPersianDigits } from '../../lib/format';
import {
  type DebtorReminderItem,
  type ExecutiveBriefingPriority,
  runWhatIfSimulation,
  type SmartAutomationRule,
  type SmartRuleKind,
  type SmartRuleTrigger,
  type WhatIfScenarioInput,
} from '../../lib/smartAutomationEngine';
import type { Cheque, ImportDossier } from '../../types/accounting';

/* ============================================================================
 * 1. COMPACT EXECUTIVE SMART BRIEFING STRIP (خلاصه اجرایی هوشمند امروز)
 * ========================================================================== */

interface ExecutiveBriefingStripProps {
  priorities: ExecutiveBriefingPriority[];
  activeTriggersCount: number;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onOpenIntelligenceTab: () => void;
  onOpenVisionScanner: () => void;
}

export const ExecutiveBriefingStrip: React.FC<ExecutiveBriefingStripProps> = ({
  priorities,
  activeTriggersCount,
  onNavigate,
  onOpenIntelligenceTab,
  onOpenVisionScanner,
}) => {
  const handlePriorityAction = (p: ExecutiveBriefingPriority) => {
    if (p.actionTarget.type === 'open_intelligence') {
      onOpenIntelligenceTab();
    } else if (p.actionTarget.type === 'open_vision_scanner') {
      onOpenVisionScanner();
    } else {
      onNavigate(p.actionTarget.module, p.actionTarget.intent, p.actionTarget.subKey);
    }
  };

  return (
    <section
      aria-label="خلاصه اجرایی هوشمند امروز"
      className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-4 sm:p-5 space-y-3.5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 dark:text-white tracking-tight">
            خلاصه اجرایی هوشمند امروز
          </h2>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
            ·
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {activeTriggersCount > 0
              ? `${toPersianDigits(activeTriggersCount)} قانون اتوماسیون فعال آماده اجرا`
              : 'پایش زنده نقدینگی، ممیزی اسناد و انبار'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenVisionScanner}
            className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900 hover:border-indigo-300 dark:hover:border-indigo-700 text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
          >
            <ScanLine className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>اسکن هوشمند سند (OCR)</span>
          </button>
          <button
            type="button"
            onClick={onOpenIntelligenceTab}
            className="h-8 px-3 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 text-xs font-semibold text-indigo-700 dark:text-indigo-300 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
          >
            <Sliders className="w-3.5 h-3.5 shrink-0" />
            <span>شبیه‌ساز و موتور قوانین</span>
            <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {priorities.map((item) => {
          const severityTone =
            item.severity === 'critical'
              ? 'text-rose-600 dark:text-rose-400'
              : item.severity === 'warning'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400';

          return (
            <div
              key={item.id}
              className="rounded-xl border border-slate-200/75 dark:border-slate-800/80 bg-slate-50/55 dark:bg-slate-950/40 p-3.5 flex flex-col justify-between gap-2.5"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-slate-900 dark:text-slate-100 truncate">
                    {item.title}
                  </span>
                  <span className={`font-code tabular-nums font-extrabold whitespace-nowrap shrink-0 ${severityTone}`}>
                    {item.metricText}
                  </span>
                </div>
                <p className="text-[11.5px] text-slate-600 dark:text-slate-400 leading-relaxed">
                  {item.summary}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handlePriorityAction(item)}
                className="text-[11.5px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 w-fit cursor-pointer"
              >
                <span>{item.actionLabel}</span>
                <ArrowLeft className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
};

/* ============================================================================
 * 2. SMART INTELLIGENCE HUB PANEL (شبیه‌ساز «چه می‌شود اگر؟» + موتور قوانین هوشمند)
 * ========================================================================== */

interface SmartIntelligenceHubPanelProps {
  unit: CurrencyUnit;
  unitLabel: string;
  currentLiquidity: number;
  cheques: Cheque[];
  importDossiers: ImportDossier[];
  netSales: number;
  grossProfit: number;
  netProfit: number;
  rules: SmartAutomationRule[];
  triggers: SmartRuleTrigger[];
  debtorReminders: DebtorReminderItem[];
  onToggleRule: (ruleId: string) => void;
  onUpdateRuleThreshold: (ruleId: string, nextThreshold: number) => void;
  onAddCustomRule: (rule: SmartAutomationRule) => void;
  onDeleteRule: (ruleId: string) => void;
  onExecuteTrigger: (trigger: SmartRuleTrigger) => Promise<void>;
  onOpenVisionScanner: () => void;
}

const DEFAULT_SCENARIO: WhatIfScenarioInput = {
  fxChangePct: 15,
  chequeDelayDays: 10,
  salesVolumeChangePct: 0,
  marginShiftPct: 0,
};

export const SmartIntelligenceHubPanel: React.FC<SmartIntelligenceHubPanelProps> = ({
  unit,
  unitLabel,
  currentLiquidity,
  cheques,
  importDossiers,
  netSales,
  grossProfit,
  netProfit,
  rules,
  triggers,
  debtorReminders,
  onToggleRule,
  onUpdateRuleThreshold,
  onAddCustomRule,
  onDeleteRule,
  onExecuteTrigger,
  onOpenVisionScanner,
}) => {
  const [scenario, setScenario] = useState<WhatIfScenarioInput>(DEFAULT_SCENARIO);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showAddRuleForm, setShowAddRuleForm] = useState(false);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleKind, setNewRuleKind] = useState<SmartRuleKind>('safe_draft_batch_approve');
  const [newRuleThreshold, setNewRuleThreshold] = useState<number>(1_000_000_000);

  const millionDivisor = unit === 'IRT' ? 10_000_000 : 1_000_000;

  const sim = useMemo(
    () =>
      runWhatIfSimulation({
        scenario,
        currentLiquidity,
        cheques,
        importDossiers,
        netSales,
        grossProfit,
        netProfit,
      }),
    [scenario, currentLiquidity, cheques, importDossiers, netSales, grossProfit, netProfit]
  );

  const chartData = useMemo(
    () => [
      {
        name: 'نقدینگی ۳۰ روزه',
        فعلی: Math.round(sim.baselineLiquidity30d / millionDivisor),
        شبیه‌سازی: Math.round(sim.simulatedLiquidity30d / millionDivisor),
      },
      {
        name: 'سود خالص دوره',
        فعلی: Math.round(sim.baselineNetProfitIrr / millionDivisor),
        شبیه‌سازی: Math.round(sim.simulatedNetProfitIrr / millionDivisor),
      },
      {
        name: 'بهای واردات باز',
        فعلی: Math.round(sim.baselineImportCostIrr / millionDivisor),
        شبیه‌سازی: Math.round(sim.simulatedImportCostIrr / millionDivisor),
      },
    ],
    [sim, millionDivisor]
  );

  const handleCopyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2200);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleRunTrigger = async (trigger: SmartRuleTrigger) => {
    setBusyRuleId(trigger.ruleId);
    try {
      await onExecuteTrigger(trigger);
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleCreateCustomRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleName.trim()) return;
    const unitByKind: Record<SmartRuleKind, string> = {
      safe_draft_batch_approve: 'ریال سقف هر سند',
      cheque_bank_shortfall: 'روز پیش از سررسید',
      low_stock_reorder: 'درصد حاشیه ایمنی',
      over_credit_reminder: 'ریال آستانه بدهی',
    };
    const descByKind: Record<SmartRuleKind, string> = {
      safe_draft_batch_approve: 'اسناد موقت تراز و بدون خطا زیر سقف تعیین‌شده را آماده تأیید گروهی می‌کند.',
      cheque_bank_shortfall: 'کمبود موجودی بانک برای پوشش چک‌های پرداختی را شناسایی و پیش‌نویس انتقال وجه می‌سازد.',
      low_stock_reorder: 'اقلام زیر نقطه سفارش را با حاشیه ایمنی مشخص‌شده برای خرید پیشنهاد می‌دهد.',
      over_credit_reminder: 'برای بدهکاران بالاتر از آستانه، پیام پیگیری رسمی آماده می‌کند.',
    };
    onAddCustomRule({
      id: `custom_rule_${Date.now()}`,
      name: newRuleName.trim(),
      description: descByKind[newRuleKind],
      kind: newRuleKind,
      enabled: true,
      thresholdValue: Math.max(1, Number(newRuleThreshold) || 1),
      thresholdUnitLabel: unitByKind[newRuleKind],
      isCustom: true,
    });
    setNewRuleName('');
    setShowAddRuleForm(false);
  };

  const simRiskClass =
    sim.riskStatus === 'critical'
      ? 'text-rose-600 dark:text-rose-400'
      : sim.riskStatus === 'watch'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="space-y-6">
      {/* SECTION 1: REAL-TIME WHAT-IF FINANCIAL SIMULATOR */}
      <section className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                شبیه‌ساز مالی «چه می‌شود اگر؟» (What-If)
              </h2>
              <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                ·
              </span>
              <span className={`text-xs font-semibold ${simRiskClass}`}>{sim.riskLabel}</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              تأثیر هم‌زمان نوسان نرخ ارز، تأخیر وصول چک‌ها و تغییر فروش را بر نقدینگی ۳۰ روزه و سود خالص بسنجید
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setScenario({ fxChangePct: 0, chequeDelayDays: 0, salesVolumeChangePct: 0, marginShiftPct: 0 })}
              className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>بازگشت به حالت پایه</span>
            </button>
            <button
              type="button"
              onClick={onOpenVisionScanner}
              className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <ScanLine className="w-3.5 h-3.5" />
              <span>اسکن هوشمند سند (OCR)</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          {/* Interactive Sliders Column */}
          <div className="lg:col-span-5 space-y-4 rounded-xl border border-slate-200/75 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-fx-slider" className="font-semibold text-slate-700 dark:text-slate-200">
                  تغییر نرخ ارز (واردات باز)
                </label>
                <span className="font-code tabular-nums font-bold text-indigo-600 dark:text-indigo-400">
                  {scenario.fxChangePct > 0 ? '+' : ''}
                  {toPersianDigits(scenario.fxChangePct)}٪
                </span>
              </div>
              <input
                id="sim-fx-slider"
                type="range"
                min={-30}
                max={60}
                step={5}
                value={scenario.fxChangePct}
                onChange={(e) => setScenario((s) => ({ ...s, fxChangePct: Number(e.target.value) }))}
                className="w-full accent-indigo-600 cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-cheque-slider" className="font-semibold text-slate-700 dark:text-slate-200">
                  تأخیر در وصول چک‌های دریافتی
                </label>
                <span className="font-code tabular-nums font-bold text-amber-700 dark:text-amber-400">
                  {toPersianDigits(scenario.chequeDelayDays)} روز
                </span>
              </div>
              <input
                id="sim-cheque-slider"
                type="range"
                min={0}
                max={45}
                step={5}
                value={scenario.chequeDelayDays}
                onChange={(e) => setScenario((s) => ({ ...s, chequeDelayDays: Number(e.target.value) }))}
                className="w-full accent-amber-600 cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-sales-slider" className="font-semibold text-slate-700 dark:text-slate-200">
                  تغییر حجم فروش دوره
                </label>
                <span className="font-code tabular-nums font-bold text-emerald-700 dark:text-emerald-400">
                  {scenario.salesVolumeChangePct > 0 ? '+' : ''}
                  {toPersianDigits(scenario.salesVolumeChangePct)}٪
                </span>
              </div>
              <input
                id="sim-sales-slider"
                type="range"
                min={-40}
                max={60}
                step={5}
                value={scenario.salesVolumeChangePct}
                onChange={(e) => setScenario((s) => ({ ...s, salesVolumeChangePct: Number(e.target.value) }))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="sim-margin-slider" className="font-semibold text-slate-700 dark:text-slate-200">
                  تغییر حاشیه سود ناخالص
                </label>
                <span className="font-code tabular-nums font-bold text-sky-700 dark:text-sky-400">
                  {scenario.marginShiftPct > 0 ? '+' : ''}
                  {toPersianDigits(scenario.marginShiftPct)}٪
                </span>
              </div>
              <input
                id="sim-margin-slider"
                type="range"
                min={-15}
                max={15}
                step={1}
                value={scenario.marginShiftPct}
                onChange={(e) => setScenario((s) => ({ ...s, marginShiftPct: Number(e.target.value) }))}
                className="w-full accent-sky-600 cursor-pointer"
              />
            </div>

            <p className="text-[11.5px] text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-200/75 dark:border-slate-800 leading-relaxed">
              {sim.headlineInsight}
            </p>
          </div>

          {/* Results KPIs + Comparison Chart */}
          <div className="lg:col-span-7 flex flex-col justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-3.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">نقدینگی ۳۰ روزه (شبیه‌سازی)</div>
                <div
                  className={`text-lg font-extrabold font-code tabular-nums mt-1 ${
                    sim.simulatedLiquidity30d < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-900 dark:text-white'
                  }`}
                >
                  {formatCompactMoney(sim.simulatedLiquidity30d, unit)}
                </div>
                <div
                  className={`text-[11px] font-code tabular-nums mt-1 font-semibold ${
                    sim.liquidityDeltaIrr < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {sim.liquidityDeltaIrr >= 0 ? '+' : ''}
                  {formatCompactMoney(sim.liquidityDeltaIrr, unit)} نسبت به پایه
                </div>
              </div>

              <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-3.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">سود خالص پیش‌بینی‌شده</div>
                <div
                  className={`text-lg font-extrabold font-code tabular-nums mt-1 ${
                    sim.simulatedNetProfitIrr < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-900 dark:text-white'
                  }`}
                >
                  {formatCompactMoney(sim.simulatedNetProfitIrr, unit)}
                </div>
                <div className="text-[11px] font-code tabular-nums mt-1 text-slate-500 dark:text-slate-400">
                  حاشیه سود: {toPersianDigits(sim.simulatedNetMarginPct)}٪ (پایه {toPersianDigits(sim.baselineNetMarginPct)}٪)
                </div>
              </div>

              <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-3.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">تأثیر ارزی بر واردات باز</div>
                <div className="text-lg font-extrabold font-code tabular-nums mt-1 text-slate-900 dark:text-white">
                  {sim.importCostDeltaIrr >= 0 ? '+' : ''}
                  {formatCompactMoney(sim.importCostDeltaIrr, unit)}
                </div>
                <div className="text-[11px] font-code tabular-nums mt-1 text-slate-500 dark:text-slate-400">
                  چک معوق‌شده: {formatCompactMoney(sim.delayedReceivablesIrr, unit)}
                </div>
              </div>
            </div>

            <div className="h-52 w-full rounded-xl border border-slate-200/75 dark:border-slate-800 p-3" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '10px',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      color: '#0f172a',
                      fontSize: '12px',
                      direction: 'rtl',
                      textAlign: 'right',
                    }}
                    formatter={(val: unknown, name: unknown) => [
                      `${toPersianDigits(Number(val).toLocaleString('en-US'))} ${unitLabel}`,
                      String(name ?? ''),
                    ]}
                  />
                  <Bar dataKey="فعلی" fill="#94a3b8" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="شبیه‌سازی" fill="#4f46e5" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: SMART AUTOMATION RULES ENGINE & LIVE TRIGGERS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Live Triggered Automations (7 cols) */}
        <section className="lg:col-span-7 bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500 shrink-0" />
                <span>اقدامات پیشنهادی موتور قوانین هوشمند</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                بر اساس قوانین فعال شما و داده‌های لحظه‌ای دفاتر، اقدامات زیر آماده اجرای یک‌کلیکه هستند
              </p>
            </div>
            <span className="text-xs font-code tabular-nums font-bold text-indigo-600 dark:text-indigo-400 shrink-0">
              {toPersianDigits(triggers.length)} مورد فعال
            </span>
          </div>

          {triggers.length === 0 ? (
            <div className="rounded-xl border border-slate-200/75 dark:border-slate-800 p-6 text-center space-y-1.5">
              <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400 mx-auto" />
              <div className="text-sm font-semibold text-slate-900 dark:text-white">
                همه قوانین در وضعیت پایدار هستند
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                در حال حاضر هیچ کسری بانکی، سند معلق یا هشدار جدیدی مطابق آستانه‌های تنظیم‌شده شناسایی نشد.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {triggers.map((trig) => {
                const isBusy = busyRuleId === trig.ruleId;
                const toneColor =
                  trig.severity === 'critical'
                    ? 'text-rose-600 dark:text-rose-400'
                    : trig.severity === 'warning'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-indigo-600 dark:text-indigo-400';

                return (
                  <div
                    key={trig.ruleId}
                    className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className={`font-bold ${toneColor}`}>
                          {trig.severity === 'critical'
                            ? 'اولویت فوری'
                            : trig.severity === 'warning'
                              ? 'هشدار هوشمند'
                              : 'آماده اتوماسیون'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{trig.ruleName}</span>
                      </div>
                      <div className="text-sm font-bold text-slate-900 dark:text-white">
                        {trig.headline}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                        {trig.detail}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRunTrigger(trig)}
                      className="h-9 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-3.5 h-3.5" />
                      )}
                      <span>{trig.actionLabel}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick Ready-to-Copy Debtor Reminder Messages */}
          {debtorReminders.length > 0 && (
            <div className="pt-3 border-t border-slate-200/80 dark:border-slate-800 space-y-2.5">
              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                متن آماده یادآوری پرداخت برای ۳ مشتری با بیشترین بدهی
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                {debtorReminders.map((rem) => (
                  <div
                    key={rem.partyId}
                    className="rounded-xl border border-slate-200/75 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-bold text-slate-900 dark:text-white">{rem.partyName}</span>
                        <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                          ·
                        </span>
                        <span className="font-code tabular-nums font-bold text-rose-600 dark:text-rose-400">
                          {formatMoney(rem.balanceIrr, unit)}
                        </span>
                        {rem.overCreditLimit && (
                          <>
                            <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
                              ·
                            </span>
                            <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              عبور از سقف اعتبار
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                        {rem.messageText}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopyText(rem.partyId, rem.messageText)}
                      className="h-8 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-indigo-400 text-xs font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                    >
                      {copiedId === rem.partyId ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span>کپی شد</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>کپی متن پیام</span>
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Rule Configuration Panel (5 cols) */}
        <section className="lg:col-span-5 bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                تنظیمات قوانین اتوماسیون
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                آستانه‌های هوشمند را مطابق سیاست مالی شرکت تنظیم کنید
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddRuleForm((p) => !p)}
              className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-400 text-xs font-semibold text-indigo-600 dark:text-indigo-400 inline-flex items-center gap-1 cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>قانون جدید</span>
            </button>
          </div>

          {showAddRuleForm && (
            <form
              onSubmit={handleCreateCustomRule}
              className="rounded-xl border border-indigo-200/80 dark:border-indigo-800/70 bg-indigo-50/40 dark:bg-indigo-950/25 p-3.5 space-y-2.5"
            >
              <input
                type="text"
                required
                value={newRuleName}
                onChange={(e) => setNewRuleName(e.target.value)}
                placeholder="عنوان قانون (مثلاً کنترل اسناد خرد روزانه)"
                className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={newRuleKind}
                  onChange={(e) => setNewRuleKind(e.target.value as SmartRuleKind)}
                  className="h-9 px-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                >
                  <option value="safe_draft_batch_approve">تأیید گروهی اسناد سالم</option>
                  <option value="cheque_bank_shortfall">انتقال بین‌بانکی چک</option>
                  <option value="low_stock_reorder">سفارش مجدد کالا</option>
                  <option value="over_credit_reminder">یادآوری بدهی مشتری</option>
                </select>
                <input
                  type="number"
                  min={1}
                  value={newRuleThreshold}
                  onChange={(e) => setNewRuleThreshold(Number(e.target.value) || 0)}
                  placeholder="مقدار آستانه"
                  className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-slate-900 dark:text-white"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddRuleForm(false)}
                  className="h-8 px-3 rounded-lg text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  className="h-8 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
                >
                  افزودن قانون
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="rounded-xl border border-slate-200/80 dark:border-slate-800 p-3.5 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      {rule.name}
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      {rule.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {rule.isCustom && (
                      <button
                        type="button"
                        onClick={() => onDeleteRule(rule.id)}
                        aria-label="حذف قانون سفارشی"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      onClick={() => onToggleRule(rule.id)}
                      className={`h-6 w-11 rounded-full p-0.5 transition-colors cursor-pointer ${
                        rule.enabled ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                      }`}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-xs transition-transform ${
                          rule.enabled ? '-translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/80">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    آستانه ({rule.thresholdUnitLabel}):
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={rule.thresholdValue}
                    onChange={(e) =>
                      onUpdateRuleThreshold(rule.id, Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-36 h-8 px-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-left text-slate-900 dark:text-white"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
