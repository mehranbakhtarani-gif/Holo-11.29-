import assert from 'node:assert/strict';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  SYSTEM_VOUCHER_TEMPLATES,
  addCustomVoucherTemplate,
  applyVoucherTemplate,
  createCustomTemplateFromLines,
  deleteCustomVoucherTemplate,
  duplicateTemplateAsCustom,
  filterVoucherTemplates,
  formatTemplateAccountSummary,
  incrementTemplateUsage,
  loadCustomVoucherTemplates,
  loadTemplateUsageMap,
  suggestTemplatesFromHistory,
  upsertCustomVoucherTemplate,
} from '../src/lib/voucherTemplates';

// Lightweight in-memory localStorage mock for Node test execution
function installMockLocalStorage() {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = mockStorage;
  return store;
}

async function runTests() {
  const storageMap = installMockLocalStorage();
  const seed = createHolooSeedData('test_owner');
  const accountCodes = new Set(seed.accounts.map((a) => a.code));

  // 1. All 12 built-in templates reference valid Holoo accounts and stay 100% balanced across odd amounts
  assert.ok(SYSTEM_VOUCHER_TEMPLATES.length >= 12, 'Expected at least 12 built-in voucher templates');
  const testAmounts = [1_000_000, 123_456_789, 50_000_000, 7_777_777];

  for (const tpl of SYSTEM_VOUCHER_TEMPLATES) {
    for (const def of tpl.lines) {
      assert.ok(
        accountCodes.has(def.accountCode),
        `Template ${tpl.id} references unknown seed account code ${def.accountCode}`
      );
    }

    for (const amount of testAmounts) {
      const applied = applyVoucherTemplate(tpl, {
        accounts: seed.accounts,
        baseAmountIrr: amount,
        date: '1405/03/15',
        party: seed.parties[0],
        costCenterId: seed.costCenters[0].id,
      });

      assert.equal(applied.isBalanced, true, `Template ${tpl.id} must be balanced for amount ${amount}`);
      assert.equal(
        applied.totalDebit,
        applied.totalCredit,
        `Template ${tpl.id} has balance drift (${applied.totalDebit} vs ${applied.totalCredit}) for amount ${amount}`
      );
      assert.ok(applied.totalDebit > 0, `Template ${tpl.id} must produce positive totalDebit`);
      assert.ok(applied.lines.length >= 2, `Template ${tpl.id} must have >= 2 lines`);
    }
  }
  console.log('✓ 1. All 12 built-in accounting templates resolve live accounts and achieve exact 0-Rial double-entry balance');

  // 2. Sales 10% VAT exact calculation & party/month interpolation
  const salesVatTpl = SYSTEM_VOUCHER_TEMPLATES.find((t) => t.id === 'sys_sales_credit_vat10')!;
  const salesApplied = applyVoucherTemplate(salesVatTpl, {
    accounts: seed.accounts,
    baseAmountIrr: 100_000_000,
    date: '1405/04/20',
    party: seed.parties[0],
    costCenterId: seed.costCenters[1].id,
  });
  assert.equal(salesApplied.lines.length, 3);
  assert.equal(salesApplied.lines[0].accountCode, '10401');
  assert.equal(salesApplied.lines[0].debit, 110_000_000);
  assert.equal(salesApplied.lines[0].partyId, seed.parties[0].id);
  assert.equal(salesApplied.lines[1].accountCode, '60101');
  assert.equal(salesApplied.lines[1].credit, 100_000_000);
  assert.equal(salesApplied.lines[1].costCenterId, seed.costCenters[1].id);
  assert.equal(salesApplied.lines[2].accountCode, '30301');
  assert.equal(salesApplied.lines[2].credit, 10_000_000);
  assert.match(salesApplied.description, new RegExp(seed.parties[0].name.slice(0, 12)));
  console.log('✓ 2. Official sales + 10% VAT template splits net/VAT/receivable with party & cost center wiring');

  // 3. Monthly payroll 30% Tamin insurance (23% employer + 7% employee) exact balance
  const payrollTpl = SYSTEM_VOUCHER_TEMPLATES.find((t) => t.id === 'sys_payroll_monthly_tamin')!;
  const payrollApplied = applyVoucherTemplate(payrollTpl, {
    accounts: seed.accounts,
    baseAmountIrr: 200_000_000,
    date: '1405/06/30',
  });
  assert.equal(payrollApplied.lines[0].debit, 246_000_000); // 200M + 23% employer (46M)
  assert.equal(payrollApplied.lines[1].credit, 186_000_000); // 200M - 7% employee (14M)
  assert.equal(payrollApplied.lines[2].credit, 60_000_000); // 30% Tamin (46M + 14M)
  assert.equal(payrollApplied.isBalanced, true);
  assert.match(payrollApplied.description, /شهریور 1405/);
  console.log('✓ 3. Payroll template computes exact 23% employer + 7% employee Tamin insurance with 0-Rial drift');

  // 4. Custom template creation from live voucher lines scales proportionally on a new amount
  const customTpl = createCustomTemplateFromLines({
    name: 'اجاره دفتر و شارژ ساختمان (۷۰/۳۰)',
    category: 'general_expenses',
    voucherType: 'general',
    description: 'پرداخت اجاره و شارژ ماهانه',
    lines: [
      { accountCode: '80201', accountTitle: 'اجاره دفتر', description: 'اجاره', debit: 70_000_000, credit: 0 },
      { accountCode: '80501', accountTitle: 'هزینه توزیع', description: 'شارژ و خدمات', debit: 30_000_000, credit: 0 },
      { accountCode: '10201', accountTitle: 'بانک ملت', description: 'پرداخت بانکی', debit: 0, credit: 100_000_000 },
    ],
  });

  const scaledCustom = applyVoucherTemplate(customTpl, {
    accounts: seed.accounts,
    baseAmountIrr: 33_333_333, // awkward prime-like amount to test rounding drift absorption
    date: '1405/07/01',
  });
  assert.equal(scaledCustom.isBalanced, true, 'Scaled custom template must remain strictly balanced');
  assert.equal(scaledCustom.totalDebit, scaledCustom.totalCredit);
  assert.equal(scaledCustom.totalDebit, 33_333_333);
  console.log('✓ 4. Custom template builder preserves multi-line ratios and absorbs 1-Rial rounding cleanly');

  // 5. Offline localStorage persistence, deletion & malformed JSON recovery
  addCustomVoucherTemplate(customTpl);
  assert.equal(loadCustomVoucherTemplates().length, 1);
  assert.equal(loadCustomVoucherTemplates()[0].name, customTpl.name);

  incrementTemplateUsage(customTpl.id);
  incrementTemplateUsage(customTpl.id);
  const usage = loadTemplateUsageMap();
  assert.equal(usage[customTpl.id], 2);

  // Suggest templates from history + usage prioritizes frequently used custom template
  const suggestions = suggestTemplatesFromHistory(
    seed.vouchers,
    [customTpl, ...SYSTEM_VOUCHER_TEMPLATES],
    usage,
    4
  );
  assert.equal(suggestions[0].id, customTpl.id, 'Most-used custom template should rank #1');

  // Filtering by Persian fuzzy query & account code
  const filteredByCode = filterVoucherTemplates(
    SYSTEM_VOUCHER_TEMPLATES,
    '80201',
    'all',
    new Set(suggestions.map((s) => s.id))
  );
  assert.ok(filteredByCode.some((t) => t.id === 'sys_exp_rent_utilities'));
  assert.match(formatTemplateAccountSummary(salesVatTpl, seed.accounts), /10401/);

  deleteCustomVoucherTemplate(customTpl.id);
  assert.equal(loadCustomVoucherTemplates().length, 0);

  // Resilient against corrupted localStorage JSON
  storageMap.set('holoo_apex_voucher_templates_v1', '{broken-json');
  assert.deepEqual(loadCustomVoucherTemplates(), []);
  console.log('✓ 5. Custom template persistence, smart history ranking, fuzzy search & corrupted-JSON guard passed');

  // 6. Templates Manager CRUD: Create with default accounts, party, cost center & balanced initial fixed values -> One-click load
  storageMap.clear();
  const createdFixed = upsertCustomVoucherTemplate({
    name: 'اجاره ثابت ماهانه انبار شادآباد',
    category: 'general_expenses',
    voucherType: 'general',
    descriptionTemplate: 'پرداخت اجاره ثابت انبار دوره {month}',
    lines: [
      {
        accountCode: '80201',
        fallbackTitle: 'اجاره دفتر، انبار شادآباد و قبوض',
        side: 'debit',
        formula: 'fixed',
        fixedAmount: 45_000_000,
        defaultDescription: 'اجاره ماهانه انبار',
        defaultPartyId: seed.parties[0].id,
        defaultPartyName: seed.parties[0].name,
        defaultCostCenterId: seed.costCenters[2].id,
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'fixed',
        fixedAmount: 45_000_000,
        defaultDescription: 'پرداخت بانکی اجاره',
      },
    ],
  });

  // One-click load with baseAmountIrr = 0 must populate exact initial debit/credit, default party & cost center!
  const oneClickLoaded = applyVoucherTemplate(createdFixed.template, {
    accounts: seed.accounts,
    baseAmountIrr: 0,
    date: '1405/05/01',
  });
  assert.equal(oneClickLoaded.isBalanced, true);
  assert.equal(oneClickLoaded.totalDebit, 45_000_000);
  assert.equal(oneClickLoaded.totalCredit, 45_000_000);
  assert.equal(oneClickLoaded.lines[0].partyId, seed.parties[0].id);
  assert.equal(oneClickLoaded.lines[0].costCenterId, seed.costCenters[2].id);
  assert.match(oneClickLoaded.description, /مرداد 1405/);

  // Edit existing custom template preserves ID & updates initial values
  const edited = upsertCustomVoucherTemplate({
    id: createdFixed.template.id,
    name: 'اجاره ثابت ماهانه انبار شادآباد (اصلاح‌شده)',
    category: 'general_expenses',
    voucherType: 'general',
    descriptionTemplate: 'پرداخت اجاره جدید انبار دوره {month}',
    lines: [
      {
        accountCode: '80201',
        fallbackTitle: 'اجاره دفتر، انبار شادآباد و قبوض',
        side: 'debit',
        formula: 'fixed',
        fixedAmount: 55_000_000,
        defaultDescription: 'اجاره جدید',
      },
      {
        accountCode: '10201',
        fallbackTitle: 'بانک ملت — حساب جاری شرکتی',
        side: 'credit',
        formula: 'fixed',
        fixedAmount: 55_000_000,
        defaultDescription: 'پرداخت بانکی',
      },
    ],
  });
  assert.equal(edited.template.id, createdFixed.template.id);
  assert.equal(edited.templates.length, 1);
  assert.equal(loadCustomVoucherTemplates()[0].lines[0].fixedAmount, 55_000_000);

  // Reject unbalanced fixed initial amounts
  assert.throws(
    () =>
      upsertCustomVoucherTemplate({
        name: 'الگوی ناتراز نامعتبر',
        category: 'general_expenses',
        voucherType: 'general',
        descriptionTemplate: 'تست خطا',
        lines: [
          { accountCode: '80201', fallbackTitle: 'هزینه', side: 'debit', formula: 'fixed', fixedAmount: 50_000_000, defaultDescription: '' },
          { accountCode: '10201', fallbackTitle: 'بانک', side: 'credit', formula: 'fixed', fixedAmount: 40_000_000, defaultDescription: '' },
        ],
      }),
    /تراز نیستند/
  );

  // Duplicate system template into editable custom template & then delete
  const cloned = duplicateTemplateAsCustom(salesVatTpl);
  assert.equal(cloned.template.isSystem, false);
  assert.equal(cloned.templates.length, 2);
  const afterDelete = deleteCustomVoucherTemplate(cloned.template.id);
  assert.equal(afterDelete.length, 1);
  console.log('✓ 6. Templates Manager CRUD (create, edit, duplicate, delete), initial values one-click load & balance guard passed');

  console.log('\nALL SMART VOUCHER TEMPLATES TESTS PASSED ✅');
}

runTests().catch((err) => {
  console.error('❌ Smart Voucher Templates tests FAILED:', err);
  process.exit(1);
});
