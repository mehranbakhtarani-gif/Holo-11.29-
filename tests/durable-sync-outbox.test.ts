import assert from 'node:assert/strict';
import { restoreDurableSyncOperation } from '../src/lib/repositoryAbstraction';
import type { SyncOutboxOperation } from '../src/lib/operationalDb';

const row: SyncOutboxOperation = {
  operationId: 'op_restart_1',
  target: 'supabase',
  workspaceId: 'workspace-1',
  deviceId: 'device-1',
  clientRevision: 4,
  baseRevision: 3,
  entityKind: 'vouchers',
  entityId: 'voucher-1',
  payloadHash: 'sha256:abc',
  payload: { id: 'voucher-1', totalDebit: 100, totalCredit: 100 },
  createdAt: '2026-11-27T10:00:00.000Z',
  retryCount: 2,
  nextRetryAt: '2026-11-27T10:01:00.000Z',
  status: 'pending',
};

const restored = restoreDurableSyncOperation(row);
assert.equal(restored.operationId, row.operationId);
assert.equal(restored.entityKind, 'vouchers');
assert.equal(restored.entityId, 'voucher-1');
assert.equal(restored.baseRevision, 3);
assert.deepEqual(restored.payload, row.payload);
assert.equal(restored.payloadHashSha256, row.payloadHash);
assert.equal(restored.nextRetryAtMs, Date.parse(row.nextRetryAt!));

assert.throws(
  () => restoreDurableSyncOperation({ ...row, payload: undefined }),
  /automatic replay is blocked/
);
assert.throws(
  () => restoreDurableSyncOperation({ ...row, entityId: undefined }),
  /automatic replay is blocked/
);

console.log('Durable sync outbox restart tests: 7 assertions passed');
