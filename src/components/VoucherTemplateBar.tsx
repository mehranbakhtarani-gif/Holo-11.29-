import React, { useMemo, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronUp,
  LayoutTemplate,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  Account,
  CostCenter,
  CurrencyUnit,
  Party,
  Voucher,
  VoucherLine,
  VoucherType,
} from '../types/accounting';
import {
  AppliedVoucherTemplateResult,
  SYSTEM_VOUCHER_TEMPLATES,
  VOUCHER_TEMPLATE_CATEGORY_LABELS,
  VoucherTemplate,
  VoucherTemplateCategory,
  addCustomVoucherTemplate,
  applyVoucherTemplate,
  createCustomTemplateFromLines,
  deleteCustomVoucherTemplate,
  filterVoucherTemplates,
  formatTemplateAccountSummary,
  incrementTemplateUsage,
  loadCustomVoucherTemplates,
  loadTemplateUsageMap,
  suggestTemplatesFromHistory,
  templateRequiresParty,
  templateUsesCostCenter,
} from '../lib/voucherTemplates';
import { formatMoney, toPersianDigits } from '../lib/format';
import { MoneyInput } from './ui/MoneyInput';
import { SmartSearchCombobox, SmartSearchOption } from './SmartSearchCombobox';

interface VoucherTemplateBarProps {
  accounts: Account[];
  parties: Party[];
  costCenters: CostCenter[];
  vouchers: Voucher[];
  unit: CurrencyUnit;
  date: string;
  currentVoucherType: VoucherType;
  currentDescription: string;
  currentLines: VoucherLine[];
  onApplyTemplate: (result: AppliedVoucherTemplateResult, templateName: string) => void;
  onNotify: (message: string) => void;
}

type FilterTab = 'recommended' | 'all' | VoucherTemplateCategory;

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'recommended', label: 'پیشنهادی هوشمند' },
  { id: 'all', label: 'همه الگوها' },
  { id: 'general_expenses', label: 'هزینه‌های عمومی' },
  { id: 'sales', label: 'فروش و درآمد' },
  { id: 'purchase', label: 'خرید و انبار' },
  { id: 'treasury', label: 'خزانه‌داری' },
  { id: 'payroll', label: 'حقوق و دستمزد' },
  { id: 'adjustments', label: 'اصلاحی' },
  { id: 'custom', label: 'الگوهای من' },
];

export const VoucherTemplateBar: React.FC<VoucherTemplateBarProps> = ({
  accounts,
  parties,
  costCenters,
  vouchers,
  unit,
  date,
  currentVoucherType,
  currentDescription,
  currentLines,
  onApplyTemplate,
  onNotify,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>('recommended');
  const [searchQuery, setSearchQuery] = useState('');
  const [customTemplates, setCustomTemplates] = useState<VoucherTemplate[]>(() =>
    loadCustomVoucherTemplates()
  );
  const [usageMap, setUsageMap] = useState<Record<string, number>>(() => loadTemplateUsageMap());

  // Selected template for quick-amount parametric application
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [quickAmountIrr, setQuickAmountIrr] = useState<number>(0);
  const [quickPartyId, setQuickPartyId] = useState<string>('');
  const [quickCostCenterId, setQuickCostCenterId] = useState<string>('');

  // Save current voucher as reusable custom template
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] =
    useState<VoucherTemplateCategory>('general_expenses');

  const allTemplates = useMemo(
    () => [...customTemplates, ...SYSTEM_VOUCHER_TEMPLATES],
    [customTemplates]
  );

  const recommendedTemplates = useMemo(
    () => suggestTemplatesFromHistory(vouchers, allTemplates, usageMap, 6),
    [vouchers, allTemplates, usageMap]
  );

  const recommendedIdSet = useMemo(
    () => new Set(recommendedTemplates.map((t) => t.id)),
    [recommendedTemplates]
  );

  const visibleTemplates = useMemo(
    () => filterVoucherTemplates(allTemplates, searchQuery, activeTab, recommendedIdSet),
    [allTemplates, searchQuery, activeTab, recommendedIdSet]
  );

  const selectedTemplate = useMemo(
    () => allTemplates.find((t) => t.id === selectedTemplateId) || null,
    [allTemplates, selectedTemplateId]
  );

  const partyOptions: SmartSearchOption[] = useMemo(
    () => [
      { id: '', label: 'بدون انتخاب طرف‌حساب', sublabel: 'می‌توانید بعداً در ردیف سند انتخاب کنید' },
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

  const previewResult = useMemo(() => {
    if (!selectedTemplate) return null;
    const party = quickPartyId ? parties.find((p) => p.id === quickPartyId) ?? null : null;
    return applyVoucherTemplate(selectedTemplate, {
      accounts,
      baseAmountIrr: quickAmountIrr,
      date,
      party,
      costCenterId: quickCostCenterId || undefined,
    });
  }, [selectedTemplate, quickAmountIrr, quickPartyId, quickCostCenterId, accounts, parties, date]);

  const handleSelectTemplate = (tpl: VoucherTemplate) => {
    setSelectedTemplateId(tpl.id);
    setQuickAmountIrr(0);
    // Immediately apply template structure (accounts + descriptions) so single-click works right away
    const party = quickPartyId ? parties.find((p) => p.id === quickPartyId) ?? null : null;
    const applied = applyVoucherTemplate(tpl, {
      accounts,
      baseAmountIrr: 0,
      date,
      party,
      costCenterId: quickCostCenterId || undefined,
    });
    const nextUsage = incrementTemplateUsage(tpl.id);
    setUsageMap(nextUsage);
    onApplyTemplate(applied, tpl.name);
  };

  const handleApplyWithQuickAmount = () => {
    if (!selectedTemplate || !previewResult) return;
    const nextUsage = incrementTemplateUsage(selectedTemplate.id);
    setUsageMap(nextUsage);
    onApplyTemplate(previewResult, selectedTemplate.name);
  };

  const handleSaveCurrentAsTemplate = () => {
    try {
      const created = createCustomTemplateFromLines({
        name: newTemplateName,
        category: newTemplateCategory,
        voucherType: currentVoucherType,
        description: currentDescription,
        lines: currentLines,
      });
      const updated = addCustomVoucherTemplate(created);
      setCustomTemplates(updated);
      setNewTemplateName('');
      setShowSaveModal(false);
      setActiveTab('custom');
      setSelectedTemplateId(created.id);
      onNotify(`الگوی شخصی «${created.name}» با موفقیت ذخیره شد و همیشه در دسترس است.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'امکان ذخیره الگو وجود ندارد.');
    }
  };

  const handleDeleteCustomTemplate = (e: React.MouseEvent, tpl: VoucherTemplate) => {
    e.stopPropagation();
    const updated = deleteCustomVoucherTemplate(tpl.id);
    setCustomTemplates(updated);
    if (selectedTemplateId === tpl.id) {
      setSelectedTemplateId(null);
    }
    onNotify(`الگوی «${tpl.name}» حذف شد.`);
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 overflow-visible">
      {/* Compact Header Bar */}
      <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="flex items-center gap-2.5 min-w-0">
          <LayoutTemplate className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0" />
          <span className="text-xs font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
            قالب‌بندی هوشمند اسناد دوبل
          </span>
          <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:inline truncate">
            {toPersianDigits(SYSTEM_VOUCHER_TEMPLATES.length)} الگوی آماده
            {customTemplates.length > 0
              ? ` · ${toPersianDigits(customTemplates.length)} الگوی شخصی`
              : ''}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
              setNewTemplateName(currentDescription.trim().slice(0, 55));
              setShowSaveModal((v) => !v);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-teal-800 dark:text-teal-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md hover:border-teal-400 dark:hover:border-teal-700 transition-colors whitespace-nowrap shrink-0"
          >
            <BookmarkPlus className="w-3.5 h-3.5" />
            <span>ذخیره سند فعلی به‌عنوان الگو</span>
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-md transition-colors whitespace-nowrap shrink-0"
            aria-expanded={expanded}
          >
            <span>{expanded ? 'بستن الگوها' : 'نمایش الگوها'}</span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-3.5">
          {/* Inline Save Current Voucher as Custom Template Drawer */}
          {showSaveModal && (
            <div className="p-3.5 rounded-lg bg-white dark:bg-slate-900 border border-teal-300/80 dark:border-teal-800/80 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  ذخیره آرتیکل‌های فعلی به‌عنوان الگوی آماده
                </span>
                <button
                  type="button"
                  onClick={() => setShowSaveModal(false)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  aria-label="بستن فرم ذخیره الگو"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                سرفصل‌ها، شرح و نسبت‌های بدهکار و بستانکار ({toPersianDigits(currentLines.length)} آرتیکل) در حافظه آفلاین دستگاه ذخیره می‌شوند تا در اسناد بعدی با یک کلیک فراخوانی شوند.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 text-xs">
                <div className="md:col-span-6">
                  <label className="block text-[11px] text-slate-500 mb-1">نام الگو</label>
                  <input
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    placeholder="مثلاً: اجاره ماهانه انبار و هزینه نگهبانی"
                    className="w-full px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>
                <div className="md:col-span-4">
                  <label className="block text-[11px] text-slate-500 mb-1">دسته‌بندی سرفصل</label>
                  <select
                    value={newTemplateCategory}
                    onChange={(e) => setNewTemplateCategory(e.target.value as VoucherTemplateCategory)}
                    className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                  >
                    {Object.entries(VOUCHER_TEMPLATE_CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2 flex items-end">
                  <button
                    type="button"
                    onClick={handleSaveCurrentAsTemplate}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>ذخیره</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Category Filter Tabs + Search Row */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
              {FILTER_TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                const countSuffix =
                  tab.id === 'custom' && customTemplates.length > 0
                    ? ` (${toPersianDigits(customTemplates.length)})`
                    : '';
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-2.5 py-1.5 text-[11px] rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-teal-700 text-white font-semibold'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 font-medium'
                    }`}
                  >
                    {tab.label}
                    {countSuffix}
                  </button>
                );
              })}
            </div>

            <div className="relative w-full lg:w-64 shrink-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="جستجوی الگو یا کد حساب (مثلاً ۸۰۲۰۱)..."
                className="w-full pr-8 pl-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>
          </div>

          {/* Template Selection Grid (Single-Elevation Clean Rows) */}
          {visibleTemplates.length === 0 ? (
            <div className="py-5 px-4 text-center text-xs text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              {activeTab === 'custom'
                ? 'هنوز الگوی شخصی ذخیره نکرده‌اید. پس از چیدمان آرتیکل‌های سند، روی «ذخیره سند فعلی به‌عنوان الگو» کلیک کنید.'
                : 'الگویی مطابق جستجوی شما یافت نشد.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {visibleTemplates.map((tpl) => {
                const isSelected = selectedTemplateId === tpl.id;
                const accountFlow = formatTemplateAccountSummary(tpl, accounts);
                return (
                  <div
                    key={tpl.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectTemplate(tpl)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectTemplate(tpl);
                      }
                    }}
                    className={`group text-right px-3.5 py-2.5 rounded-lg border transition-colors cursor-pointer flex items-start justify-between gap-2 ${
                      isSelected
                        ? 'bg-teal-50/80 dark:bg-teal-950/40 border-teal-500/80 dark:border-teal-600'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-teal-400/70 dark:hover:border-teal-700'
                    }`}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {tpl.name}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-code tabular-nums truncate">
                        {accountFlow} · {toPersianDigits(tpl.lines.length)} آرتیکل
                      </div>
                    </div>

                    {!tpl.isSystem && (
                      <button
                        type="button"
                        onClick={(e) => handleDeleteCustomTemplate(e, tpl)}
                        title="حذف الگوی شخصی"
                        className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 shrink-0"
                        aria-label={`حذف الگوی ${tpl.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Smart Parametric Quick-Fill Bar for the Active Template */}
          {selectedTemplate && (
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="text-slate-700 dark:text-slate-300">
                  <strong className="text-slate-900 dark:text-white">{selectedTemplate.name}</strong>
                  <span className="mx-1.5 text-slate-400" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">{selectedTemplate.hint}</span>
                </div>
                {previewResult && previewResult.totalDebit > 0 && (
                  <span className="font-code tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                    جمع سند تراز: {formatMoney(previewResult.totalDebit, unit)}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 items-end text-xs">
                {selectedTemplate.supportsQuickAmount && (
                  <div className="lg:col-span-4">
                    <label className="block text-[11px] text-slate-500 mb-1">
                      {selectedTemplate.quickAmountLabel || 'مبلغ پایه سند (ریال)'}
                    </label>
                    <MoneyInput
                      value={quickAmountIrr}
                      onValueChange={(val) => setQuickAmountIrr(val)}
                      placeholder="مبلغ را وارد کنید تا آرتیکل‌ها خودکار تراز شوند..."
                      unitLabel="ریال"
                      className="py-1.5 rounded-md border border-teal-300 dark:border-teal-800 bg-white dark:bg-slate-900"
                    />
                  </div>
                )}

                {templateRequiresParty(selectedTemplate) && (
                  <div className="lg:col-span-3">
                    <label className="block text-[11px] text-slate-500 mb-1">
                      طرف‌حساب تفصیلی (اختیاری)
                    </label>
                    <SmartSearchCombobox
                      mode="picker"
                      compact
                      options={partyOptions}
                      value={quickPartyId}
                      placeholder="انتخاب مشتری / تأمین‌کننده..."
                      onSelect={(opt) => setQuickPartyId(opt.id)}
                    />
                  </div>
                )}

                {templateUsesCostCenter(selectedTemplate) && costCenters.length > 0 && (
                  <div className="lg:col-span-3">
                    <label className="block text-[11px] text-slate-500 mb-1">
                      مرکز هزینه (اختیاری)
                    </label>
                    <select
                      value={quickCostCenterId}
                      onChange={(e) => setQuickCostCenterId(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                    >
                      <option value="">بدون مرکز هزینه</option>
                      {costCenters.map((cc) => (
                        <option key={cc.id} value={cc.id}>
                          {cc.code} — {cc.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="lg:col-span-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleApplyWithQuickAmount}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>تکمیل خودکار سند</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
