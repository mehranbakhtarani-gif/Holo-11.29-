import assert from 'node:assert/strict';
import {
  advanceWorkspaceExtensionMigration,
  decideWorkspaceExtensionCommit,
  validateWorkspaceExtensionRecord,
  type WorkspaceExtensionMigrationJournal,
  type WorkspaceExtensionRecord,
} from '../src/lib/workspaceExtensionRepository';

const now = '2026-11-28T12:00:00.000Z';
const initial: WorkspaceExtensionRecord<{ items: string[] }> = {
  workspaceId: 'workspace-1', schemaVersion: 1, generation: 0,
  payload: { items: [] }, updatedAt: now,
};
assert.equal(validateWorkspaceExtensionRecord(initial, 'workspace-1'), true);
assert.equal(validateWorkspaceExtensionRecord({ ...initial, generation: -1 }), false);
assert.equal(validateWorkspaceExtensionRecord({ ...initial, workspaceId: 'other' }, 'workspace-1'), false);

// A successful commit increments generation exactly once and preserves explicit empty payloads.
const committed = decideWorkspaceExtensionCommit({
  current: initial, expectedGeneration: 0, payload: { items: [] }, now,
});
assert.equal(committed.status, 'committed');
if (committed.status === 'committed') {
  assert.equal(committed.record.generation, 1);
  assert.deepEqual(committed.record.payload, { items: [] });
}

// Two tabs reading generation 0: only the first transaction can commit; the stale writer conflicts.
const competingWriter = decideWorkspaceExtensionCommit({
  current: committed.status === 'committed' ? committed.record : initial,
  expectedGeneration: 0, payload: { items: ['stale'] }, now,
});
assert.deepEqual(competingWriter, {
  status: 'conflict', expectedGeneration: 0, actualGeneration: 1,
});

// An absent record is generation 0 but cannot be created without an explicit workspace identity.
assert.throws(() => decideWorkspaceExtensionCommit({
  current: null, expectedGeneration: 0, payload: { items: [] }, now,
}), /workspaceId/);

const journal: WorkspaceExtensionMigrationJournal = {
  workspaceId: 'workspace-1', migrationId: 'migration-0001',
  sourceFingerprint: 'a'.repeat(64), targetGeneration: 1,
  state: 'not_started', updatedAt: now,
};
const staged = advanceWorkspaceExtensionMigration(journal, 'staging', now);
const verified = advanceWorkspaceExtensionMigration(staged, 'verified', now);
const done = advanceWorkspaceExtensionMigration(verified, 'committed', now);
assert.equal(done.state, 'committed');
assert.throws(() => advanceWorkspaceExtensionMigration(done, 'staging', now), /backwards/);
assert.throws(() => advanceWorkspaceExtensionMigration(journal, 'verified', 'invalid'), /timestamp/);

console.log('Workspace extension repository contract tests passed');
