/**
 * Bounded source-to-ciphertext verification for an already copied migration store.
 *
 * Verification is read-only against source and shadow rows. The only write is a
 * metadata checkpoint committed with a source-revision fence; it never switches
 * production readers or deletes plaintext source data.
 */
import { openOperationalMigrationDbConnection } from './operationalDb';
import { queryEncryptedOperationalStore } from './encryptedOperationalIndexedDb';
import { assertOperationalDataKeyLease, captureOperationalDataKeyLease } from './operationalEncryptionSession';
import { readOperationalMigrationSourceBatch } from './operationalMigrationSource';
import { verifyOperationalMigrationStoreDigests } from './operationalMigrationDigest';
import {
  assertOperationalMigrationBinding,
  isValidOperationalMigrationJournalRecord,
  type OperationalMigrationBinding,
  type OperationalMigrationJournalRecord,
} from './operationalMigrationJournal';
import { persistOperationalMigrationStoreCheckpoint } from './operationalMigrationPersistence';
import type { OperationalEncryptedStore } from './operationalRecordEncryption';

const VERIFICATION_PAGE_SIZE = 500;

function assertMigrationLease(binding: OperationalMigrationBinding, lease: ReturnType<typeof captureOperationalDataKeyLease>): void {
  assertOperationalDataKeyLease(lease);
  if (lease.workspaceId !== binding.workspaceId ||
      lease.backupSessionGeneration !== binding.backupSessionGeneration) {
    throw new Error('Operational migration verification key lease changed workspace or generation.');
  }
}

/**
 * Verify one copied store. Callers must first transition the journal to
 * the verifying phase; all stores must be verified before ready_to_cutover.
 */
export async function verifyOperationalMigrationStore(
  binding: OperationalMigrationBinding,
  storeName: OperationalEncryptedStore,
  expectedJournal: OperationalMigrationJournalRecord
): Promise<OperationalMigrationJournalRecord> {
  if (!isValidOperationalMigrationJournalRecord(expectedJournal)) {
    throw new Error('Operational migration verification journal is invalid.');
  }
  assertOperationalMigrationBinding(expectedJournal, binding);
  if (expectedJournal.phase !== 'verifying') {
    throw new Error('Operational migration store verification is permitted only in verifying phase.');
  }
  const checkpoint = expectedJournal.stores.find((store) => store.storeName === storeName);
  if (!checkpoint || checkpoint.state !== 'copying' ||
      checkpoint.sourceRecordCount !== checkpoint.copiedRecordCount ||
      !checkpoint.sourceDigest) {
    throw new Error('Operational migration store is not fully copied and checkpointed for verification.');
  }

  const lease = captureOperationalDataKeyLease();
  assertMigrationLease(binding, lease);
  const sourceRecords: Record<string, unknown>[] = [];
  let sourceCursor: string | null = null;
  let sourceRecordCount: number | null = null;
  do {
    assertMigrationLease(binding, lease);
    const batch = await readOperationalMigrationSourceBatch(binding, storeName, sourceCursor, VERIFICATION_PAGE_SIZE);
    assertMigrationLease(binding, lease);
    if (sourceRecordCount === null) sourceRecordCount = batch.sourceRecordCount;
    else if (sourceRecordCount !== batch.sourceRecordCount) {
      throw new Error('Operational source record count changed during verification.');
    }
    sourceRecords.push(...batch.records);
    if (sourceRecords.length > 1_000_000) throw new Error('Operational migration verification exceeds the bounded snapshot size.');
    sourceCursor = batch.nextCursor;
    if (batch.hasMore && !sourceCursor) throw new Error('Operational source verification cursor failed to advance.');
    if (storeName === 'localProfiles' && batch.hasMore) throw new Error('Local profile verification unexpectedly returned multiple pages.');
    if (!batch.hasMore) break;
  } while (true);

  const db = await openOperationalMigrationDbConnection();
  const targetRecords: Record<string, unknown>[] = [];
  let targetCursor: string | null = null;
  try {
    while (true) {
      assertMigrationLease(binding, lease);
      const page = await queryEncryptedOperationalStore<Record<string, unknown>>(
        db,
        storeName,
        binding.workspaceId,
        {
          migrationId: binding.migrationId,
          afterRecordId: targetCursor,
          maxScan: VERIFICATION_PAGE_SIZE,
          limit: VERIFICATION_PAGE_SIZE,
        }
      );
      assertMigrationLease(binding, lease);
      targetRecords.push(...page.items);
      if (targetRecords.length > 1_000_000) throw new Error('Encrypted migration verification exceeds the bounded target snapshot size.');
      if (!page.hasMore) break;
      if (!page.nextCursor || page.nextCursor === targetCursor) {
        throw new Error('Encrypted shadow verification cursor failed to advance.');
      }
      targetCursor = page.nextCursor;
    }
  } finally {
    db.close();
  }

  assertMigrationLease(binding, lease);
  const verification = await verifyOperationalMigrationStoreDigests(storeName, sourceRecords, targetRecords);
  assertMigrationLease(binding, lease);
  if (verification.sourceRecordCount !== sourceRecordCount ||
      verification.sourceDigest !== checkpoint.sourceDigest) {
    throw new Error('Operational source snapshot no longer matches the digest recorded during copying.');
  }

  return persistOperationalMigrationStoreCheckpoint(binding, storeName, {
    state: 'verified',
    cursor: checkpoint.cursor,
    batchSequence: checkpoint.batchSequence + 1,
    sourceRecordCount: verification.sourceRecordCount,
    copiedRecordCount: verification.targetRecordCount,
    sourceDigest: verification.sourceDigest,
    targetDigest: verification.targetDigest,
  });
}
