import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  planAtomicInvoiceCommit,
  planInvoiceCancellation,
  planProformaToSaleConversion,
  planStockAdjustmentWithCostLayers,
} from '../src/lib/accountingEngine';
import {
  mergeWorkspacesDeterministicLWW,
  tagSnapshotWithSyncMetadata,
  type MeshDevicePeerId,
} from '../src/lib/localFolderDexieDb';
import {
  computeMeshAuthTag,
  MAX_MESH_CLOCK_SKEW_MS,
  MAX_SEEN_NONCES,
  MeshReplayGuard,
  signMeshMessageEnvelope,
  verifyMeshMessageEnvelope,
  type MeshWireMessage,
} from '../src/lib/p2pMeshSync';
import { analyzeAccountingSnapshotConflict } from '../src/lib/syncConflictResolver';
import {
  buildIsolatedWorkspaceStorageKey,
  computeSnapshotDigest256Sync,
  computeSnapshotSha256Hex,
  computeSyncBackoffMs,
  createLocalOfflinePasscodeRecord,
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
  evaluateStorageHealthSnapshot,
  requiresManualFinancialConflictReview,
  resolveEffectiveOperatingMode,
  verifyLocalOfflinePasscode,
} from '../src/lib/offlineFirstCore';
import { percentOfIrr } from '../src/lib/moneyMath';
import type { Cheque, Invoice, Product, Voucher } from '../src/types/accounting';

const SEED = createHolooSeedData('u_audit');
const DEFAULT_ACCOUNTS = SEED.accounts;
const DEFAULT_PARTIES = SEED.parties;
const DEFAULT_PRODUCTS = SEED.products;

let passed = 0;

function runTest(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const PASS = 'Holoo-Enterprise-3Dev-Secret#1404';
const AUTH_TAG = computeMeshAuthTag(PASS);

// ============================================================================
// 1. ACCOUNTING PRECISION, 10% IRAN VAT & ATOMIC ROLLBACK GUARDS
// ============================================================================

runTest('1. Exact 10% Iran VAT, FIFO COGS & atomic invoice plan balance to 0 IRR drift', () => {
  const baseProd: Product = {
    ...DEFAULT_PRODUCTS[0],
    id: 'p_audit_yarn',
    sku: 'YRN-AUD-01',
    name: 'نخ پلی‌استر DTY 150/48',
    warehouse: 'انبار مرکزی تهران',
    stock: 200,
    buyPrice: 1_500_000,
    sellPrice: 2_100_000,
    vatExempt: false,
    costingMethod: 'fifo',
    costLayers: [
      {
        layerId: 'l1',
        date: '1404/01/05',
        sourceRef: 'open',
        originalQty: 80,
        remainingQty: 80,
        unitCostIrr: 1_400_000,
        totalCostIrr: 80 * 1_400_000,
      },
      {
        layerId: 'l2',
        date: '1404/01/12',
        sourceRef: 'pur1',
        originalQty: 120,
        remainingQty: 120,
        unitCostIrr: 1_600_000,
        totalCostIrr: 120 * 1_600_000,
      },
    ],
    inventoryValueIrr: 80 * 1_400_000 + 120 * 1_600_000,
  };
  const exemptProd: Product = {
    ...DEFAULT_PRODUCTS[1],
    id: 'p_audit_exempt',
    sku: 'YRN-EXM-02',
    name: 'ماده اولیه معاف مالیات',
    warehouse: 'انبار تبریز',
    stock: 100,
    buyPrice: 900_000,
    sellPrice: 1_200_000,
    vatExempt: true,
    costingMethod: 'fifo',
    costLayers: [
      {
        layerId: 'le1',
        date: '1404/01/05',
        sourceRef: 'open',
        originalQty: 100,
        remainingQty: 100,
        unitCostIrr: 900_000,
        totalCostIrr: 100 * 900_000,
      },
    ],
    inventoryValueIrr: 100 * 900_000,
  };

  // Taxable line: 100 * 2,100,000 = 210,000,000; discount 10,000,000 -> net 200,000,000 -> 10% VAT = 20,000,000
  // Exempt line: 10 * 1,200,000 = 12,000,000 -> 0% VAT
  const subtotal = 210_000_000 + 12_000_000;
  const discount = 10_000_000;
  const expectedVat = percentOfIrr(200_000_000, 10);
  assert.equal(expectedVat, 20_000_000);
  const grandTotal = subtotal - discount + expectedVat; // 232,000,000

  const plan = planAtomicInvoiceCommit({
    invoiceId: 'inv_audit_1',
    voucherId: 'vch_audit_1',
    chequeId: 'chq_audit_1',
    nextVoucherNumber: 501,
    ownerId: 'u_audit',
    deviceId: 'holoo-mesh-mehran-laptop',
    payload: {
      invoiceNumber: 'SL-1404-0501',
      invoiceType: 'sale',
      date: '1404/02/15',
      partyId: DEFAULT_PARTIES[0].id,
      partyName: DEFAULT_PARTIES[0].name,
      warehouse: 'انبار مرکزی تهران',
      subtotal,
      discount,
      vatAmount: expectedVat,
      grandTotal,
      paidCash: 32_000_000,
      paidBank: 100_000_000,
      paidCheque: 50_000_000,
      creditAmount: 50_000_000,
      status: 'issued',
      items: [
        {
          productId: baseProd.id,
          productName: baseProd.name,
          sku: baseProd.sku,
          unit: 'کیلوگرم',
          quantity: 100,
          unitPrice: 2_100_000,
          discount: 10_000_000,
          vatAmount: 20_000_000,
          lineTotal: 220_000_000,
        },
        {
          productId: exemptProd.id,
          productName: exemptProd.name,
          sku: exemptProd.sku,
          unit: 'کیلوگرم',
          quantity: 10,
          unitPrice: 1_200_000,
          discount: 0,
          vatAmount: 0,
          lineTotal: 12_000_000,
        },
      ],
    },
    products: [baseProd, exemptProd],
    trialBalance: [],
    party: DEFAULT_PARTIES[0],
    currentPartyBalance: 0,
    enforceCashOverdraftGuard: false,
    defaultCostingMethod: 'fifo',
    closedFiscalYears: ['1403'],
  });

  // FIFO COGS for 100 kg of baseProd = 80 * 1.4M + 20 * 1.6M = 112M + 32M = 144,000,000
  // Remaining baseProd stock = 100 kg @ 1.6M = 160,000,000
  const updBase = plan.updatedProducts.find((p) => p.id === baseProd.id)!;
  assert.equal(updBase.stock, 100);
  assert.equal(updBase.inventoryValueIrr, 160_000_000);
  assert.ok(plan.voucher);
  assert.equal(plan.voucher.totalDebit, plan.voucher.totalCredit);
  assert.ok(plan.cheque);
  assert.equal(plan.cheque.amount, 50_000_000);

  // Atomic cancellation restores exact FIFO value & emits balanced reversing voucher + cancels cheque
  const cancelPlan = planInvoiceCancellation({
    invoice: plan.invoice,
    cancellationDate: '1404/02/16',
    products: plan.updatedProducts,
    vouchers: [plan.voucher],
    cheques: [plan.cheque],
    costingMethod: 'fifo',
    closedFiscalYears: ['1403'],
    ownerId: 'u_audit',
    reversalVoucherId: 'vch_rev_501',
    nextVoucherNumber: 502,
    deviceId: 'holoo-mesh-mehran-laptop',
  });

  assert.equal(cancelPlan.productDeltas.get(baseProd.id)?.stock, 200);
  assert.equal(cancelPlan.productDeltas.get(baseProd.id)?.inventoryValueIrr, baseProd.inventoryValueIrr);
  assert.ok(cancelPlan.reversalVoucher);
  assert.equal(cancelPlan.reversalVoucher.totalDebit, cancelPlan.reversalVoucher.totalCredit);
  assert.equal(cancelPlan.reversalVoucher.reversalOfVoucherId, plan.voucher.id);
  assert.deepEqual(cancelPlan.chequeIdsToCancel, [plan.cheque.id]);
});

runTest('2. Closed fiscal year & negative stock guards abort cleanly before any write', () => {
  const prod: Product = { ...DEFAULT_PRODUCTS[0], stock: 10, buyPrice: 1_000_000 };

  assert.throws(
    () =>
      planStockAdjustmentWithCostLayers({
        product: prod,
        newStock: 15,
        date: '1403/12/29',
        reason: 'انبارگردانی سال بسته',
        costingMethod: 'fifo',
        allowNegativeStock: false,
        closedFiscalYears: ['1403'],
        accounts: DEFAULT_ACCOUNTS,
        ownerId: 'u_audit',
        referenceId: 'stk_closed',
        voucherId: 'vch_closed',
        nextVoucherNumber: 1,
        deviceId: 'holoo-mesh-mehran-laptop',
      }),
    /بسته/
  );

  assert.throws(
    () =>
      planStockAdjustmentWithCostLayers({
        product: prod,
        newStock: -5,
        date: '1404/02/20',
        reason: 'شمارش منفی نامعتبر',
        costingMethod: 'fifo',
        allowNegativeStock: false,
        closedFiscalYears: [],
        accounts: DEFAULT_ACCOUNTS,
        ownerId: 'u_audit',
        referenceId: 'stk_neg',
        voucherId: 'vch_neg',
        nextVoucherNumber: 1,
        deviceId: 'holoo-mesh-mehran-laptop',
      }),
    /منفی/
  );

  // Proforma conversion aborts atomically when stock is insufficient
  const proforma: Invoice = {
    id: 'inv_pf_1',
    ownerId: 'u_audit',
    invoiceNumber: 'PF-1404-01',
    invoiceType: 'proforma',
    date: '1404/02/10',
    partyId: DEFAULT_PARTIES[0].id,
    partyName: DEFAULT_PARTIES[0].name,
    warehouse: prod.warehouse,
    subtotal: 50_000_000,
    discount: 0,
    vatAmount: 5_000_000,
    grandTotal: 55_000_000,
    paidCash: 0,
    paidBank: 0,
    paidCheque: 0,
    creditAmount: 55_000_000,
    status: 'issued',
    items: [
      {
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        unit: prod.unit,
        quantity: 50, // exceeds available stock=10
        unitPrice: 1_000_000,
        discount: 0,
        vatAmount: 5_000_000,
        lineTotal: 55_000_000,
      },
    ],
  };

  assert.throws(
    () =>
      planProformaToSaleConversion({
        proforma,
        conversionDate: '1404/02/11',
        products: [prod],
        parties: DEFAULT_PARTIES,
        existingInvoices: [proforma],
        existingVouchers: [],
        costingMethod: 'fifo',
        allowNegativeStock: false,
        closedFiscalYears: [],
        ownerId: 'u_audit',
        voucherId: 'vch_pf_conv',
        nextVoucherNumber: 10,
        chequeId: 'chq_pf_conv',
        deviceId: 'holoo-mesh-mehran-laptop',
      }),
    /موجودی/
  );
});

// ============================================================================
// 2. P2P MESH CRYPTOGRAPHIC AUTH: NONCE, MAC, REPLAY, FORGERY, CLOCK SKEW, DoS
// ============================================================================

runTest('3. P2P Mesh rejects replay attacks, 1-byte tampering, forgery, clock skew & oversized payloads', () => {
  const guard = new MeshReplayGuard();
  const baseNow = 1_760_000_000_000;
  const snap = JSON.stringify({
    vouchers: [{ id: 'v1', voucherNumber: 101, totalDebit: 50_000_000, totalCredit: 50_000_000 }],
  });

  const signed: MeshWireMessage = signMeshMessageEnvelope(
    PASS,
    {
      type: 'mesh:state_payload',
      fromPeerId: 'holoo-mesh-mehran-laptop',
      authTag: AUTH_TAG,
      updatedAt: '2026-11-26T10:00:00.000Z',
      payloadHash: 'hash_v1',
      vectorClock: { 'holoo-mesh-mehran-laptop': 3 },
      snapshotJson: snap,
      relayEnvelopes: [],
      batchedOperationIds: ['op_1'],
    },
    baseNow
  );

  // 1) Legitimate fresh message passes
  const firstCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-laptop',
    raw: signed,
    replayGuard: guard,
    nowMs: baseNow + 1200,
  });
  assert.deepEqual(firstCheck, { ok: true });
  assert.equal(guard.getSize(), 1);

  // 2) Exact replay attack is immediately blocked
  const replayCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-laptop',
    raw: signed,
    replayGuard: guard,
    nowMs: baseNow + 2400,
  });
  assert.equal(replayCheck.ok, false);
  if (!replayCheck.ok) assert.equal(replayCheck.reason, 'replay_detected');

  // 3) 1-Rial payload tampering is blocked by 256-bit MAC (without polluting replay cache!)
  const freshSigned = signMeshMessageEnvelope(
    PASS,
    {
      type: 'mesh:state_payload',
      fromPeerId: 'holoo-mesh-mehran-phone1',
      authTag: AUTH_TAG,
      updatedAt: '2026-11-26T10:01:00.000Z',
      payloadHash: 'hash_v2',
      vectorClock: { 'holoo-mesh-mehran-phone1': 2 },
      snapshotJson: snap,
      relayEnvelopes: [],
    },
    baseNow + 5000
  );
  const tamperedSnap = {
    ...freshSigned,
    snapshotJson: snap.replace('50000000', '50000001'),
  };
  const tamperCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone1',
    raw: tamperedSnap,
    replayGuard: guard,
    nowMs: baseNow + 5500,
  });
  assert.equal(tamperCheck.ok, false);
  if (!tamperCheck.ok) assert.equal(tamperCheck.reason, 'mac_mismatch');
  // Verify replay cache was NOT polluted by tampered packet
  assert.equal(guard.getSize(), 1);

  // 4) Vector-clock tampering is also caught by MAC
  const tamperedClock = {
    ...freshSigned,
    vectorClock: { 'holoo-mesh-mehran-phone1': 999 },
  };
  const clockTamperCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone1',
    raw: tamperedClock,
    replayGuard: guard,
    nowMs: baseNow + 5500,
  });
  assert.equal(clockTamperCheck.ok, false);
  if (!clockTamperCheck.ok) assert.equal(clockTamperCheck.reason, 'mac_mismatch');

  // 5) Expired (> 5 min old) and future (> 5 min ahead) timestamps rejected
  const staleMsg = signMeshMessageEnvelope(
    PASS,
    {
      type: 'mesh:request_state',
      fromPeerId: 'holoo-mesh-mehran-phone2',
      authTag: AUTH_TAG,
    },
    baseNow - MAX_MESH_CLOCK_SKEW_MS - 10_000
  );
  const staleCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone2',
    raw: staleMsg,
    replayGuard: guard,
    nowMs: baseNow,
  });
  assert.equal(staleCheck.ok, false);
  if (!staleCheck.ok) assert.equal(staleCheck.reason, 'timestamp_out_of_window');

  const futureMsg = signMeshMessageEnvelope(
    PASS,
    {
      type: 'mesh:request_state',
      fromPeerId: 'holoo-mesh-mehran-phone2',
      authTag: AUTH_TAG,
    },
    baseNow + MAX_MESH_CLOCK_SKEW_MS + 10_000
  );
  const futureCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone2',
    raw: futureMsg,
    replayGuard: guard,
    nowMs: baseNow,
  });
  assert.equal(futureCheck.ok, false);
  if (!futureCheck.ok) assert.equal(futureCheck.reason, 'timestamp_out_of_window');

  // 6) Wrong passphrase & spoofed peerId & missing security fields rejected
  const wrongPassCheck = verifyMeshMessageEnvelope({
    passphrase: 'Wrong-Passphrase',
    expectedPeerId: 'holoo-mesh-mehran-phone1',
    raw: freshSigned,
    replayGuard: guard,
    nowMs: baseNow + 5500,
  });
  assert.equal(wrongPassCheck.ok, false);
  if (!wrongPassCheck.ok) assert.equal(wrongPassCheck.reason, 'auth_tag_mismatch');

  const spoofedPeerCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone2',
    raw: freshSigned,
    replayGuard: guard,
    nowMs: baseNow + 5500,
  });
  assert.equal(spoofedPeerCheck.ok, false);
  if (!spoofedPeerCheck.ok) assert.equal(spoofedPeerCheck.reason, 'invalid_peer');

  const legacyUnsignedCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-phone1',
    raw: { type: 'mesh:request_state', fromPeerId: 'holoo-mesh-mehran-phone1', authTag: AUTH_TAG },
    replayGuard: guard,
    nowMs: baseNow + 5500,
  });
  assert.equal(legacyUnsignedCheck.ok, false);
  if (!legacyUnsignedCheck.ok) assert.equal(legacyUnsignedCheck.reason, 'missing_security_fields');

  // 7) Oversized payload DoS rejected BEFORE hashing
  const hugeSigned = signMeshMessageEnvelope(
    PASS,
    {
      type: 'mesh:state_payload',
      fromPeerId: 'holoo-mesh-mehran-laptop',
      authTag: AUTH_TAG,
      updatedAt: '2026-11-26T10:02:00.000Z',
      payloadHash: 'huge',
      vectorClock: {},
      snapshotJson: 'X'.repeat(50_000),
      relayEnvelopes: [],
    },
    baseNow + 6000
  );
  const dosCheck = verifyMeshMessageEnvelope({
    passphrase: PASS,
    expectedPeerId: 'holoo-mesh-mehran-laptop',
    raw: hugeSigned,
    replayGuard: guard,
    nowMs: baseNow + 6500,
    maxPayloadBytes: 32_768, // tight cap to simulate >16MB flood cleanly in test
  });
  assert.equal(dosCheck.ok, false);
  if (!dosCheck.ok) assert.equal(dosCheck.reason, 'payload_too_large');
});

runTest('4. MeshReplayGuard enforces strict bounded memory cap (<= 2048 entries) under 5,000-packet flood', () => {
  const guard = new MeshReplayGuard(MAX_MESH_CLOCK_SKEW_MS, MAX_SEEN_NONCES);
  const t0 = 1_760_100_000_000;

  for (let i = 0; i < 5000; i++) {
    const nonce = `nonce_${i.toString(16).padStart(20, '0')}`;
    const res = guard.checkAndRecord('holoo-mesh-mehran-laptop', nonce, t0 + i, t0 + i);
    assert.equal(res.ok, true);
    assert.ok(guard.getSize() <= MAX_SEEN_NONCES, `Expected cache size <= ${MAX_SEEN_NONCES}, got ${guard.getSize()}`);
  }
  assert.equal(guard.getSize(), MAX_SEEN_NONCES);

  // Advance clock past TTL -> expired entries prune to 0
  guard.pruneExpired(t0 + 5000 + MAX_MESH_CLOCK_SKEW_MS + 1000);
  assert.equal(guard.getSize(), 0);
});

// ============================================================================
// 3. REALISTIC 3-DEVICE OFFLINE MESH CONVERGENCE SIMULATION (LAPTOP + 2 PHONES)
// ============================================================================

runTest('5. 3-Device Mesh (Laptop + Phone1 + Phone2) converges identically via signed packets & LWW', () => {
  const devices: MeshDevicePeerId[] = [
    'holoo-mesh-mehran-laptop',
    'holoo-mesh-mehran-phone1',
    'holoo-mesh-mehran-phone2',
  ];
  const guards = new Map<MeshDevicePeerId, MeshReplayGuard>(
    devices.map((id) => [id, new MeshReplayGuard()])
  );

  // Each device starts from common base and makes independent offline edits
  const baseObj = {
    profile: { companyName: 'شرکت بازرگانی پارس نخ', fiscalYear: '1404', updatedAt: '2026-11-26T08:00:00.000Z' },
    vouchers: [] as Partial<Voucher>[],
    invoices: [] as Partial<Invoice>[],
    products: [{ id: 'p_shared', name: 'نخ ویسکوز ۳۰', stock: 500, sellPrice: 1_800_000, updatedAt: '2026-11-26T08:00:00.000Z' }],
    parties: [{ id: 'pty_1', name: 'بافندگی اطلس', openingBalance: 0, updatedAt: '2026-11-26T08:00:00.000Z' }],
    cheques: [] as Partial<Cheque>[],
  };

  let snapLaptop = tagSnapshotWithSyncMetadata(
    JSON.stringify({
      ...baseObj,
      invoices: [{ id: 'inv_L1', invoiceNumber: 'SL-1404-101', invoiceType: 'sale', grandTotal: 44_000_000, updatedAt: '2026-11-26T09:10:00.000Z' }],
      vouchers: [{ id: 'v_L1', voucherNumber: 201, status: 'permanent', totalDebit: 44_000_000, totalCredit: 44_000_000, updatedAt: '2026-11-26T09:10:00.000Z' }],
    }),
    'holoo-mesh-mehran-laptop',
    '2026-11-26T09:10:00.000Z'
  );

  let snapPhone1 = tagSnapshotWithSyncMetadata(
    JSON.stringify({
      ...baseObj,
      products: [{ id: 'p_shared', name: 'نخ ویسکوز ۳۰', stock: 460, sellPrice: 1_950_000, updatedAt: '2026-11-26T09:15:00.000Z' }],
      cheques: [{ id: 'chq_P1', sayadiId: '1234567890123456', serial: 'CH-901', amount: 15_000_000, dueDate: '1404/04/10', updatedAt: '2026-11-26T09:15:00.000Z' }],
    }),
    'holoo-mesh-mehran-phone1',
    '2026-11-26T09:15:00.000Z'
  );

  let snapPhone2 = tagSnapshotWithSyncMetadata(
    JSON.stringify({
      ...baseObj,
      parties: [
        baseObj.parties[0],
        { id: 'pty_P2', name: 'نساجی کویر یزد', openingBalance: 25_000_000, updatedAt: '2026-11-26T09:20:00.000Z' },
      ],
      vouchers: [{ id: 'v_P2', voucherNumber: 202, status: 'permanent', totalDebit: 12_000_000, totalCredit: 12_000_000, updatedAt: '2026-11-26T09:20:00.000Z' }],
    }),
    'holoo-mesh-mehran-phone2',
    '2026-11-26T09:20:00.000Z'
  );

  const now = Date.now();
  const transferSigned = (from: MeshDevicePeerId, to: MeshDevicePeerId, fromSnap: string, toSnap: string, offsetMs: number) => {
    const pkt = signMeshMessageEnvelope(
      PASS,
      {
        type: 'mesh:state_payload',
        fromPeerId: from,
        authTag: AUTH_TAG,
        updatedAt: new Date(now + offsetMs).toISOString(),
        payloadHash: `h_${from}_${offsetMs}`,
        vectorClock: { [from]: 1 },
        snapshotJson: fromSnap,
        relayEnvelopes: [],
      },
      now + offsetMs
    );
    const ver = verifyMeshMessageEnvelope({
      passphrase: PASS,
      expectedPeerId: from,
      raw: pkt,
      replayGuard: guards.get(to)!,
      nowMs: now + offsetMs + 250,
    });
    assert.deepEqual(ver, { ok: true });
    return mergeWorkspacesDeterministicLWW(toSnap, pkt.snapshotJson, to).mergedSnapshotJson;
  };

  // Topology: Laptop -> Phone1 -> Phone2 -> Laptop -> Phone1
  snapPhone1 = transferSigned('holoo-mesh-mehran-laptop', 'holoo-mesh-mehran-phone1', snapLaptop, snapPhone1, 1000);
  snapPhone2 = transferSigned('holoo-mesh-mehran-phone1', 'holoo-mesh-mehran-phone2', snapPhone1, snapPhone2, 2000);
  snapLaptop = transferSigned('holoo-mesh-mehran-phone2', 'holoo-mesh-mehran-laptop', snapPhone2, snapLaptop, 3000);
  snapPhone1 = transferSigned('holoo-mesh-mehran-laptop', 'holoo-mesh-mehran-phone1', snapLaptop, snapPhone1, 4000);

  const stateL = JSON.parse(snapLaptop);
  const stateP1 = JSON.parse(snapPhone1);
  const stateP2 = JSON.parse(snapPhone2);

  for (const st of [stateL, stateP1, stateP2]) {
    assert.equal(st.vouchers.length, 2);
    assert.equal(st.invoices.length, 1);
    assert.equal(st.cheques.length, 1);
    assert.equal(st.parties.length, 2);
    assert.equal(st.products[0].stock, 460);
    assert.equal(st.products[0].sellPrice, 1_950_000);
  }
});

// ============================================================================
// 4. CONFLICT RESOLVER PERSIAN PREVIEW ACCURACY
// ============================================================================

runTest('6. analyzeAccountingSnapshotConflict displays exact Holoo voucherNumber, permanent status, invoiceNumber & sellPrice', () => {
  const localSnap = JSON.stringify({
    vouchers: [{ id: 'v_c1', voucherNumber: 312, status: 'permanent', description: 'سند فروش رسمی', lines: [{ debit: 5_000_000, credit: 0 }, { debit: 0, credit: 5_000_000 }] }],
    invoices: [{ id: 'inv_c1', invoiceNumber: 'SL-404-08', invoiceType: 'sale', partyName: 'مشتری آلفا', grandTotal: 5_000_000, date: '1404/03/01' }],
    products: [{ id: 'p_c1', name: 'نخ اکریلیک', stock: 120, sellPrice: 2_400_000 }],
  });
  const remoteSnap = JSON.stringify({
    vouchers: [{ id: 'v_c1', voucherNumber: 312, status: 'draft', description: 'سند فروش رسمی (ویرایش همتا)', lines: [{ debit: 6_000_000, credit: 0 }, { debit: 0, credit: 6_000_000 }] }],
    invoices: [{ id: 'inv_c1', invoiceNumber: 'SL-404-08', invoiceType: 'sale', partyName: 'مشتری آلفا', grandTotal: 6_000_000, date: '1404/03/01' }],
    products: [{ id: 'p_c1', name: 'نخ اکریلیک', stock: 115, sellPrice: 2_500_000 }],
  });

  const summary = analyzeAccountingSnapshotConflict(localSnap, remoteSnap);
  assert.equal(summary.hasConflicts, true);
  assert.equal(summary.totalConflictingDocs, 3);

  const vItem = summary.previews.find((i) => i.collection === 'vouchers')!;
  assert.ok(vItem.title.includes('۳۱۲'), `Expected Persian voucherNumber ۳۱۲, got: ${vItem.title}`);
  assert.ok(vItem.localSummary?.includes('قطعی'), `Expected قطعی status, got: ${vItem.localSummary}`);

  const iItem = summary.previews.find((i) => i.collection === 'invoices')!;
  assert.ok(iItem.title.includes('فروش'), `Expected فروش type, got: ${iItem.title}`);
  assert.ok(iItem.title.includes('۴۰۴'), `Expected invoiceNumber, got: ${iItem.title}`);

  const pItem = summary.previews.find((i) => i.collection === 'products')!;
  assert.ok(pItem.localSummary?.includes('۲,۴۰۰,۰۰۰'), `Expected exact sellPrice, got: ${pItem.localSummary}`);
});

// ============================================================================
// 5. STANDALONE ANDROID PWA, IDB v2 & FIRESTORE RULES READINESS CHECK
// ============================================================================

runTest('7. Standalone Android/PWA assets, manifest config, IDB v2 schema & Firestore rules are release-ready', () => {
  const root = process.cwd();
  for (const rel of [
    'public/pwa-192x192.png',
    'public/pwa-512x512.png',
    'public/pwa-maskable-512x512.png',
    'public/apple-touch-icon.png',
    'public/icon.svg',
  ]) {
    const fullPath = path.join(root, rel);
    assert.ok(fs.existsSync(fullPath), `Missing PWA asset: ${rel}`);
    assert.ok(fs.statSync(fullPath).size > 200, `PWA asset appears empty: ${rel}`);
  }

  const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('mobile-web-app-capable'));
  assert.ok(indexHtml.includes('apple-touch-icon'));
  assert.ok(indexHtml.includes('theme-color'));
  assert.ok(indexHtml.includes('viewport-fit=cover'));

  const viteCfg = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.ok(viteCfg.includes("display: 'standalone'"));
  // GitHub Pages serves this app from a repository subpath; relative PWA URLs
  // keep the installed app and its navigation scoped to that deployment path.
  assert.ok(viteCfg.includes("base: '/Holo-11.29-/'"));
  assert.ok(viteCfg.includes("start_url: './'"));
  assert.ok(viteCfg.includes("scope: './'"));
  assert.ok(viteCfg.includes('pwa-maskable-512x512.png'));

  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.ok(rules.includes("'costLayers'"));
  assert.ok(rules.includes("'inventoryValueIrr'"));
  assert.ok(rules.includes("'reversalOfVoucherId'"));
  assert.ok(rules.includes("'integrityHash'"));

  const opDb = fs.readFileSync(path.join(root, 'src/lib/operationalDb.ts'), 'utf8');
  assert.ok(opDb.includes('OP_DB_VERSION = 6'));
  assert.ok(opDb.includes("operationalMigrationJournal"), 'v6 must add the durable migration journal store');
  assert.ok(opDb.includes('syncInbox'));
  assert.ok(opDb.includes('secureWorkspace'));
  assert.ok(opDb.includes('prepareEncryptedOperationalWorkspaceMigration'));
  const workspaceLoaderStart = opDb.indexOf('export async function loadOperationalWorkspace()');
  const workspaceLoaderEnd = opDb.indexOf('export function countOperationalWorkspaceRecords', workspaceLoaderStart);
  const workspaceLoader = opDb.slice(workspaceLoaderStart, workspaceLoaderEnd);
  for (const storeName of ['warehouses', 'taxReports', 'localProfiles', 'syncOutbox', 'syncInbox']) {
    assert.ok(workspaceLoader.includes(`'${storeName}'`), `Encrypted migration source must include ${storeName}`);
  }
  assert.ok(opDb.includes('schemaVersion: 2'), 'Encrypted workspace schema must version the auxiliary-store coverage');

  assert.ok(opDb.includes('commitStockAdjustmentOperationalTx'));

  const reportExport = fs.readFileSync(path.join(root, 'src/lib/accountingReportExport.ts'), 'utf8');
  assert.ok(
    !reportExport.includes('fonts.googleapis.com') && !reportExport.includes('fonts.gstatic.com'),
    'Print reports must be 100% self-hosted without external Google Fonts CDN links'
  );
});

// ============================================================================
// 6. OFFLINE-FIRST CORE: SHA-256, AES-256-GCM BACKUPS, 3 MODES, PBKDF2 AUTH
// ============================================================================

async function runAsyncTest(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function runOfflineFirstSuite() {
  await runAsyncTest('8. Collision-resistant 256-bit & SHA-256 snapshot digests ignore volatile timestamps and catch 1-Rial diffs', async () => {
    const base = JSON.stringify({
      exportedAt: '2026-11-26T08:00:00.000Z',
      mirroredAt: '2026-11-26T08:00:01.000Z',
      vouchers: [{ id: 'v1', totalDebit: 125_000_000, totalCredit: 125_000_000 }],
    });
    const sameDifferentStamp = JSON.stringify({
      exportedAt: '2026-11-26T12:34:56.789Z',
      mirroredAt: '2026-11-26T12:35:00.000Z',
      vouchers: [{ id: 'v1', totalDebit: 125_000_000, totalCredit: 125_000_000 }],
    });
    const oneRialDiff = JSON.stringify({
      exportedAt: '2026-11-26T08:00:00.000Z',
      mirroredAt: '2026-11-26T08:00:01.000Z',
      vouchers: [{ id: 'v1', totalDebit: 125_000_001, totalCredit: 125_000_001 }],
    });

    const sha1 = await computeSnapshotSha256Hex(base);
    const sha2 = await computeSnapshotSha256Hex(sameDifferentStamp);
    const sha3 = await computeSnapshotSha256Hex(oneRialDiff);

    assert.equal(sha1.length, 64);
    assert.match(sha1, /^[0-9a-f]{64}$/);
    assert.equal(sha1, sha2);
    assert.notEqual(sha1, sha3);

    assert.equal(computeSnapshotDigest256Sync(base), computeSnapshotDigest256Sync(sameDifferentStamp));
    assert.notEqual(computeSnapshotDigest256Sync(base), computeSnapshotDigest256Sync(oneRialDiff));
  });

  await runAsyncTest('9. AES-256-GCM encrypted offline backup round-trip, wrong password, tamper & schema guards', async () => {
    const snapshot = JSON.stringify({
      profile: { companyName: 'پارس نخ', fiscalYear: '1404' },
      vouchers: [{ id: 'v_sec_1', voucherNumber: 101, totalDebit: 90_000_000, totalCredit: 90_000_000 }],
    });

    const env = await encryptBackupEnvelope(snapshot, 'HolooVault#1404!');
    assert.equal(env.cipher, 'AES-256-GCM');
    assert.equal(env.kdf, 'PBKDF2-SHA256');
    assert.equal(env.plaintextSha256.length, 64);
    assert.ok(!env.ciphertextB64.includes('پارس نخ'));

    // Valid decrypt
    const okRes = await decryptAndVerifyBackupEnvelope(JSON.stringify(env), 'HolooVault#1404!');
    assert.equal(okRes.ok, true);
    assert.equal(okRes.snapshotJson, snapshot);
    assert.equal(okRes.sha256, env.plaintextSha256);

    // Wrong password rejected
    const wrongPass = await decryptAndVerifyBackupEnvelope(JSON.stringify(env), 'WrongPassword!');
    assert.equal(wrongPass.ok, false);

    // 1-char ciphertext tamper rejected by AES-GCM tag
    const tamperedCipher = {
      ...env,
      ciphertextB64: (env.ciphertextB64[0] === 'A' ? 'B' : 'A') + env.ciphertextB64.slice(1),
    };
    const tamperRes = await decryptAndVerifyBackupEnvelope(JSON.stringify(tamperedCipher), 'HolooVault#1404!');
    assert.equal(tamperRes.ok, false);

    // Tampered SHA-256 checksum rejected
    const tamperedHash = { ...env, plaintextSha256: '0'.repeat(64) };
    const hashRes = await decryptAndVerifyBackupEnvelope(JSON.stringify(tamperedHash), 'HolooVault#1404!');
    assert.equal(hashRes.ok, false);
    assert.ok(hashRes.error?.includes('SHA-256'));

    // Incompatible schema version rejected
    const badSchema = { ...env, schemaVersion: 99 };
    const schemaRes = await decryptAndVerifyBackupEnvelope(JSON.stringify(badSchema), 'HolooVault#1404!');
    assert.equal(schemaRes.ok, false);
  });

  await runAsyncTest('10. Operating modes (local / online / hybrid) preserve uninterrupted offline local writes', async () => {
    const localOnline = resolveEffectiveOperatingMode('local', true);
    assert.equal(localOnline.allowLocalWrites, true);
    assert.equal(localOnline.allowCloudPush, false);
    assert.equal(localOnline.allowCloudPull, false);
    assert.equal(localOnline.queueOutboxWhenOffline, false);

    const onlineWhenOffline = resolveEffectiveOperatingMode('online', false);
    assert.equal(onlineWhenOffline.effectiveMode, 'local');
    assert.equal(onlineWhenOffline.allowLocalWrites, true);
    assert.equal(onlineWhenOffline.allowCloudPush, false);
    assert.equal(onlineWhenOffline.queueOutboxWhenOffline, true);

    const hybridOffline = resolveEffectiveOperatingMode('hybrid', false);
    assert.equal(hybridOffline.allowLocalWrites, true);
    assert.equal(hybridOffline.allowCloudPush, false);
    assert.equal(hybridOffline.queueOutboxWhenOffline, true);

    const hybridOnline = resolveEffectiveOperatingMode('hybrid', true);
    assert.equal(hybridOnline.allowLocalWrites, true);
    assert.equal(hybridOnline.allowCloudPush, true);
    assert.equal(hybridOnline.allowCloudPull, true);
  });

  await runAsyncTest('11. Offline PBKDF2 local profile auth stores zero plaintext, enforces expiry & isolates workspaces', async () => {
    const rec = await createLocalOfflinePasscodeRecord({
      workspaceId: 'co_pars_nakh',
      deviceId: 'dev_android_1',
      passcode: '741852',
      sessionTtlHours: 24,
    });
    assert.equal(rec.authScope, 'local_only');
    assert.equal(rec.kdf, 'PBKDF2-SHA256');
    assert.ok(!JSON.stringify(rec).includes('741852'));

    const valid = await verifyLocalOfflinePasscode(rec, '741852');
    assert.deepEqual(valid, { valid: true, expired: false });

    const invalid = await verifyLocalOfflinePasscode(rec, '000000');
    assert.deepEqual(invalid, { valid: false, expired: false });

    const expired = await verifyLocalOfflinePasscode(rec, '741852', Date.parse(rec.expiresAt) + 5000);
    assert.deepEqual(expired, { valid: false, expired: true });

    const keyA = buildIsolatedWorkspaceStorageKey('company-A', 'snapshot');
    const keyB = buildIsolatedWorkspaceStorageKey('company-B', 'snapshot');
    assert.notEqual(keyA, keyB);
    assert.ok(keyA.startsWith('holoo_ws_company-A__'));
  });

  await runAsyncTest('12. Exponential backoff, storage quota thresholds & financial conflict human-review guards', async () => {
    const b0 = computeSyncBackoffMs(0, 2000, 60_000, 0);
    const b1 = computeSyncBackoffMs(1, 2000, 60_000, 0);
    const b2 = computeSyncBackoffMs(2, 2000, 60_000, 0);
    const bCap = computeSyncBackoffMs(15, 2000, 60_000, 0);
    assert.equal(b0, 2000);
    assert.equal(b1, 4000);
    assert.equal(b2, 8000);
    assert.equal(bCap, 60_000);

    const okHealth = evaluateStorageHealthSnapshot(100_000_000, 1_000_000_000, true);
    assert.equal(okHealth.status, 'ok');
    assert.equal(okHealth.warningMessage, null);

    const warnHealth = evaluateStorageHealthSnapshot(850_000_000, 1_000_000_000, false);
    assert.equal(warnHealth.status, 'warning');
    assert.ok(warnHealth.warningMessage);

    const critHealth = evaluateStorageHealthSnapshot(950_000_000, 1_000_000_000, false);
    assert.equal(critHealth.status, 'critical');
    assert.ok(critHealth.warningMessage);

    // Financial conflict review guard
    assert.equal(
      requiresManualFinancialConflictReview('vouchers', { status: 'permanent', totalDebit: 100 }, { status: 'permanent', totalDebit: 100 }),
      true
    );
    assert.equal(
      requiresManualFinancialConflictReview('vouchers', { status: 'draft', totalDebit: 100 }, { status: 'draft', totalDebit: 100 }),
      false
    );
    assert.equal(
      requiresManualFinancialConflictReview('invoices', { invoiceType: 'sale', grandTotal: 500 }, { invoiceType: 'sale', grandTotal: 500 }),
      true
    );
    assert.equal(
      requiresManualFinancialConflictReview('products', { stock: 10, inventoryValueIrr: 1000 }, { stock: 9, inventoryValueIrr: 900 }),
      true
    );
    assert.equal(
      requiresManualFinancialConflictReview('cheques', { status: 'pending', amount: 500 }, { status: 'cleared', amount: 500 }),
      true
    );
  });

  console.log(`\nAll ${passed} enterprise mesh, atomicity, security & offline-first PWA audit tests passed!`);
}

runOfflineFirstSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
