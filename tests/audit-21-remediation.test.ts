import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeAuditReport,
  computeBalanceSheet,
  computePartyBalances,
  computeTrialBalance,
  computeVoucherIntegrityHash,
  sha256HexSync,
  verifyVoucherIntegrityHash,
} from '../src/lib/accountingEngine';
import {
  applyInventoryMovementStep,
  normalizeProductCostState,
} from '../src/lib/inventoryCostingEngine';
import { getEffectiveExchangeRate } from '../src/lib/currency';
import {
  computeWebCryptoHmacSha256,
  decryptMeshPayloadAesGcm,
  encryptMeshPayloadAesGcm,
  generateSecureMeshPassphrase,
  isWeakMeshPassphrase,
  LEGACY_INSECURE_MESH_PASSPHRASE,
} from '../src/lib/p2pMeshSync';
import { mergeWorkspacesDeterministicLWW } from '../src/lib/localFolderDexieDb';
import { buildStandardAccountingReportHtml } from '../src/lib/accountingReportExport';
import {
  exportAllBankReconciliationSessions,
  importAllBankReconciliationSessions,
} from '../src/lib/bankReconciliationEngine';
import {
  detectCloudflareWorkerBackend,
  resetBackendProbeCache,
} from '../src/lib/staticRuntimeGuard';
import { createHolooSeedData } from '../src/data/holooSeed';
import { Product, Voucher } from '../src/types/accounting';

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    });
}

async function main() {
  console.log('Running 21-point full project audit remediation verification...');

  // 1. AUD-003 & AUD-014: SHA-256 tamper-evident voucher seal decoupled from voucherNumber
  await test('AUD-003/014: SHA-256 voucher seal survives chronological renumbering & detects tampering', () => {
    const baseVoucher: Voucher = {
      id: 'v_test_seal',
      ownerId: 'demo',
      voucherNumber: 12,
      date: '1405/02/10',
      description: 'ثبت فروش نقدی تست',
      voucherType: 'general',
      status: 'permanent',
      totalDebit: 2_500_000,
      totalCredit: 2_500_000,
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'دریافت نقدی', debit: 2_500_000, credit: 0 },
        { accountCode: '40101', accountTitle: 'فروش', description: 'درآمد فروش', debit: 0, credit: 2_500_000 },
      ],
    };

    const seal1 = computeVoucherIntegrityHash(baseVoucher);
    assert.ok(seal1.startsWith('vseal2_'), 'New voucher seals must use SHA-256 vseal2_ prefix');
    assert.equal(seal1.length, 'vseal2_'.length + 64, 'SHA-256 hex digest must be 64 hex chars');

    // Renumbering voucherNumber must NOT invalidate seal
    const renumbered: Voucher = { ...baseVoucher, voucherNumber: 99, integrityHash: seal1 };
    assert.equal(computeVoucherIntegrityHash(renumbered), seal1);
    assert.equal(verifyVoucherIntegrityHash(renumbered), true);

    // Tampering with amount MUST invalidate seal
    const tampered: Voucher = {
      ...renumbered,
      totalDebit: 2_500_001,
      totalCredit: 2_500_001,
      lines: [
        { accountCode: '10101', accountTitle: 'صندوق', description: 'دریافت نقدی', debit: 2_500_001, credit: 0 },
        { accountCode: '40101', accountTitle: 'فروش', description: 'درآمد فروش', debit: 0, credit: 2_500_001 },
      ],
    };
    assert.equal(verifyVoucherIntegrityHash(tampered), false);

    // FIPS 180-4 SHA-256 standard vector check: sha256("abc")
    assert.equal(
      sha256HexSync('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  // 2. AUD-002: P2P Mesh passphrase entropy, HMAC-SHA256, and AES-256-GCM E2EE
  await test('AUD-002: P2P Mesh generates strong passphrase and enforces AES-256-GCM E2EE + HMAC-SHA256', async () => {
    assert.equal(isWeakMeshPassphrase(LEGACY_INSECURE_MESH_PASSPHRASE), true);
    assert.equal(isWeakMeshPassphrase('1234'), true);

    const pass = generateSecureMeshPassphrase();
    assert.equal(isWeakMeshPassphrase(pass), false);
    assert.ok(pass.length >= 20, 'Generated passphrase must carry strong entropy');

    const macA = await computeWebCryptoHmacSha256(pass, 'deviceA|1000|nonce1|hash1');
    const macB = await computeWebCryptoHmacSha256(pass, 'deviceA|1000|nonce1|hash1');
    const macWrong = await computeWebCryptoHmacSha256(pass + 'x', 'deviceA|1000|nonce1|hash1');
    assert.equal(macA, macB);
    assert.equal(macA.length, 64);
    assert.notEqual(macA, macWrong);

    const secretLedger = JSON.stringify({ vouchers: [{ id: 'v1', totalDebit: 99_000_000 }] });
    const encrypted = await encryptMeshPayloadAesGcm(pass, secretLedger);
    assert.ok(encrypted.startsWith('mesh_e2ee_v1:'));
    assert.ok(!encrypted.includes('99000000'), 'Ciphertext must not leak plaintext financial figures');

    const decrypted = await decryptMeshPayloadAesGcm(pass, encrypted);
    assert.equal(decrypted, secretLedger);

    await assert.rejects(
      () => decryptMeshPayloadAesGcm('different-wrong-passphrase-123456', encrypted),
      'Wrong passphrase must fail AES-GCM authentication'
    );
  });

  // 3. AUD-005: 4-decimal FIFO inventory precision without rounding collapse
  await test('AUD-005: FIFO inventory costing preserves 4-decimal stockQty precision', () => {
    const product: Product = {
      id: 'p_chem',
      ownerId: 'demo',
      sku: 'CHEM-01',
      name: 'اسید سیتریک آزمایشگاهی',
      category: 'شیمیایی',
      warehouse: 'انبار مرکزی',
      unit: 'کیلوگرم',
      buyPrice: 1_000_000,
      sellPrice: 1_500_000,
      stock: 0,
      reorderPoint: 1,
      vatExempt: false,
      costLayers: [],
    };

    const initialState = normalizeProductCostState(product, 'fifo');
    const step1 = applyInventoryMovementStep(initialState, {
      id: 'pur-1',
      date: '1405/01/10',
      kind: 'purchase',
      productId: product.id,
      qty: 10.1234,
      unitCostIrr: 1_000_000,
    });
    assert.equal(step1.nextState.stockQty, 10.1234);

    const step2 = applyInventoryMovementStep(step1.nextState, {
      id: 'pur-2',
      date: '1405/01/11',
      kind: 'purchase',
      productId: product.id,
      qty: 0.0045,
      unitCostIrr: 1_200_000,
    });
    assert.equal(step2.nextState.stockQty, 10.1279);

    const step3 = applyInventoryMovementStep(step2.nextState, {
      id: 'sal-1',
      date: '1405/01/12',
      kind: 'sale',
      productId: product.id,
      qty: 5.0029,
    });
    assert.equal(step3.nextState.stockQty, 5.125);
  });

  // 4. AUD-006: Historical FX lookup fallback & missing-rate 0 guard
  await test('AUD-006: getEffectiveExchangeRate uses earliest historical rate before first date and returns 0 if unavailable', () => {
    const rates = [
      { id: 'r1', ownerId: 'demo', currencyCode: 'USD', date: '1405/01/15', rateToIrr: 600_000, rateType: 'market' as const },
      { id: 'r2', ownerId: 'demo', currencyCode: 'USD', date: '1405/03/01', rateToIrr: 950_000, rateType: 'market' as const },
    ];
    const currencies = [
      { id: 'c_usd', ownerId: 'demo', code: 'USD', name: 'دلار', symbol: '$', decimalPlaces: 2, isBase: false, defaultRateToIrr: 550_000, active: true },
      { id: 'c_gbp', ownerId: 'demo', code: 'GBP', name: 'پوند', symbol: '£', decimalPlaces: 2, isBase: false, defaultRateToIrr: 0, active: true },
    ];

    // Date earlier than all recorded rates must fall back to earliest (600,000), NOT future (950,000)
    const earliest = getEffectiveExchangeRate('USD', '1405/01/05', rates, currencies);
    assert.equal(earliest.rateToIrr, 600_000);
    assert.equal(earliest.rateDate, '1405/01/15');

    // Foreign currency with no rates and no positive defaultRateToIrr must return 0 (never silently 1)
    const missing = getEffectiveExchangeRate('GBP', '1405/02/01', rates, currencies);
    assert.equal(missing.rateToIrr, 0);
  });

  // 5. AUD-011: 3-device LWW tombstone anti-resurrection
  await test('AUD-011: 3-device mergeWorkspacesDeterministicLWW preserves deletion tombstones against offline resurrection', () => {
    const now = Date.now();
    const tOld = new Date(now - 60_000).toISOString();
    const tMid = new Date(now - 30_000).toISOString();
    const tDel = new Date(now - 5_000).toISOString();

    const devA = JSON.stringify({
      parties: [
        { id: 'p_keep', uuid: 'p_keep', name: 'مشتری فعال', updatedAt: tOld, deviceId: 'devA', isDeleted: false },
        { id: 'p_del', uuid: 'p_del', name: 'مشتری حذف‌شده', updatedAt: tDel, deviceId: 'devA', isDeleted: true },
      ],
    });
    const devB = JSON.stringify({
      parties: [
        { id: 'p_keep', uuid: 'p_keep', name: 'مشتری فعال', updatedAt: tOld, deviceId: 'devB', isDeleted: false },
        { id: 'p_del', uuid: 'p_del', name: 'مشتری حذف‌شده', updatedAt: tOld, deviceId: 'devB', isDeleted: false },
      ],
    });

    const abRes = mergeWorkspacesDeterministicLWW(devA, devB, 'devA');
    const abObj = JSON.parse(abRes.mergedSnapshotJson) as {
      parties: Array<{ id: string }>;
      _meshTombstones?: Record<string, Record<string, { deletedAt: string }>>;
    };
    assert.equal(abObj.parties.some((p) => p.id === 'p_del'), false);
    assert.ok(abObj._meshTombstones?.parties?.p_del, 'Merged snapshot must retain _meshTombstones entry for p_del');

    // Now Device C comes online later still holding the older pre-delete copy of p_del
    const devC = JSON.stringify({
      parties: [
        { id: 'p_keep', uuid: 'p_keep', name: 'مشتری فعال', updatedAt: tOld, deviceId: 'devC', isDeleted: false },
        { id: 'p_del', uuid: 'p_del', name: 'مشتری قدیمی آفلاین', updatedAt: tMid, deviceId: 'devC', isDeleted: false },
      ],
    });

    const abcRes = mergeWorkspacesDeterministicLWW(abRes.mergedSnapshotJson, devC, 'devA');
    const abcObj = JSON.parse(abcRes.mergedSnapshotJson) as { parties: Array<{ id: string }> };
    const activeIds = abcObj.parties.map((p) => p.id);
    assert.equal(activeIds.includes('p_del'), false, 'Deleted record must NOT resurrect when Device C syncs');
    assert.equal(activeIds.includes('p_keep'), true);
  });

  // 6. AUD-013: Exact 0-IRR inventory vs GL reconciliation tolerance
  await test('AUD-013: computeAuditReport flags any non-zero inventory vs GL discrepancy (even 1,000 IRR)', () => {
    const seed = createHolooSeedData('demo_owner');
    const trialBalance = computeTrialBalance(seed.accounts, seed.vouchers);
    const balanceSheet = computeBalanceSheet(trialBalance);
    const partyBalances = computePartyBalances(seed.parties, seed.vouchers);

    // Artificially inject an exact 1,000 IRR drift (previously hidden by <= 5,000 tolerance)
    const driftedProducts = seed.products.map((p, idx) => {
      if (idx !== 0) return p;
      const baseVal =
        p.inventoryValueIrr !== undefined && Number.isFinite(p.inventoryValueIrr)
          ? p.inventoryValueIrr
          : Math.round((Number(p.stock) || 0) * (Number(p.buyPrice) || 0));
      return { ...p, inventoryValueIrr: baseVal + 1_000 };
    });
    const report = computeAuditReport({
      accounts: seed.accounts,
      vouchers: seed.vouchers,
      invoices: seed.invoices,
      parties: seed.parties,
      products: driftedProducts,
      cheques: seed.cheques,
      trialBalance,
      balanceSheet,
      partyBalances,
    });
    const invCheck = report.checks.find((c) => c.id === 'inventory-gl-reconcile');
    assert.ok(invCheck, 'inventory-gl-reconcile check must exist');
    assert.notEqual(invCheck.status, 'pass', 'Any discrepancy > 0 IRR must not pass strict inventory-GL audit');
    assert.ok((invCheck.discrepancyAmount ?? 0) >= 1_000, 'Discrepancy amount must report the 1,000 IRR drift');
  });

  // 7. AUD-015: Bank reconciliation sessions export/import with prototype-pollution hardening
  await test('AUD-015: Bank reconciliation export/import strips dangerous keys', () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };

    const payload = JSON.parse(
      '{"10201":{"row_1":{"statementRowId":"row_1","reviewStatus":"confirmed","reviewedBy":"مدیر مالی","reviewedAt":"2026-05-01T10:00:00Z"}},"__proto__":{"polluted":{"statementRowId":"x","reviewStatus":"confirmed"}}}'
    );
    const count = importAllBankReconciliationSessions(payload);
    assert.equal(count, 1);
    const exported = exportAllBankReconciliationSessions();
    assert.equal(exported['10201']?.row_1?.reviewStatus, 'confirmed');
    assert.equal(Object.prototype.hasOwnProperty.call(exported, '__proto__'), false);
  });

  // 8. AUD-017: Zero external CDN URLs in print report HTML
  await test('AUD-017: buildStandardAccountingReportHtml contains zero external Google Fonts CDN links', () => {
    const columns = [
      { key: 'code', label: 'کد حساب', align: 'center' as const, defaultVisible: true },
      { key: 'debit', label: 'بدهکار', align: 'left' as const, isNumeric: true, defaultVisible: true },
    ];
    const html = buildStandardAccountingReportHtml(
      {
        reportId: 'trial_balance',
        fileNamePrefix: 'trial-balance',
        title: 'تراز آزمایشی تست',
        periodLabel: 'سال مالی ۱۴۰۵',
        voucherScopeLabel: 'اسناد قطعی',
        currencyUnit: 'IRR',
        recommendedOrientation: 'portrait',
        columns,
        rows: [{ id: 'r1', cells: { code: '10101', debit: '1,000,000' } }],
      },
      columns,
      {
        uid: 'demo',
        companyName: 'شرکت آزمایشی',
        displayName: 'آزمایشی',
        fiscalYear: '1405',
        currencyUnit: 'IRR',
        role: 'accountant',
      },
      {
        orientation: 'portrait',
        showRowNumbers: true,
        showSignatures: false,
        showKpis: false,
        compactDensity: false,
      }
    );
    assert.equal(html.includes('fonts.googleapis.com'), false);
    assert.equal(html.includes('fonts.gstatic.com'), false);
  });

  // 9. AUD-001: Cloudflare Worker availability probe caches healthy/unhealthy results
  await test('AUD-001: detectCloudflareWorkerBackend probes /api/health, rejects non-JSON, and caches result', async () => {
    resetBackendProbeCache();
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as Record<string, unknown>).window;
    let calls = 0;
    (globalThis as Record<string, unknown>).window = {};
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: 'ok', service: 'holoo-apex-cloudflare-worker' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const ok1 = await detectCloudflareWorkerBackend('https://worker.example.dev');
      const ok2 = await detectCloudflareWorkerBackend('https://worker.example.dev');
      assert.equal(ok1, true);
      assert.equal(ok2, true);
      assert.equal(calls, 1, 'Worker probe result must be cached for the session');

      // Non-JSON HTML response must be rejected cleanly
      const htmlReject = await detectCloudflareWorkerBackend(
        'https://bad.example.dev',
        (async () => new Response('<html>404</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
      );
      assert.equal(htmlReject, false);
    } finally {
      globalThis.fetch = origFetch;
      if (origWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = origWindow;
      }
      resetBackendProbeCache();
    }
  });

  // 10. AUD-008, AUD-012, AUD-018, AUD-019: Static security & PWA config invariants
  await test('AUD-008/012/018/019: Worker, server, Vite PWA manifest, and dead files meet audit invariants', () => {
    const viteCfg = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
    assert.equal(viteCfg.includes("'/pwa-192x192.png'"), false, 'Manifest shortcuts must not use root-absolute /pwa-192x192.png');
    assert.equal(viteCfg.includes("'./pwa-192x192.png'"), true, 'Manifest shortcuts must use relative ./pwa-192x192.png');
    assert.equal(viteCfg.includes('fileURLToPath(import.meta.url)'), true, 'vite.config.ts must use ESM fileURLToPath(import.meta.url)');

    const workerSrc = fs.readFileSync(path.resolve('worker/index.js'), 'utf8');
    assert.equal(workerSrc.includes('holoo-apex-dev-fallback-secret-change-me'), false, 'Worker must not fall back to hardcoded session secret');
    assert.equal(workerSrc.includes('checkAuthRateLimit'), true, 'Worker must enforce auth rate limiting');
    assert.equal(workerSrc.includes('CSRF_DENIED'), true, 'Worker must enforce CSRF protection on mutating routes');

    const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf8');
    assert.equal(serverSrc.includes('ALLOW_CLOUD_AI'), true, 'Server AI routes must require explicit ALLOW_CLOUD_AI opt-in');
    assert.equal(serverSrc.includes('auditTrailPreserved: true'), true, 'Server reset must preserve immutable audit log');

    assert.equal(fs.existsSync(path.resolve('src/components/dashboard/BentoAnalyticalChartsRow.tsx')), false);
    assert.equal(fs.existsSync(path.resolve('src/components/dashboard/BentoOperationalBottomRow.tsx')), false);
  });

  console.log(`\nAll ${passed} audit remediation assertions passed!`);
}

main().catch((err) => {
  console.error('Audit remediation test failed:', err);
  process.exit(1);
});
