import assert from 'node:assert/strict';
import {
  readLegacyPlaintextSyncCloseSnapshot,
  readSyncCloseSnapshot,
  saveSyncCloseSnapshot,
} from '../src/lib/localBackup';

async function run() {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    },
  });

  try {
    const payloadJson = JSON.stringify({
      profile: { companyName: 'Plaintext Guard Test' },
      accounts: [{ code: '101', title: 'Cash' }],
      vouchers: [],
    });

    const result = saveSyncCloseSnapshot({
      payloadJson,
      reason: 'before_close',
      companyName: 'Plaintext Guard Test',
      voucherCount: 0,
      invoiceCount: 0,
      productCount: 0,
    });

    assert.equal(result, null, 'synchronous close path must not persist plaintext');
    assert.equal(values.has('holoo_apex_last_close_snapshot_v1'), false,
      'synchronous close path must not write the financial payload to localStorage');
    assert.equal(readSyncCloseSnapshot(), null,
      'normal hydration must not read an absent or plaintext close snapshot');

    values.set('holoo_apex_last_close_snapshot_v1', JSON.stringify({
      id: 'legacy_close_1',
      payloadJson,
      savedAt: new Date().toISOString(),
      reason: 'before_close',
    }));
    assert.equal(readSyncCloseSnapshot(), null,
      'legacy plaintext close snapshot must remain excluded from automatic hydration');
    assert.equal(readLegacyPlaintextSyncCloseSnapshot()?.payloadJson, payloadJson,
      'legacy plaintext snapshot remains available only through the explicit migration reader');

    console.log('Local backup plaintext close-snapshot guard: 5 assertions passed');
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
