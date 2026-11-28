/**
 * End-to-end shadow migration coordinator.
 *
 * This runner copies, resumes, and verifies encrypted shadow data only. It
 * deliberately stops at ready_to_cutover; production readers/writers and
 * plaintext source stores remain untouched pending the separate rollback gate.
 */
import { copyOperationalMigrationStore } from './operationalMigrationCopy';
import { verifyOperationalMigrationStore } from './operationalMigrationVerification';
import { persistOperationalMigrationPhase } from './operationalMigrationPersistence';
import {
  assertOperationalMigrationBinding,
  isValidOperationalMigrationJournalRecord,
  type OperationalMigrationBinding,
  type OperationalMigrationJournalRecord,
} from './operationalMigrationJournal';
import type { OperationalEncryptedStore } from './operationalRecordEncryption';

const ENCRYPTED_STORES = new Set<OperationalEncryptedStore>([
  'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques',
  'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates',
  'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators',
  'auditLogs', 'warehouses', 'taxReports', 'localProfiles',
]);

/**
 * Run or resume every store in the journal. The returned journal is ready for
 * a separately reviewed cutover plan; this function never performs cutover.
 */
export async function runOperationalShadowMigration(
  binding: OperationalMigrationBinding,
  initialJournal: OperationalMigrationJournalRecord
): Promise<OperationalMigrationJournalRecord> {
  if (!isValidOperationalMigrationJournalRecord(initialJournal)) {
    throw new Error('Operational shadow migration journal is invalid.');
  }
  assertOperationalMigrationBinding(initialJournal, binding);
  const stores = initialJournal.stores.map((entry) => {
    if (!ENCRYPTED_STORES.has(entry.storeName as OperationalEncryptedStore)) {
      throw new Error('Operational migration journal contains an unsupported logical store.');
    }
    return entry.storeName as OperationalEncryptedStore;
  });
  if (stores.length === 0 || new Set(stores).size !== stores.length) {
    throw new Error('Operational shadow migration must contain unique supported stores.');
  }

  let journal = initialJournal;
  if (journal.phase === 'preparing') {
    journal = await persistOperationalMigrationPhase(binding, 'copying');
  }
  if (journal.phase === 'copying') {
    for (const storeName of stores) {
      const checkpoint = journal.stores.find((entry) => entry.storeName === storeName);
      if (checkpoint?.state === 'verified') continue;
      journal = await copyOperationalMigrationStore(binding, storeName, journal);
    }
    journal = await persistOperationalMigrationPhase(binding, 'verifying');
  }
  if (journal.phase === 'verifying') {
    for (const storeName of stores) {
      const checkpoint = journal.stores.find((entry) => entry.storeName === storeName);
      if (checkpoint?.state === 'verified') continue;
      journal = await verifyOperationalMigrationStore(binding, storeName, journal);
    }
    journal = await persistOperationalMigrationPhase(binding, 'ready_to_cutover');
  }
  if (journal.phase !== 'ready_to_cutover') {
    throw new Error('Operational shadow migration did not reach the verified ready-to-cutover gate.');
  }
  return journal;
}
