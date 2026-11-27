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

    // Unknown collections remain denied by the global default-deny rule.
    await assertFails(setDoc(doc(ownerA, 'unexpectedCollection', 'unexpected'), {
      ownerId: 'company_a',
    }));

    console.log('Firestore Emulator security tests: 12 passed, 0 failed');
  } finally {
    await testEnv.cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  throw error;
});
