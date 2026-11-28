import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { computeOperationalMigrationDigest, verifyOperationalMigrationStoreDigests } from '../src/lib/operationalMigrationDigest';

async function run() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    const first = await computeOperationalMigrationDigest('accounts', [
      { id: 'b', title: 'Bank', balance: 20 },
      { balance: 10, title: 'Cash', id: 'a' },
    ]);
    const reordered = await computeOperationalMigrationDigest('accounts', [
      { id: 'a', title: 'Cash', balance: 10 },
      { title: 'Bank', balance: 20, id: 'b' },
    ]);
    assert.equal(first, reordered, 'digest must ignore cursor and object property order');
    assert.match(first, /^[a-f0-9]{64}$/);
    const verified = await verifyOperationalMigrationStoreDigests('accounts', [
      { id: 'a', title: 'Cash', balance: 10 },
      { id: 'b', title: 'Bank', balance: 20 },
    ], [
      { title: 'Bank', balance: 20, id: 'b' },
      { balance: 10, title: 'Cash', id: 'a' },
    ]);
    assert.equal(verified.verified, true);
    assert.equal(verified.sourceRecordCount, 2);
    assert.equal(verified.sourceDigest, verified.targetDigest);
    await assert.rejects(
      () => verifyOperationalMigrationStoreDigests('accounts', [{ id: 'a', value: 1 }], []),
      /record counts differ/
    );
    await assert.rejects(
      () => verifyOperationalMigrationStoreDigests('accounts', [{ id: 'a', value: 1 }], [{ id: 'a', value: 2 }]),
      /digests differ/
    );
    assert.notEqual(first, await computeOperationalMigrationDigest('products', [
      { id: 'a', title: 'Cash', balance: 10 },
      { id: 'b', title: 'Bank', balance: 20 },
    ]), 'digest must bind the logical store');
    assert.notEqual(first, await computeOperationalMigrationDigest('accounts', [
      { id: 'a', title: 'Cash', balance: 11 },
      { id: 'b', title: 'Bank', balance: 20 },
    ]), 'digest must detect record changes');
    await assert.rejects(() => computeOperationalMigrationDigest('accounts', [
      { id: 'same', value: 1 }, { id: 'same', value: 2 },
    ]), /duplicate primary keys/);
    await assert.rejects(() => computeOperationalMigrationDigest('accounts', [
      { id: 'bad', amount: Number.NaN },
    ]), /non-finite/);
    console.log('Operational migration digest: canonical ordering, store binding, mutation and malformed-record checks passed');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'crypto', previous);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
