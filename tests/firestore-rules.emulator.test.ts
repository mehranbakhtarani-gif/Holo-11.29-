import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

const projectId = 'demo-holoo-firestore-rules';
let testEnv: RulesTestEnvironment;

const makeVoucher = (ownerId: string, overrides: Record<string, unknown> = {}) => ({
  ownerId,
  voucherNumber: 1,
  date: '1405/01/01',
  description: 'Emulator security test',
  voucherType: 'general',
  status: 'draft',
  totalDebit: 0,
  totalCredit: 0,
  lines: [
    { accountCode: '10101', accountTitle: 'Cash', description: 'Debit', debit: 0, credit: 0 },
    { accountCode: '40101', accountTitle: 'Revenue', description: 'Credit', debit: 0, credit: 0 },
  ],
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
});

const makeInvoice = (ownerId: string, overrides: Record<string, unknown> = {}) => ({
  ownerId,
  invoiceNumber: 'INV-001',
  invoiceType: 'sale',
  date: '1405/01/01',
  partyId: 'party_1',
  partyName: 'Test customer',
  warehouse: 'Main',
  subtotal: 1000,
  discount: 0,
  vatAmount: 0,
  grandTotal: 1000,
  paidCash: 0,
  paidBank: 0,
  paidCheque: 0,
  creditAmount: 1000,
  status: 'issued',
  items: [{ productId: 'product_1', quantity: 1, lineTotal: 1000 }],
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...overrides,
});

async function run() {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: await readFile('firestore.rules', 'utf8'),
    },
  });

  try {
    await testEnv.clearFirestore();

    const ownerA = testEnv.authenticatedContext('company_a', {
      email: 'a@example.test',
      email_verified: true,
    }).firestore();
    const ownerB = testEnv.authenticatedContext('company_b', {
      email: 'b@example.test',
      email_verified: true,
    }).firestore();
    const unverified = testEnv.authenticatedContext('unverified_user', {
      email: 'u@example.test',
      email_verified: false,
    }).firestore();
    const anonymous = testEnv.unauthenticatedContext().firestore();

    // A verified owner can create a correctly scoped account.
    await assertSucceeds(setDoc(doc(ownerA, 'accounts', 'cash_10101'), {
      ownerId: 'company_a',
      code: '10101',
      title: 'Cash',
      level: 'moein',
      category: 'asset',
      nature: 'debit',
      isSystem: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Cross-company reads and owner spoofing must be denied.
    await assertFails(getDoc(doc(ownerB, 'accounts', 'cash_10101')));
    await assertFails(setDoc(doc(ownerB, 'accounts', 'spoofed_account'), {
      ownerId: 'company_a',
      code: '10102',
      title: 'Spoofed',
      level: 'moein',
      category: 'asset',
      nature: 'debit',
      isSystem: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Unverified and anonymous identities cannot write tenant data.
    await assertFails(setDoc(doc(unverified, 'accounts', 'unverified_account'), {
      ownerId: 'unverified_user',
      code: '10103',
      title: 'Unverified',
      level: 'moein',
      category: 'asset',
      nature: 'debit',
      isSystem: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(setDoc(doc(anonymous, 'accounts', 'anonymous_account'), {
      ownerId: 'anonymous',
      code: '10104',
      title: 'Anonymous',
      level: 'moein',
      category: 'asset',
      nature: 'debit',
      isSystem: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Query constraints are tenant-scoped; company B cannot enumerate A's rows.
    const companyBRows = await assertSucceeds(getDocs(query(
      collection(ownerB, 'accounts'),
      where('ownerId', '==', 'company_b'),
    )));
    assert.equal(companyBRows.size, 0);

    // Valid draft voucher accepted; unbalanced and unsafe-precision vouchers rejected.
    await assertSucceeds(setDoc(doc(ownerA, 'vouchers', 'valid_draft'), makeVoucher('company_a')));
    await assertFails(setDoc(doc(ownerA, 'vouchers', 'unbalanced'), makeVoucher('company_a', {
      totalDebit: 100,
      totalCredit: 90,
    })));
    await assertFails(setDoc(doc(ownerA, 'vouchers', 'unsafe_amount'), makeVoucher('company_a', {
      totalDebit: Number.MAX_SAFE_INTEGER + 1,
      totalCredit: Number.MAX_SAFE_INTEGER + 1,
    })));

    // Invoice amount fields must be non-negative safe integers.
    await assertSucceeds(setDoc(doc(ownerA, 'invoices', 'valid_invoice'), makeInvoice('company_a')));
    await assertFails(setDoc(doc(ownerA, 'invoices', 'negative_invoice'), makeInvoice('company_a', {
      discount: -1,
    })));

    // Tracked warehouse transfers are tenant-scoped, bounded map records and may be updated by their owner.
    const transferDoc = doc(ownerA, 'workspaceExtensions', 'company_a');
    const trackedTransfer = {
      id: 'trf_001',
      transferNumber: 'TRF-1405-001',
      productId: 'product_1',
      qty: 2.5,
      transferredCostIrr: 2500,
      transferredLayers: [{ layerId: 'layer_1', remainingQty: 2.5, totalCostIrr: 2500 }],
      status: 'in_transit',
      fromWarehouse: 'Main',
      toWarehouse: 'Branch',
    };
    await assertSucceeds(setDoc(transferDoc, {
      ownerId: 'company_a',
      warehouseTransfers: [trackedTransfer],
      _version: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertFails(getDoc(doc(ownerB, 'workspaceExtensions', 'company_a')));
    await assertSucceeds(setDoc(transferDoc, {
      warehouseTransfers: [{ ...trackedTransfer, status: 'received' }],
      _version: 2,
      updatedByDevice: 'device_a',
      updatedAt: serverTimestamp(),
    }, { merge: true }));
    await assertFails(setDoc(transferDoc, {
      warehouseTransfers: Array.from({ length: 251 }, (_, index) => ({ ...trackedTransfer, id: `trf_${index}` })),
      _version: 3,
      updatedByDevice: 'device_a',
      updatedAt: serverTimestamp(),
    }, { merge: true }));

    // Warehouse transfer commits must be allowed to update cost layers and inventory valuation atomically.
    const productDoc = doc(ownerA, 'products', 'transfer_product');
    await assertSucceeds(setDoc(productDoc, {
      ownerId: 'company_a',
      sku: 'TR-001',
      name: 'Transfer yarn',
      category: 'Yarn',
      warehouse: 'Main',
      unit: 'kg',
      buyPrice: 1000,
      sellPrice: 1200,
      stock: 10,
      reorderPoint: 0,
      vatExempt: false,
      costingMethod: 'fifo',
      costLayers: [{ layerId: 'opening-1', remainingQty: 10, totalCostIrr: 10000 }],
      inventoryValueIrr: 10000,
      _version: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(productDoc, {
      stock: 10,
      buyPrice: 1000,
      lotNumber: '',
      costLayers: [{ layerId: 'opening-1', remainingQty: 8, totalCostIrr: 8000 }],
      inventoryValueIrr: 10000,
      _version: 2,
      updatedByDevice: 'device_a',
      updatedAt: serverTimestamp(),
    }, { merge: true }));

    // Restore the in-transit state, then verify receipt and product cost-layer changes commit atomically.
    await assertSucceeds(setDoc(transferDoc, {
      warehouseTransfers: [trackedTransfer],
      _version: 3,
      updatedByDevice: 'device_a',
      updatedAt: serverTimestamp(),
    }, { merge: true }));
    await assertSucceeds(runTransaction(ownerA, async (transaction) => {
      const [productSnap, extensionSnap] = await Promise.all([
        transaction.get(productDoc),
        transaction.get(transferDoc),
      ]);
      assert.equal(productSnap.exists(), true);
      assert.equal(extensionSnap.exists(), true);
      const currentExtension = extensionSnap.data();
      assert.ok(currentExtension);
      const currentTransfers = currentExtension.warehouseTransfers as Array<Record<string, unknown>>;
      assert.equal(currentTransfers.some((item) => item.id === 'trf_001' && item.status === 'in_transit'), true);
      transaction.update(productDoc, {
        stock: 10,
        costLayers: [{ layerId: 'opening-1', remainingQty: 8, totalCostIrr: 8000 }],
        inventoryValueIrr: 10000,
        _version: 4,
        updatedByDevice: 'device_a',
        updatedAt: serverTimestamp(),
      });
      transaction.update(transferDoc, {
        warehouseTransfers: currentTransfers.map((item) =>
          item.id === 'trf_001' ? { ...item, status: 'received' } : item
        ),
        _version: 4,
        updatedByDevice: 'device_a',
        updatedAt: serverTimestamp(),
      });
    }));
    const [committedProduct, committedExtensions] = await Promise.all([
      getDoc(productDoc),
      getDoc(transferDoc),
    ]);
    assert.equal(committedProduct.data()?.costLayers?.[0]?.remainingQty, 8);
    assert.equal(committedExtensions.data()?.warehouseTransfers?.[0]?.status, 'received');

    // New cloud backups must contain an encrypted envelope, never a plaintext snapshot map.
    const encryptedCloudBackup = {
      ownerId: 'company_a',
      revision: 1,
      reason: 'manual_push',
      deviceId: 'device_a',
      deviceLabel: 'Finance workstation',
      companyName: 'Test company',
      fiscalYear: '1405',
      savedAtMs: Date.now(),
      savedAtShamsi: '1405/01/01',
      voucherCount: 1,
      invoiceCount: 1,
      productCount: 1,
      sizeKb: 4,
      snapshotEnvelope: 'eyJmb3JtYXQiOiJob2xvby1hcGV4LWVuY3J5cHRlZC1iYWNrdXAifQ==',
      encryption: 'PBKDF2-SHA256+AES-256-GCM',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await assertSucceeds(setDoc(doc(ownerA, 'cloudBackups', 'encrypted_backup'), encryptedCloudBackup));
    const { snapshotEnvelope: _envelope, encryption: _encryption, ...legacyCloudBackup } = encryptedCloudBackup;
    await assertFails(setDoc(doc(ownerA, 'cloudBackups', 'plaintext_backup'), {
      ...legacyCloudBackup,
      snapshot: { accounts: [{ code: '101', balance: 500 }] },
    }));

    // Unknown collections remain denied by the global default-deny rule.
    await assertFails(setDoc(doc(ownerA, 'unexpectedCollection', 'unexpected'), {
      ownerId: 'company_a',
    }));

    console.log('Firestore Emulator security tests: tracked warehouse transfer access covered');
  } finally {
    await testEnv.cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  throw error;
});
