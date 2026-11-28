import assert from 'node:assert/strict';
import {
  advanceOperationalMigrationStoreCheckpoint,
  assertOperationalMigrationBinding,
  createOperationalMigrationJournalRecord,
  isValidOperationalMigrationJournalRecord,
  transitionOperationalMigrationPhase,
} from '../src/lib/operationalMigrationJournal';

const now = '2026-11-28T12:00:00.000Z';
const binding = {
  workspaceId: 'workspace-1',
  migrationId: 'migration_run_0001',
  sourceRevision: 42,
  backupSessionGeneration: 7,
};
const sourceDigest = 'a'.repeat(64);
const record = createOperationalMigrationJournalRecord({
  ...binding,
  sourceSchemaVersion: 5,
  targetFormatVersion: 2,
  storeNames: ['accounts', 'vouchers'],
  now,
});

assert.equal(record.phase, 'preparing');
assert.equal(isValidOperationalMigrationJournalRecord(record), true);
assert.equal(record.stores.length, 2);
assert.throws(() => assertOperationalMigrationBinding(record, {
  ...binding,
  workspaceId: 'workspace-2',
}), /stale|another workspace/);
assert.throws(() => createOperationalMigrationJournalRecord({
  ...binding,
  sourceSchemaVersion: 5,
  targetFormatVersion: 2,
  storeNames: ['accounts', 'accounts'],
  now,
}), /invalid/);
assert.equal(isValidOperationalMigrationJournalRecord({
  ...record,
  passphrase: 'must-not-be-journaled',
}), false);

let current = transitionOperationalMigrationPhase(record, 'copying', now);
const copying = (sequence: number, copied: number, cursor: string | null) => ({
  state: 'copying' as const,
  cursor,
  batchSequence: sequence,
  sourceRecordCount: 2,
  copiedRecordCount: copied,
  sourceDigest,
  targetDigest: null,
});
current = advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', copying(1, 1, 'account-1'), binding, now
);
assert.equal(current.stores[0].batchSequence, 1);
assert.throws(() => advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', copying(1, 2, 'account-2'), binding, now
), /non-monotonic/);
assert.throws(() => advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', copying(2, 2, 'account-2'), { ...binding, backupSessionGeneration: 8 }, now
), /stale|another workspace/);
assert.throws(() => advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', { ...copying(2, 2, 'account-2'), sourceRecordCount: 3 }, binding, now
), /non-monotonic/);

current = advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', copying(2, 2, 'account-2'), binding, now
);
assert.throws(() => advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', {
    ...copying(3, 2, 'account-2'),
    state: 'verified',
    targetDigest: 'b'.repeat(64),
  }, binding, now
), /invalid/);

current = advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', {
    ...copying(3, 2, 'account-2'),
    state: 'verified',
    targetDigest: sourceDigest,
  }, binding, now
);
current = advanceOperationalMigrationStoreCheckpoint(
  current, 'vouchers', {
    state: 'copying',
    cursor: 'voucher-2',
    batchSequence: 1,
    sourceRecordCount: 0,
    copiedRecordCount: 0,
    sourceDigest,
    targetDigest: null,
  }, binding, now
);
current = advanceOperationalMigrationStoreCheckpoint(
  current, 'vouchers', {
    state: 'verified',
    cursor: null,
    batchSequence: 2,
    sourceRecordCount: 0,
    copiedRecordCount: 0,
    sourceDigest,
    targetDigest: sourceDigest,
  }, binding, now
);
current = transitionOperationalMigrationPhase(current, 'verifying', now);
current = transitionOperationalMigrationPhase(current, 'ready_to_cutover', now);
assert.equal(current.phase, 'ready_to_cutover');

current = advanceOperationalMigrationStoreCheckpoint(
  current, 'accounts', {
    state: 'committed',
    cursor: 'account-2',
    batchSequence: 4,
    sourceRecordCount: 2,
    copiedRecordCount: 2,
    sourceDigest,
    targetDigest: sourceDigest,
  }, binding, now
);
current = advanceOperationalMigrationStoreCheckpoint(
  current, 'vouchers', {
    state: 'committed',
    cursor: null,
    batchSequence: 3,
    sourceRecordCount: 0,
    copiedRecordCount: 0,
    sourceDigest,
    targetDigest: sourceDigest,
  }, binding, now
);
current = transitionOperationalMigrationPhase(current, 'cutover_committed', now);
assert.equal(current.phase, 'cutover_committed');
assert.equal(isValidOperationalMigrationJournalRecord(current), true);

assert.throws(() => transitionOperationalMigrationPhase(
  current, 'copying', now
), /Illegal operational migration phase transition/);

assert.equal(isValidOperationalMigrationJournalRecord({
  ...current,
  phase: 'cutover_committed',
  stores: current.stores.map((store) => ({ ...store, state: 'verified' })),
}), false, 'a cutover terminal phase must not validate while any store is uncommitted');

// Rollback can close both a partially copied store and a store never started.
const rollbackBinding = {
  workspaceId: 'workspace-rollback',
  migrationId: 'migration_rollback_001',
  sourceRevision: 9,
  backupSessionGeneration: 3,
};
let rollback = createOperationalMigrationJournalRecord({
  ...rollbackBinding,
  sourceSchemaVersion: 5,
  targetFormatVersion: 2,
  storeNames: ['accounts', 'vouchers'],
  now,
});
rollback = transitionOperationalMigrationPhase(rollback, 'copying', now);
rollback = advanceOperationalMigrationStoreCheckpoint(rollback, 'accounts', {
  state: 'copying', cursor: 'account-1', batchSequence: 1,
  sourceRecordCount: 1, copiedRecordCount: 0,
  sourceDigest, targetDigest: null,
}, rollbackBinding, now);
rollback = transitionOperationalMigrationPhase(rollback, 'rolling_back', now);
rollback = advanceOperationalMigrationStoreCheckpoint(rollback, 'accounts', {
  state: 'rolled_back', cursor: 'account-1', batchSequence: 2,
  sourceRecordCount: 1, copiedRecordCount: 0,
  sourceDigest, targetDigest: null,
}, rollbackBinding, now);
rollback = advanceOperationalMigrationStoreCheckpoint(rollback, 'vouchers', {
  state: 'rolled_back', cursor: null, batchSequence: 1,
  sourceRecordCount: 0, copiedRecordCount: 0,
  sourceDigest: null, targetDigest: null,
}, rollbackBinding, now);
rollback = transitionOperationalMigrationPhase(rollback, 'rolled_back', now);
assert.equal(rollback.phase, 'rolled_back');
assert.equal(isValidOperationalMigrationJournalRecord(rollback), true);
console.log('Operational migration journal state machine: validation and transition coverage passed');
