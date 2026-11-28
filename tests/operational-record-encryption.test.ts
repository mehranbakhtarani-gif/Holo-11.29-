import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createOperationalDataSalt,
  decryptOperationalRecord,
  deriveOperationalDataKey,
  encryptOperationalRecord,
} from '../src/lib/operationalRecordEncryption';

async function run() {
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    const salt = createOperationalDataSalt();
    assert.equal(salt.byteLength, 16);
    const key = await deriveOperationalDataKey('OperationalEncryption#1405', salt);
    assert.equal(key.type, 'secret');
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ['encrypt', 'decrypt']);

    const context = { workspaceId: 'workspace-A', store: 'vouchers' as const, recordId: 'voucher-42' };
    const record = {
      id: 'voucher-42',
      voucherNumber: 'V-1405-0042',
      lines: [{ accountId: '101', debit: 2500, credit: 0 }, { accountId: '201', debit: 0, credit: 2500 }],
    };
    const envelope = await encryptOperationalRecord(record, context, key);
    assert.equal(envelope.workspaceId, context.workspaceId);
    assert.equal(envelope.store, context.store);
    assert.equal(envelope.recordId, context.recordId);
    assert.notEqual(envelope.ciphertextB64, JSON.stringify(record));
    assert.deepEqual(await decryptOperationalRecord<typeof record>(envelope, context, key), record);

    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, workspaceId: 'workspace-B' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be movable to another workspace'
    );
    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, recordId: 'voucher-43' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be movable to another primary key'
    );
    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, store: 'invoices' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be moved between object stores'
    );

    await assert.rejects(
      () => encryptOperationalRecord(record, { ...context, store: 'meta' as typeof context.store }, key),
      /context is invalid/,
      'runtime callers cannot encrypt into stores outside the approved encrypted-store allowlist'
    );

    const otherKey = await deriveOperationalDataKey('DifferentEncryption#1405', salt);
    await assert.rejects(
      () => decryptOperationalRecord(envelope, context, otherKey),
      /operation|decrypt|authentication/i,
      'wrong keys must fail authentication'
    );

    const tampered = { ...envelope, ciphertextB64: envelope.ciphertextB64.slice(0, -4) + 'AAAA' };
    await assert.rejects(
      () => decryptOperationalRecord(tampered, context, key),
      /operation|decrypt|authentication/i,
      'modified ciphertext must fail authentication'
    );

    const freshEnvelope = await encryptOperationalRecord(record, context, key);
    assert.notEqual(envelope.ivB64, freshEnvelope.ivB64, 'every record encryption must use a fresh random IV');
    assert.notEqual(envelope.ciphertextB64, freshEnvelope.ciphertextB64);

    await assert.rejects(() => deriveOperationalDataKey('short', salt), /at least 10/);
    await assert.rejects(() => deriveOperationalDataKey('OperationalEncryption#1405', new Uint8Array(8)), /16 bytes/);
    await assert.rejects(
      () => deriveOperationalDataKey('OperationalEncryption#1405', salt, 100_000),
      /work factor/
    );

    console.log('Operational record encryption codec: 18 assertions passed');
  } finally {
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
