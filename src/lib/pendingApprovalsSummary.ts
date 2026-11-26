import type {
  ActiveModule,
  ImportDossier,
  Invoice,
  SalesOrder,
  SubcontractJob,
  Voucher,
  VoucherType,
} from '../types/accounting';
import type { PettyCashItem, WarehouseSlip } from './apexExtensions';
import type { ReservedInvoice } from './smartIntelligence';
import { fuzzyFilterAndRank, normalizeFuzzyText } from './fuzzySearch';

export type PendingApprovalCategoryKey =
  | 'draft_vouchers'
  | 'pending_invoices'
  | 'pending_imports'
  | 'pending_operations';

export type PendingApprovalDocType = 'voucher' | 'invoice' | 'import' | 'operation';

export type PendingQuickApproveKind =
  | 'finalize_voucher'
  | 'convert_proforma'
  | 'clear_import'
  | 'invoice_sales_order'
  | 'navigate_only';

export interface PendingApprovalDocumentItem {
  id: string;
  docType: PendingApprovalDocType;
  categoryKey: PendingApprovalCategoryKey;
  docTypeLabel: string;
  subTypeLabel: string;
  referenceCode: string;
  title: string;
  secondaryInfo: string;
  date: string;
  amountIrr: number;
  statusLabel: string;
  statusTone: 'amber' | 'rose' | 'indigo';
  quickApproveKind: PendingQuickApproveKind;
  quickApproveLabel: string;
  canQuickApprove: boolean;
  disabledReason?: string;
  targetModule: ActiveModule;
  targetIntent?: string;
  targetSubKey?: string;
}

export interface PendingApprovalsInput {
  vouchers: Voucher[];
  invoices: Invoice[];
  reservedInvoices: ReservedInvoice[];
  importDossiers: ImportDossier[];
  salesOrders: SalesOrder[];
  subcontractJobs: SubcontractJob[];
  warehouseSlips: WarehouseSlip[];
  pettyCashItems: PettyCashItem[];
}

export interface PendingApprovalsSummary {
  draftVouchers: Voucher[];
  draftVouchersCount: number;
  draftVouchersTotalIrr: number;
  unbalancedDraftCount: number;
  oldestDraftDate: string | null;
  permanentVouchersCount: number;
  totalVouchersCount: number;
  voucherApprovalRatePct: number;

  pendingProformas: Invoice[];
  reservedInvoices: ReservedInvoice[];
  pendingInvoicesCount: number;
  pendingInvoicesTotalIrr: number;

  pendingImports: ImportDossier[];
  pendingImportsCount: number;
  importsInTransitCount: number;
  importsInCustomsCount: number;
  pendingImportsTotalIrr: number;

  pendingSalesOrders: SalesOrder[];
  pendingSubcontracts: SubcontractJob[];
  draftWarehouseSlips: WarehouseSlip[];
  pendingPettyCash: PettyCashItem[];
  pendingOperationsCount: number;
  pendingOperationsTotalIrr: number;

  totalPendingCount: number;
  totalPendingValueIrr: number;
  urgencyLevel: 'clear' | 'attention' | 'action_required';
}

const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  opening: 'سند افتتاحیه',
  general: 'سند عمومی',
  sales: 'سند فروش',
  purchase: 'سند خرید',
  treasury: 'سند خزانه‌داری',
  payroll: 'سند حقوق و دستمزد',
  depreciation: 'سند استهلاک',
  closing: 'سند اختتامیه',
};

const SUBCONTRACT_PROCESS_LABELS: Record<SubcontractJob['processType'], string> = {
  dyeing: 'رنگرزی',
  weaving: 'بافندگی',
  twisting: 'دولاتابی',
};

export const CATEGORY_TO_DOC_TYPE: Record<PendingApprovalCategoryKey, PendingApprovalDocType> = {
  draft_vouchers: 'voucher',
  pending_invoices: 'invoice',
  pending_imports: 'import',
  pending_operations: 'operation',
};

export const DOC_TYPE_TO_CATEGORY: Record<PendingApprovalDocType, PendingApprovalCategoryKey> = {
  voucher: 'draft_vouchers',
  invoice: 'pending_invoices',
  import: 'pending_imports',
  operation: 'pending_operations',
};

function estimateSalesOrderValueIrr(order: SalesOrder): number {
  return order.items.reduce((sum, item) => {
    const qty = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
    return sum + Math.round(qty * (item.unitPriceIrr || 0));
  }, 0);
}

function estimateSubcontractValueIrr(job: SubcontractJob): number {
  const rawMaterialCost = Math.round((job.sentWeightKg || 0) * (job.rawUnitCostIrr || 0));
  const serviceCost = job.totalServiceFeeIrr || 0;
  return rawMaterialCost + serviceCost;
}

export function computePendingApprovalsSummary(
  input: PendingApprovalsInput
): PendingApprovalsSummary {
  const draftVouchers = input.vouchers
    .filter((v) => v.status === 'draft')
    .sort((a, b) => b.voucherNumber - a.voucherNumber);

  const permanentVouchersCount = input.vouchers.filter((v) => v.status === 'permanent').length;
  const totalVouchersCount = input.vouchers.length;
  const voucherApprovalRatePct =
    totalVouchersCount > 0
      ? Math.round((permanentVouchersCount / totalVouchersCount) * 1000) / 10
      : 100;

  const draftVouchersTotalIrr = draftVouchers.reduce((sum, v) => sum + (v.totalDebit || 0), 0);
  const unbalancedDraftCount = draftVouchers.filter(
    (v) => Math.abs((v.totalDebit || 0) - (v.totalCredit || 0)) > 0.01
  ).length;
  const oldestDraftDate =
    draftVouchers.length > 0
      ? [...draftVouchers]
          .map((v) => v.date)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))[0] ?? null
      : null;

  const pendingProformas = input.invoices
    .filter((inv) => inv.invoiceType === 'proforma' && inv.status !== 'cancelled')
    .sort((a, b) => b.date.localeCompare(a.date));

  const reservedInvoices = [...input.reservedInvoices].sort((a, b) =>
    (b.savedAt || b.date).localeCompare(a.savedAt || a.date)
  );

  const pendingInvoicesCount = pendingProformas.length + reservedInvoices.length;
  const pendingInvoicesTotalIrr =
    pendingProformas.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0) +
    reservedInvoices.reduce((sum, r) => sum + (r.estimatedTotalIrr || 0), 0);

  const pendingImports = input.importDossiers
    .filter((d) => d.status !== 'cleared')
    .sort((a, b) => b.date.localeCompare(a.date));
  const importsInTransitCount = pendingImports.filter((d) => d.status === 'in_transit').length;
  const importsInCustomsCount = pendingImports.filter((d) => d.status === 'customs').length;
  const pendingImportsTotalIrr = pendingImports.reduce(
    (sum, d) => sum + (d.grandTotalLandedIrr || 0),
    0
  );

  const pendingSalesOrders = input.salesOrders
    .filter((o) => o.status === 'ordered' || o.status === 'dispatched')
    .sort((a, b) => b.date.localeCompare(a.date));
  const pendingSubcontracts = input.subcontractJobs
    .filter((j) => j.status === 'sent')
    .sort((a, b) => b.date.localeCompare(a.date));
  const draftWarehouseSlips = input.warehouseSlips
    .filter((s) => s.status === 'draft')
    .sort((a, b) => b.date.localeCompare(a.date));
  const pendingPettyCash = input.pettyCashItems
    .filter((p) => p.status === 'pending')
    .sort((a, b) => b.date.localeCompare(a.date));

  const pendingOperationsCount =
    pendingSalesOrders.length +
    pendingSubcontracts.length +
    draftWarehouseSlips.length +
    pendingPettyCash.length;

  const pendingOperationsTotalIrr =
    pendingSalesOrders.reduce((sum, o) => sum + estimateSalesOrderValueIrr(o), 0) +
    pendingSubcontracts.reduce((sum, j) => sum + estimateSubcontractValueIrr(j), 0) +
    pendingPettyCash.reduce((sum, p) => sum + (p.amountIrr || 0), 0);

  const totalPendingCount =
    draftVouchers.length +
    pendingInvoicesCount +
    pendingImports.length +
    pendingOperationsCount;

  const totalPendingValueIrr =
    draftVouchersTotalIrr +
    pendingInvoicesTotalIrr +
    pendingImportsTotalIrr +
    pendingOperationsTotalIrr;

  const urgencyLevel: PendingApprovalsSummary['urgencyLevel'] =
    unbalancedDraftCount > 0 || draftVouchers.length > 0
      ? 'action_required'
      : totalPendingCount > 0
        ? 'attention'
        : 'clear';

  return {
    draftVouchers,
    draftVouchersCount: draftVouchers.length,
    draftVouchersTotalIrr,
    unbalancedDraftCount,
    oldestDraftDate,
    permanentVouchersCount,
    totalVouchersCount,
    voucherApprovalRatePct,

    pendingProformas,
    reservedInvoices,
    pendingInvoicesCount,
    pendingInvoicesTotalIrr,

    pendingImports,
    pendingImportsCount: pendingImports.length,
    importsInTransitCount,
    importsInCustomsCount,
    pendingImportsTotalIrr,

    pendingSalesOrders,
    pendingSubcontracts,
    draftWarehouseSlips,
    pendingPettyCash,
    pendingOperationsCount,
    pendingOperationsTotalIrr,

    totalPendingCount,
    totalPendingValueIrr,
    urgencyLevel,
  };
}

export function buildPendingApprovalItems(
  summary: PendingApprovalsSummary
): PendingApprovalDocumentItem[] {
  const items: PendingApprovalDocumentItem[] = [];

  summary.draftVouchers.forEach((v) => {
    const isBalanced = Math.abs((v.totalDebit || 0) - (v.totalCredit || 0)) <= 0.01;
    items.push({
      id: v.id,
      docType: 'voucher',
      categoryKey: 'draft_vouchers',
      docTypeLabel: 'سند حسابداری',
      subTypeLabel: `${VOUCHER_TYPE_LABELS[v.voucherType]} (موقت)`,
      referenceCode: `#${v.voucherNumber}`,
      title: v.description || `سند حسابداری شماره ${v.voucherNumber}`,
      secondaryInfo: `${v.lines.length} آرتیکل · ${isBalanced ? 'تراز کامل' : 'اختلاف بدهکار و بستانکار'}`,
      date: v.date,
      amountIrr: v.totalDebit || 0,
      statusLabel: isBalanced ? 'در انتظار تأیید' : 'نامتوازن',
      statusTone: isBalanced ? 'amber' : 'rose',
      quickApproveKind: 'finalize_voucher',
      quickApproveLabel: 'تأیید و دائم‌سازی',
      canQuickApprove: isBalanced,
      disabledReason: isBalanced ? undefined : 'سند نامتوازن است و پیش از تأیید باید ویرایش شود',
      targetModule: 'vouchers',
      targetIntent: 'cartable',
      targetSubKey: 'voucher-cartable',
    });
  });

  summary.pendingProformas.forEach((inv) => {
    items.push({
      id: inv.id,
      docType: 'invoice',
      categoryKey: 'pending_invoices',
      docTypeLabel: 'فاکتور',
      subTypeLabel: 'پیش‌فاکتور فروش',
      referenceCode: inv.invoiceNumber,
      title: inv.partyName,
      secondaryInfo: `${inv.items.length} ردیف کالا · ${inv.warehouse}`,
      date: inv.date,
      amountIrr: inv.grandTotal || 0,
      statusLabel: 'در انتظار تبدیل به فروش',
      statusTone: 'indigo',
      quickApproveKind: 'convert_proforma',
      quickApproveLabel: 'تأیید و صدور فروش',
      canQuickApprove: true,
      targetModule: 'invoices',
    });
  });

  summary.reservedInvoices.forEach((res) => {
    items.push({
      id: res.id,
      docType: 'invoice',
      categoryKey: 'pending_invoices',
      docTypeLabel: 'فاکتور',
      subTypeLabel: 'رزرو موقت ۹.۶',
      referenceCode: res.label,
      title: res.partyName,
      secondaryInfo: `${res.draftItems.length} ردیف کالا · ${res.warehouse}`,
      date: res.date,
      amountIrr: res.estimatedTotalIrr || 0,
      statusLabel: 'در صف رزرو فاکتور',
      statusTone: 'indigo',
      quickApproveKind: 'navigate_only',
      quickApproveLabel: 'ادامه و صدور نهایی',
      canQuickApprove: false,
      targetModule: 'invoices',
      targetIntent: 'reserved',
      targetSubKey: 'inv-reserved',
    });
  });

  summary.pendingImports.forEach((dossier) => {
    items.push({
      id: dossier.id,
      docType: 'import',
      categoryKey: 'pending_imports',
      docTypeLabel: 'پرونده وارداتی',
      subTypeLabel: dossier.status === 'customs' ? 'در گمرک' : 'در مسیر حمل',
      referenceCode: dossier.dossierNumber,
      title: dossier.supplierName,
      secondaryInfo: `مبدأ: ${dossier.originCountry} · ${dossier.items.length} ردیف کالا`,
      date: dossier.date,
      amountIrr: dossier.grandTotalLandedIrr || 0,
      statusLabel: dossier.status === 'customs' ? 'آماده ترخیص و سند' : 'در مسیر حمل',
      statusTone: 'amber',
      quickApproveKind: 'clear_import',
      quickApproveLabel: 'تأیید ترخیص و سند',
      canQuickApprove: true,
      targetModule: 'commercial',
      targetIntent: 'imports',
      targetSubKey: 'comm-imports',
    });
  });

  summary.pendingSalesOrders.forEach((order) => {
    const isDispatched = order.status === 'dispatched';
    items.push({
      id: order.id,
      docType: 'operation',
      categoryKey: 'pending_operations',
      docTypeLabel: 'حواله و عملیات',
      subTypeLabel: isDispatched ? 'حواله باسکول خارج‌شده' : 'سفارش فروش باز',
      referenceCode: order.orderNumber,
      title: order.partyName,
      secondaryInfo: `${order.warehouse} · ${order.items.length} ردیف کالا`,
      date: order.dispatchDate || order.date,
      amountIrr: estimateSalesOrderValueIrr(order),
      statusLabel: isDispatched ? 'آماده صدور فاکتور' : 'در انتظار توزین باسکول',
      statusTone: isDispatched ? 'indigo' : 'amber',
      quickApproveKind: isDispatched ? 'invoice_sales_order' : 'navigate_only',
      quickApproveLabel: isDispatched ? 'تأیید و صدور فاکتور' : 'ثبت توزین باسکول',
      canQuickApprove: isDispatched,
      targetModule: 'commercial',
      targetIntent: 'orders',
      targetSubKey: 'comm-orders',
    });
  });

  summary.pendingSubcontracts.forEach((job) => {
    items.push({
      id: job.id,
      docType: 'operation',
      categoryKey: 'pending_operations',
      docTypeLabel: 'حواله و عملیات',
      subTypeLabel: `پیمانکاری ${SUBCONTRACT_PROCESS_LABELS[job.processType]}`,
      referenceCode: job.jobNumber,
      title: job.contractorName,
      secondaryInfo: `${job.rawProductName} · ${job.sentWeightKg} کیلوگرم ارسالی`,
      date: job.date,
      amountIrr: estimateSubcontractValueIrr(job),
      statusLabel: 'ارسالی / در انتظار برگشت',
      statusTone: 'amber',
      quickApproveKind: 'navigate_only',
      quickApproveLabel: 'ثبت برگشت و سند',
      canQuickApprove: false,
      targetModule: 'commercial',
      targetIntent: 'subcontract',
      targetSubKey: 'comm-subcontract',
    });
  });

  summary.draftWarehouseSlips.forEach((slip) => {
    items.push({
      id: slip.id,
      docType: 'operation',
      categoryKey: 'pending_operations',
      docTypeLabel: 'حواله و عملیات',
      subTypeLabel: 'سند انبار پیش‌نویس',
      referenceCode: slip.slipNumber,
      title: slip.partyName,
      secondaryInfo: `${slip.warehouse} · ${slip.items.length} ردیف کالا`,
      date: slip.date,
      amountIrr: 0,
      statusLabel: 'پیش‌نویس انبار',
      statusTone: 'amber',
      quickApproveKind: 'navigate_only',
      quickApproveLabel: 'بررسی و تأیید انبار',
      canQuickApprove: false,
      targetModule: 'warehouse-crm',
      targetIntent: 'slips',
      targetSubKey: 'wh-slips',
    });
  });

  summary.pendingPettyCash.forEach((item) => {
    items.push({
      id: item.id,
      docType: 'operation',
      categoryKey: 'pending_operations',
      docTypeLabel: 'حواله و عملیات',
      subTypeLabel: 'تنخواه‌گردان باز',
      referenceCode: item.receiptNo || 'تنخواه',
      title: item.title,
      secondaryInfo: `${item.categoryTitle}${item.vendorName ? ` · ${item.vendorName}` : ''}`,
      date: item.date,
      amountIrr: item.amountIrr || 0,
      statusLabel: 'در انتظار تسویه تنخواه',
      statusTone: 'amber',
      quickApproveKind: 'navigate_only',
      quickApproveLabel: 'ثبت سند تسویه',
      canQuickApprove: false,
      targetModule: 'finance-ops',
      targetIntent: 'petty-cash',
      targetSubKey: 'fin-petty',
    });
  });

  return items;
}

export function filterPendingApprovalItems(
  items: PendingApprovalDocumentItem[],
  docTypeFilter: 'all' | PendingApprovalDocType,
  searchQuery: string
): PendingApprovalDocumentItem[] {
  const scoped =
    docTypeFilter === 'all' ? items : items.filter((item) => item.docType === docTypeFilter);
  if (!normalizeFuzzyText(searchQuery)) {
    return scoped;
  }
  return fuzzyFilterAndRank(scoped, searchQuery, (item) => [
    { text: item.referenceCode, weight: 1.5 },
    { text: item.title, weight: 1.35 },
    { text: item.docTypeLabel, weight: 1.15 },
    { text: item.subTypeLabel, weight: 1.1 },
    { text: item.secondaryInfo, weight: 0.95 },
    { text: item.statusLabel, weight: 0.9 },
    { text: item.date, weight: 0.85 },
  ]).map((r) => r.item);
}
