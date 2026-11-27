import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Edit3,
  FilePlus2,
  LayoutTemplate,
  Lock,
  Plus,
  Scale,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  Account,
  CostCenter,
  CurrencyUnit,
  Party,
  VoucherType,
} from '../types/accounting';
import {
  AppliedVoucherTemplateResult,
  SYSTEM_VOUCHER_TEMPLATES,
  VOUCHER_TEMPLATE_CATEGORY_LABELS,
  VOUCHER_TEMPLATES_CHANGED_EVENT,
  VoucherTemplate,
  VoucherTemplateCategory,
  VoucherTemplateFormula,
  VoucherTemplateLineDef,
  applyVoucherTemplate,
  deleteCustomVoucherTemplate,
  duplicateTemplateAsCustom,
  formatTemplateAccountSummary,
  incrementTemplateUsage,
  loadCustomVoucherTemplates,
  upsertCustomVoucherTemplate,
} from '../lib/voucherTemplates';
import { formatMoney, toPersianDigits } from '../lib/format';
import { sumIrr, toExactIrr } from '../lib/moneyMath';
import { MoneyInput } from './ui/MoneyInput';
import { SmartSearchCombobox, SmartSearchOption } from './SmartSearchCombobox';

const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  opening: 'افتتاحیه',
  general: 'عمومی / اصلاحی',
  sales: 'فروش',
  purchase: 'خرید',
  treasury: 'خزانه‌داری',
  payroll: 'حقوق و دستمزد',
  depreciation: 'استهلاک',
  closing: 'اختتامیه',
};

const FORMULA_OPTIONS: Array<{ value: VoucherTemplateFormula; label: string }> = [
  { value: 'fixed', label: 'مبلغ اولیه ثابت' },
  { value: 'full', label: '۱۰۰٪ مبلغ پایه' },
  { value: 'vat_10', label: '۱۰٪ ارزش افزوده' },
  { value: 'gross_with_vat_10', label: 'مبلغ پایه + ۱۰٪ مالیات' },
  { value: 'percentage', label: 'درصد دلخواه از پایه' },
];

interface VoucherTemplatesManagerModalProps {
  open: boolean;
  initialTemplateId?: string | null;
  accounts: Account[];
  parties: Party[];
  costCenters: CostCenter[];
  unit: CurrencyUnit;
  date: string;
  onClose: () => void;
  onLoadTemplateIntoNewVoucher: (
    applied: AppliedVoucherTemplateResult,
    templateName: string
  ) => void;
  onNotify: (message: string) => void;
}

function createBlankLine(
  accountCode: string,
  fallbackTitle: string,
  side: 'debit' | 'credit'
): VoucherTemplateLineDef {
  return {
    accountCode,
    fallbackTitle,
    side,
    formula: 'fixed',
    fixedAmount: 0,
    defaultDescription: '',
    requiresParty: accountCode.startsWith('104') || accountCode.startsWith('301'),
  };
}

export const VoucherTemplatesManagerModal: React.FC<VoucherTemplatesManagerModalProps> = ({
  open,
  initialTemplateId,
  accounts,
  parties,
  costCenters,
  unit,
  date,
  onClose,
  onLoadTemplateIntoNewVoucher,
  onNotify,
}) => {
  const [customTemplates, setCustomTemplates] = useState<VoucherTemplate[]>(() =>
    loadCustomVoucherTemplates()
  );
  const [listFilter, setListFilter] = useState<'all' | 'custom' | 'system'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Editor state: mode === 'create' | 'edit' | 'view_system'
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | 'view_system'>('create');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Draft fields for create/edit
  const [draftName, setDraftName] = useState('');
  const [draftCategory, setDraftCategory] = useState<VoucherTemplateCategory>('general_expenses');
  const [draftVoucherType, setDraftVoucherType] = useState<VoucherType>('general');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftQuickLabel, setDraftQuickLabel] = useState('مبلغ پایه سند (ریال)');
  const [draftLines, setDraftLines] = useState<VoucherTemplateLineDef[]>([
    createBlankLine('80201', 'اجاره دفتر، انبار شادآباد و قبوض', 'debit'),
    createBlankLine('10201', 'بانک ملت — حساب جاری شرکتی', 'credit'),
  ]);

  // Sync with external changes & Escape key
  useEffect(() => {
    if (!open) return;
    const refresh = () => setCustomTemplates(loadCustomVoucherTemplates());
    refresh();
    window.addEventListener(VOUCHER_TEMPLATES_CHANGED_EVENT, refresh);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(VOUCHER_TEMPLATES_CHANGED_EVENT, refresh);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const moeinAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.level === 'moein' || a.level === 'tafsili')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts]
  );

  const accountPickerOptions: SmartSearchOption[] = useMemo(
    () =>
      moeinAccounts.map((a) => ({
        id: a.code,
        code: a.code,
        label: a.title,
        sublabel: `سطح: ${a.level === 'moein' ? 'معین' : 'تفصیلی'}`,
        keywords: `${a.code} ${a.title} ${a.parentCode || ''}`,
      })),
    [moeinAccounts]
  );

  const partyPickerOptions: SmartSearchOption[] = useMemo(
    () => [
      { id: '', label: 'بدون طرف‌حساب پیش‌فرض', sublabel: 'انتخاب هنگام ثبت سند' },
      ...parties.map((p) => ({
        id: p.id,
        code: p.code,
        label: p.name,
        sublabel: p.nationalId ? `شناسه: ${p.nationalId}` : p.phone || '',
        keywords: `${p.code} ${p.name} ${p.nationalId || ''}`,
      })),
    ],
    [parties]
  );

  const allTemplates = useMemo(
    () => [...customTemplates, ...SYSTEM_VOUCHER_TEMPLATES],
    [customTemplates]
  );

  const loadTemplateIntoEditor = (tpl: VoucherTemplate) => {
    setSelectedId(tpl.id);
    setConfirmDeleteId(null);
    setFormError(null);
    if (tpl.isSystem) {
      setEditorMode('view_system');
      return;
    }
    setEditorMode('edit');
    setDraftName(tpl.name);
    setDraftCategory(tpl.category);
    setDraftVoucherType(tpl.voucherType);
    setDraftDescription(tpl.descriptionTemplate);
    setDraftQuickLabel(tpl.quickAmountLabel || 'مبلغ پایه سند (ریال)');
    setDraftLines(tpl.lines.map((l) => ({ ...l })));
  };

  const startCreateNew = () => {
    const firstAcc = moeinAccounts.find((a) => a.code === '80201') || moeinAccounts[0];
    const secondAcc = moeinAccounts.find((a) => a.code === '10201') || moeinAccounts[1] || firstAcc;
    setSelectedId(null);
    setConfirmDeleteId(null);
    setFormError(null);
    setEditorMode('create');
    setDraftName('');
    setDraftCategory('general_expenses');
    setDraftVoucherType('general');
    setDraftDescription('');
    setDraftQuickLabel('مبلغ پایه سند (ریال)');
    setDraftLines([
      createBlankLine(firstAcc?.code || '80201', firstAcc?.title || 'حساب بدهکار', 'debit'),
      createBlankLine(secondAcc?.code || '10201', secondAcc?.title || 'حساب بستانکار', 'credit'),
    ]);
  };

  // Focus initial template when modal opens
  useEffect(() => {
    if (!open) return;
    if (initialTemplateId) {
      const target = [...loadCustomVoucherTemplates(), ...SYSTEM_VOUCHER_TEMPLATES].find(
        (t) => t.id === initialTemplateId
      );
      if (target) {
        loadTemplateIntoEditor(target);
        return;
      }
    }
    const existingCustom = loadCustomVoucherTemplates();
    if (existingCustom.length > 0) {
      loadTemplateIntoEditor(existingCustom[0]);
    } else {
      startCreateNew();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplateId]);

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allTemplates.filter((t) => {
      if (listFilter === 'custom' && t.isSystem) return false;
      if (listFilter === 'system' && !t.isSystem) return false;
      if (!q) return true;
      const hay = [
        t.name,
        t.hint,
        VOUCHER_TEMPLATE_CATEGORY_LABELS[t.category],
        ...t.lines.map((l) => `${l.accountCode} ${l.fallbackTitle}`),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allTemplates, listFilter, searchQuery]);

  const viewedSystemTemplate = useMemo(
    () =>
      editorMode === 'view_system'
        ? SYSTEM_VOUCHER_TEMPLATES.find((t) => t.id === selectedId) || null
        : null,
    [editorMode, selectedId]
  );

  // Live initial fixed-amount balance check
  const fixedDebitTotal = useMemo(
    () =>
      sumIrr(
        draftLines.map((l) =>
          l.formula === 'fixed' && l.side === 'debit'
            ? Math.max(0, toExactIrr(l.fixedAmount ?? 0))
            : 0
        )
      ),
    [draftLines]
  );
  const fixedCreditTotal = useMemo(
    () =>
      sumIrr(
        draftLines.map((l) =>
          l.formula === 'fixed' && l.side === 'credit'
            ? Math.max(0, toExactIrr(l.fixedAmount ?? 0))
            : 0
        )
      ),
    [draftLines]
  );
  const fixedDiff = fixedDebitTotal - fixedCreditTotal;
  const allLinesFixed = draftLines.every((l) => l.formula === 'fixed');

  if (!open) return null;

  const autoBalanceDraftLine = (idx: number) => {
    setDraftLines((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      const otherDebit = sumIrr(
        prev.map((l, i) =>
          i !== idx && l.formula === 'fixed' && l.side === 'debit'
            ? Math.max(0, toExactIrr(l.fixedAmount ?? 0))
            : 0
        )
      );
      const otherCredit = sumIrr(
        prev.map((l, i) =>
          i !== idx && l.formula === 'fixed' && l.side === 'credit'
            ? Math.max(0, toExactIrr(l.fixedAmount ?? 0))
            : 0
        )
      );
      const diff = otherDebit - otherCredit;
      if (diff === 0) return prev;
      return prev.map((line, i) =>
        i === idx
          ? {
              ...line,
              formula: 'fixed',
              side: diff > 0 ? 'credit' : 'debit',
              fixedAmount: Math.abs(diff),
            }
          : line
      );
    });
  };

  const handleSaveTemplate = (andLoadNewVoucher = false) => {
    setFormError(null);
    try {
      const { template, templates } = upsertCustomVoucherTemplate({
        id: editorMode === 'edit' && selectedId ? selectedId : undefined,
        name: draftName,
        category: draftCategory,
        voucherType: draftVoucherType,
        descriptionTemplate: draftDescription,
        quickAmountLabel: draftQuickLabel,
        lines: draftLines,
      });
      setCustomTemplates(templates);
      setSelectedId(template.id);
      setEditorMode('edit');

      if (andLoadNewVoucher) {
        const applied = applyVoucherTemplate(template, {
          accounts,
          baseAmountIrr: 0,
          date,
        });
        incrementTemplateUsage(template.id);
        onLoadTemplateIntoNewVoucher(applied, template.name);
        onClose();
      } else {
        onNotify(
          editorMode === 'edit'
            ? `تغییرات الگوی «${template.name}» با موفقیت ذخیره شد.`
            : `الگوی جدید «${template.name}» ایجاد و ذخیره شد.`
        );
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطا در ذخیره الگوی سند.');
    }
  };

  const handleDeleteTemplate = (tpl: VoucherTemplate) => {
    const next = deleteCustomVoucherTemplate(tpl.id);
    setCustomTemplates(next);
    setConfirmDeleteId(null);
    onNotify(`الگوی «${tpl.name}» حذف شد.`);
    if (selectedId === tpl.id) {
      if (next.length > 0) {
        loadTemplateIntoEditor(next[0]);
      } else {
        startCreateNew();
      }
    }
  };

  const handleDuplicateTemplate = (source: VoucherTemplate) => {
    try {
      const { template, templates } = duplicateTemplateAsCustom(source);
      setCustomTemplates(templates);
      loadTemplateIntoEditor(template);
      onNotify(`نسخه قابل ویرایش «${template.name}» ساخته شد.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در کپی الگو.');
    }
  };

  const handleOneClickUse = (tpl: VoucherTemplate) => {
    const applied = applyVoucherTemplate(tpl, {
      accounts,
      baseAmountIrr: 0,
      date,
    });
    incrementTemplateUsage(tpl.id);
    onLoadTemplateIntoNewVoucher(applied, tpl.name);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-3 sm:p-5 no-print"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="مدیریت قالب‌های سند حسابداری"
    >
      <div
        className="w-full max-w-6xl max-h-[90vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Modal Header */}
        <div className="px-5 py-3.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <LayoutTemplate className="w-5 h-5 text-teal-700 dark:text-teal-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                مدیریت قالب‌های سند دوبل (Templates Manager)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {toPersianDigits(customTemplates.length)} الگوی شخصی ·{' '}
                {toPersianDigits(SYSTEM_VOUCHER_TEMPLATES.length)} الگوی استاندارد — ذخیره سرفصل‌های پیش‌فرض و مقادیر اولیه برای بارگذاری یک‌کلیکی
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={startCreateNew}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>الگوی جدید</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
              aria-label="بستن پنجره مدیریت قالب‌ها"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main 2-Pane Split Workspace */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Right Sidebar (RTL): Template Catalog List */}
          <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-l border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex flex-col min-h-0 max-h-[34vh] lg:max-h-none">
            <div className="p-3.5 space-y-2.5 border-b border-slate-200 dark:border-slate-800">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="جستجوی نام الگو یا کد حساب..."
                  className="w-full pr-8 pl-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                />
              </div>

              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-200/60 dark:bg-slate-900 rounded-lg text-[11px]">
                {(
                  [
                    { id: 'all', label: `همه (${toPersianDigits(allTemplates.length)})` },
                    { id: 'custom', label: `شخصی (${toPersianDigits(customTemplates.length)})` },
                    { id: 'system', label: `استاندارد (${toPersianDigits(SYSTEM_VOUCHER_TEMPLATES.length)})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setListFilter(tab.id)}
                    className={`py-1.5 px-2 rounded-md transition-colors whitespace-nowrap ${
                      listFilter === tab.id
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-semibold shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-200/70 dark:divide-slate-800/70">
              {filteredTemplates.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                  {listFilter === 'custom'
                    ? 'هنوز الگوی شخصی ایجاد نکرده‌اید. روی «الگوی جدید» کلیک کنید.'
                    : 'الگویی با این عبارت یافت نشد.'}
                </div>
              ) : (
                filteredTemplates.map((tpl) => {
                  const isActive = selectedId === tpl.id && editorMode !== 'create';
                  const summary = formatTemplateAccountSummary(tpl, accounts);
                  return (
                    <div
                      key={tpl.id}
                      onClick={() => loadTemplateIntoEditor(tpl)}
                      className={`px-3.5 py-2.5 cursor-pointer transition-colors flex items-start justify-between gap-2 ${
                        isActive
                          ? 'bg-teal-50/90 dark:bg-teal-950/40'
                          : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {tpl.name}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {VOUCHER_TEMPLATE_CATEGORY_LABELS[tpl.category]} ·{' '}
                          {tpl.isSystem ? 'استاندارد' : 'شخصی'} · {toPersianDigits(tpl.lines.length)}{' '}
                          آرتیکل
                        </div>
                        <div className="text-[10.5px] font-code tabular-nums text-slate-500 dark:text-slate-400 truncate">
                          {summary}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 pt-0.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOneClickUse(tpl);
                          }}
                          title="بارگذاری با یک کلیک در سند جدید"
                          className="p-1.5 rounded-md text-teal-700 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-950/70"
                          aria-label={`استفاده از الگوی ${tpl.name}`}
                        >
                          <FilePlus2 className="w-3.5 h-3.5" />
                        </button>
                        {!tpl.isSystem ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              loadTemplateIntoEditor(tpl);
                            }}
                            title="ویرایش الگو"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800"
                            aria-label={`ویرایش الگوی ${tpl.name}`}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDuplicateTemplate(tpl);
                            }}
                            title="کپی برای شخصی‌سازی"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800"
                            aria-label={`کپی الگوی ${tpl.name}`}
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Left Workspace (RTL): Editor or System Preview */}
          <div className="lg:col-span-8 flex flex-col min-h-0 overflow-hidden bg-white dark:bg-slate-900">
            {editorMode === 'view_system' && viewedSystemTemplate ? (
              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <Lock className="w-3.5 h-3.5" />
                      <span>الگوی استاندارد سیستم</span>
                      <span aria-hidden="true">·</span>
                      <span>{VOUCHER_TEMPLATE_CATEGORY_LABELS[viewedSystemTemplate.category]}</span>
                      <span aria-hidden="true">·</span>
                      <span>نوع سند: {VOUCHER_TYPE_LABELS[viewedSystemTemplate.voucherType]}</span>
                    </div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      {viewedSystemTemplate.name}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {viewedSystemTemplate.hint}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleDuplicateTemplate(viewedSystemTemplate)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg whitespace-nowrap"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>کپی و شخصی‌سازی</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOneClickUse(viewedSystemTemplate)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" />
                      <span>بارگذاری در سند جدید</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="text-[11px] font-semibold text-slate-500">شرح پیش‌فرض سند</div>
                  <div className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200">
                    {viewedSystemTemplate.descriptionTemplate}
                  </div>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-right">
                    <thead className="bg-slate-50 dark:bg-slate-950 text-[11px] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2 px-3 font-semibold">ردیف</th>
                        <th className="py-2 px-3 font-semibold">سرفصل حساب معین</th>
                        <th className="py-2 px-3 font-semibold">ماهیت</th>
                        <th className="py-2 px-3 font-semibold">فرمول محاسبه</th>
                        <th className="py-2 px-3 font-semibold">شرح پیش‌فرض آرتیکل</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {viewedSystemTemplate.lines.map((line, i) => (
                        <tr key={i} className="bg-white dark:bg-slate-900">
                          <td className="py-2.5 px-3 font-code tabular-nums text-slate-500">
                            {toPersianDigits(i + 1)}
                          </td>
                          <td className="py-2.5 px-3">
                            <span className="font-code font-semibold text-teal-700 dark:text-teal-400 ml-1.5">
                              {line.accountCode}
                            </span>
                            <span className="text-slate-800 dark:text-slate-200">
                              {accounts.find((a) => a.code === line.accountCode)?.title ||
                                line.fallbackTitle}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-semibold">
                            <span
                              className={
                                line.side === 'debit'
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-rose-700 dark:text-rose-400'
                              }
                            >
                              {line.side === 'debit' ? 'بدهکار' : 'بستانکار'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                            {line.formula === 'full'
                              ? '۱۰۰٪ مبلغ پایه'
                              : line.formula === 'vat_10'
                                ? '۱۰٪ مالیات ارزش افزوده'
                                : line.formula === 'gross_with_vat_10'
                                  ? 'مبلغ پایه + ۱۰٪ مالیات'
                                  : line.formula === 'payroll_gross_with_employer_ins'
                                    ? 'حقوق ناخالص + ۲۳٪ کارفرما'
                                    : line.formula === 'payroll_net_after_ins'
                                      ? 'خالص حقوق (۹۳٪)'
                                      : line.formula === 'payroll_total_ins_30'
                                        ? 'بیمه ۳۰٪ تأمین اجتماعی'
                                        : 'مبلغ ثابت'}
                          </td>
                          <td className="py-2.5 px-3 text-slate-500 dark:text-slate-400">
                            {line.defaultDescription}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              /* Create / Edit Custom Template Form */
              <>
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        {editorMode === 'edit' ? 'ویرایش الگوی سند دوبل' : 'ایجاد الگوی جدید سند دوبل'}
                      </h3>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        سرفصل‌های پیش‌فرض، طرف‌حساب، مرکز هزینه و مقادیر اولیه (ثابت یا درصدی) را تعریف کنید تا هنگام ثبت سند جدید با یک کلیک بارگذاری شوند.
                      </p>
                    </div>
                  </div>

                  {formError && (
                    <div className="px-3.5 py-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-800 dark:text-rose-200">
                      {formError}
                    </div>
                  )}

                  {/* Metadata Fields */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 text-xs">
                    <div className="lg:col-span-5">
                      <label className="block text-[11px] text-slate-500 mb-1">نام الگو *</label>
                      <input
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="مثلاً: اجاره ماهانه انبار شادآباد (ثابت ۵۰ میلیون)"
                        className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                      />
                    </div>
                    <div className="lg:col-span-4">
                      <label className="block text-[11px] text-slate-500 mb-1">دسته‌بندی</label>
                      <select
                        value={draftCategory}
                        onChange={(e) => setDraftCategory(e.target.value as VoucherTemplateCategory)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                      >
                        {Object.entries(VOUCHER_TEMPLATE_CATEGORY_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="lg:col-span-3">
                      <label className="block text-[11px] text-slate-500 mb-1">نوع سند</label>
                      <select
                        value={draftVoucherType}
                        onChange={(e) => setDraftVoucherType(e.target.value as VoucherType)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                      >
                        {Object.entries(VOUCHER_TYPE_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2 lg:col-span-12">
                      <label className="block text-[11px] text-slate-500 mb-1">
                        شرح پیش‌فرض سند (می‌توانید از متغیرهای {'{month}'} یا {'{date}'} استفاده کنید)
                      </label>
                      <input
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        placeholder="مثلاً: پرداخت هزینه اجاره و شارژ انبار دوره {month}"
                        className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>

                  {/* Lines Editor Table */}
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-visible">
                    <div className="px-3.5 py-2 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        آرتیکل‌های پیش‌فرض و مقادیر اولیه ({toPersianDigits(draftLines.length)} ردیف)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const defaultBank = moeinAccounts.find((a) => a.code === '10201') || moeinAccounts[0];
                          setDraftLines((prev) => [
                            ...prev,
                            createBlankLine(
                              defaultBank?.code || '10201',
                              defaultBank?.title || 'بانک',
                              fixedDiff > 0 ? 'credit' : 'debit'
                            ),
                          ]);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-teal-800 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800 rounded-md hover:bg-teal-100 dark:hover:bg-teal-950"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>افزودن آرتیکل</span>
                      </button>
                    </div>

                    <div className="divide-y divide-slate-200 dark:divide-slate-800">
                      {draftLines.map((line, idx) => (
                        <div key={idx} className="p-3 space-y-2.5 bg-white dark:bg-slate-900 text-xs">
                          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-start">
                            {/* Account Picker */}
                            <div className="md:col-span-5">
                              <label className="block text-[10.5px] text-slate-500 mb-1">
                                ردیف {toPersianDigits(idx + 1)} · سرفصل حساب معین
                              </label>
                              <SmartSearchCombobox
                                mode="picker"
                                compact
                                options={accountPickerOptions}
                                value={line.accountCode}
                                placeholder="کد یا عنوان حساب..."
                                onSelect={(opt) => {
                                  const acc = moeinAccounts.find((a) => a.code === opt.id);
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? {
                                            ...r,
                                            accountCode: opt.id,
                                            fallbackTitle: acc?.title || opt.label,
                                          }
                                        : r
                                    )
                                  );
                                }}
                              />
                            </div>

                            {/* Side (Debit / Credit) */}
                            <div className="md:col-span-2">
                              <label className="block text-[10.5px] text-slate-500 mb-1">ماهیت</label>
                              <select
                                value={line.side}
                                onChange={(e) =>
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? { ...r, side: e.target.value === 'credit' ? 'credit' : 'debit' }
                                        : r
                                    )
                                  )
                                }
                                className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-semibold"
                              >
                                <option value="debit">بدهکار</option>
                                <option value="credit">بستانکار</option>
                              </select>
                            </div>

                            {/* Value / Formula Mode */}
                            <div className="md:col-span-3">
                              <label className="block text-[10.5px] text-slate-500 mb-1">
                                نحوه مقداردهی اولیه
                              </label>
                              <select
                                value={line.formula}
                                onChange={(e) => {
                                  const nextFormula = e.target.value as VoucherTemplateFormula;
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? {
                                            ...r,
                                            formula: nextFormula,
                                            fixedAmount:
                                              nextFormula === 'fixed' ? r.fixedAmount ?? 0 : undefined,
                                            percentage:
                                              nextFormula === 'percentage' ? r.percentage ?? 50 : undefined,
                                          }
                                        : r
                                    )
                                  );
                                }}
                                className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                              >
                                {FORMULA_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Row Controls */}
                            <div className="md:col-span-2 flex items-center justify-end gap-1 md:pt-5">
                              {line.formula === 'fixed' && (
                                <button
                                  type="button"
                                  onClick={() => autoBalanceDraftLine(idx)}
                                  title="تراز خودکار اختلاف روی این ردیف"
                                  className="p-1.5 rounded-md text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50"
                                >
                                  <Scale className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftLines((prev) => [
                                    ...prev.slice(0, idx + 1),
                                    { ...line },
                                    ...prev.slice(idx + 1),
                                  ])
                                }
                                title="کپی این ردیف"
                                className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              {draftLines.length > 2 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraftLines((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                  title="حذف ردیف"
                                  className="p-1.5 rounded-md text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Second Row: Initial Amount / Percentage, Default Party, Cost Center, Line Description */}
                          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-start">
                            {line.formula === 'fixed' ? (
                              <div className="md:col-span-3">
                                <label className="block text-[10.5px] text-slate-500 mb-1">
                                  مبلغ اولیه ({line.side === 'debit' ? 'بدهکار' : 'بستانکار'} · ریال)
                                </label>
                                <MoneyInput
                                  value={line.fixedAmount ?? 0}
                                  onValueChange={(val) =>
                                    setDraftLines((prev) =>
                                      prev.map((r, i) =>
                                        i === idx ? { ...r, fixedAmount: val } : r
                                      )
                                    )
                                  }
                                  placeholder="۰ (اختیاری)"
                                  unitLabel="ریال"
                                  className="py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                            ) : line.formula === 'percentage' ? (
                              <div className="md:col-span-3">
                                <label className="block text-[10.5px] text-slate-500 mb-1">
                                  درصد از مبلغ پایه (%)
                                </label>
                                <input
                                  type="number"
                                  min={0}
                                  max={1000}
                                  step={0.5}
                                  value={line.percentage ?? 50}
                                  onChange={(e) =>
                                    setDraftLines((prev) =>
                                      prev.map((r, i) =>
                                        i === idx
                                          ? { ...r, percentage: Number(e.target.value) || 0 }
                                          : r
                                      )
                                    )
                                  }
                                  className="w-full px-2.5 py-1.5 font-code tabular-nums rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                            ) : (
                              <div className="md:col-span-3">
                                <label className="block text-[10.5px] text-slate-500 mb-1">
                                  مقداردهی هوشمند
                                </label>
                                <div className="px-2.5 py-1.5 rounded-md border border-slate-200/70 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-[11px] text-slate-500">
                                  محاسبه خودکار از مبلغ پایه
                                </div>
                              </div>
                            )}

                            <div className="md:col-span-3">
                              <label className="block text-[10.5px] text-slate-500 mb-1">
                                طرف‌حساب پیش‌فرض
                              </label>
                              <SmartSearchCombobox
                                mode="picker"
                                compact
                                options={partyPickerOptions}
                                value={line.defaultPartyId || ''}
                                placeholder="بدون طرف‌حساب"
                                onSelect={(opt) => {
                                  const p = parties.find((x) => x.id === opt.id);
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? {
                                            ...r,
                                            defaultPartyId: p?.id,
                                            defaultPartyName: p?.name,
                                            requiresParty: Boolean(p) || r.requiresParty,
                                          }
                                        : r
                                    )
                                  );
                                }}
                              />
                            </div>

                            <div className="md:col-span-3">
                              <label className="block text-[10.5px] text-slate-500 mb-1">
                                مرکز هزینه پیش‌فرض
                              </label>
                              <select
                                value={line.defaultCostCenterId || ''}
                                onChange={(e) =>
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx
                                        ? {
                                            ...r,
                                            defaultCostCenterId: e.target.value || undefined,
                                            applyCostCenter: Boolean(e.target.value) || r.applyCostCenter,
                                          }
                                        : r
                                    )
                                  )
                                }
                                className="w-full px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-[11px]"
                              >
                                <option value="">بدون مرکز هزینه</option>
                                {costCenters.map((cc) => (
                                  <option key={cc.id} value={cc.id}>
                                    {cc.code} — {cc.name}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="md:col-span-3">
                              <label className="block text-[10.5px] text-slate-500 mb-1">
                                شرح پیش‌فرض آرتیکل
                              </label>
                              <input
                                value={line.defaultDescription}
                                onChange={(e) =>
                                  setDraftLines((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, defaultDescription: e.target.value } : r
                                    )
                                  )
                                }
                                placeholder="شرح ردیف..."
                                className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Initial Values Balance Summary Bar */}
                    {allLinesFixed && (fixedDebitTotal > 0 || fixedCreditTotal > 0) && (
                      <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex flex-wrap items-center gap-4 font-code tabular-nums">
                          <span>
                            جمع بدهکار اولیه:{' '}
                            <strong className="text-slate-900 dark:text-white">
                              {formatMoney(fixedDebitTotal, unit)}
                            </strong>
                          </span>
                          <span>
                            جمع بستانکار اولیه:{' '}
                            <strong className="text-slate-900 dark:text-white">
                              {formatMoney(fixedCreditTotal, unit)}
                            </strong>
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {fixedDiff === 0 ? (
                            <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                              مقادیر اولیه کاملاً تراز است
                            </span>
                          ) : (
                            <>
                              <span className="text-rose-700 dark:text-rose-400 font-semibold font-code tabular-nums">
                                اختلاف: {formatMoney(Math.abs(fixedDiff), unit)}
                              </span>
                              <button
                                type="button"
                                onClick={() => autoBalanceDraftLine(draftLines.length - 1)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:text-amber-200 bg-amber-100 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 rounded-md hover:bg-amber-200/80"
                              >
                                <Scale className="w-3 h-3" />
                                <span>تراز خودکار</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Sticky Footer Actions */}
                <div className="px-5 py-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    {editorMode === 'edit' && selectedId && (
                      confirmDeleteId === selectedId ? (
                        <div className="inline-flex items-center gap-2 text-xs">
                          <span className="text-rose-700 dark:text-rose-400 font-semibold">
                            حذف قطعی این الگو؟
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const target = customTemplates.find((t) => t.id === selectedId);
                              if (target) handleDeleteTemplate(target);
                            }}
                            className="px-2.5 py-1 text-[11px] font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-md"
                          >
                            بله، حذف شود
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:underline"
                          >
                            انصراف
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selectedId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف الگو</span>
                        </button>
                      )
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSaveTemplate(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800 hover:bg-teal-100 dark:hover:bg-teal-950 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" />
                      <span>ذخیره و بارگذاری در سند جدید</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveTemplate(false)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <Check className="w-4 h-4" />
                      <span>{editorMode === 'edit' ? 'ذخیره تغییرات' : 'ایجاد الگو'}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
