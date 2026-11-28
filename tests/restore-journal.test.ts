import assert from 'node:assert/strict';
import {
  OP_DB_VERSION,
  OPERATIONAL_STORES,
  isValidOperationalRestoreJournalRecord,
  type OperationalRestoreJournalRecord,
} from '../src/lib/operationalDb';

const now = new Date().toISOString();
const valid: OperationalRestoreJournalRecord = {
  restoreId: 'restore_123456789012',
  workspaceId: 'tenant_demo',
  packageDigest: 'a'.repeat(64),
  workspaceEnvelopeJson: JSON.stringify({ format: 'holoo-apex-encrypted-backup' }),
  workspacePlaintextSha256: 'b'.repeat(64),
  workspaceSchemaVersion: 2,
  workspaceRecordCount: 42,
  attachmentManifestDigest: 'c'.repeat(64),
  attachmentCount: 3,
  packageSchemaVersion: 2,
  state: 'staging',
  createdAt: now,
  updatedAt: now,
};

assert.equal(OP_DB_VERSION, 6, 'Restore journal requires operational DB schema v6');
assert.ok(!OPERATIONAL_STORES.includes('restoreJournal' as never), 'Restore journal is infrastructure, not an accounting collection');
assert.equal(isValidOperationalRestoreJournalRecord(valid), true);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, packageDigest: 'not-a-digest' }), false);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, workspaceEnvelopeJson: '' }), false);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, attachmentCount: -1 }), false);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, state: 'unknown' }), false);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, workspaceSchemaVersion: 1 }), false);
assert.equal(isValidOperationalRestoreJournalRecord({ ...valid, workspaceEnvelopeJson: 'x'.repeat(12_000_001) }), false);

console.log('PASS: durable restore journal schema and validation');
