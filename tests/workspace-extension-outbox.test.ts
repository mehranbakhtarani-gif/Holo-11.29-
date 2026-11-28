import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import {
  createEncryptedWorkspaceExtensionOutboxOperation,
  decryptWorkspaceExtensionOutboxOperation,
} from '../src/lib/workspaceExtensionOutbox';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto as unknown as Crypto });
}

const passphrase = 'workspace-outbox-test-passphrase';
const previous = {
  bankLoans: [{ id: 'loan-1', principalIrr: 1_000_000 }],
  warehouseTransfers: [],
};
const next = {
  bankLoans: [{ id: 'loan-1', principalIrr: 1_250_000 }],
  warehouseTransfers: [{ id: 'transfer-1', productId: 'product-1', qty: 2, status: 'in_transit' }],
};

const operation = await createEncryptedWorkspaceExtensionOutboxOperation({
  workspaceId: 'workspace-user-1',
  deviceId: 'device-1',
  clientRevision: 12,
  previous,
  next,
  passphrase,
  createdAt: '2026-11-28T08:00:00.000Z',
});

assert.equal(operation.target, 'firebase');
assert.equal(operation.status, 'pending');
assert.equal(operation.payload, undefined, 'sensitive payload must never be written in plaintext');
assert.ok(operation.encryptedPayload);
assert.equal(operation.payloadHash.length, 64);
assert.ok(!operation.encryptedPayload.includes('principalIrr'));
assert.ok(!operation.encryptedPayload.includes('1_250_000'));

const restored = await decryptWorkspaceExtensionOutboxOperation(
  operation,
  'workspace-user-1',
  passphrase
);
assert.deepEqual(restored, {
  schemaVersion: 1,
  workspaceId: 'workspace-user-1',
  previous,
  next,
});
assert.equal(
  await decryptWorkspaceExtensionOutboxOperation(operation, 'another-workspace', passphrase),
  null,
  'outbox records must be bound to their originating workspace'
);
assert.equal(
  await decryptWorkspaceExtensionOutboxOperation(operation, 'workspace-user-1', 'incorrect-passphrase'),
  null,
  'wrong session key must not recover queued financial data'
);

const tampered = { ...operation };
const envelope = JSON.parse(tampered.encryptedPayload!);
const ciphertext = envelope.ciphertextB64 as string;
envelope.ciphertextB64 = ciphertext.slice(0, 40) + (ciphertext[40] === 'A' ? 'B' : 'A') + ciphertext.slice(41);
tampered.encryptedPayload = JSON.stringify(envelope);
assert.equal(
  await decryptWorkspaceExtensionOutboxOperation(tampered, 'workspace-user-1', passphrase),
  null,
  'tampered ciphertext must be rejected'
);

await assert.rejects(
  () => createEncryptedWorkspaceExtensionOutboxOperation({
    workspaceId: 'workspace-user-1',
    deviceId: 'device-1',
    clientRevision: 12,
    previous: JSON.parse('{"__proto__":{"polluted":true}}'),
    next,
    passphrase,
  }),
  /invalid/i,
  'prototype-sensitive payloads must be rejected before encryption'
);


Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { indexedDB },
});
const operationalDb = await import('../src/lib/operationalDb');
const { operationalSyncPersistencePort } = await import('../src/lib/repositoryAbstraction');
await operationalSyncPersistencePort.enqueueOutbox(operation);
await operationalSyncPersistencePort.enqueueOutbox({
  operationId: 'supabase_pending_1',
  target: 'supabase',
  workspaceId: 'workspace-user-1',
  deviceId: 'device-1',
  clientRevision: 12,
  payloadHash: 'a'.repeat(64),
  createdAt: '2026-11-28T08:00:01.000Z',
  retryCount: 0,
  status: 'pending',
});
assert.deepEqual(
  (await operationalSyncPersistencePort.listPendingOutbox()).map((item) => item.operationId),
  [operation.operationId, 'supabase_pending_1'],
  'the typed port must expose durable pending operations'
);
await operationalSyncPersistencePort.markOutboxStatus('supabase_pending_1', 'conflict');
assert.deepEqual(
  (await operationalSyncPersistencePort.listPendingOutbox()).map((item) => item.operationId),
  [operation.operationId],
  'conflict operations must not be replayed as pending'
);
await operationalSyncPersistencePort.clearPendingOutbox();
const pendingAfterCloudCleanup = await operationalSyncPersistencePort.listPendingOutbox();
assert.deepEqual(
  pendingAfterCloudCleanup.map((item) => item.operationId),
  [operation.operationId],
  'generic cloud cleanup must preserve encrypted Firebase extension mutations'
);
await operationalSyncPersistencePort.markOutboxStatus(operation.operationId, 'conflict');
assert.equal((await operationalSyncPersistencePort.listPendingOutbox()).length, 0);
await operationalSyncPersistencePort.markOutboxStatus(operation.operationId, 'synced');
assert.equal((await operationalSyncPersistencePort.listPendingOutbox()).length, 0);
await operationalSyncPersistencePort.recordInbox({
  operationId: 'inbound-duplicate-1',
  sourceDeviceId: 'peer-1',
  payloadHash: 'b'.repeat(64),
  receivedAt: '2026-11-28T08:00:02.000Z',
});
assert.equal(await operationalSyncPersistencePort.hasProcessedInbox('inbound-duplicate-1'), true);
assert.equal(await operationalSyncPersistencePort.hasProcessedInbox('unknown-inbound'), false);
operationalDb.setOperationalRestoreBarrier(true);
assert.equal(operationalSyncPersistencePort.isRestoreBarrierActive(), true);
operationalDb.setOperationalRestoreBarrier(false);
assert.equal(operationalSyncPersistencePort.isRestoreBarrierActive(), false);

console.log('Encrypted workspace extension outbox tests passed');
