/**
 * Restartable, bounded copy orchestration for one operational business store.
 *
 * Source rows remain authoritative and unchanged. Each encrypted batch and its
 * durable cursor/count checkpoint commit in one IndexedDB transaction.
 */
import { openOperationalMigrationDbConnection } from './operationalDb';
import { writeEncryptedOperationalMigrationBatchAtomically } from './encryptedOperationalIndexedDb';
import { readOperationalMigrationSourceBatch } from './operationalMigrationSource';
import { computeOperationalMigrationDigest } from './operationalMigrationDigest';
import {
  assertOperationalMigrationBinding,
  isValidOperationalMigrationJournalRecord,
  type OperationalMigrationBinding,
  type OperationalMigrationJournalRecord,
} from './operationalMigrationJournal';
import { assertOperationalDataKeyLease, captureOperationalDataKeyLease } from './operationalEncryptionSession';
import type { OperationalEncryptedStore } from './operationalRecordEncryption';

const COPY_PAGE_SIZE = 500;
const MAX_MIGRATION_RECORDS = 1_000_000;

function assertCopyLease(binding: OperationalMigrationBinding, lease: ReturnType<typeof captureOperationalDataKeyLease>): void {
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== binding.workspaceId ||
      lease.backupSessionGeneration !== binding.backupSessionGeneration) {
    throw new Error('Operational migration copy key lease changed workspace or generation.');
  }
}

/** Read a stable source snapshot in bounded pages for deterministic digesting. */
async function readSourceSnapshot(
  binding: OperationalMigrationBinding,
  storeName: OperationalEncryptedStore,
  lease: ReturnType<typeof captureOperationalDataKeyLease>
): Promise<{ records: Record<string, unknown>[]; count: number }> {
  const records: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let count: number | null = null;
  while (true) {
    assertCopyLease(binding, lease);
    const page = await readOperationalMigrationSourceBatch(binding, storeName, cursor, COPY_PAGE_SIZE);
    assertCopyLease(binding, lease);
    if (count === null) count = page.sourceRecordCount;
    else if (count !== page.sourceRecordCount) throw new Error('Operational source count changed while preparing migration digest.');
    records.push(...page.records);
    if (records.length > MAX_MIGRATION_RECORDS) throw new Error('Operational migration source exceeds the supported snapshot bound.');
    if (!page.hasMore) break;
    if (!page.nextCursor || page.nextCursor === cursor) throw new Error('Operational migration source cursor failed to advance.');
    if (storeName === 'localProfiles') throw new Error('Local profile source unexpectedly requires multiple pages.');
    cursor = page.nextCursor;
  }
  if (count === null || count !== records.length) {
    throw new Error('Operational migration source snapshot count does not match its rows.');
  }
  return { records, count };
}

/**
 * Copy or resume one logical store. The migration journal must already be in
 * copying phase. A completed store is returned unchanged and can be verified.
 */
export async function copyOperationalMigrationStore(
  binding: OperationalMigrationBinding,
  storeName: OperationalEncryptedStore,
  expectedJournal: OperationalMigrationJournalRecord
): Promise<OperationalMigrationJournalRecord> {
  if (!isValidOperationalMigrationJournalRecord(expectedJournal)) {
    throw new Error('Operational migration copy journal is invalid.');
  }
  assertOperationalMigrationBinding(expectedJournal, binding);
  if (expectedJournal.phase !== 'copying') throw new Error('Operational migration copying requires the copying phase.');
  const checkpoint = expectedJournal.stores.find((store) => store.storeName === storeName);
  if (!checkpoint || !['pending', 'copying'].includes(checkpoint.state)) {
    throw new Error('Operational migration store is not pending or resumable.');
  }

  const lease = captureOperationalDataKeyLease();
  assertCopyLease(binding, lease);
  const snapshot = await readSourceSnapshot(binding, storeName, lease);
  const sourceDigest = await computeOperationalMigrationDigest(storeName, snapshot.records);
  assertCopyLease(binding, lease);
  if (checkpoint.sourceDigest && checkpoint.sourceDigest !== sourceDigest) {
    throw new Error('Operational source digest changed since the migration checkpoint; automatic resume is unsafe.');
  }
  if (checkpoint.sourceRecordCount !== 0 && checkpoint.sourceRecordCount !== snapshot.count) {
    throw new Error('Operational source record count changed since the migration checkpoint.');
  }
  if (checkpoint.copiedRecordCount > snapshot.count) {
    throw new Error('Operational migration checkpoint claims more copied rows than the source contains.');
  }
  if (checkpoint.copiedRecordCount > 0 && !checkpoint.cursor) {
    throw new Error('Operational migration resume checkpoint is missing its source cursor.');
  }

  let journal = expectedJournal;
  let cursor = checkpoint.state === 'copying' ? checkpoint.cursor as string | null : null;
  let sequence = checkpoint.batchSequence;
  let copied = checkpoint.copiedRecordCount;
  let wroteEmptySnapshot = false;
  const db = await openOperationalMigrationDbConnection();
  try {
    while (true) {
      assertCopyLease(binding, lease);
      const page = await readOperationalMigrationSourceBatch(binding, storeName, cursor, COPY_PAGE_SIZE);
      assertCopyLease(binding, lease);
      if (page.sourceRecordCount !== snapshot.count) {
        throw new Error('Operational source count changed between digest and encrypted copy passes.');
      }
      if (page.records.length === 0 && page.hasMore) {
        throw new Error('Operational migration source returned an empty non-terminal page.');
      }
      if (page.records.length === 0 && sequence > 0) break;
      if (page.records.length === 0) wroteEmptySnapshot = true;

      const nextCopied = copied + page.records.length;
      if (nextCopied > snapshot.count) throw new Error('Operational migration copy count exceeded the source count.');
      sequence += 1;
      const result = await writeEncryptedOperationalMigrationBatchAtomically(
        db,
        binding.workspaceId,
        [{ store: storeName, records: page.records }],
        journal,
        binding,
        {
          storeName,
          state: 'copying',
          cursor: page.nextCursor,
          batchSequence: sequence,
          sourceRecordCount: snapshot.count,
          copiedRecordCount: nextCopied,
          sourceDigest,
          targetDigest: null,
        }
      );
      journal = result.journal;
      copied = nextCopied;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      if (!cursor) throw new Error('Operational migration copy cursor failed to advance.');
      if (storeName === 'localProfiles') throw new Error('Local profile migration unexpectedly requires multiple copy pages.');
    }
  } finally {
    db.close();
  }

  if (!wroteEmptySnapshot && sequence === 0) {
    throw new Error('Operational migration copy did not persist its initial checkpoint.');
  }
  if (copied !== snapshot.count) {
    throw new Error('Operational migration copy is incomplete; source rows remain untouched.');
  }
  assertCopyLease(binding, lease);
  return journal;
}
