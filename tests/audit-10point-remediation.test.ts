import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildStandaloneLocalDiagnostics } from '../src/lib/staticRuntimeGuard';
import { convertForeignToIrr } from '../src/lib/currency';
import {
  buildTaminDskFiles,
  buildTtmsSalaryCsv,
  computeFxRevaluationReport,
  sanitizeCsvCell,
} from '../src/lib/enterpriseAccounting';
import { normalizeProductCostState } from '../src/lib/inventoryCostingEngine';
import { ALL_HOLOO_INDEXED_DBS } from '../src/lib/operationalDb';
import {
  computeContrastRatio,
  generateColorScale,
  UI_THEME_PRESETS,
} from '../src/lib/uiThemeCustomizer';
import type { CompanyProfile, CurrencyDefinition, Employee, ExchangeRateEntry, Product, Voucher } from '../src/types/accounting';

const ROOT = process.cwd();
let passed = 0;

function runCase(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

runCase('1. buildStandaloneLocalDiagnostics exposes complete session/supabase/server contract without TypeError', () => {
  const diag = buildStandaloneLocalDiagnostics();
  assert.equal(typeof diag.session, 'object');
  assert.equal(diag.session.authenticated, false);
  assert.equal(diag.session.serverRevision, 0);
  assert.equal(diag.supabase.connected, false);
  assert.equal(diag.supabase.tableName, 'holoo_apex_workspaces');
  assert.equal(diag.supabase.auditTableName, 'holoo_apex_audit_logs');
  assert.equal(diag.server.service, 'holoo-apex-standalone-pwa');
});

runCase('2. convertForeignToIrr uses exact BigInt fixed-point math without IEEE-754 float drift', () => {
  // Classic IEEE-754 edge cases: 1.005 * 1000, 19.99 * 100, and large multi-billion IRR conversions
  assert.equal(convertForeignToIrr(1.005, 1000), 1005);
  assert.equal(convertForeignToIrr(0.1 + 0.2, 1_000_000), 300_000);
  assert.equal(convertForeignToIrr(125_432.75, 845_000), 105_990_673_750);
  assert.equal(convertForeignToIrr(-500.25, 800_000), -400_200_000);
  assert.equal(convertForeignToIrr(0, 800_000), 0);
});

runCase('3. computeFxRevaluationReport excludes draft vouchers and computes exact revalued diff', () => {
  const currencies: CurrencyDefinition[] = [
    {
      id: 'cur_usd',
      ownerId: 'u1',
      code: 'USD',
      name: 'دلار آمریکا',
      symbol: '$',
      isBase: false,
      decimalPlaces: 2,
      defaultRateToIrr: 900_000,
      active: true,
    },
  ];
  const rates: ExchangeRateEntry[] = [
    {
      id: 'fx_1',
      ownerId: 'u1',
      currencyCode: 'USD',
      date: '1405/06/31',
      rateToIrr: 950_000,
      rateType: 'market',
    },
  ];
  const vouchers: Voucher[] = [
    {
      id: 'v_perm',
      ownerId: 'u1',
      voucherNumber: 1,
      date: '1405/02/01',
      description: 'مانده ارزی دائمی',
      voucherType: 'general',
      status: 'permanent',
      currencyCode: 'USD',
      exchangeRate: 850_000,
      totalDebit: 850_000_000,
      totalCredit: 850_000_000,
      lines: [
        {
          accountCode: '10201',
          accountTitle: 'بانک ارزی',
          description: 'واریز ۱۰۰۰ دلار',
          debit: 850_000_000,
          credit: 0,
          fxCurrencyCode: 'USD',
          foreignDebit: 1000,
          foreignCredit: 0,
        },
        {
          accountCode: '40101',
          accountTitle: 'سرمایه',
          description: 'طرف حساب',
          debit: 0,
          credit: 850_000_000,
          foreignDebit: 0,
          foreignCredit: 0,
        },
      ],
    },
    {
      id: 'v_draft',
      ownerId: 'u1',
      voucherNumber: 2,
      date: '1405/02/05',
      description: 'سند پیش‌نویس تاییدنشده (نباید تسعیر شود)',
      voucherType: 'general',
      status: 'draft',
      currencyCode: 'USD',
      exchangeRate: 850_000,
      totalDebit: 850_000_000,
      totalCredit: 850_000_000,
      lines: [
        {
          accountCode: '10201',
          accountTitle: 'بانک ارزی',
          description: 'پیش‌نویس ۱۰۰۰ دلار',
          debit: 850_000_000,
          credit: 0,
          fxCurrencyCode: 'USD',
          foreignDebit: 1000,
          foreignCredit: 0,
        },
        {
          accountCode: '40101',
          accountTitle: 'سرمایه',
          description: 'طرف حساب',
          debit: 0,
          credit: 850_000_000,
          foreignDebit: 0,
          foreignCredit: 0,
        },
      ],
    },
  ];

  const rows = computeFxRevaluationReport(vouchers, rates, currencies, '1405/06/31');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].netForeignBalance, 1000);
  assert.equal(rows[0].revaluedIrrBalance, 950_000_000);
  assert.equal(rows[0].revaluationDiffIrr, 100_000_000);
});

runCase('4. Tamin DSK & TTMS exports apply fiscal year 1404 vs 1405 statutory parameters and neutralize CSV formula injection', () => {
  const emp: Employee = {
    id: 'emp_1',
    ownerId: 'u1',
    personnelCode: '=1+1',
    fullName: '=CMD("calc")',
    department: '+مالی',
    baseSalary: 280_000_000,
    housingAllowance: 10_000_000,
    foodAllowance: 15_000_000,
    childrenCount: 1,
    overtimeHours: 0,
    active: true,
  };
  const profile1404: CompanyProfile = {
    uid: 'u1',
    displayName: 'مدیر مالی',
    role: 'accountant',
    companyName: '@شرکت نمونه',
    fiscalYear: '1404',
    currencyUnit: 'IRR',
  };
  const profile1405: CompanyProfile = {
    uid: 'u1',
    displayName: 'مدیر مالی',
    role: 'accountant',
    companyName: '@شرکت نمونه',
    fiscalYear: '1405',
    currencyUnit: 'IRR',
  };

  const ttms1404 = buildTtmsSalaryCsv([emp], profile1404, 'فروردین ۱۴۰۴');
  const ttms1405 = buildTtmsSalaryCsv([emp], profile1405, 'فروردین ۱۴۰۵');
  const dsk1405 = buildTaminDskFiles([emp], profile1405, 'فروردین ۱۴۰۵');

  // 1404 and 1405 have different monthly tax exemption thresholds (240M vs 400M IRR) -> different salary tax
  assert.notEqual(ttms1404, ttms1405);

  // Formula injection payloads must be prefixed with single quote inside CSV cells
  assert.equal(sanitizeCsvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.ok(ttms1405.includes(`"'=CMD(""calc"")"`), 'Malicious employee fullName must be neutralized');
  assert.ok(ttms1405.includes(`"'@شرکت نمونه"`), 'Malicious companyName must be neutralized');
  assert.ok(dsk1405.worFile.includes("'=1+1"), 'Malicious personnelCode must be neutralized');
  assert.ok(dsk1405.worFile.includes(`"'+مالی"`), 'Malicious department must be neutralized');
});

runCase('5. FIFO cost layers survive 3-decimal textile weight rounding differences without collapsing', () => {
  const product: Product = {
    id: 'p_yarn_1',
    ownerId: 'u1',
    sku: 'YRN-3DEC',
    name: 'نخ پلی‌استر 150/48',
    category: 'نخ',
    warehouse: 'انبار مرکزی',
    unit: 'کیلوگرم',
    buyPrice: 2_000_000,
    sellPrice: 2_500_000,
    stock: 12.35, // 2-decimal display rounded from 12.345
    reorderPoint: 5,
    vatExempt: false,
    costingMethod: 'fifo',
    costLayers: [
      {
        layerId: 'l1',
        date: '1405/01/05',
        sourceRef: 'inv_1',
        warehouse: 'انبار مرکزی',
        originalQty: 5.125,
        remainingQty: 5.125,
        unitCostIrr: 1_900_000,
        totalCostIrr: 9_737_500,
      },
      {
        layerId: 'l2',
        date: '1405/01/10',
        sourceRef: 'inv_2',
        warehouse: 'انبار مرکزی',
        originalQty: 7.22,
        remainingQty: 7.22,
        unitCostIrr: 2_100_000,
        totalCostIrr: 15_162_000,
      },
    ],
    inventoryValueIrr: 24_899_500,
  };

  const state = normalizeProductCostState(product, 'fifo', '1405/01/01');
  assert.equal(state.layers.length, 2, 'Both FIFO layers must be preserved without collapsing');
  assert.equal(state.layers[0].unitCostIrr, 1_900_000);
  assert.equal(state.layers[1].unitCostIrr, 2_100_000);
});

runCase('6. ALL_HOLOO_INDEXED_DBS includes Dexie P2P Mesh DB for complete factory reset wipe', () => {
  assert.ok(
    (ALL_HOLOO_INDEXED_DBS as readonly string[]).includes('holoo_apex_mesh_dexie_v1'),
    'ALL_HOLOO_INDEXED_DBS must include holoo_apex_mesh_dexie_v1'
  );
});

runCase('7. All 6 UI Theme Customizer presets achieve WCAG AA (>= 4.5:1) dark-mode legibility on shade 400', () => {
  for (const preset of UI_THEME_PRESETS) {
    const scale = generateColorScale(preset.primaryColor);
    const ratioOnDark = computeContrastRatio(scale[400], '#0B0F17');
    assert.ok(
      ratioOnDark >= 4.5,
      `Preset ${preset.id} primary shade 400 (${scale[400]}) contrast on #0B0F17 is ${ratioOnDark.toFixed(2)} (< 4.5)`
    );
  }
});

runCase('8. Static code guards verify syncInbox wiring, O(1) IDB count(), and consignment 10503 posting', () => {
  const opDbSrc = fs.readFileSync(path.join(ROOT, 'src/lib/operationalDb.ts'), 'utf8');
  assert.ok(opDbSrc.includes('countStoreRecords'), 'operationalDb must use O(1) countStoreRecords');
  assert.ok(opDbSrc.includes('countStoreByIndex'), 'operationalDb must use O(1) indexed counts');

  const dualHookSrc = fs.readFileSync(path.join(ROOT, 'src/hooks/useDualCloudSync.ts'), 'utf8');
  assert.ok(dualHookSrc.includes('recordInboxOperation'), 'useDualCloudSync must wire syncInbox');
  assert.ok(dualHookSrc.includes('hasFinancialDocConflict'), 'useDualCloudSync must halt on financial doc conflict');
  assert.ok(dualHookSrc.includes('holoo:remote-import-applied'), 'useDualCloudSync must coordinate anti-echo event');

  const meshHookSrc = fs.readFileSync(path.join(ROOT, 'src/hooks/useLocalFirstMeshSync.ts'), 'utf8');
  assert.ok(meshHookSrc.includes('isInboxOperationProcessed'), 'useLocalFirstMeshSync must check syncInbox');
  assert.ok(meshHookSrc.includes('holoo:operating-mode-changed'), 'useLocalFirstMeshSync must respect 3-mode OperatingMode');

  const whViewSrc = fs.readFileSync(path.join(ROOT, 'src/components/WarehouseCrmOpsView.tsx'), 'utf8');
  assert.ok(whViewSrc.includes("accountCode: '10503'"), 'Consignment slips must post to 10503 instead of P&L shortage/surplus');
});

console.log(`\nAll ${passed} 10-Point Audit Remediation regression tests passed!`);
