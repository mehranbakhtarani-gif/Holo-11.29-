import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock,
  FileCheck2,
  FileText,
  Filter,
  Loader2,
  Lock,
  Maximize2,
  Plus,
  Scale,
  Search,
  Ship,
  X,
} from 'lucide-react';
import type { ActiveModule, CurrencyUnit } from '../../types/accounting';
import {
  buildPendingApprovalItems,
  CATEGORY_TO_DOC_TYPE,
  filterPendingApprovalItems,
  type PendingApprovalCategoryKey,
  type PendingApprovalDocType,
  type PendingApprovalDocumentItem,
  type PendingApprovalsSummary,
} from '../../lib/pendingApprovalsSummary';
import { formatCompactMoney, formatMoney, toPersianDigits } from '../../lib/format';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

const snappyTransition = {
  duration: 0.18,
  ease: [0.16, 1, 0.3, 1] as const,
};

interface PendingApprovalSummaryCardsProps {
  summary: PendingApprovalsSummary;
  unit: CurrencyUnit;
  canFinalizeVoucher: boolean;
  canIssueInvoice: boolean;
  canEditInventory: boolean;
  onFinalizeVoucher: (voucherId: string) => Promise<void>;
  onFinalizeAllDraftVouchers: () => Promise<number>;
  onConvertProforma: (invoiceId: string) => Promise<void>;
  onClearImportDossier: (dossierId: string) => Promise<void>;
  onInvoiceSalesOrder: (orderId: string) => Promise<void>;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onExpand?: () => void;
}

interface SummaryCardDescriptor {
  key: PendingApprovalCategoryKey;
  docType: PendingApprovalDocType;
  title: string;
  subtitle: string;
  count: number;
  countUnit: string;
  totalIrr: number;
  statusLabel: string;
  statusTone: 'amber' | 'rose' | 'indigo' | 'emerald';
  metaSegments: string[];
  progressPct: number;
  progressColor: string;
  icon: React.ComponentType<{ className?: string }>;
}

const DOC_TYPE_ICONS: Record<PendingApprovalDocType, React.ComponentType<{ className?: string }>> = {
  voucher: BookOpen,
  invoice: FileText,
  import: Ship,
  operation: Scale,
};

export const PendingApprovalSummaryCards: React.FC<PendingApprovalSummaryCardsProps> = ({
  summary,
  unit,
  canFinalizeVoucher,
  canIssueInvoice,
  canEditInventory,
  onFinalizeVoucher,
  onFinalizeAllDraftVouchers,
  onConvertProforma,
  onClearImportDossier,
  onInvoiceSalesOrder,
  onNavigate,
  onExpand,
}) => {
  const [docTypeFilter, setDocTypeFilter] = useState<'all' | PendingApprovalDocType>('all');
  const [viewerSearch, setViewerSearch] = useState('');
  const debouncedSearch = useDebouncedValue(viewerSearch, 90);
  const [isViewerOpen, setIsViewerOpen] = useState<boolean>(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [isFinalizingAll, setIsFinalizingAll] = useState(false);
  const [recentApprovedNote, setRecentApprovedNote] = useState<string | null>(null);

  const allPendingItems = useMemo(() => buildPendingApprovalItems(summary), [summary]);

  const filteredItems = useMemo(
    () => filterPendingApprovalItems(allPendingItems, docTypeFilter, debouncedSearch),
    [allPendingItems, docTypeFilter, debouncedSearch]
  );

  const cards = useMemo<SummaryCardDescriptor[]>(() => {
    const totalPending = Math.max(1, summary.totalPendingCount);

    const draftMeta: string[] = [
      `${toPersianDigits(summary.permanentVouchersCount)} از ${toPersianDigits(summary.totalVouchersCount)} سند قطعی`,
    ];
    if (summary.unbalancedDraftCount > 0) {
      draftMeta.push(`${toPersianDigits(summary.unbalancedDraftCount)} سند نامتوازن`);
    } else if (summary.oldestDraftDate) {
      draftMeta.push(`قدیمی‌ترین: ${toPersianDigits(summary.oldestDraftDate)}`);
    } else {
      draftMeta.push(`${toPersianDigits(summary.voucherApprovalRatePct)}٪ قطعی‌شده`);
    }

    const invoiceMeta: string[] = [];
    if (summary.pendingProformas.length > 0) {
      invoiceMeta.push(`${toPersianDigits(summary.pendingProformas.length)} پیش‌فاکتور باز`);
    }
    if (summary.reservedInvoices.length > 0) {
      invoiceMeta.push(`${toPersianDigits(summary.reservedInvoices.length)} رزرو موقت`);
    }
    if (invoiceMeta.length === 0) {
      invoiceMeta.push('بدون پیش‌فاکتور یا صف رزرو');
    }

    const importMeta: string[] = [];
    if (summary.importsInCustomsCount > 0) {
      importMeta.push(`${toPersianDigits(summary.importsInCustomsCount)} در گمرک`);
    }
    if (summary.importsInTransitCount > 0) {
      importMeta.push(`${toPersianDigits(summary.importsInTransitCount)} در مسیر حمل`);
    }
    if (importMeta.length === 0) {
      importMeta.push('تمامی پرونده‌ها ترخیص شده‌اند');
    }

    const opsMeta: string[] = [];
    if (summary.pendingSalesOrders.length > 0) {
      opsMeta.push(`${toPersianDigits(summary.pendingSalesOrders.length)} حواله باسکول`);
    }
    if (summary.pendingSubcontracts.length > 0) {
      opsMeta.push(`${toPersianDigits(summary.pendingSubcontracts.length)} پیمانکاری باز`);
    }
    if (summary.draftWarehouseSlips.length > 0) {
      opsMeta.push(`${toPersianDigits(summary.draftWarehouseSlips.length)} سند انبار موقت`);
    }
    if (summary.pendingPettyCash.length > 0) {
      opsMeta.push(`${toPersianDigits(summary.pendingPettyCash.length)} تنخواه باز`);
    }
    if (opsMeta.length === 0) {
      opsMeta.push('حواله و سند عملیاتی باز وجود ندارد');
    }

    return [
      {
        key: 'draft_vouchers',
        docType: 'voucher',
        title: 'اسناد حسابداری موقت',
        subtitle: 'در انتظار تأیید و دائم‌سازی',
        count: summary.draftVouchersCount,
        countUnit: 'سند',
        totalIrr: summary.draftVouchersTotalIrr,
        statusLabel:
          summary.unbalancedDraftCount > 0
            ? 'نیازمند اصلاح تراز'
            : summary.draftVouchersCount > 0
              ? 'در انتظار تأیید'
              : 'همه اسناد قطعی',
        statusTone:
          summary.unbalancedDraftCount > 0
            ? 'rose'
            : summary.draftVouchersCount > 0
              ? 'amber'
              : 'emerald',
        metaSegments: draftMeta,
        progressPct: summary.voucherApprovalRatePct,
        progressColor:
          summary.unbalancedDraftCount > 0
            ? 'bg-rose-500'
            : summary.draftVouchersCount > 0
              ? 'bg-amber-500'
              : 'bg-emerald-500',
        icon: BookOpen,
      },
      {
        key: 'pending_invoices',
        docType: 'invoice',
        title: 'فاکتور و پیش‌فاکتور باز',
        subtitle: 'در انتظار تبدیل به فروش رسمی',
        count: summary.pendingInvoicesCount,
        countUnit: 'مورد',
        totalIrr: summary.pendingInvoicesTotalIrr,
        statusLabel:
          summary.pendingInvoicesCount > 0 ? 'در انتظار نهایی‌سازی' : 'صف فاکتور پاک است',
        statusTone: summary.pendingInvoicesCount > 0 ? 'indigo' : 'emerald',
        metaSegments: invoiceMeta,
        progressPct:
          summary.pendingInvoicesCount > 0
            ? Math.min(100, Math.round((summary.pendingInvoicesCount / totalPending) * 100))
            : 100,
        progressColor:
          summary.pendingInvoicesCount > 0 ? 'bg-indigo-500' : 'bg-emerald-500',
        icon: FileText,
      },
      {
        key: 'pending_imports',
        docType: 'import',
        title: 'پرونده‌های وارداتی باز',
        subtitle: 'در انتظار ترخیص و ثبت بهای تمام‌شده',
        count: summary.pendingImportsCount,
        countUnit: 'پرونده',
        totalIrr: summary.pendingImportsTotalIrr,
        statusLabel:
          summary.pendingImportsCount > 0 ? 'در جریان ترخیص' : 'بدون پرونده معوق',
        statusTone: summary.pendingImportsCount > 0 ? 'amber' : 'emerald',
        metaSegments: importMeta,
        progressPct:
          summary.pendingImportsCount > 0
            ? Math.min(100, Math.round((summary.pendingImportsCount / totalPending) * 100))
            : 100,
        progressColor:
          summary.pendingImportsCount > 0 ? 'bg-amber-500' : 'bg-emerald-500',
        icon: Ship,
      },
      {
        key: 'pending_operations',
        docType: 'operation',
        title: 'حواله‌ها و عملیات باز',
        subtitle: 'باسکول، پیمانکاری، انبار و تنخواه',
        count: summary.pendingOperationsCount,
        countUnit: 'مورد',
        totalIrr: summary.pendingOperationsTotalIrr,
        statusLabel:
          summary.pendingOperationsCount > 0 ? 'در انتظار تکمیل' : 'همه عملیات تسویه شده',
        statusTone: summary.pendingOperationsCount > 0 ? 'indigo' : 'emerald',
        metaSegments: opsMeta.slice(0, 2),
        progressPct:
          summary.pendingOperationsCount > 0
            ? Math.min(100, Math.round((summary.pendingOperationsCount / totalPending) * 100))
            : 100,
        progressColor:
          summary.pendingOperationsCount > 0 ? 'bg-indigo-500' : 'bg-emerald-500',
        icon: Scale,
      },
    ];
  }, [summary]);

  const filterTabs = useMemo(
    () =>
      [
        { id: 'all', label: 'همه اسناد', count: summary.totalPendingCount },
        { id: 'voucher', label: 'سند حسابداری', count: summary.draftVouchersCount },
        { id: 'invoice', label: 'فاکتور', count: summary.pendingInvoicesCount },
        { id: 'import', label: 'پرونده وارداتی', count: summary.pendingImportsCount },
        { id: 'operation', label: 'حواله و عملیات', count: summary.pendingOperationsCount },
      ] as const,
    [summary]
  );

  const handleSummaryCardClick = (categoryKey: PendingApprovalCategoryKey) => {
    const mappedDocType = CATEGORY_TO_DOC_TYPE[categoryKey];
    if (!isViewerOpen) {
      setIsViewerOpen(true);
      setDocTypeFilter(mappedDocType);
      return;
    }
    setDocTypeFilter((prev) => (prev === mappedDocType ? 'all' : mappedDocType));
  };

  const getPermissionState = (
    item: PendingApprovalDocumentItem
  ): { allowed: boolean; reason?: string } => {
    if (!item.canQuickApprove) {
      return { allowed: false, reason: item.disabledReason };
    }
    if (item.quickApproveKind === 'finalize_voucher') {
      return canFinalizeVoucher
        ? { allowed: true }
        : { allowed: false, reason: 'کاربر فعلی مجوز دائم‌سازی سند حسابداری ندارد' };
    }
    if (
      item.quickApproveKind === 'convert_proforma' ||
      item.quickApproveKind === 'invoice_sales_order'
    ) {
      return canIssueInvoice
        ? { allowed: true }
        : { allowed: false, reason: 'کاربر فعلی مجوز صدور فاکتور فروش ندارد' };
    }
    if (item.quickApproveKind === 'clear_import') {
      return canEditInventory
        ? { allowed: true }
        : { allowed: false, reason: 'کاربر فعلی مجوز ترخیص و ثبت موجودی انبار ندارد' };
    }
    return { allowed: false };
  };

  const handleQuickApproveItem = async (item: PendingApprovalDocumentItem) => {
    const perm = getPermissionState(item);
    if (!perm.allowed) return;
    setBusyItemId(item.id);
    try {
      if (item.quickApproveKind === 'finalize_voucher') {
        await onFinalizeVoucher(item.id);
        setRecentApprovedNote(`سند ${toPersianDigits(item.referenceCode)} تأیید و دائم‌سازی شد.`);
      } else if (item.quickApproveKind === 'convert_proforma') {
        await onConvertProforma(item.id);
        setRecentApprovedNote(
          `پیش‌فاکتور ${toPersianDigits(item.referenceCode)} به فاکتور فروش رسمی تبدیل شد.`
        );
      } else if (item.quickApproveKind === 'clear_import') {
        await onClearImportDossier(item.id);
        setRecentApprovedNote(
          `پرونده وارداتی ${toPersianDigits(item.referenceCode)} ترخیص و سند بهای تمام‌شده ثبت شد.`
        );
      } else if (item.quickApproveKind === 'invoice_sales_order') {
        await onInvoiceSalesOrder(item.id);
        setRecentApprovedNote(
          `حواله ${toPersianDigits(item.referenceCode)} تأیید و به فاکتور فروش رسمی تبدیل شد.`
        );
      }
    } finally {
      setBusyItemId(null);
    }
  };

  const handleFinalizeAll = async () => {
    if (summary.draftVouchersCount === 0 || !canFinalizeVoucher) return;
    setIsFinalizingAll(true);
    try {
      const count = await onFinalizeAllDraftVouchers();
      if (count > 0) {
        setRecentApprovedNote(`${toPersianDigits(count)} سند موقت به‌صورت یکجا تأیید و دائم‌سازی شد.`);
      }
    } finally {
      setIsFinalizingAll(false);
    }
  };

  const visibleCards = filteredItems.slice(0, 6);

  return (
    <section
      aria-label="وضعیت و نمایشگر تعاملی اسناد در انتظار تأیید"
      className="space-y-4"
    >
      {/* Clean Single-Row Section Header — Zero Pills, Unboxed Typographic Separators */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 px-0.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white tracking-tight">
              وضعیت اسناد در انتظار تأیید
            </h2>
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
              ·
            </span>
            <span
              className={`text-xs font-semibold tabular-nums ${
                summary.urgencyLevel === 'action_required'
                  ? 'text-amber-700 dark:text-amber-400'
                  : summary.urgencyLevel === 'attention'
                    ? 'text-indigo-700 dark:text-indigo-400'
                    : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {summary.totalPendingCount > 0
                ? `${toPersianDigits(summary.totalPendingCount)} سند فعال در کارتابل`
                : 'کارتابل تأیید پاک است'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
            <span>
              ارزش کل در جریان:{' '}
              <strong className="font-code font-semibold text-slate-700 dark:text-slate-200">
                {formatCompactMoney(summary.totalPendingValueIrr, unit)}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              نرخ قطعی‌سازی اسناد:{' '}
              <strong className="font-code font-semibold text-slate-700 dark:text-slate-200">
                {toPersianDigits(summary.voucherApprovalRatePct)}٪
              </strong>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {summary.draftVouchersCount > 0 && canFinalizeVoucher && (
            <button
              type="button"
              disabled={isFinalizingAll}
              onClick={handleFinalizeAll}
              className="h-9 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              {isFinalizingAll ? (
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
              ) : (
                <Lock className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>
                {isFinalizingAll
                  ? 'در حال دائم‌سازی...'
                  : `تأیید همه اسناد موقت (${toPersianDigits(summary.draftVouchersCount)})`}
              </span>
            </button>
          )}

          <button
            type="button"
            aria-expanded={isViewerOpen}
            onClick={() => setIsViewerOpen((prev) => !prev)}
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#151A24] text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-700 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <Filter className="w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
            <span>{isViewerOpen ? 'بستن نمایشگر تعاملی' : 'باز کردن نمایشگر تعاملی'}</span>
            {isViewerOpen ? (
              <ChevronUp className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            )}
          </button>

          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              title="نمایش جدول کامل اسناد در انتظار تأیید"
              aria-label="نمایش جدول کامل اسناد در انتظار تأیید"
              className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#151A24] text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300 hover:border-indigo-300 dark:hover:border-indigo-700 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">نمای کامل</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onNavigate('vouchers', 'cartable', 'voucher-cartable')}
            className="h-9 px-3 rounded-xl text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <span>کارتابل اسناد</span>
            <ChevronLeft className="w-3.5 h-3.5 shrink-0" />
          </button>
        </div>
      </div>

      {/* 4 Executive Summary Cards Grid (Synced with Document Type Filter) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const isSelected = isViewerOpen && docTypeFilter === card.docType;
          const statusColorClass =
            card.statusTone === 'rose'
              ? 'text-rose-600 dark:text-rose-400'
              : card.statusTone === 'amber'
                ? 'text-amber-700 dark:text-amber-400'
                : card.statusTone === 'indigo'
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-emerald-600 dark:text-emerald-400';

          const countColorClass =
            card.count === 0
              ? 'text-slate-900 dark:text-white'
              : card.statusTone === 'rose'
                ? 'text-rose-600 dark:text-rose-400'
                : card.statusTone === 'amber'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-indigo-600 dark:text-[#818CF8]';

          return (
            <button
              key={card.key}
              type="button"
              aria-pressed={isSelected}
              onClick={() => handleSummaryCardClick(card.key)}
              className={`group text-right bg-white dark:bg-[#151A24] rounded-2xl border p-4 sm:p-5 flex flex-col justify-between gap-3 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 ${
                isSelected
                  ? 'border-indigo-500 dark:border-indigo-400 ring-2 ring-indigo-500/15 shadow-[0_6px_20px_-8px_rgba(79,70,229,0.22)]'
                  : 'border-slate-200/80 dark:border-white/[0.07] hover:border-indigo-300/80 dark:hover:border-white/[0.16] shadow-[0_2px_12px_-4px_rgba(15,23,42,0.05)] dark:shadow-[0_10px_28px_-14px_rgba(0,0,0,0.6)]'
              }`}
            >
              <div className="flex items-start justify-between gap-2 w-full">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 leading-snug truncate">
                    {card.title}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {card.subtitle}
                  </div>
                </div>
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                    isSelected
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100/90 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 group-hover:text-indigo-600 dark:group-hover:text-indigo-300'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                </div>
              </div>

              <div className="flex items-baseline justify-between gap-2 w-full">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span
                    className={`text-2xl sm:text-[26px] font-extrabold font-code tabular-nums tracking-tight ${countColorClass}`}
                  >
                    {toPersianDigits(card.count)}
                  </span>
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
                    {card.countUnit}
                  </span>
                </div>

                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap shrink-0 ${statusColorClass}`}
                >
                  {card.count === 0 ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  ) : card.statusTone === 'rose' ? (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span>{card.statusLabel}</span>
                </span>
              </div>

              <div className="w-full space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                  <span className="truncate">{card.metaSegments.join(' · ')}</span>
                  <span className="font-code font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0">
                    {card.totalIrr > 0 ? formatCompactMoney(card.totalIrr, unit) : '—'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${card.progressColor}`}
                      style={{ width: `${Math.max(card.count > 0 ? 12 : 100, card.progressPct)}%` }}
                    />
                  </div>
                  <span className="text-[10.5px] font-medium text-slate-400 dark:text-slate-500 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 whitespace-nowrap shrink-0 transition-colors">
                    {isSelected ? 'فیلتر فعال' : 'فیلتر کارت‌ها'}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Interactive Pending Approvals Viewer (Filter by Document Type + Search + One-Click Action Cards) */}
      <AnimatePresence initial={false}>
        {isViewerOpen && (
          <motion.div
            key="pending-approvals-interactive-viewer"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={snappyTransition}
            className="space-y-3.5 pt-1"
          >
            {/* Interactive Filter Toolbar — Clean Segmented Controls + Live Fuzzy Search */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-1 border-b border-slate-200/70 dark:border-slate-800/80">
              <div
                role="tablist"
                aria-label="فیلتر بر اساس نوع سند"
                className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-100/90 dark:bg-slate-900/90 border border-slate-200/70 dark:border-slate-800/80"
              >
                {filterTabs.map((tab) => {
                  const active = docTypeFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setDocTypeFilter(tab.id)}
                      className={`h-8 px-3 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        active
                          ? 'bg-white dark:bg-[#151A24] text-slate-900 dark:text-white font-semibold shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 font-medium'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={`font-code tabular-nums text-[11px] ${
                          active
                            ? 'text-indigo-600 dark:text-indigo-400 font-bold'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        ({toPersianDigits(tab.count)})
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 min-w-0">
                <div className="relative flex-1 sm:w-64 min-w-[200px]">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={viewerSearch}
                    onChange={(e) => setViewerSearch(e.target.value)}
                    placeholder="جستجو در اسناد در انتظار تأیید..."
                    className="w-full h-9 pr-9 pl-8 rounded-xl bg-white dark:bg-[#151A24] border border-slate-200/90 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                  {viewerSearch && (
                    <button
                      type="button"
                      onClick={() => setViewerSearch('')}
                      aria-label="پاک کردن جستجو"
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap shrink-0">
                  نمایش {toPersianDigits(visibleCards.length)} از {toPersianDigits(filteredItems.length)} سند
                </span>
              </div>
            </div>

            {/* Inline Confirmation Banner After One-Click Quick Approval */}
            <AnimatePresence initial={false}>
              {recentApprovedNote && (
                <motion.div
                  key="quick-approve-feedback"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={snappyTransition}
                  className="px-4 py-2.5 rounded-xl bg-emerald-50/85 dark:bg-emerald-950/35 border border-emerald-200/80 dark:border-emerald-800/70 flex items-center justify-between gap-3 text-xs text-emerald-800 dark:text-emerald-200"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="font-medium truncate">{recentApprovedNote}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRecentApprovedNote(null)}
                    aria-label="بستن پیام تأیید"
                    className="text-emerald-600 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-white cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Interactive Document Cards Grid or Purposeful Empty State */}
            {filteredItems.length === 0 ? (
              <div className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] px-5 py-7 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-3 text-right">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {viewerSearch.trim()
                        ? `سندی مطابق با «${viewerSearch.trim()}» یافت نشد`
                        : docTypeFilter === 'all'
                          ? 'همه اسناد بررسی و تأیید شده‌اند'
                          : docTypeFilter === 'voucher'
                            ? 'سند حسابداری موقتی در انتظار تأیید نیست'
                            : docTypeFilter === 'invoice'
                              ? 'پیش‌فاکتور یا فاکتور رزرو موقتی ثبت نشده است'
                              : docTypeFilter === 'import'
                                ? 'پرونده وارداتی منتظر ترخیص وجود ندارد'
                                : 'حواله یا سند عملیاتی بازی در کارتابل نیست'}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {viewerSearch.trim() || docTypeFilter !== 'all'
                        ? 'فیلتر را تغییر دهید تا سایر اسناد در انتظار تأیید نمایش داده شوند.'
                        : 'با ثبت سند موقت جدید یا صدور پیش‌فاکتور، موارد جدید به‌صورت لحظه‌ای در این بخش نمایش داده می‌شوند.'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {(docTypeFilter !== 'all' || viewerSearch.trim()) && (
                    <button
                      type="button"
                      onClick={() => {
                        setDocTypeFilter('all');
                        setViewerSearch('');
                      }}
                      className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap cursor-pointer transition-colors"
                    >
                      نمایش همه انواع سند
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      docTypeFilter === 'invoice'
                        ? onNavigate('invoices', 'new-proforma', 'inv-proforma')
                        : onNavigate('vouchers', 'new-voucher', 'voucher-new')
                    }
                    className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5 shrink-0" />
                    <span>{docTypeFilter === 'invoice' ? 'صدور پیش‌فاکتور' : 'ثبت سند جدید'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
                  <AnimatePresence mode="popLayout">
                    {visibleCards.map((item) => {
                      const DocIcon = DOC_TYPE_ICONS[item.docType];
                      const perm = getPermissionState(item);
                      const isBusy = busyItemId === item.id;
                      const isDirectApprove = item.quickApproveKind !== 'navigate_only';

                      const statusColor =
                        item.statusTone === 'rose'
                          ? 'text-rose-600 dark:text-rose-400'
                          : item.statusTone === 'amber'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-indigo-600 dark:text-indigo-400';

                      return (
                        <motion.article
                          key={`${item.docType}-${item.id}`}
                          layout="position"
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.96 }}
                          transition={snappyTransition}
                          className="bg-white dark:bg-[#151A24] rounded-2xl border border-slate-200/80 dark:border-white/[0.07] hover:border-indigo-300/80 dark:hover:border-white/[0.15] shadow-[0_2px_10px_-4px_rgba(15,23,42,0.05)] p-4 flex flex-col justify-between gap-3.5 transition-colors"
                        >
                          {/* Top Row: Clean Unboxed Metadata Kicker & Explicit Status */}
                          <div className="space-y-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 min-w-0 tabular-nums">
                                <DocIcon className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                                <span className="font-semibold text-slate-700 dark:text-slate-200 truncate">
                                  {item.docTypeLabel}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-code font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                                  {toPersianDigits(item.referenceCode)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-code whitespace-nowrap">
                                  {toPersianDigits(item.date)}
                                </span>
                              </div>

                              <span
                                className={`inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap shrink-0 ${statusColor}`}
                              >
                                {item.statusTone === 'rose' ? (
                                  <AlertTriangle className="w-3 h-3 shrink-0" />
                                ) : (
                                  <Clock className="w-3 h-3 shrink-0" />
                                )}
                                <span>{item.statusLabel}</span>
                              </span>
                            </div>

                            {/* Primary Subject + Subtype + Secondary Metadata */}
                            <div className="min-w-0">
                              <h3 className="text-sm font-bold text-slate-900 dark:text-white leading-snug line-clamp-2">
                                {item.title}
                              </h3>
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate tabular-nums">
                                {item.subTypeLabel} · {toPersianDigits(item.secondaryInfo)}
                              </p>
                            </div>

                            {/* Financial Value */}
                            <div className="flex items-baseline justify-between gap-2 pt-0.5">
                              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                مبلغ سند
                              </span>
                              <span className="font-code tabular-nums text-sm sm:text-[15px] font-extrabold text-slate-900 dark:text-white whitespace-nowrap">
                                {item.amountIrr > 0 ? formatMoney(item.amountIrr, unit) : '—'}
                              </span>
                            </div>
                          </div>

                          {/* Card Footer: One-Click Quick Approve & Details Action Buttons */}
                          <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2">
                            {isDirectApprove ? (
                              <button
                                type="button"
                                disabled={!perm.allowed || isBusy}
                                title={perm.reason || item.quickApproveLabel}
                                onClick={() => handleQuickApproveItem(item)}
                                className="flex-1 h-9 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-400 disabled:cursor-not-allowed text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                              >
                                {isBusy ? (
                                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                                ) : (
                                  <FileCheck2 className="w-3.5 h-3.5 shrink-0" />
                                )}
                                <span>{isBusy ? 'در حال تأیید...' : item.quickApproveLabel}</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  onNavigate(
                                    item.targetModule,
                                    item.targetIntent,
                                    item.targetSubKey
                                  )
                                }
                                className="flex-1 h-9 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                              >
                                <span>{item.quickApproveLabel}</span>
                                <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() =>
                                onNavigate(item.targetModule, item.targetIntent, item.targetSubKey)
                              }
                              className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                            >
                              بررسی
                            </button>
                          </div>
                        </motion.article>
                      );
                    })}
                  </AnimatePresence>
                </div>

                {filteredItems.length > 6 && onExpand && (
                  <div className="flex items-center justify-center pt-1">
                    <button
                      type="button"
                      onClick={onExpand}
                      className="h-9 px-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#151A24] hover:border-indigo-300 dark:hover:border-indigo-700 text-xs font-semibold text-indigo-600 dark:text-indigo-400 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
                    >
                      <span>
                        مشاهده همه {toPersianDigits(filteredItems.length)} سند در پنجره کامل
                      </span>
                      <ChevronLeft className="w-3.5 h-3.5 shrink-0" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
