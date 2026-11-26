import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
} from '../src/lib/accountingEngine';
import {
  buildPendingApprovalItems,
  computePendingApprovalsSummary,
} from '../src/lib/pendingApprovalsSummary';
import { computeCashFlowLiquidityRadar } from '../src/lib/smartIntelligence';
import {
  auditPendingApprovalItems,
  buildDebtorReminderMessages,
  computeExecutiveBriefing,
  DEFAULT_SMART_RULES,
  evaluateSmartRules,
  runWhatIfSimulation,
} from '../src/lib/smartAutomationEngine';
import type { Invoice, Voucher } from '../src/types/accounting';

const seed = createHolooSeedData('test-owner');
const trialBalance = computeTrialBalance(seed.accounts, seed.vouchers);
const partyBalances = computePartyBalances(seed.parties, seed.vouchers);
const incomeStatement = computeIncomeStatement(trialBalance);
const liquidity = trialBalance
  .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
  .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0);

// 1. Test Pre-Approval Risk Audit Engine (safe draft, duplicate, unbalanced, below-cost & credit limit)
const cleanDraftVoucher: Voucher = {
  id: 'v-draft-safe',
  ownerId: 'test-owner',
  voucherNumber: 901,
  date: '1405/01/20',
  description: 'ثبت هزینه حمل داخلی تاییدشده',
  voucherType: 'general',
  status: 'draft',
  totalDebit: 42_000_000,
  totalCredit: 42_000_000,
  lines: [
    { accountCode: '60101', accountTitle: 'هزینه حمل', description: 'حمل', debit: 42_000_000, credit: 0 },
    { accountCode: '10201', accountTitle: 'بانک ملت', description: 'پرداخت', debit: 0, credit: 42_000_000 },
  ],
};

const duplicateDraftVoucher: Voucher = {
  ...cleanDraftVoucher,
  id: 'v-draft-dup',
  voucherNumber: 902,
};

const unbalancedDraftVoucher: Voucher = {
  id: 'v-draft-unbal',
  ownerId: 'test-owner',
  voucherNumber: 903,
  date: '1405/01/21',
  description: 'سند نامتوازن آزمایشی',
  voucherType: 'general',
  status: 'draft',
  totalDebit: 50_000_000,
  totalCredit: 45_000_000,
  lines: [
    { accountCode: '60101', accountTitle: 'هزینه', description: 'تست', debit: 50_000_000, credit: 0 },
    { accountCode: '10201', accountTitle: 'بانک', description: 'تست', debit: 0, credit: 45_000_000 },
  ],
};

const sampleParty = seed.parties.find((p) => p.partyType === 'customer' || p.partyType === 'both') || seed.parties[0];
const sampleProduct = seed.products[0];

const riskyProforma: Invoice = {
  id: 'inv-proforma-risky',
  ownerId: 'test-owner',
  invoiceNumber: 'PF-RISK-1',
  invoiceType: 'proforma',
  date: '1405/01/22',
  partyId: sampleParty.id,
  partyName: sampleParty.name,
  warehouse: sampleProduct.warehouse,
  subtotal: Math.round(sampleProduct.buyPrice * 0.5 * 10),
  discount: 0,
  vatAmount: 0, // intentionally missing VAT
  grandTotal: Math.max(sampleParty.creditLimit + 500_000_000, Math.round(sampleProduct.buyPrice * 0.5 * 10)),
  paidCash: 0,
  paidBank: 0,
  paidCheque: 0,
  creditAmount: Math.max(sampleParty.creditLimit + 500_000_000, Math.round(sampleProduct.buyPrice * 0.5 * 10)),
  status: 'issued',
  items: [
    {
      productId: sampleProduct.id,
      sku: sampleProduct.sku,
      productName: sampleProduct.name,
      unit: sampleProduct.unit,
      quantity: 10,
      unitPrice: Math.round(sampleProduct.buyPrice * 0.5), // Below cost!
      discount: 0,
      vatAmount: 0,
      lineTotal: Math.round(sampleProduct.buyPrice * 0.5 * 10),
    },
  ],
};

const uniqueSafeDraft: Voucher = {
  id: 'v-draft-unique-clean',
  ownerId: 'test-owner',
  voucherNumber: 904,
  date: '1405/01/25',
  description: 'ثبت هزینه قبض برق کارگاه مرکزی فروردین',
  voucherType: 'general',
  status: 'draft',
  totalDebit: 19_500_000,
  totalCredit: 19_500_000,
  lines: [
    { accountCode: '60101', accountTitle: 'هزینه آب و برق', description: 'قبض برق', debit: 19_500_000, credit: 0 },
    { accountCode: '10201', accountTitle: 'بانک ملت', description: 'پرداخت', debit: 0, credit: 19_500_000 },
  ],
};

const testVouchers = [...seed.vouchers, cleanDraftVoucher, duplicateDraftVoucher, unbalancedDraftVoucher, uniqueSafeDraft];
const testInvoices = [...seed.invoices, riskyProforma];

const summary = computePendingApprovalsSummary({
  vouchers: testVouchers,
  invoices: testInvoices,
  reservedInvoices: [],
  importDossiers: seed.importDossiers,
  salesOrders: seed.salesOrders,
  subcontractJobs: seed.subcontractJobs,
  warehouseSlips: [],
  pettyCashItems: [],
});
const pendingItems = buildPendingApprovalItems(summary);

const auditMap = auditPendingApprovalItems(pendingItems, {
  vouchers: testVouchers,
  invoices: testInvoices,
  parties: seed.parties,
  partyBalances,
  products: seed.products,
});

const uniqueSafeAudit = auditMap.get('v-draft-unique-clean');
assert.ok(uniqueSafeAudit, 'Expected audit result for unique clean draft');
assert.equal(uniqueSafeAudit.riskLevel, 'safe');
assert.equal(uniqueSafeAudit.eligibleForBatchAutoApprove, true);
assert.equal(uniqueSafeAudit.flags.length, 0);

const dupAudit = auditMap.get('v-draft-dup');
assert.ok(dupAudit, 'Expected audit result for duplicate draft');
assert.ok(dupAudit.flags.some((f) => f.code === 'duplicate_voucher'), 'Should detect duplicate voucher');
assert.equal(dupAudit.eligibleForBatchAutoApprove, false);

const unbalAudit = auditMap.get('v-draft-unbal');
assert.ok(unbalAudit, 'Expected audit result for unbalanced draft');
assert.equal(unbalAudit.riskLevel, 'critical');
assert.ok(unbalAudit.flags.some((f) => f.code === 'unbalanced_voucher'));
assert.equal(unbalAudit.eligibleForBatchAutoApprove, false);

const riskyInvAudit = auditMap.get('inv-proforma-risky');
assert.ok(riskyInvAudit, 'Expected audit result for risky proforma');
assert.equal(riskyInvAudit.riskLevel, 'critical');
assert.ok(riskyInvAudit.flags.some((f) => f.code === 'below_cost_sale'), 'Should detect below-cost sale');
if (sampleParty.creditLimit > 0) {
  assert.ok(
    riskyInvAudit.flags.some((f) => f.code === 'credit_limit_exceeded'),
    'Should detect credit limit exceedance'
  );
}
if (!sampleProduct.vatExempt) {
  assert.ok(riskyInvAudit.flags.some((f) => f.code === 'vat_mismatch'), 'Should detect VAT mismatch');
}

// 2. Test Smart Automation Rules Engine
const triggers = evaluateSmartRules({
  rules: DEFAULT_SMART_RULES,
  companyName: 'شرکت آزمایشی هلو Apex',
  unit: 'IRT',
  pendingItems,
  riskAuditMap: auditMap,
  trialBalance,
  cheques: seed.cheques,
  products: seed.products,
  parties: seed.parties,
  partyBalances,
});
assert.ok(
  triggers.some((t) => t.kind === 'safe_draft_batch_approve' && t.payload?.safeDraftVoucherIds?.includes('v-draft-unique-clean')),
  'Rules engine should flag unique clean draft for 1-click batch approval'
);

// 3. Test Debtor Reminder Messages
const reminders = buildDebtorReminderMessages({
  parties: seed.parties,
  partyBalances,
  companyName: 'شرکت آزمایشی هلو Apex',
  unit: 'IRT',
  limit: 3,
});
assert.ok(reminders.length <= 3, 'Should respect limit=3');
for (const rem of reminders) {
  assert.ok(rem.messageText.includes(rem.partyName), 'Reminder should include party name');
  assert.ok(rem.messageText.includes('شرکت آزمایشی هلو Apex'), 'Reminder should include company name');
}

// 4. Test Executive Smart Briefing (always returns exactly 3 prioritized items)
const radar = computeCashFlowLiquidityRadar({ currentLiquidity: liquidity, cheques: seed.cheques });
const briefing = computeExecutiveBriefing({
  liquidity,
  liquidityRadar: radar,
  pendingSummary: summary,
  riskAuditMap: auditMap,
  parties: seed.parties,
  partyBalances,
  products: seed.products,
  unit: 'IRT',
});
assert.equal(briefing.length, 3, 'Executive briefing should return top 3 actionable priorities');

// 5. Test What-If Financial Simulator
const baseSim = runWhatIfSimulation({
  scenario: { fxChangePct: 0, chequeDelayDays: 0, salesVolumeChangePct: 0, marginShiftPct: 0 },
  currentLiquidity: liquidity,
  cheques: seed.cheques,
  importDossiers: seed.importDossiers,
  netSales: incomeStatement.netSales,
  grossProfit: incomeStatement.grossProfit,
  netProfit: incomeStatement.netProfit,
});
assert.equal(baseSim.liquidityDeltaIrr, 0, 'Baseline scenario must have zero liquidity delta');
assert.equal(baseSim.importCostDeltaIrr, 0, 'Baseline scenario must have zero import FX delta');

const stressSim = runWhatIfSimulation({
  scenario: { fxChangePct: 30, chequeDelayDays: 30, salesVolumeChangePct: -20, marginShiftPct: -5 },
  currentLiquidity: liquidity,
  cheques: seed.cheques,
  importDossiers: seed.importDossiers,
  netSales: incomeStatement.netSales,
  grossProfit: incomeStatement.grossProfit,
  netProfit: incomeStatement.netProfit,
});
assert.ok(
  stressSim.simulatedLiquidity30d <= baseSim.simulatedLiquidity30d,
  'Stress scenario (FX up + cheque delay + sales drop) must reduce or hold simulated liquidity'
);
assert.ok(
  stressSim.simulatedNetProfitIrr <= baseSim.simulatedNetProfitIrr,
  'Stress scenario must reduce or hold simulated net profit'
);

console.log('✅ All 5 Smart Intelligence Engine unit tests passed successfully.');
