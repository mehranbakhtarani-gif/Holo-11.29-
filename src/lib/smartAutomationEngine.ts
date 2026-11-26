import type {
  ActiveModule,
  Cheque,
  CurrencyUnit,
  ImportDossier,
  Invoice,
  Party,
  Product,
  TrialBalanceRow,
  Voucher,
} from '../types/accounting';
import type {
  PendingApprovalDocumentItem,
  PendingApprovalsSummary,
} from './pendingApprovalsSummary';
import { formatCompactMoney, formatMoney, toPersianDigits } from './format';
import { computeCashFlowLiquidityRadar, type CashFlowRadarReport } from './smartIntelligence';

/* ============================================================================
 * 1. PRE-APPROVAL RISK AUDIT ENGINE (ممیزی هوشمند پیش از تأیید)
 * ========================================================================== */

export type PreApprovalRiskLevel = 'safe' | 'warning' | 'critical';

export interface PreApprovalRiskFlag {
  code:
    | 'unbalanced_voucher'
    | 'duplicate_voucher'
    | 'credit_limit_exceeded'
    | 'below_cost_sale'
    | 'vat_mismatch'
    | 'high_value_review'
    | 'zero_amount_doc';
  severity: 'warning' | 'critical';
  message: string;
}

export interface PreApprovalRiskAudit {
  itemId: string;
  riskLevel: PreApprovalRiskLevel;
  score: number; // 0..100 (100 = completely clean)
  flags: PreApprovalRiskFlag[];
  eligibleForBatchAutoApprove: boolean;
}

export interface PreApprovalAuditContext {
  vouchers: Voucher[];
  invoices: Invoice[];
  parties: Party[];
  partyBalances: Map<string, number>;
  products: Product[];
  vatRate?: number; // Default 0.10 (Iran 10% VAT)
  highValueThresholdIrr?: number;
}

export function auditPendingApprovalItems(
  items: PendingApprovalDocumentItem[],
  ctx: PreApprovalAuditContext
): Map<string, PreApprovalRiskAudit> {
  const result = new Map<string, PreApprovalRiskAudit>();
  const vatRate = ctx.vatRate ?? 0.1;
  const highValueThreshold = ctx.highValueThresholdIrr ?? 5_000_000_000; // 500M Toman default review notice

  const voucherById = new Map(ctx.vouchers.map((v) => [v.id, v]));
  const invoiceById = new Map(ctx.invoices.map((inv) => [inv.id, inv]));
  const partyById = new Map(ctx.parties.map((p) => [p.id, p]));
  const productById = new Map(ctx.products.map((p) => [p.id, p]));

  // O(M) pre-index by rounded debit amount so duplicate detection is O(1) amortized at 25,000+ vouchers
  const vouchersByRoundedDebit = new Map<number, Voucher[]>();
  for (const v of ctx.vouchers) {
    const amt = Math.round(v.totalDebit || 0);
    if (amt <= 0) continue;
    let bucket = vouchersByRoundedDebit.get(amt);
    if (!bucket) {
      bucket = [];
      vouchersByRoundedDebit.set(amt, bucket);
    }
    bucket.push(v);
  }

  for (const item of items) {
    const flags: PreApprovalRiskFlag[] = [];

    if (item.docType === 'voucher') {
      const v = voucherById.get(item.id);
      if (v) {
        const diff = Math.abs((v.totalDebit || 0) - (v.totalCredit || 0));
        if (diff > 0.01) {
          flags.push({
            code: 'unbalanced_voucher',
            severity: 'critical',
            message: `اختلاف تراز بدهکار و بستانکار به مبلغ ${toPersianDigits(Math.round(diff).toLocaleString('en-US'))} ریال`,
          });
        }

        if ((v.totalDebit || 0) <= 0) {
          flags.push({
            code: 'zero_amount_doc',
            severity: 'warning',
            message: 'سند فاقد مبلغ گردش بدهکار است',
          });
        }

        // O(1) amortized duplicate voucher detection (same amount ±1 IRR + same date, or identical description + amount)
        const normalizedDesc = (v.description || '').trim();
        let duplicate: Voucher | undefined;
        const baseAmt = Math.round(v.totalDebit || 0);
        if (baseAmt > 0) {
          outer: for (let delta = -1; delta <= 1; delta++) {
            const bucket = vouchersByRoundedDebit.get(baseAmt + delta);
            if (!bucket) continue;
            for (const other of bucket) {
              if (
                other.id !== v.id &&
                Math.abs((other.totalDebit || 0) - (v.totalDebit || 0)) <= 1 &&
                (other.date === v.date ||
                  (normalizedDesc.length >= 8 && (other.description || '').trim() === normalizedDesc))
              ) {
                duplicate = other;
                break outer;
              }
            }
          }
        }
        if (duplicate) {
          flags.push({
            code: 'duplicate_voucher',
            severity: 'warning',
            message: `احتمال ثبت تکراری با سند #${toPersianDigits(duplicate.voucherNumber)} (${toPersianDigits(duplicate.date)})`,
          });
        }

        // Party credit limit check on receivable debit lines (10401 trade receivables & 103xx notes receivable)
        for (const line of v.lines) {
          if (
            line.partyId &&
            line.debit > 0 &&
            (line.accountCode.startsWith('104') || line.accountCode.startsWith('103'))
          ) {
            const party = partyById.get(line.partyId);
            if (party && party.creditLimit > 0) {
              const currentBalance = ctx.partyBalances.get(party.id) ?? party.openingBalance ?? 0;
              if (currentBalance + line.debit > party.creditLimit) {
                flags.push({
                  code: 'credit_limit_exceeded',
                  severity: 'critical',
                  message: `عبور از سقف اعتبار «${party.name}» پس از تأیید سند`,
                });
                break;
              }
            }
          }
        }
      }
    } else if (item.docType === 'invoice') {
      const inv = invoiceById.get(item.id);
      if (inv) {
        // 1. Party credit limit exceedance check
        const party = partyById.get(inv.partyId);
        if (party && party.creditLimit > 0) {
          const currentBalance = ctx.partyBalances.get(party.id) ?? party.openingBalance ?? 0;
          const unpaidAmount =
            inv.creditAmount > 0 ? inv.creditAmount : Math.max(0, inv.grandTotal - inv.paidCash - inv.paidBank);
          if (currentBalance + unpaidAmount > party.creditLimit) {
            flags.push({
              code: 'credit_limit_exceeded',
              severity: 'critical',
              message: `مانده + فاکتور از سقف اعتبار «${party.name}» بیشتر می‌شود`,
            });
          }
        }

        // 2. Selling below cost / negative margin check
        const belowCostItems: string[] = [];
        let expectedVat = 0;
        for (const row of inv.items) {
          const prod = productById.get(row.productId);
          const refCost = prod?.buyPrice ?? row.unitCostSnapshot ?? 0;
          const effectiveUnitSell =
            row.quantity > 0 ? (row.unitPrice * row.quantity - (row.discount || 0)) / row.quantity : row.unitPrice;
          if (refCost > 0 && effectiveUnitSell < refCost) {
            belowCostItems.push(row.productName);
          }
          if (!prod?.vatExempt) {
            const taxable = Math.max(0, Math.round(row.quantity * row.unitPrice - (row.discount || 0)));
            expectedVat += Math.round(taxable * vatRate);
          }
        }

        if (belowCostItems.length > 0) {
          flags.push({
            code: 'below_cost_sale',
            severity: 'critical',
            message: `فروش زیر قیمت خرید برای ${toPersianDigits(belowCostItems.length)} قلم (${belowCostItems[0]})`,
          });
        }

        // 3. VAT mismatch check (> 2% variance and > 50,000 IRR tolerance)
        const vatDiff = Math.abs((inv.vatAmount || 0) - expectedVat);
        if (expectedVat > 0 && vatDiff > Math.max(50_000, expectedVat * 0.02)) {
          flags.push({
            code: 'vat_mismatch',
            severity: 'warning',
            message: `اختلاف ارزش افزوده ثبت‌شده با نرخ ${toPersianDigits(Math.round(vatRate * 100))}٪ قانونی`,
          });
        }
      }
    }

    if (item.amountIrr >= highValueThreshold) {
      flags.push({
        code: 'high_value_review',
        severity: 'warning',
        message: 'مبلغ سند بالاتر از آستانه کنترل مدیریتی است',
      });
    }

    const criticalCount = flags.filter((f) => f.severity === 'critical').length;
    const warningCount = flags.filter((f) => f.severity === 'warning').length;
    const score = Math.max(0, 100 - criticalCount * 40 - warningCount * 15);
    const riskLevel: PreApprovalRiskLevel =
      criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'safe';

    const eligibleForBatchAutoApprove =
      item.docType === 'voucher' &&
      item.canQuickApprove &&
      riskLevel === 'safe' &&
      flags.length === 0;

    result.set(item.id, {
      itemId: item.id,
      riskLevel,
      score,
      flags,
      eligibleForBatchAutoApprove,
    });
  }

  return result;
}

/* ============================================================================
 * 2. SMART AUTOMATION RULES ENGINE (موتور قوانین هوشمند و اتوماسیون)
 * ========================================================================== */

export type SmartRuleKind =
  | 'low_stock_reorder'
  | 'cheque_bank_shortfall'
  | 'safe_draft_batch_approve'
  | 'over_credit_reminder';

export interface SmartAutomationRule {
  id: string;
  name: string;
  description: string;
  kind: SmartRuleKind;
  enabled: boolean;
  thresholdValue: number; // Days (cheque), IRR amount (draft/credit), or safety buffer % (stock)
  thresholdUnitLabel: string;
  isCustom?: boolean;
}

export interface SmartRuleTrigger {
  ruleId: string;
  ruleName: string;
  kind: SmartRuleKind;
  severity: 'info' | 'warning' | 'critical';
  headline: string;
  detail: string;
  actionLabel: string;
  payload?: {
    amountIrr?: number;
    fromAccountCode?: string;
    fromAccountTitle?: string;
    toAccountCode?: string;
    toAccountTitle?: string;
    safeDraftVoucherIds?: string[];
    partyId?: string;
    partyName?: string;
    reminderText?: string;
    productNames?: string[];
  };
  targetModule?: ActiveModule;
  targetIntent?: string;
}

export const SMART_RULES_STORAGE_KEY = 'holoo_apex_smart_rules_v1';

export const DEFAULT_SMART_RULES: SmartAutomationRule[] = [
  {
    id: 'rule_safe_draft_batch',
    name: 'آماده‌سازی تأیید گروهی اسناد موقت سالم',
    description:
      'اسناد موقت تراز و بدون خطای ممیزی با مبلغ کمتر از آستانه تعیین‌شده را برای دائم‌سازی یک‌کلیکه صف‌بندی می‌کند.',
    kind: 'safe_draft_batch_approve',
    enabled: true,
    thresholdValue: 3_000_000_000, // 300M Toman
    thresholdUnitLabel: 'ریال سقف هر سند',
  },
  {
    id: 'rule_cheque_bank_shortfall',
    name: 'پیشنهاد خودکار سند انتقال بین‌بانکی پیش از سررسید چک',
    description:
      'اگر چک‌های پرداختی نزدیک از موجودی بانک اصلی بیشتر باشد، پیش‌نویس سند انتقال وجه از حساب دارای مازاد آماده می‌کند.',
    kind: 'cheque_bank_shortfall',
    enabled: true,
    thresholdValue: 14, // 14 days lookahead
    thresholdUnitLabel: 'روز پیش از سررسید',
  },
  {
    id: 'rule_low_stock_po',
    name: 'هشدار و پیشنهاد سفارش خرید کالاهای زیر نقطه سفارش',
    description:
      'با افت موجودی کالا زیر نقطه سفارش (یا حاشیه ایمنی)، اقلام بحرانی و حجم پیشنهادی تأمین را محاسبه می‌کند.',
    kind: 'low_stock_reorder',
    enabled: true,
    thresholdValue: 10, // +10% safety buffer above reorderPoint
    thresholdUnitLabel: 'درصد حاشیه ایمنی',
  },
  {
    id: 'rule_over_credit_reminder',
    name: 'تولید خودکار پیام یادآوری پرداخت برای بدهکاران پرریسک',
    description:
      'برای مشتریانی که از سقف اعتبار عبور کرده یا مانده بدهی بالای آستانه دارند، پیام رسمی پیگیری آماده می‌کند.',
    kind: 'over_credit_reminder',
    enabled: true,
    thresholdValue: 1_500_000_000, // 150M Toman
    thresholdUnitLabel: 'ریال آستانه بدهی',
  },
];

export function loadSmartRules(): SmartAutomationRule[] {
  if (typeof window === 'undefined') return DEFAULT_SMART_RULES;
  try {
    const raw = window.localStorage.getItem(SMART_RULES_STORAGE_KEY);
    if (!raw) return DEFAULT_SMART_RULES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SMART_RULES;
    return parsed.filter(
      (r): r is SmartAutomationRule =>
        Boolean(r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.kind === 'string')
    );
  } catch {
    return DEFAULT_SMART_RULES;
  }
}

export function saveSmartRules(rules: SmartAutomationRule[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SMART_RULES_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // ignore quota errors
  }
}

export interface EvaluateSmartRulesInput {
  rules: SmartAutomationRule[];
  companyName: string;
  unit: CurrencyUnit;
  pendingItems: PendingApprovalDocumentItem[];
  riskAuditMap: Map<string, PreApprovalRiskAudit>;
  trialBalance: TrialBalanceRow[];
  cheques: Cheque[];
  products: Product[];
  parties: Party[];
  partyBalances: Map<string, number>;
}

export function evaluateSmartRules(input: EvaluateSmartRulesInput): SmartRuleTrigger[] {
  const triggers: SmartRuleTrigger[] = [];
  const { rules, unit } = input;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.kind === 'safe_draft_batch_approve') {
      const safeDraftIds = input.pendingItems
        .filter((item) => {
          const audit = input.riskAuditMap.get(item.id);
          return (
            audit?.eligibleForBatchAutoApprove &&
            item.amountIrr > 0 &&
            item.amountIrr <= Math.max(1, rule.thresholdValue)
          );
        })
        .map((item) => item.id);

      if (safeDraftIds.length > 0) {
        const totalIrr = input.pendingItems
          .filter((i) => safeDraftIds.includes(i.id))
          .reduce((s, i) => s + i.amountIrr, 0);
        triggers.push({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: rule.kind,
          severity: 'info',
          headline: `${toPersianDigits(safeDraftIds.length)} سند موقت بدون خطا آماده تأیید گروهی است`,
          detail: `ارزش کل: ${formatCompactMoney(totalIrr, unit)} · همه موارد تراز بوده و زیر سقف ${formatCompactMoney(rule.thresholdValue, unit)} هستند.`,
          actionLabel: `دائم‌سازی یکجا (${toPersianDigits(safeDraftIds.length)} سند)`,
          payload: { safeDraftVoucherIds: safeDraftIds, amountIrr: totalIrr },
        });
      }
    } else if (rule.kind === 'cheque_bank_shortfall') {
      const bankRows = input.trialBalance
        .filter((r) => r.accountCode.startsWith('102'))
        .map((r) => ({
          code: r.accountCode,
          title: r.accountTitle,
          balance: Math.max(0, r.balanceDebit - r.balanceCredit),
        }))
        .sort((a, b) => b.balance - a.balance);

      const cashRows = input.trialBalance
        .filter((r) => r.accountCode.startsWith('101'))
        .map((r) => ({
          code: r.accountCode,
          title: r.accountTitle,
          balance: Math.max(0, r.balanceDebit - r.balanceCredit),
        }))
        .sort((a, b) => b.balance - a.balance);

      const activePayables = input.cheques.filter(
        (c) => c.direction === 'payable' && (c.status === 'in_box' || c.status === 'deposited')
      );
      const totalPayableIrr = activePayables.reduce((s, c) => s + (c.amount || 0), 0);
      const primaryBank = bankRows[bankRows.length - 1] ?? bankRows[0];
      const surplusAccount = bankRows[0] && bankRows[0].code !== primaryBank?.code ? bankRows[0] : cashRows[0];

      if (totalPayableIrr > 0 && primaryBank && totalPayableIrr > primaryBank.balance) {
        const shortfall = Math.round(totalPayableIrr - primaryBank.balance);
        const suggestedTransfer =
          surplusAccount && surplusAccount.balance > 0
            ? Math.min(shortfall, Math.round(surplusAccount.balance * 0.8))
            : shortfall;
        triggers.push({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: rule.kind,
          severity: 'critical',
          headline: `کسری پوشش چک‌های پرداختی نسبت به ${primaryBank.title}`,
          detail: `مجموع ${toPersianDigits(activePayables.length)} چک پرداختی در جریان (${formatCompactMoney(totalPayableIrr, unit)}) از مانده فعلی حساب بیشتر است. پیشنهاد: ثبت سند موقت انتقال وجه به مبلغ ${formatCompactMoney(suggestedTransfer, unit)}.`,
          actionLabel: 'ایجاد پیش‌نویس سند انتقال وجه',
          payload: {
            amountIrr: suggestedTransfer,
            fromAccountCode: surplusAccount?.code ?? '10101',
            fromAccountTitle: surplusAccount?.title ?? 'صندوق مرکزی ریالی',
            toAccountCode: primaryBank.code,
            toAccountTitle: primaryBank.title,
          },
          targetModule: 'treasury',
          targetIntent: 'cheques',
        });
      }
    } else if (rule.kind === 'low_stock_reorder') {
      const bufferFactor = 1 + Math.max(0, rule.thresholdValue) / 100;
      const criticalProducts = input.products.filter(
        (p) => p.reorderPoint > 0 && p.stock <= p.reorderPoint * bufferFactor
      );
      if (criticalProducts.length > 0) {
        const suggestedCostIrr = criticalProducts.reduce((sum, p) => {
          const orderQty = Math.max(1, Math.ceil(p.reorderPoint * 1.5 - p.stock));
          return sum + Math.round(orderQty * (p.buyPrice || 0));
        }, 0);
        triggers.push({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: rule.kind,
          severity: criticalProducts.some((p) => p.stock <= p.reorderPoint) ? 'warning' : 'info',
          headline: `${toPersianDigits(criticalProducts.length)} قلم کالا در آستانه سفارش مجدد است`,
          detail: `اقلام اولویت‌دار: ${criticalProducts.slice(0, 2).map((p) => p.name).join('، ')}${criticalProducts.length > 2 ? ' و ...' : ''} · برآورد تأمین: ${formatCompactMoney(suggestedCostIrr, unit)}`,
          actionLabel: 'ثبت فاکتور خرید / سفارش تأمین',
          payload: {
            amountIrr: suggestedCostIrr,
            productNames: criticalProducts.slice(0, 5).map((p) => p.name),
          },
          targetModule: 'invoices',
          targetIntent: 'new-purchase',
        });
      }
    } else if (rule.kind === 'over_credit_reminder') {
      const reminders = buildDebtorReminderMessages({
        parties: input.parties,
        partyBalances: input.partyBalances,
        companyName: input.companyName,
        unit,
        minDebtIrr: Math.max(1, rule.thresholdValue),
        limit: 3,
      });
      if (reminders.length > 0) {
        const top = reminders[0];
        triggers.push({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: rule.kind,
          severity: top.overCreditLimit ? 'critical' : 'warning',
          headline: `${toPersianDigits(reminders.length)} مشتری دارای بدهی اولویت‌دار پیگیری هستند`,
          detail: `بیشترین مانده: «${top.partyName}» به مبلغ ${formatCompactMoney(top.balanceIrr, unit)}${top.overCreditLimit ? ' (عبور از سقف اعتبار)' : ''}.`,
          actionLabel: `کپی پیام یادآوری «${top.partyName}»`,
          payload: {
            partyId: top.partyId,
            partyName: top.partyName,
            amountIrr: top.balanceIrr,
            reminderText: top.messageText,
          },
          targetModule: 'parties',
        });
      }
    }
  }

  return triggers;
}

/* ============================================================================
 * 3. DEBTOR REMINDER MESSAGE BUILDER (تولید متن یادآوری پرداخت بدهکاران)
 * ========================================================================== */

export interface DebtorReminderItem {
  partyId: string;
  partyName: string;
  phone?: string;
  balanceIrr: number;
  creditLimitIrr: number;
  overCreditLimit: boolean;
  messageText: string;
}

export function buildDebtorReminderMessages(params: {
  parties: Party[];
  partyBalances: Map<string, number>;
  companyName: string;
  unit: CurrencyUnit;
  minDebtIrr?: number;
  limit?: number;
}): DebtorReminderItem[] {
  const minDebt = params.minDebtIrr ?? 1;
  const limit = params.limit ?? 3;

  const ranked = params.parties
    .filter((p) => p.partyType === 'customer' || p.partyType === 'both')
    .map((party) => {
      const balanceIrr = Math.round(params.partyBalances.get(party.id) ?? party.openingBalance ?? 0);
      const overCreditLimit = party.creditLimit > 0 && balanceIrr > party.creditLimit;
      return { party, balanceIrr, overCreditLimit };
    })
    .filter((row) => row.balanceIrr >= minDebt || row.overCreditLimit)
    .sort((a, b) => {
      if (a.overCreditLimit !== b.overCreditLimit) return a.overCreditLimit ? -1 : 1;
      return b.balanceIrr - a.balanceIrr;
    })
    .slice(0, limit);

  return ranked.map(({ party, balanceIrr, overCreditLimit }) => {
    const formattedAmount = formatMoney(balanceIrr, params.unit);
    const creditLine = overCreditLimit
      ? `\nبا توجه به عبور مانده حساب از سقف اعتبار توافق‌شده (${formatMoney(party.creditLimit, params.unit)})، لطفاً جهت جلوگیری از توقف ارسال سفارش‌های جدید اقدام فرمایید.`
      : '';
    const messageText = `با سلام و احترام خدمت مدیریت محترم «${party.name}»،\nبه استحضار می‌رساند مانده بدهی جاری جنابعالی در دفاتر «${params.companyName}» مبلغ ${formattedAmount} می‌باشد.${creditLine}\nخواهشمند است نسبت به تسویه یا اعلام زمان واریز اقدام و فیش واریزی را ارسال فرمایید.\nبا سپاس — واحد مالی ${params.companyName}`;

    return {
      partyId: party.id,
      partyName: party.name,
      phone: party.phone,
      balanceIrr,
      creditLimitIrr: party.creditLimit,
      overCreditLimit,
      messageText,
    };
  });
}

/* ============================================================================
 * 4. EXECUTIVE SMART BRIEFING (خلاصه اجرایی روزانه — ۳ اولویت فوری امروز)
 * ========================================================================== */

export interface ExecutiveBriefingPriority {
  id: string;
  category: 'liquidity' | 'approvals' | 'credit' | 'inventory';
  severity: 'ok' | 'warning' | 'critical';
  title: string;
  metricText: string;
  summary: string;
  actionLabel: string;
  actionTarget:
    | { type: 'navigate'; module: ActiveModule; intent?: string; subKey?: string }
    | { type: 'open_intelligence' }
    | { type: 'open_vision_scanner' };
}

export function computeExecutiveBriefing(params: {
  liquidity: number;
  liquidityRadar: CashFlowRadarReport;
  pendingSummary: PendingApprovalsSummary;
  riskAuditMap: Map<string, PreApprovalRiskAudit>;
  parties: Party[];
  partyBalances: Map<string, number>;
  products: Product[];
  unit: CurrencyUnit;
}): ExecutiveBriefingPriority[] {
  const priorities: ExecutiveBriefingPriority[] = [];
  const { unit } = params;

  // Priority 1: Liquidity / 30-Day Cheque Radar
  if (params.liquidityRadar.earliestDeficitDate) {
    priorities.push({
      id: 'briefing_liquidity_deficit',
      category: 'liquidity',
      severity: 'critical',
      title: 'ریسک شکاف نقدینگی چک‌ها',
      metricText: formatCompactMoney(params.liquidityRadar.earliestDeficitAmount, unit),
      summary: `در تاریخ ${toPersianDigits(params.liquidityRadar.earliestDeficitDate)} نقدینگی با کسری مواجه می‌شود. در شبیه‌ساز سناریوی پوشش را بررسی کنید.`,
      actionLabel: 'شبیه‌ساز نقدینگی',
      actionTarget: { type: 'open_intelligence' },
    });
  } else {
    priorities.push({
      id: 'briefing_liquidity_ok',
      category: 'liquidity',
      severity: params.liquidityRadar.riskLevel === 'watch' ? 'warning' : 'ok',
      title: 'چشم‌انداز نقدینگی ۳۰ روزه',
      metricText: formatCompactMoney(params.liquidityRadar.horizons[2].projectedBalance, unit),
      summary:
        params.liquidityRadar.riskLevel === 'watch'
          ? 'چک‌های پرداختی نزدیک نیازمند پایش وصول مطالبات هستند.'
          : 'موجودی نقد و بانک پاسخگوی چک‌های ۳۰ روز آینده است.',
      actionLabel: 'رادار و شبیه‌ساز',
      actionTarget: { type: 'open_intelligence' },
    });
  }

  // Priority 2: Risky or Pending Approvals
  let criticalRiskDocs = 0;
  let safeBatchDrafts = 0;
  params.riskAuditMap.forEach((audit) => {
    if (audit.riskLevel === 'critical') criticalRiskDocs += 1;
    if (audit.eligibleForBatchAutoApprove) safeBatchDrafts += 1;
  });

  if (criticalRiskDocs > 0) {
    priorities.push({
      id: 'briefing_risky_approvals',
      category: 'approvals',
      severity: 'critical',
      title: 'اسناد دارای هشدار ممیزی',
      metricText: `${toPersianDigits(criticalRiskDocs)} سند پرریسک`,
      summary: `از ${toPersianDigits(params.pendingSummary.totalPendingCount)} سند کارتابل، ${toPersianDigits(criticalRiskDocs)} مورد دارای هشدار سقف اعتبار، فروش زیر قیمت یا عدم تراز است.`,
      actionLabel: 'بررسی کارتابل',
      actionTarget: { type: 'navigate', module: 'vouchers', intent: 'cartable', subKey: 'voucher-cartable' },
    });
  } else if (safeBatchDrafts > 0) {
    priorities.push({
      id: 'briefing_safe_drafts',
      category: 'approvals',
      severity: 'warning',
      title: 'اسناد سالم آماده تأیید یکجا',
      metricText: `${toPersianDigits(safeBatchDrafts)} سند سالم`,
      summary: `تمامی کنترل‌های ممیزی برای ${toPersianDigits(safeBatchDrafts)} سند موقت بدون خطا عبور کرده و آماده دائم‌سازی هستند.`,
      actionLabel: 'اسکن یا ثبت سند',
      actionTarget: { type: 'open_vision_scanner' },
    });
  } else {
    priorities.push({
      id: 'briefing_approvals_clean',
      category: 'approvals',
      severity: 'ok',
      title: 'سلامت کارتابل تأیید',
      metricText: `${toPersianDigits(params.pendingSummary.voucherApprovalRatePct)}٪ قطعی`,
      summary: 'هیچ سند پرریسک یا نامتوازنی در صف تأیید مشاهده نشد.',
      actionLabel: 'اسکن سند جدید (OCR)',
      actionTarget: { type: 'open_vision_scanner' },
    });
  }

  // Priority 3: Over-credit Debtors OR Low-stock Inventory
  const overCreditParties = params.parties.filter((p) => {
    if (p.creditLimit <= 0) return false;
    const bal = params.partyBalances.get(p.id) ?? p.openingBalance ?? 0;
    return bal > p.creditLimit;
  });
  const lowStockProducts = params.products.filter((p) => p.reorderPoint > 0 && p.stock <= p.reorderPoint);

  if (overCreditParties.length > 0) {
    const topParty = overCreditParties[0];
    const topBal = params.partyBalances.get(topParty.id) ?? topParty.openingBalance ?? 0;
    priorities.push({
      id: 'briefing_over_credit',
      category: 'credit',
      severity: 'critical',
      title: 'عبور مشتری از سقف اعتبار',
      metricText: `${toPersianDigits(overCreditParties.length)} مشتری`,
      summary: `«${topParty.name}» با مانده ${formatCompactMoney(topBal, unit)} از سقف اعتبار عبور کرده است.`,
      actionLabel: 'قوانین و یادآوری',
      actionTarget: { type: 'open_intelligence' },
    });
  } else if (lowStockProducts.length > 0) {
    priorities.push({
      id: 'briefing_low_stock',
      category: 'inventory',
      severity: 'warning',
      title: 'هشدار موجودی انبار',
      metricText: `${toPersianDigits(lowStockProducts.length)} قلم کالا`,
      summary: `کالاهایی مانند «${lowStockProducts[0].name}» به نقطه سفارش مجدد رسیده‌اند.`,
      actionLabel: 'مدیریت انبار',
      actionTarget: { type: 'navigate', module: 'inventory', intent: 'kardex', subKey: 'inv-kardex' },
    });
  } else {
    priorities.push({
      id: 'briefing_ops_healthy',
      category: 'inventory',
      severity: 'ok',
      title: 'توازن انبار و اعتبار مشتریان',
      metricText: `${toPersianDigits(params.products.length)} قلم فعال`,
      summary: 'موجودی کالاها و سقف اعتبار طرف‌حساب‌ها در محدوده ایمن قرار دارد.',
      actionLabel: 'تنظیم قوانین هوشمند',
      actionTarget: { type: 'open_intelligence' },
    });
  }

  return priorities.slice(0, 3);
}

/* ============================================================================
 * 5. "WHAT-IF" FINANCIAL SIMULATOR (شبیه‌ساز هوشمند «چه می‌شود اگر؟»)
 * ========================================================================== */

export interface WhatIfScenarioInput {
  fxChangePct: number; // -30 to +60 (%)
  chequeDelayDays: number; // 0 to 45 days delay on receivable cheques
  salesVolumeChangePct: number; // -40 to +60 (%)
  marginShiftPct: number; // -15 to +15 percentage points on gross margin
}

export interface WhatIfSimulationResult {
  baselineLiquidity30d: number;
  simulatedLiquidity30d: number;
  liquidityDeltaIrr: number;

  baselineImportCostIrr: number;
  simulatedImportCostIrr: number;
  importCostDeltaIrr: number;

  baselineNetSalesIrr: number;
  simulatedNetSalesIrr: number;

  baselineNetProfitIrr: number;
  simulatedNetProfitIrr: number;
  netProfitDeltaIrr: number;

  baselineNetMarginPct: number;
  simulatedNetMarginPct: number;

  delayedReceivablesIrr: number;
  riskStatus: 'safe' | 'watch' | 'critical';
  riskLabel: string;
  headlineInsight: string;
}

export function runWhatIfSimulation(params: {
  scenario: WhatIfScenarioInput;
  currentLiquidity: number;
  cheques: Cheque[];
  importDossiers: ImportDossier[];
  netSales: number;
  grossProfit: number;
  netProfit: number;
}): WhatIfSimulationResult {
  const { scenario } = params;
  const baseRadar = computeCashFlowLiquidityRadar({
    currentLiquidity: params.currentLiquidity,
    cheques: params.cheques,
  });

  const baselineLiquidity30d = baseRadar.horizons[2].projectedBalance;
  const receivables30d = baseRadar.horizons[2].receivableInflow;

  // Portion of 30-day receivable inflows pushed beyond the 30-day window due to delay days
  const delayRatio = Math.min(1, Math.max(0, scenario.chequeDelayDays / 30));
  const delayedReceivablesIrr = Math.round(receivables30d * delayRatio);

  // FX sensitivity on open foreign-currency import dossiers
  const openImports = params.importDossiers.filter((d) => d.status !== 'cleared');
  const baselineImportCostIrr = openImports.reduce((sum, d) => sum + (d.grandTotalLandedIrr || 0), 0);
  const fxSensitiveBaseIrr = openImports.reduce((sum, d) => sum + (d.totalFobIrr || d.grandTotalLandedIrr || 0), 0);
  const importCostDeltaIrr = Math.round(fxSensitiveBaseIrr * (scenario.fxChangePct / 100));
  const simulatedImportCostIrr = Math.max(0, baselineImportCostIrr + importCostDeltaIrr);

  // Sales volume & margin sensitivity
  const baselineNetSalesIrr = Math.max(0, params.netSales);
  const simulatedNetSalesIrr = Math.max(
    0,
    Math.round(baselineNetSalesIrr * (1 + scenario.salesVolumeChangePct / 100))
  );

  const baseGrossMarginRatio =
    baselineNetSalesIrr > 0 ? params.grossProfit / baselineNetSalesIrr : 0.2;
  const simulatedGrossMarginRatio = Math.max(
    -0.5,
    Math.min(0.95, baseGrossMarginRatio + scenario.marginShiftPct / 100)
  );

  const fixedOperatingExpensesIrr = Math.max(0, params.grossProfit - params.netProfit);
  const simulatedGrossProfitIrr = Math.round(simulatedNetSalesIrr * simulatedGrossMarginRatio);
  // 35% of open import FX shock impacts near-term COGS/profit if unhedged
  const fxProfitHitIrr = Math.round(importCostDeltaIrr * 0.35);
  const simulatedNetProfitIrr = simulatedGrossProfitIrr - fixedOperatingExpensesIrr - fxProfitHitIrr;
  const netProfitDeltaIrr = simulatedNetProfitIrr - params.netProfit;

  const baselineNetMarginPct =
    baselineNetSalesIrr > 0 ? Math.round((params.netProfit / baselineNetSalesIrr) * 1000) / 10 : 0;
  const simulatedNetMarginPct =
    simulatedNetSalesIrr > 0
      ? Math.round((simulatedNetProfitIrr / simulatedNetSalesIrr) * 1000) / 10
      : 0;

  // Cash flow impact: delayed receivables + 50% of near-term import FX cash outlay + 25% of sales cash delta
  const salesCashDeltaIrr = Math.round((simulatedNetSalesIrr - baselineNetSalesIrr) * 0.25);
  const fxCashImpactIrr = Math.round(importCostDeltaIrr * 0.5);
  const simulatedLiquidity30d =
    baselineLiquidity30d - delayedReceivablesIrr - fxCashImpactIrr + salesCashDeltaIrr;
  const liquidityDeltaIrr = simulatedLiquidity30d - baselineLiquidity30d;

  const riskStatus: 'safe' | 'watch' | 'critical' =
    simulatedLiquidity30d < 0 || simulatedNetProfitIrr < 0
      ? 'critical'
      : simulatedLiquidity30d < Math.max(100_000_000, params.currentLiquidity * 0.25)
        ? 'watch'
        : 'safe';

  const riskLabel =
    riskStatus === 'critical'
      ? 'هشدار کسری / زیان'
      : riskStatus === 'watch'
        ? 'نیاز به پایش نقدینگی'
        : 'حاشیه ایمنی مطلوب';

  const headlineInsight =
    riskStatus === 'critical'
      ? 'در این سناریو نقدینگی ۳۰ روزه یا سود خالص وارد محدوده منفی می‌شود؛ تسریع وصول چک‌ها یا تعدیل قیمت فروش توصیه می‌شود.'
      : riskStatus === 'watch'
        ? 'نقدینگی شرکت مثبت می‌ماند اما حاشیه ایمنی کاهش می‌یابد؛ نگهداری ذخیره ریالی پیش از سررسید چک‌ها پیشنهاد می‌شود.'
        : 'ساختار مالی شرکت در برابر این سناریو تاب‌آوری کامل دارد و جریان نقدینگی در محدوده ایمن است.';

  return {
    baselineLiquidity30d,
    simulatedLiquidity30d,
    liquidityDeltaIrr,
    baselineImportCostIrr,
    simulatedImportCostIrr,
    importCostDeltaIrr,
    baselineNetSalesIrr,
    simulatedNetSalesIrr,
    baselineNetProfitIrr: params.netProfit,
    simulatedNetProfitIrr,
    netProfitDeltaIrr,
    baselineNetMarginPct,
    simulatedNetMarginPct,
    delayedReceivablesIrr,
    riskStatus,
    riskLabel,
    headlineInsight,
  };
}
