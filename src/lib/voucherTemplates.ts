import { Account, CostCenter, Party, Voucher, VoucherLine, VoucherType } from '../types/accounting';
import { sumIrr, toExactIrr } from './moneyMath';
import { fuzzyFilterAndRank } from './fuzzySearch';

export type VoucherTemplateCategory =
  | 'general_expenses'
  | 'sales'
  | 'purchase'
  | 'treasury'
  | 'payroll'
  | 'adjustments'
  | 'custom';

export type VoucherTemplateFormula =
  | 'full'
  | 'vat_10'
  | 'gross_with_vat_10'
  | 'payroll_net_after_ins'
  | 'payroll_total_ins_30'
  | 'payroll_gross_with_employer_ins'
  | 'percentage'
  | 'fixed';

export interface VoucherTemplateLineDef {
  accountCode: string;
  fallbackTitle: string;
  side: 'debit' | 'credit';
  formula: VoucherTemplateFormula;
  /** Used when formula === 'percentage' (0..100, e.g. 25 means 25% of base amount) */
  percentage?: number;
  /** Used when formula === 'fixed' (exact integer IRR) */
  fixedAmount?: number;
  defaultDescription: string;
  requiresParty?: boolean;
  applyCostCenter?: boolean;
  defaultCostCenterId?: string;
}

export interface VoucherTemplate {
  id: string;
  name: string;
  category: VoucherTemplateCategory;
  voucherType: VoucherType;
  descriptionTemplate: string;
  hint: string;
  isSystem: boolean;
  supportsQuickAmount: boolean;
  quickAmountLabel?: string;
  lines: VoucherTemplateLineDef[];
  createdAt?: string;
}

export interface ApplyVoucherTemplateParams {
  accounts: Account[];
  baseAmountIrr?: number;
  date?: string;
  party?: Party | null;
  costCenterId?: string;
}

export interface AppliedVoucherTemplateResult {
  voucherType: VoucherType;
  description: string;
  lines: VoucherLine[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
}

export const VOUCHER_TEMPLATE_CATEGORY_LABELS: Record<VoucherTemplateCategory, string> = {
  general_expenses: 'هزینه‌های عمومی',
  sales: 'فروش و درآمد',
  purchase: 'خرید و انبار',
  treasury: 'خزانه‌داری و بانک',
  payroll: 'حقوق و دستمزد',
  adjustments: 'اصلاحی و استهلاک',
  custom: 'الگوهای من',
};

const CUSTOM_TEMPLATES_STORAGE_KEY = 'holoo_apex_voucher_templates_v1';
const TEMPLATE_USAGE_STORAGE_KEY = 'holoo_apex_voucher_template_usage_v1';

/**
 * 12 Curated Built-In Iranian Corporate Accounting Templates
 * Aligned directly with the standard Holoo Apex chart of accounts (101xx–901xx).
 */
export const SYSTEM_VOUCHER_TEMPLATES: VoucherTemplate[] = [
  {
    id: 'sys_exp_rent_utilities',
    name: 'هزینه‌های عمومی (اجاره و قبوض از بانک)',
    category: 'general_expenses',
    voucherType: 'general',
    descriptionTemplate: 'پرداخت هزینه اجاره و قبوض دوره {month}',
    hint: 'بدهکار هزینه اداری/انبار (۸۰۲۰۱) و بستانکار حساب بانکی (۱۰۲۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ هزینه (ریال)',
    lines: [
      {
        accountCode: '80201',
        fallbackTitle: 'اجاره دفتر، انبار شادآباد و قبوض',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'بابت هزینه اجاره و قبوض جاری {month}',
        applyCostCenter: true,
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'پرداخت از حساب بانکی بابت هزینه عمومی {month}',
      },
    ],
  },
  {
    id: 'sys_exp_freight_commission',
    name: 'هزینه حمل بار و پورسانت فروش',
    category: 'general_expenses',
    voucherType: 'general',
    descriptionTemplate: 'ثبت هزینه حمل بار و پورسانت فروش {partySuffix}',
    hint: 'بدهکار هزینه توزیع و پورسانت (۸۰۵۰۱) در برابر بانک (۱۰۲۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ حمل / پورسانت (ریال)',
    lines: [
      {
        accountCode: '80501',
        fallbackTitle: 'پورسانت کارگزاران بازار و حمل بار نخ',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'هزینه حمل و پورسانت فروش {partySuffix}',
        requiresParty: true,
        applyCostCenter: true,
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'پرداخت وجه حمل / پورسانت {partySuffix}',
      },
    ],
  },
  {
    id: 'sys_exp_petty_cash_charge',
    name: 'شارژ تنخواه‌گردان انبار و گمرک',
    category: 'general_expenses',
    voucherType: 'treasury',
    descriptionTemplate: 'واریز شارژ تنخواه‌گردان مورخ {date}',
    hint: 'انتقال وجه از بانک شرکتی (۱۰۲۰۱) به تنخواه‌گردان (۱۰۱۰۲)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ شارژ تنخواه (ریال)',
    lines: [
      {
        accountCode: '10102',
        fallbackTitle: 'تنخواه‌گردان گمرک و انبار',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'افزایش موجودی تنخواه‌گردان مورخ {date}',
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'برداشت از حساب بانکی بابت شارژ تنخواه',
      },
    ],
  },
  {
    id: 'sys_exp_bank_fee',
    name: 'کارمزدهای بانکی و هزینه مالی',
    category: 'general_expenses',
    voucherType: 'general',
    descriptionTemplate: 'ثبت کارمزد بانکی و هزینه حواله مورخ {date}',
    hint: 'بدهکار هزینه مالی و کارمزد (۸۰۹۰۱) و بستانکار بانک (۱۰۲۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ کارمزد (ریال)',
    lines: [
      {
        accountCode: '80901',
        fallbackTitle: 'زیان تسعیر ارز و کارمزدهای بانکی',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'کارمزد خدمات بانکی و صدور حواله',
        applyCostCenter: true,
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'کسر مستقیم کارمزد از حساب بانکی',
      },
    ],
  },
  {
    id: 'sys_sales_credit_vat10',
    name: 'فروش نسیه رسمی با ۱۰٪ ارزش افزوده',
    category: 'sales',
    voucherType: 'sales',
    descriptionTemplate: 'ثبت فروش رسمی نسیه با ۱۰٪ ارزش افزوده {partySuffix}',
    hint: 'تفکیک خودکار خالص فروش (۶۰۱۰۱) و ۱۰٪ مالیات ارزش افزوده فروش (۳۰۳۰۱) در برابر بدهکاران (۱۰۴۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ خالص فروش بدون مالیات (ریال)',
    lines: [
      {
        accountCode: '10401',
        fallbackTitle: 'بدهکاران تجاری و کارخانجات نساجی',
        side: 'debit',
        formula: 'gross_with_vat_10',
        defaultDescription: 'بدهکار بابت فروش رسمی به همراه ۱۰٪ ارزش افزوده {partySuffix}',
        requiresParty: true,
      },
      {
        accountCode: '60101',
        fallbackTitle: 'فروش رسمی نخ نساجی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'درآمد فروش رسمی کالا {partySuffix}',
        applyCostCenter: true,
      },
      {
        accountCode: '30301',
        fallbackTitle: 'مالیات بر ارزش افزوده فروش (۱۰٪)',
        side: 'credit',
        formula: 'vat_10',
        defaultDescription: 'مالیات بر ارزش افزوده ۱۰٪ فروش رسمی',
      },
    ],
  },
  {
    id: 'sys_sales_cash_vat10',
    name: 'فروش نقدی / کارت‌خوان با ۱۰٪ ارزش افزوده',
    category: 'sales',
    voucherType: 'sales',
    descriptionTemplate: 'ثبت فروش نقدی واریز به بانک با ۱۰٪ ارزش افزوده {partySuffix}',
    hint: 'واریز مستقیم جمع کل فاکتور به بانک (۱۰۲۰۱) با تفکیک فروش (۶۰۱۰۱) و ۱۰٪ ارزش افزوده (۳۰۳۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ خالص فروش بدون مالیات (ریال)',
    lines: [
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'debit',
        formula: 'gross_with_vat_10',
        defaultDescription: 'دریافت وجه فروش نقدی (شامل ۱۰٪ مالیات ارزش افزوده)',
      },
      {
        accountCode: '60101',
        fallbackTitle: 'فروش رسمی نخ نساجی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'درآمد فروش نقدی کالا {partySuffix}',
        applyCostCenter: true,
      },
      {
        accountCode: '30301',
        fallbackTitle: 'مالیات بر ارزش افزوده فروش (۱۰٪)',
        side: 'credit',
        formula: 'vat_10',
        defaultDescription: 'مالیات بر ارزش افزوده ۱۰٪ فروش نقدی',
      },
    ],
  },
  {
    id: 'sys_sales_return_vat10',
    name: 'برگشت از فروش رسمی و تعدیل ارزش افزوده',
    category: 'sales',
    voucherType: 'sales',
    descriptionTemplate: 'ثبت برگشت از فروش رسمی {partySuffix}',
    hint: 'بدهکار برگشت از فروش (۶۰۲۰۱) و تعدیل ارزش افزوده (۳۰۳۰۱) در برابر کاهش بدهی مشتری (۱۰۴۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ خالص کالای برگشتی (ریال)',
    lines: [
      {
        accountCode: '60201',
        fallbackTitle: 'برگشت از فروش نخ',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'برگشت از فروش کالا {partySuffix}',
        applyCostCenter: true,
      },
      {
        accountCode: '30301',
        fallbackTitle: 'مالیات بر ارزش افزوده فروش (۱۰٪)',
        side: 'debit',
        formula: 'vat_10',
        defaultDescription: 'تعدیل کاهشی ۱۰٪ مالیات ارزش افزوده برگشت از فروش',
      },
      {
        accountCode: '10401',
        fallbackTitle: 'بدهکاران تجاری و کارخانجات نساجی',
        side: 'credit',
        formula: 'gross_with_vat_10',
        defaultDescription: 'کاهش مانده بدهی مشتری بابت برگشت کالا {partySuffix}',
        requiresParty: true,
      },
    ],
  },
  {
    id: 'sys_purchase_credit_vat10',
    name: 'خرید کالا / مواد اولیه با ۱۰٪ ارزش افزوده',
    category: 'purchase',
    voucherType: 'purchase',
    descriptionTemplate: 'ثبت خرید رسمی کالا با ۱۰٪ ارزش افزوده {partySuffix}',
    hint: 'بدهکار موجودی انبار (۱۰۵۰۱) و اعتبار ارزش افزوده خرید (۳۰۳۰۲) در برابر بستانکاران (۳۰۱۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ خالص خرید بدون مالیات (ریال)',
    lines: [
      {
        accountCode: '10501',
        fallbackTitle: 'موجودی انبار نخ و کالای وارداتی',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'افزایش موجودی انبار بابت خرید کالا {partySuffix}',
      },
      {
        accountCode: '30302',
        fallbackTitle: 'مالیات بر ارزش افزوده خرید و گمرک',
        side: 'debit',
        formula: 'vat_10',
        defaultDescription: 'مالیات بر ارزش افزوده خرید ۱۰٪',
      },
      {
        accountCode: '30101',
        fallbackTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
        side: 'credit',
        formula: 'gross_with_vat_10',
        defaultDescription: 'بستانکاری تأمین‌کننده بابت فاکتور خرید {partySuffix}',
        requiresParty: true,
      },
    ],
  },
  {
    id: 'sys_treasury_customer_receipt',
    name: 'دریافت وجه از مشتری (وصول مطالبات)',
    category: 'treasury',
    voucherType: 'treasury',
    descriptionTemplate: 'دریافت وجه واریزی از مشتری {partySuffix}',
    hint: 'واریز به حساب بانکی (۱۰۲۰۱) و تسویه حساب دریافتنی مشتری (۱۰۴۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ دریافتی (ریال)',
    lines: [
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'واریز وجه توسط مشتری {partySuffix}',
      },
      {
        accountCode: '10401',
        fallbackTitle: 'بدهکاران تجاری و کارخانجات نساجی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'بابت تسویه مطالبات {partySuffix}',
        requiresParty: true,
      },
    ],
  },
  {
    id: 'sys_treasury_vendor_payment',
    name: 'پرداخت به تأمین‌کننده (تسویه بدهی)',
    category: 'treasury',
    voucherType: 'treasury',
    descriptionTemplate: 'پرداخت وجه بابت تسویه حساب تأمین‌کننده {partySuffix}',
    hint: 'کاهش مانده بستانکاران (۳۰۱۰۱) و برداشت از حساب بانکی (۱۰۲۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ پرداختی (ریال)',
    lines: [
      {
        accountCode: '30101',
        fallbackTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'پرداخت بابت تسویه بدهی {partySuffix}',
        requiresParty: true,
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'حواله بانکی به حساب تأمین‌کننده {partySuffix}',
      },
    ],
  },
  {
    id: 'sys_payroll_monthly_tamin',
    name: 'سند حقوق و دستمزد ماهانه با بیمه ۳۰٪',
    category: 'payroll',
    voucherType: 'payroll',
    descriptionTemplate: 'ثبت هزینه حقوق، دستمزد و حق بیمه دوره {month}',
    hint: 'محاسبه خودکار ۲۳٪ بیمه کارفرما + ۷٪ بیمه کارگر (۳۰٪ تأمین اجتماعی) و خالص حقوق پرداختنی',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'جمع حقوق ناخالص مشمول بیمه (ریال)',
    lines: [
      {
        accountCode: '80101',
        fallbackTitle: 'هزینه حقوق، مزایا و بیمه سهم کارفرما',
        side: 'debit',
        formula: 'payroll_gross_with_employer_ins',
        defaultDescription: 'هزینه حقوق ناخالص به همراه ۲۳٪ بیمه سهم کارفرما ({month})',
        applyCostCenter: true,
      },
      {
        accountCode: '30401',
        fallbackTitle: 'حقوق پرداختنی کارکنان',
        side: 'credit',
        formula: 'payroll_net_after_ins',
        defaultDescription: 'خالص حقوق پرداختنی پرسنل پس از کسر ۷٪ بیمه کارگر ({month})',
      },
      {
        accountCode: '30402',
        fallbackTitle: 'سازمان تأمین اجتماعی (بیمه ۳۰٪)',
        side: 'credit',
        formula: 'payroll_total_ins_30',
        defaultDescription: 'حق بیمه تأمین اجتماعی ۳۰٪ (۲۳٪ کارفرما + ۷٪ کارگر) دوره {month}',
      },
    ],
  },
  {
    id: 'sys_adj_depreciation',
    name: 'سند اصلاحی استهلاک دارایی ثابت',
    category: 'adjustments',
    voucherType: 'depreciation',
    descriptionTemplate: 'ثبت هزینه استهلاک ماهانه دارایی‌های ثابت دوره {month}',
    hint: 'بدهکار هزینه استهلاک (۸۰۳۰۱) در برابر استهلاک انباشته (۲۰۲۰۱)',
    isSystem: true,
    supportsQuickAmount: true,
    quickAmountLabel: 'مبلغ استهلاک دوره (ریال)',
    lines: [
      {
        accountCode: '80301',
        fallbackTitle: 'هزینه استهلاک ماشین‌آلات و تجهیزات',
        side: 'debit',
        formula: 'full',
        defaultDescription: 'هزینه استهلاک ماشین‌آلات و تجهیزات دوره {month}',
        applyCostCenter: true,
      },
      {
        accountCode: '20201',
        fallbackTitle: 'استهلاک انباشته ماشین‌آلات و تجهیزات',
        side: 'credit',
        formula: 'full',
        defaultDescription: 'افزایش استهلاک انباشته دارایی‌ها دوره {month}',
      },
    ],
  },
];

const SHAMSI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

function extractShamsiMonthLabel(dateStr?: string): string {
  if (!dateStr) return 'جاری';
  const match = dateStr.trim().match(/^(\d{4})\/(\d{1,2})\/\d{1,2}$/);
  if (!match) return dateStr;
  const year = match[1];
  const monthIdx = Number(match[2]) - 1;
  if (monthIdx >= 0 && monthIdx < SHAMSI_MONTHS.length) {
    return `${SHAMSI_MONTHS[monthIdx]} ${year}`;
  }
  return dateStr;
}

function interpolateTemplateText(
  raw: string,
  ctx: { date: string; month: string; partyName?: string }
): string {
  const partySuffix = ctx.partyName ? `(${ctx.partyName})` : '';
  return raw
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{month\}/g, ctx.month)
    .replace(/\{party\}/g, ctx.partyName || '')
    .replace(/\{partySuffix\}/g, partySuffix)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resolveLiveAccount(
  code: string,
  fallbackTitle: string,
  accounts: Account[]
): { code: string; title: string } {
  const exact = accounts.find((a) => a.code === code);
  if (exact) return { code: exact.code, title: exact.title };

  // Fallback to closest moein/tafsili sharing the same 3-digit kol prefix
  const prefix = code.slice(0, 3);
  const sibling = accounts.find(
    (a) => (a.level === 'moein' || a.level === 'tafsili') && a.code.startsWith(prefix)
  );
  if (sibling) return { code: sibling.code, title: sibling.title };

  return { code, title: fallbackTitle };
}

function computeLineAmountIrr(def: VoucherTemplateLineDef, baseAmountIrr: number): number {
  const base = Math.max(0, toExactIrr(baseAmountIrr));
  if (def.formula === 'fixed') {
    return Math.max(0, toExactIrr(def.fixedAmount ?? 0));
  }
  if (base <= 0) return 0;

  const vat10 = Math.round(base * 0.1);
  const empIns7 = Math.round(base * 0.07);
  const employerIns23 = Math.round(base * 0.23);

  switch (def.formula) {
    case 'full':
      return base;
    case 'vat_10':
      return vat10;
    case 'gross_with_vat_10':
      return base + vat10;
    case 'payroll_net_after_ins':
      return Math.max(0, base - empIns7);
    case 'payroll_total_ins_30':
      return empIns7 + employerIns23;
    case 'payroll_gross_with_employer_ins':
      return base + employerIns23;
    case 'percentage': {
      const pct = Number.isFinite(def.percentage) ? Math.max(0, Number(def.percentage)) : 0;
      return Math.round((base * pct) / 100);
    }
    default:
      return 0;
  }
}

/**
 * Applies a VoucherTemplate against live accounts, optional quick base amount,
 * Shamsi date, party, and cost center.
 * Enforces exact 0-Rial balance drift when baseAmountIrr > 0 and percentage-based
 * custom templates have a 1-Rial rounding remainder.
 */
export function applyVoucherTemplate(
  template: VoucherTemplate,
  params: ApplyVoucherTemplateParams
): AppliedVoucherTemplateResult {
  const safeDate = params.date?.trim() || '1405/01/01';
  const monthLabel = extractShamsiMonthLabel(safeDate);
  const baseIrr = Math.max(0, toExactIrr(params.baseAmountIrr ?? 0));

  const lines: VoucherLine[] = template.lines.map((def) => {
    const resolved = resolveLiveAccount(def.accountCode, def.fallbackTitle, params.accounts);
    const amount = computeLineAmountIrr(def, baseIrr);
    const lineDesc = interpolateTemplateText(def.defaultDescription, {
      date: safeDate,
      month: monthLabel,
      partyName: params.party?.name,
    });

    const line: VoucherLine = {
      accountCode: resolved.code,
      accountTitle: resolved.title,
      description: lineDesc,
      debit: def.side === 'debit' ? amount : 0,
      credit: def.side === 'credit' ? amount : 0,
    };

    if (def.requiresParty && params.party) {
      line.partyId = params.party.id;
      line.partyName = params.party.name;
    }

    const effectiveCostCenterId = def.defaultCostCenterId || (def.applyCostCenter ? params.costCenterId : undefined);
    if (effectiveCostCenterId) {
      line.costCenterId = effectiveCostCenterId;
    }

    return line;
  });

  // Guard against minor rounding drift (e.g. 1–2 Rial) on custom multi-percentage templates
  if (baseIrr > 0 && lines.length >= 2) {
    const dSum = sumIrr(lines.map((l) => l.debit));
    const cSum = sumIrr(lines.map((l) => l.credit));
    const drift = dSum - cSum;
    if (drift !== 0 && Math.abs(drift) <= lines.length) {
      // Absorb tiny rounding residual into the last line on the opposite/smaller side
      const targetSide = drift > 0 ? 'credit' : 'debit';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (targetSide === 'credit' && lines[i].credit > 0) {
          lines[i].credit += Math.abs(drift);
          break;
        }
        if (targetSide === 'debit' && lines[i].debit > 0) {
          lines[i].debit += Math.abs(drift);
          break;
        }
      }
    }
  }

  const totalDebit = sumIrr(lines.map((l) => l.debit));
  const totalCredit = sumIrr(lines.map((l) => l.credit));
  const description = interpolateTemplateText(template.descriptionTemplate, {
    date: safeDate,
    month: monthLabel,
    partyName: params.party?.name,
  });

  return {
    voucherType: template.voucherType,
    description,
    lines,
    totalDebit,
    totalCredit,
    isBalanced: totalDebit === totalCredit && totalDebit > 0,
  };
}

/**
 * Converts a user's currently composed voucher lines into a reusable custom template.
 * If the current voucher has non-zero balanced totals, automatically converts each line
 * into proportional percentages so re-applying with ANY new quick amount stays 100% balanced!
 */
export function createCustomTemplateFromLines(input: {
  name: string;
  category?: VoucherTemplateCategory;
  voucherType: VoucherType;
  description: string;
  lines: VoucherLine[];
}): VoucherTemplate {
  const cleanName = input.name.trim();
  if (cleanName.length < 2) {
    throw new Error('نام الگو باید حداقل ۲ کاراکتر باشد.');
  }
  const validLines = input.lines.filter((l) => l.accountCode && l.accountCode.trim().length > 0);
  if (validLines.length < 2) {
    throw new Error('الگوی سند دوبل باید حداقل ۲ آرتیکل معتبر داشته باشد.');
  }

  const totalDebit = sumIrr(validLines.map((l) => Math.max(0, toExactIrr(l.debit))));
  const totalCredit = sumIrr(validLines.map((l) => Math.max(0, toExactIrr(l.credit))));
  const hasBalancedBase = totalDebit > 0 && totalDebit === totalCredit;

  const lineDefs: VoucherTemplateLineDef[] = validLines.map((l) => {
    const debit = Math.max(0, toExactIrr(l.debit));
    const credit = Math.max(0, toExactIrr(l.credit));
    const side: 'debit' | 'credit' = credit > debit ? 'credit' : 'debit';
    const amount = side === 'debit' ? debit : credit;

    let formula: VoucherTemplateFormula = 'full';
    let percentage: number | undefined;
    if (hasBalancedBase) {
      if (amount === totalDebit) {
        formula = 'full';
      } else {
        formula = 'percentage';
        percentage = Number(((amount / totalDebit) * 100).toFixed(4));
      }
    } else if (amount > 0) {
      formula = 'fixed';
    }

    return {
      accountCode: l.accountCode.trim(),
      fallbackTitle: l.accountTitle?.trim() || 'حساب معین',
      side,
      formula,
      ...(formula === 'percentage' ? { percentage } : {}),
      ...(formula === 'fixed' ? { fixedAmount: amount } : {}),
      defaultDescription: l.description?.trim() || input.description.trim() || cleanName,
      requiresParty: Boolean(l.partyId || l.accountCode.startsWith('104') || l.accountCode.startsWith('301')),
      ...(l.costCenterId ? { defaultCostCenterId: l.costCenterId, applyCostCenter: true } : {}),
    };
  });

  const summaryCodes = Array.from(new Set(lineDefs.map((l) => l.accountCode))).slice(0, 4).join('، ');
  return {
    id: `usr_tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName.slice(0, 80),
    category: input.category || 'custom',
    voucherType: input.voucherType,
    descriptionTemplate: input.description.trim() || cleanName,
    hint: `الگوی شخصی · سرفصل‌ها: ${summaryCodes}`,
    isSystem: false,
    supportsQuickAmount: hasBalancedBase || lineDefs.every((l) => l.formula === 'full'),
    quickAmountLabel: 'مبلغ کل سند (ریال)',
    lines: lineDefs,
    createdAt: new Date().toISOString(),
  };
}

// ==================== OFFLINE-FIRST LOCAL STORAGE PERSISTENCE ====================

function isValidTemplate(obj: unknown): obj is VoucherTemplate {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    Array.isArray(t.lines) &&
    t.lines.length >= 2
  );
}

export function loadCustomVoucherTemplates(): VoucherTemplate[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(CUSTOM_TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTemplate).map((t) => ({ ...t, isSystem: false }));
  } catch {
    return [];
  }
}

export function saveCustomVoucherTemplates(templates: VoucherTemplate[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const onlyCustom = templates.filter((t) => !t.isSystem);
    localStorage.setItem(CUSTOM_TEMPLATES_STORAGE_KEY, JSON.stringify(onlyCustom));
  } catch {
    // Ignore quota errors cleanly in restricted browser modes
  }
}

export function addCustomVoucherTemplate(template: VoucherTemplate): VoucherTemplate[] {
  const existing = loadCustomVoucherTemplates().filter((t) => t.id !== template.id);
  const next = [{ ...template, isSystem: false }, ...existing];
  saveCustomVoucherTemplates(next);
  return next;
}

export function deleteCustomVoucherTemplate(templateId: string): VoucherTemplate[] {
  const next = loadCustomVoucherTemplates().filter((t) => t.id !== templateId);
  saveCustomVoucherTemplates(next);
  return next;
}

export function loadTemplateUsageMap(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(TEMPLATE_USAGE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        clean[k] = Math.floor(v);
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function incrementTemplateUsage(templateId: string): Record<string, number> {
  const map = loadTemplateUsageMap();
  map[templateId] = (map[templateId] || 0) + 1;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TEMPLATE_USAGE_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // ignore
  }
  return map;
}

/**
 * Smart contextual ranking: boosts templates matching the company's real posted
 * voucher accounts + explicit user usage frequency.
 */
export function suggestTemplatesFromHistory(
  vouchers: Voucher[],
  templates: VoucherTemplate[],
  usageMap: Record<string, number> = {},
  limit = 4
): VoucherTemplate[] {
  const accountFreq = new Map<string, number>();
  // Scan up to last 150 vouchers for fast O(N) inference
  const recent = vouchers.slice(-150);
  for (const v of recent) {
    for (const l of v.lines) {
      accountFreq.set(l.accountCode, (accountFreq.get(l.accountCode) || 0) + 1);
    }
  }

  const scored = templates.map((tpl) => {
    const manualScore = (usageMap[tpl.id] || 0) * 15;
    const customBoost = tpl.isSystem ? 0 : 6;
    let historyScore = 0;
    for (const line of tpl.lines) {
      historyScore += Math.min(8, accountFreq.get(line.accountCode) || 0);
    }
    return { tpl, score: manualScore + customBoost + historyScore };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.tpl);
}

export function filterVoucherTemplates(
  templates: VoucherTemplate[],
  query: string,
  category: VoucherTemplateCategory | 'all' | 'recommended',
  recommendedIds: Set<string>
): VoucherTemplate[] {
  const scoped = templates.filter((t) => {
    if (category === 'all') return true;
    if (category === 'recommended') return recommendedIds.has(t.id);
    if (category === 'custom') return !t.isSystem;
    return t.category === category;
  });

  if (!query.trim()) return scoped;

  return fuzzyFilterAndRank(scoped, query, (t) => [
    { text: t.name, weight: 1.5 },
    { text: t.hint, weight: 1.1 },
    { text: VOUCHER_TEMPLATE_CATEGORY_LABELS[t.category], weight: 1.0 },
    { text: t.lines.map((l) => `${l.accountCode} ${l.fallbackTitle}`).join(' '), weight: 1.2 },
  ]).map((r) => r.item);
}

export function templateRequiresParty(template: VoucherTemplate): boolean {
  return template.lines.some((l) => Boolean(l.requiresParty));
}

export function templateUsesCostCenter(template: VoucherTemplate): boolean {
  return template.lines.some((l) => Boolean(l.applyCostCenter));
}

export function formatTemplateAccountSummary(template: VoucherTemplate, accounts: Account[]): string {
  const debits = template.lines
    .filter((l) => l.side === 'debit')
    .map((l) => resolveLiveAccount(l.accountCode, l.fallbackTitle, accounts).code);
  const credits = template.lines
    .filter((l) => l.side === 'credit')
    .map((l) => resolveLiveAccount(l.accountCode, l.fallbackTitle, accounts).code);
  return `بدهکار ${debits.join(' + ')} ← بستانکار ${credits.join(' + ')}`;
}

export type CostCenterRef = CostCenter;
