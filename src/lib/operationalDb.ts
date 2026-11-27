/**
 * Operational Local IndexedDB Engine for Holoo Apex 9.6
 * Elevates IndexedDB from a backup-only store to the primary operational local
 * database with dedicated entity object stores, atomic multi-store commits, and
 * an idempotent multi-device sync outbox.
 */

import type { FinancialCollectionKind } from './offlineFirstCore';
import { encryptBackupEnvelope, decryptAndVerifyBackupEnvelope } from './offlineFirstCore';
import { requireBackupSessionPassphrase } from './backupSession';
import { importAllBankReconciliationSessions } from './bankReconciliationEngine';
import {
  captureBusinessLocalStateSnapshot,
  countBusinessLocalStateSnapshotRecords,
  restoreBusinessLocalStateSnapshot,
  validateBusinessLocalStateSnapshot,
  type BusinessLocalStateSnapshot,
} from './businessLocalStateSnapshot';
import {
  Account,
  AuditActivityLog,
  Cheque,
  CompanyProfile,
  CostCenter,
  CurrencyDefinition,
  ExchangeRateEntry,
  FixedAsset,
  ImportDossier,
  Invoice,
  Party,
  Product,
  RbacOperator,
  SalesOrder,
  SubcontractJob,
  Voucher,
} from '../types/accounting';

let forcedOperationalRestoreBarrier = false;

export function setOperationalRestoreBarrier(active: boolean): void {
  forcedOperationalRestoreBarrier = active;
}

export function isOperationalRestoreBarrierActive(): boolean {
  return forcedOperationalRestoreBarrier;
}

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  const restoreBarrierChannel = new BroadcastChannel('holoo-complete-restore');
  restoreBarrierChannel.onmessage = (event) => {
    if (event.data?.reload === true) {
      forcedOperationalRestoreBarrier = true;
      window.location.reload();
      return;
    }
    forcedOperationalRestoreBarrier = event.data?.active !== false;
  };
}

const OP_DB_NAME = 'holoo_apex_operational_db_v1';
export const OP_DB_VERSION = 5;

export const OPERATIONAL_STORES = [
  'meta',
  'accounts',
  'parties',
  'products',
  'vouchers',
  'invoices',
  'cheques',
  'employees',
  'assets',
  'costCenters',
  'currencies',
  'exchangeRates',
  'importDossiers',
  'salesOrders',
  'subcontractJobs',
  'rbacOperators',
  'auditLogs',
  'syncOutbox',
  'syncInbox',
  'localProfiles',
  'warehouses',
  'taxReports',
  'preUpdateBackups',
  'secureWorkspace',
] as const;

export type OperationalStoreName = (typeof OPERATIONAL_STORES)[number];

export interface OperationalWorkspaceData {
  profile: CompanyProfile;
  accounts: Account[];
  parties: Party[];
  products: Product[];
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
  employees: import('../types/accounting').Employee[];
  assets: FixedAsset[];
  costCenters: CostCenter[];
  currencies: CurrencyDefinition[];
  exchangeRates: ExchangeRateEntry[];
  importDossiers: ImportDossier[];
  salesOrders: SalesOrder[];
  subcontractJobs: SubcontractJob[];
  rbacOperators: RbacOperator[];
  auditLogs: AuditActivityLog[];
  // Auxiliary operational stores are included in the encrypted shadow so the
  // migration cannot silently omit warehouse, tax, local-profile, or sync state.
  warehouses?: Record<string, unknown>[];
  taxReports?: Record<string, unknown>[];
  localProfiles?: Record<string, unknown>[];
  syncOutbox?: SyncOutboxOperation[];
  syncInbox?: SyncInboxRecord[];
  localRevision?: number;
  updatedAt?: string;
  bankReconciliationSessions?: Record<string, unknown>;
  businessLocalState?: BusinessLocalStateSnapshot;
}

export interface SyncOutboxOperation {
  operationId: string;
  target: 'supabase' | 'firebase';
  workspaceId: string;
  deviceId: string;
  clientRevision: number;
  baseRevision?: number;
  entityKind?: FinancialCollectionKind;
  entityId?: string;
  payloadHash: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  nextRetryAt?: string;
  lastError?: string;
  status: 'pending' | 'synced' | 'conflict';
}

export interface SyncInboxRecord {
  operationId: string;
  sourceDeviceId: string;
  payloadHash: string;
  receivedAt: string;
}

export interface EncryptedOperationalWorkspaceRecord {
  workspaceId: string;
  envelopeJson: string;
  schemaVersion: number;
  recordCount: number;
  sourceRevision: number;
  plaintextSha256: string;
  preparedAt: string;
  migrationState: 'prepared';
}

export interface EncryptedOperationalWorkspaceMeta {
  workspaceId: string;
  schemaVersion: number;
  recordCount: number;
  sourceRevision: number;
  plaintextSha256: string;
  preparedAt: string;
  migrationState: 'prepared';
}

/** Validates untrusted IndexedDB migration metadata before it is used or displayed. */
export function validateEncryptedOperationalWorkspaceRecordMetadata(
  value: unknown,
  expectedWorkspaceId?: string
): value is EncryptedOperationalWorkspaceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<EncryptedOperationalWorkspaceRecord>;
  return (
    typeof record.workspaceId === 'string' &&
    record.workspaceId.length > 0 &&
    record.workspaceId.length <= 180 &&
    (!expectedWorkspaceId || record.workspaceId === expectedWorkspaceId) &&
    typeof record.envelopeJson === 'string' &&
    record.envelopeJson.length > 0 &&
    record.envelopeJson.length <= 1_500_000 &&
    record.schemaVersion === 2 &&
    Number.isSafeInteger(record.recordCount) &&
    Number(record.recordCount) >= 0 &&
    Number.isSafeInteger(record.sourceRevision) &&
    Number(record.sourceRevision) >= 1 &&
    typeof record.plaintextSha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(record.plaintextSha256) &&
    typeof record.preparedAt === 'string' &&
    Number.isFinite(Date.parse(record.preparedAt)) &&
    record.migrationState === 'prepared'
  );
}

export type RestoreJournalState =
  | 'staging'
  | 'commit_requested'
  | 'workspace_applied'
  | 'committed'
  | 'failed_recovery_required';

export interface OperationalRestoreJournalRecord {
  restoreId: string;
  workspaceId: string;
  packageDigest: string;
  workspaceEnvelopeJson: string;
  workspacePlaintextSha256: string;
  workspaceSchemaVersion: number;
  workspaceRecordCount: number;
  attachmentManifestDigest: string;
  attachmentCount: number;
  packageSchemaVersion: number;
  state: RestoreJournalState;
  createdAt: string;
  updatedAt: string;
  lastRecoveryError?: string;
}

const RESTORE_JOURNAL_STORE = 'restoreJournal';
const RESTORE_JOURNAL_TERMINAL_STATES: RestoreJournalState[] = ['committed'];

export function isValidOperationalRestoreJournalRecord(value: unknown): value is OperationalRestoreJournalRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<OperationalRestoreJournalRecord>;
  return typeof row.restoreId === 'string' && /^[a-zA-Z0-9_-]{12,100}$/.test(row.restoreId) &&
    typeof row.workspaceId === 'string' && row.workspaceId.length > 0 && row.workspaceId.length <= 180 &&
    typeof row.packageDigest === 'string' && /^[a-f0-9]{64}$/i.test(row.packageDigest) &&
    typeof row.workspaceEnvelopeJson === 'string' && row.workspaceEnvelopeJson.length > 0 &&
    row.workspaceEnvelopeJson.length <= 12_000_000 &&
    typeof row.workspacePlaintextSha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.workspacePlaintextSha256) &&
    row.workspaceSchemaVersion === 2 &&
    Number.isSafeInteger(row.workspaceRecordCount) && Number(row.workspaceRecordCount) >= 0 &&
    typeof row.attachmentManifestDigest === 'string' && /^[a-f0-9]{64}$/i.test(row.attachmentManifestDigest) &&
    Number.isSafeInteger(row.attachmentCount) && Number(row.attachmentCount) >= 0 &&
    (row.packageSchemaVersion === 1 || row.packageSchemaVersion === 2) &&
    ['staging', 'commit_requested', 'workspace_applied', 'committed', 'failed_recovery_required'].includes(String(row.state)) &&
    typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) &&
    typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt));
}

/** Read the durable restore journal before normal workspace hydration. */
export async function getActiveOperationalRestoreJournal(): Promise<OperationalRestoreJournalRecord | null> {
  if (!isIndexedDbAvailable()) throw new Error('برای بررسی وضعیت بازیابی، IndexedDB در دسترس نیست.');
  const db = await openOperationalDb(true);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readonly');
      const request = tx.objectStore(RESTORE_JOURNAL_STORE).getAll();
      request.onsuccess = () => {
        const rawRows = (request.result as unknown[]) ?? [];
        if (rawRows.some((row) => !isValidOperationalRestoreJournalRecord(row))) {
          reject(new Error('ژورنال بازیابی خراب یا دستکاری‌شده است؛ شروع عادی برنامه مسدود شد.'));
          return;
        }
        const rows = rawRows as OperationalRestoreJournalRecord[];
        const active = rows.filter((row) => !RESTORE_JOURNAL_TERMINAL_STATES.includes(row.state));
        if (active.length > 1) {
          reject(new Error('بیش از یک بازیابی ناتمام ثبت شده است؛ برای جلوگیری از اختلاط داده‌ها شروع برنامه مسدود شد.'));
          return;
        }
        resolve(active[0] ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error('خواندن ژورنال بازیابی ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش خواندن ژورنال بازیابی لغو شد.'));
    });
  } finally {
    db.close();
  }
}

/** Persist a validated encrypted restore journal record. Does not modify live workspace rows. */
export async function createOperationalRestoreJournal(
  record: OperationalRestoreJournalRecord
): Promise<void> {
  if (!isValidOperationalRestoreJournalRecord(record) || record.state !== 'staging') {
    throw new Error('ساختار اولیه ژورنال بازیابی معتبر نیست.');
  }
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB برای ثبت ژورنال بازیابی در دسترس نیست.');
  const db = await openOperationalDb(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readwrite');
      const store = tx.objectStore(RESTORE_JOURNAL_STORE);
      const get = store.getAll();
      get.onsuccess = () => {
        const existingRows = (get.result as unknown[]) ?? [];
        const hasInvalidOrActive = existingRows.some((row) =>
          !isValidOperationalRestoreJournalRecord(row) ||
          !RESTORE_JOURNAL_TERMINAL_STATES.includes((row as OperationalRestoreJournalRecord).state)
        );
        if (hasInvalidOrActive || existingRows.some((row) =>
          (row as OperationalRestoreJournalRecord).restoreId === record.restoreId
        )) {
          tx.abort();
          return;
        }
        store.add(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('ثبت ژورنال بازیابی ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('ثبت ژورنال بازیابی لغو شد.'));
    });
  } finally {
    db.close();
  }
}

/** Update attachment staging metadata while the restore is still non-committing. */
export async function updateStagingOperationalRestoreJournal(
  restoreId: string,
  attachmentManifestDigest: string,
  attachmentCount: number
): Promise<OperationalRestoreJournalRecord> {
  if (!restoreId || !/^[a-f0-9]{64}$/i.test(attachmentManifestDigest) ||
      !Number.isSafeInteger(attachmentCount) || attachmentCount < 0) {
    throw new Error('فرادادهٔ staging بازیابی معتبر نیست.');
  }
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB برای به‌روزرسانی ژورنال در دسترس نیست.');
  const db = await openOperationalDb(true);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readwrite');
      const store = tx.objectStore(RESTORE_JOURNAL_STORE);
      let updated: OperationalRestoreJournalRecord | null = null;
      const request = store.get(restoreId);
      request.onsuccess = () => {
        const current = request.result as OperationalRestoreJournalRecord | undefined;
        if (!current || !isValidOperationalRestoreJournalRecord(current) || current.state !== 'staging') {
          tx.abort();
          return;
        }
        updated = {
          ...current,
          attachmentManifestDigest,
          attachmentCount,
          updatedAt: new Date().toISOString(),
        };
        store.put(updated);
      };
      tx.oncomplete = () => updated ? resolve(updated) : reject(new Error('ژورنال staging به‌روزرسانی نشد.'));
      tx.onerror = () => reject(tx.error ?? new Error('به‌روزرسانی ژورنال staging ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش به‌روزرسانی ژورنال staging لغو شد.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Apply the encrypted workspace staged in the durable restore journal.
 * All operational entity stores and the journal phase advance share one IDB transaction.
 * This is one half of the cross-database forward-recovery protocol; Document Vault
 * must still be applied and verified before the restore can be marked committed.
 */
export async function applyOperationalRestoreJournalWorkspace(
  restoreId: string
): Promise<{ localRevision: number; recordCount: number }> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB برای اعمال بازیابی فضای کاری در دسترس نیست.');
  const passphrase = requireBackupSessionPassphrase();
  const db = await openOperationalDb(true);
  try {
    const journal = await new Promise<OperationalRestoreJournalRecord>((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readonly');
      const request = tx.objectStore(RESTORE_JOURNAL_STORE).get(restoreId);
      request.onsuccess = () => {
        const row = request.result;
        if (!isValidOperationalRestoreJournalRecord(row) || !['commit_requested', 'failed_recovery_required'].includes(row.state)) {
          reject(new Error('ژورنال در وضعیت مجاز برای اعمال فضای کاری نیست.'));
          return;
        }
        resolve(row);
      };
      request.onerror = () => reject(request.error ?? new Error('خواندن ژورنال بازیابی ناموفق بود.'));
    });
    const verified = await decryptAndVerifyBackupEnvelope(journal.workspaceEnvelopeJson, passphrase);
    if (!verified.ok || !verified.snapshotJson || verified.sha256 !== journal.workspacePlaintextSha256) {
      throw new Error(verified.error || 'اصالت فضای کاری staging شده تأیید نشد.');
    }
    const workspace = parseOperationalWorkspaceSnapshot(verified.snapshotJson);
    const recordCount = countOperationalWorkspaceRecords(workspace);
    if (recordCount !== journal.workspaceRecordCount) {
      throw new Error('تعداد رکوردهای فضای کاری با ژورنال بازیابی مطابقت ندارد.');
    }
    if (workspace.businessLocalState) {
      // The commit-intent journal is durable before this replayable localStorage apply.
      // If the browser stops mid-write, recovery repeats the complete allowlisted set.
      restoreBusinessLocalStateSnapshot(workspace.businessLocalState);
    }
    if (!workspace.businessLocalState && workspace.bankReconciliationSessions !== undefined) {
      const sessions = workspace.bankReconciliationSessions;
      if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
        throw new Error('ساختار تطبیق بانکی در فضای کاری بازیابی معتبر نیست.');
      }
      let expectedDecisionCount = 0;
      for (const [bankCode, entries] of Object.entries(sessions)) {
        if (!bankCode || ['__proto__', 'constructor', 'prototype'].includes(bankCode) ||
            !entries || typeof entries !== 'object' || Array.isArray(entries)) {
          throw new Error('ساختار حساب یا ردیف تطبیق بانکی در بسته نامعتبر است.');
        }
        for (const [rowId, rawDecision] of Object.entries(entries as Record<string, unknown>)) {
          if (!rowId || ['__proto__', 'constructor', 'prototype'].includes(rowId) ||
              !rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
            throw new Error('یکی از تصمیم‌های تطبیق بانکی در بسته نامعتبر است.');
          }
          const decision = rawDecision as Record<string, unknown>;
          if (typeof decision.statementRowId !== 'string' ||
              !['pending_review', 'confirmed', 'rejected', 'adjusted', 'duplicate_ignored'].includes(String(decision.reviewStatus))) {
            throw new Error('فیلدهای یکی از تصمیم‌های تطبیق بانکی معتبر نیست.');
          }
          expectedDecisionCount += 1;
        }
      }
      const importedDecisionCount = importAllBankReconciliationSessions(sessions);
      if (importedDecisionCount !== expectedDecisionCount) {
        throw new Error('تمام تصمیم‌های تطبیق بانکی با موفقیت بازیابی نشدند.');
      }
    }

    const stores = [
      'meta', 'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques',
      'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates',
      'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators', 'auditLogs',
      'warehouses', 'taxReports', 'localProfiles', 'syncOutbox', 'syncInbox',
      RESTORE_JOURNAL_STORE,
    ];
    const committedAt = new Date().toISOString();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      const metaStore = tx.objectStore('meta');
      const journalStore = tx.objectStore(RESTORE_JOURNAL_STORE);
      let nextRevision = 1;
      let didQueueWrites = false;
      let journalReady = false;
      let metaReady = false;
      const journalRequest = journalStore.get(restoreId);
      const metaRequest = metaStore.get('workspace_meta');
      const queueWrites = () => {
        if (didQueueWrites || !journalReady || !metaReady) return;
        didQueueWrites = true;
        const current = journalRequest.result as OperationalRestoreJournalRecord | undefined;
        if (!isValidOperationalRestoreJournalRecord(current) ||
            !['commit_requested', 'failed_recovery_required'].includes(current.state) ||
            current.packageDigest !== journal.packageDigest ||
            current.workspacePlaintextSha256 !== journal.workspacePlaintextSha256) {
          tx.abort();
          return;
        }
        const currentMeta = metaRequest.result as { localRevision?: number } | undefined;
        nextRevision = Math.max(1, Number(currentMeta?.localRevision || 0) + 1);
        const putRows = (storeName: string, rows: Array<Record<string, unknown>>, keyField: string) => {
          const store = tx.objectStore(storeName);
          store.clear();
          for (const row of rows) {
            if (!row || typeof row !== 'object' || typeof row[keyField] !== 'string' || !String(row[keyField]).trim()) {
              tx.abort();
              return false;
            }
            store.put(row);
          }
          return true;
        };
        metaStore.put({ key: 'profile', value: workspace.profile, updatedAt: committedAt });
        metaStore.put({ key: 'workspace_meta', localRevision: nextRevision, updatedAt: committedAt, schemaVersion: OP_DB_VERSION });
        const valid =
          putRows('accounts', workspace.accounts as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('parties', workspace.parties as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('products', workspace.products as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('vouchers', workspace.vouchers as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('invoices', workspace.invoices as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('cheques', workspace.cheques as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('employees', workspace.employees as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('assets', workspace.assets as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('costCenters', workspace.costCenters as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('currencies', workspace.currencies as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('exchangeRates', workspace.exchangeRates as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('importDossiers', workspace.importDossiers as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('salesOrders', workspace.salesOrders as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('subcontractJobs', workspace.subcontractJobs as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('rbacOperators', workspace.rbacOperators as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('auditLogs', workspace.auditLogs as unknown as Array<Record<string, unknown>>, 'id') &&
          putRows('warehouses', workspace.warehouses ?? [], 'id') &&
          putRows('taxReports', workspace.taxReports ?? [], 'id') &&
          putRows('localProfiles', workspace.localProfiles ?? [], 'workspaceId') &&
          putRows('syncOutbox', (workspace.syncOutbox ?? []) as unknown as Array<Record<string, unknown>>, 'operationId') &&
          putRows('syncInbox', (workspace.syncInbox ?? []) as unknown as Array<Record<string, unknown>>, 'operationId');
        if (!valid) {
          tx.abort();
          return;
        }
        journalStore.put({ ...current, state: 'workspace_applied', updatedAt: committedAt, lastRecoveryError: undefined });
      };
      journalRequest.onsuccess = () => { journalReady = true; queueWrites(); };
      metaRequest.onsuccess = () => { metaReady = true; queueWrites(); };
      tx.oncomplete = () => {
        resetOperationalDiffCache();
        resolve({ localRevision: nextRevision, recordCount });
      };
      tx.onerror = () => reject(tx.error ?? new Error('تراکنش اعمال فضای کاری ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش اعمال فضای کاری لغو شد.'));
    });
  } finally {
    db.close();
  }
}

/** Remove only an uncommitted staging journal; committed or commit-intent journals are immutable. */
export async function discardStagingOperationalRestoreJournal(restoreId: string): Promise<void> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB برای پاک‌سازی ژورنال در دسترس نیست.');
  const db = await openOperationalDb(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readwrite');
      const store = tx.objectStore(RESTORE_JOURNAL_STORE);
      const request = store.get(restoreId);
      request.onsuccess = () => {
        const current = request.result as OperationalRestoreJournalRecord | undefined;
        if (!current || !isValidOperationalRestoreJournalRecord(current) || current.state !== 'staging') {
          tx.abort();
          return;
        }
        store.delete(restoreId);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('پاک‌سازی ژورنال staging ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('پاک‌سازی ژورنال staging لغو شد.'));
    });
  } finally { db.close(); }
}

/** Monotonic journal transition; terminal committed records cannot be reopened. */
export async function transitionOperationalRestoreJournal(
  restoreId: string,
  expectedStates: RestoreJournalState[],
  nextState: RestoreJournalState,
  patch: Partial<Pick<OperationalRestoreJournalRecord, 'lastRecoveryError' | 'updatedAt'>>
): Promise<OperationalRestoreJournalRecord> {
  if (!restoreId || !expectedStates.length) throw new Error('پارامتر تغییر وضعیت ژورنال معتبر نیست.');
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB برای تغییر ژورنال بازیابی در دسترس نیست.');
  const db = await openOperationalDb(true);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([RESTORE_JOURNAL_STORE], 'readwrite');
      const store = tx.objectStore(RESTORE_JOURNAL_STORE);
      let updated: OperationalRestoreJournalRecord | null = null;
      const get = store.get(restoreId);
      get.onsuccess = () => {
        const current = get.result as OperationalRestoreJournalRecord | undefined;
        if (!current || !isValidOperationalRestoreJournalRecord(current) || !expectedStates.includes(current.state)) {
          tx.abort();
          return;
        }
        const allowed: Record<RestoreJournalState, RestoreJournalState[]> = {
          staging: ['commit_requested', 'failed_recovery_required'],
          commit_requested: ['workspace_applied', 'failed_recovery_required'],
          workspace_applied: ['committed', 'failed_recovery_required'],
          failed_recovery_required: ['commit_requested', 'workspace_applied', 'committed'],
          committed: [],
        };
        if (!allowed[current.state].includes(nextState)) {
          tx.abort();
          return;
        }
        updated = { ...current, ...patch, state: nextState, updatedAt: patch.updatedAt ?? new Date().toISOString() };
        store.put(updated);
      };
      tx.oncomplete = () => {
        if (updated) resolve(updated);
        else reject(new Error('ژورنال بازیابی پس از تراکنش قابل تأیید نبود.'));
      };
      tx.onerror = () => reject(tx.error ?? new Error('تغییر ژورنال بازیابی ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تغییر وضعیت ژورنال بازیابی لغو شد.'));
    });
  } finally {
    db.close();
  }
}

export interface OperationalDbStats {
  supported: boolean;
  ready: boolean;
  dbName: string;
  storeCount: number;
  totalRecords: number;
  pendingOutboxCount: number;
  localRevision: number;
  lastCommitAt: string | null;
}

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openOperationalDb(allowRestoreRecovery = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(OP_DB_NAME, OP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const upgradeTx = req.transaction;
      if (!db.objectStoreNames.contains(RESTORE_JOURNAL_STORE)) {
        db.createObjectStore(RESTORE_JOURNAL_STORE, { keyPath: 'restoreId' });
      }
      for (const storeName of OPERATIONAL_STORES) {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(storeName)) {
          if (storeName === 'meta') {
            store = db.createObjectStore(storeName, { keyPath: 'key' });
          } else if (storeName === 'syncOutbox' || storeName === 'syncInbox') {
            store = db.createObjectStore(storeName, { keyPath: 'operationId' });
          } else if (storeName === 'localProfiles' || storeName === 'secureWorkspace') {
            store = db.createObjectStore(storeName, { keyPath: 'workspaceId' });
          } else {
            store = db.createObjectStore(storeName, { keyPath: 'id' });
          }
        } else if (upgradeTx) {
          store = upgradeTx.objectStore(storeName);
        } else {
          continue;
        }

        const ensureIndex = (name: string, keyPath: string) => {
          if (!store.indexNames.contains(name)) {
            store.createIndex(name, keyPath, { unique: false });
          }
        };

        if (storeName === 'syncOutbox') {
          ensureIndex('status', 'status');
          ensureIndex('createdAt', 'createdAt');
          ensureIndex('nextRetryAt', 'nextRetryAt');
        } else if (storeName === 'syncInbox') {
          ensureIndex('receivedAt', 'receivedAt');
        } else if (storeName === 'vouchers') {
          ensureIndex('date', 'date');
          ensureIndex('status', 'status');
          ensureIndex('voucherNumber', 'voucherNumber');
        } else if (storeName === 'invoices') {
          ensureIndex('date', 'date');
          ensureIndex('partyId', 'partyId');
          ensureIndex('status', 'status');
        } else if (storeName === 'products') {
          ensureIndex('warehouse', 'warehouse');
          ensureIndex('sku', 'sku');
        } else if (storeName === 'cheques') {
          ensureIndex('dueDate', 'dueDate');
          ensureIndex('status', 'status');
        } else if (storeName === 'preUpdateBackups') {
          ensureIndex('createdAt', 'createdAt');
        } else if (storeName === 'taxReports') {
          ensureIndex('period', 'period');
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (allowRestoreRecovery || !db.objectStoreNames.contains(RESTORE_JOURNAL_STORE)) {
        resolve(db);
        return;
      }
      const journalTx = db.transaction([RESTORE_JOURNAL_STORE], 'readonly');
      const journalRequest = journalTx.objectStore(RESTORE_JOURNAL_STORE).getAll();
      journalRequest.onsuccess = () => {
        const rows = (journalRequest.result as unknown[]) ?? [];
        const barrierActive = forcedOperationalRestoreBarrier || rows.some((row) =>
          !isValidOperationalRestoreJournalRecord(row) ||
          !RESTORE_JOURNAL_TERMINAL_STATES.includes((row as OperationalRestoreJournalRecord).state)
        );
        if (!barrierActive) {
          resolve(db);
          return;
        }
        const guarded = new Proxy(db, {
          get(target, property) {
            if (property === 'transaction') {
              return (..._args: Parameters<IDBDatabase['transaction']>) => {
                throw new Error('بازیابی پشتیبان در حال انجام یا نیازمند ادامه است؛ عملیات عادی فضای کاری تا تکمیل بازیابی مسدود است.');
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        resolve(guarded);
      };
      journalRequest.onerror = () => {
        db.close();
        reject(journalRequest.error ?? new Error('بررسی مانع بازیابی عملیاتی ناموفق بود.'));
      };
      journalTx.onerror = () => {
        db.close();
        reject(journalTx.error ?? new Error('تراکنش بررسی مانع بازیابی شکست خورد.'));
      };
      journalTx.onabort = () => {
        db.close();
        reject(journalTx.error ?? new Error('تراکنش بررسی مانع بازیابی لغو شد.'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to open operational IndexedDB'));
    req.onblocked = () =>
      reject(new Error('Operational IndexedDB is blocked by another open tab/connection'));
  });
}

function readAllFromStore<T>(tx: IDBTransaction, storeName: OperationalStoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

const lastCommittedStoreSignatures = new Map<OperationalStoreName, Map<string, string>>();

function computeRecordSignature(item: unknown): string {
  try {
    return JSON.stringify(item);
  } catch {
    return String(Date.now());
  }
}

export function resetOperationalDiffCache(): void {
  lastCommittedStoreSignatures.clear();
}

function syncStoreContentsIncremental<T extends { id: string }>(
  tx: IDBTransaction,
  storeName: OperationalStoreName,
  items: T[]
): void {
  const store = tx.objectStore(storeName);
  const prevMap = lastCommittedStoreSignatures.get(storeName);
  const nextMap = new Map<string, string>();

  if (!prevMap) {
    // First write in this session: synchronize full store and seed diff cache
    store.clear();
    for (const item of items) {
      if (item && typeof item.id === 'string' && item.id.length > 0) {
        store.put(item);
        nextMap.set(item.id, computeRecordSignature(item));
      }
    }
    lastCommittedStoreSignatures.set(storeName, nextMap);
    return;
  }

  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
    const sig = computeRecordSignature(item);
    nextMap.set(item.id, sig);
    if (prevMap.get(item.id) !== sig) {
      store.put(item);
    }
  }

  for (const oldId of prevMap.keys()) {
    if (!nextMap.has(oldId)) {
      store.delete(oldId);
    }
  }

  lastCommittedStoreSignatures.set(storeName, nextMap);
}

/**
 * Persists the operational accounting dataset atomically in a single
 * IndexedDB readwrite transaction using incremental per-record diffing
 * so unchanged stores and records are never unnecessarily cleared or rewritten.
 */
export async function saveOperationalWorkspaceTx(
  data: OperationalWorkspaceData
): Promise<{ localRevision: number; committedAt: string } | null> {
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('ذخیره‌سازی فضای کاری تا پایان بازیابی پشتیبان متوقف است.');
  }
  if (!isIndexedDbAvailable()) return null;
  const db = await openOperationalDb();
  const committedAt = new Date().toISOString();

  return new Promise((resolve, reject) => {
    const entityStores: OperationalStoreName[] = [
      'meta',
      'accounts',
      'parties',
      'products',
      'vouchers',
      'invoices',
      'cheques',
      'employees',
      'assets',
      'costCenters',
      'currencies',
      'exchangeRates',
      'importDossiers',
      'salesOrders',
      'subcontractJobs',
      'rbacOperators',
      'auditLogs',
    ];
    try {
      const tx = db.transaction(entityStores, 'readwrite');
      const metaStore = tx.objectStore('meta');
      const revReq = metaStore.get('workspace_meta');

      let nextRevision = Math.max(1, Number(data.localRevision) || 1);

      revReq.onsuccess = () => {
        if (isOperationalRestoreBarrierActive()) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          return;
        }
        const existing = revReq.result as { localRevision?: number } | undefined;
        if (existing && typeof existing.localRevision === 'number') {
          nextRevision = Math.max(nextRevision, existing.localRevision + 1);
        }

        metaStore.put({
          key: 'profile',
          value: data.profile,
          updatedAt: committedAt,
        });
        metaStore.put({
          key: 'workspace_meta',
          localRevision: nextRevision,
          updatedAt: committedAt,
          schemaVersion: OP_DB_VERSION,
        });

        syncStoreContentsIncremental(tx, 'accounts', data.accounts);
        syncStoreContentsIncremental(tx, 'parties', data.parties);
        syncStoreContentsIncremental(tx, 'products', data.products);
        syncStoreContentsIncremental(tx, 'vouchers', data.vouchers);
        syncStoreContentsIncremental(tx, 'invoices', data.invoices);
        syncStoreContentsIncremental(tx, 'cheques', data.cheques);
        syncStoreContentsIncremental(tx, 'employees', data.employees);
        syncStoreContentsIncremental(tx, 'assets', data.assets);
        syncStoreContentsIncremental(tx, 'costCenters', data.costCenters);
        syncStoreContentsIncremental(tx, 'currencies', data.currencies);
        syncStoreContentsIncremental(tx, 'exchangeRates', data.exchangeRates);
        syncStoreContentsIncremental(tx, 'importDossiers', data.importDossiers);
        syncStoreContentsIncremental(tx, 'salesOrders', data.salesOrders);
        syncStoreContentsIncremental(tx, 'subcontractJobs', data.subcontractJobs);
        syncStoreContentsIncremental(tx, 'rbacOperators', data.rbacOperators);
        syncStoreContentsIncremental(tx, 'auditLogs', data.auditLogs);
      };

      tx.oncomplete = () => {
        db.close();
        resolve({ localRevision: nextRevision, committedAt });
      };
      tx.onerror = () => {
        resetOperationalDiffCache();
        db.close();
        reject(tx.error ?? new Error('Operational IndexedDB commit failed'));
      };
      tx.onabort = () => {
        resetOperationalDiffCache();
        db.close();
        reject(tx.error ?? new Error('Operational IndexedDB transaction aborted'));
      };
    } catch (err) {
      resetOperationalDiffCache();
      db.close();
      reject(err);
    }
  });
}

/**
 * Atomic Invoice Commit directly in Operational IndexedDB:
 * Writes updated products (inventory/FIFO), double-entry voucher (ledger),
 * optional Sayadi cheque(s) (treasury), invoice, and workspace revision metadata
 * in a SINGLE IndexedDB readwrite transaction.
 *
 * If ANY entity fails integrity validation (e.g., unbalanced voucher, missing ID)
 * or ANY IndexedDB store write errors, `tx.abort()` immediately rolls back ALL
 * 5 object stores so zero partial writes can ever persist.
 */
export async function commitInvoiceOperationalTx(
  payload: {
    updatedProducts: Product[];
    voucher?: Voucher;
    cheque?: Cheque;
    cheques?: Cheque[];
    invoice: Invoice;
  },
  options?: { dbOverride?: IDBDatabase }
): Promise<boolean> {
  const usingOverride = Boolean(options?.dbOverride);
  if (!usingOverride && !isIndexedDbAvailable()) return false;
  const db = options?.dbOverride ?? (await openOperationalDb());
  const committedAt = new Date().toISOString();

  const closeIfOwned = () => {
    if (!usingOverride) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  };

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    let settled = false;
    const abortAndReject = (err: unknown) => {
      if (tx) {
        try {
          tx.abort();
        } catch {
          // ignore if transaction already finished/aborted
        }
      }
      if (!settled) {
        settled = true;
        closeIfOwned();
        reject(err instanceof Error ? err : new Error(String(err || 'Atomic invoice IndexedDB rollback')));
      }
    };

    try {
      tx = db.transaction(['meta', 'products', 'vouchers', 'cheques', 'invoices'], 'readwrite');

      if (!Array.isArray(payload.updatedProducts)) {
        throw new Error('ATOMIC_ROLLBACK_INVALID_PRODUCTS: فهرست تغییرات انبار معتبر نیست.');
      }

      // 1. Inventory (Products & FIFO/MWA layers)
      const prodStore = tx.objectStore('products');
      const seenProductIds = new Set<string>();
      for (const prod of payload.updatedProducts) {
        if (
          !prod ||
          typeof prod.id !== 'string' ||
          !prod.id.trim() ||
          !Number.isFinite(prod.stock) ||
          prod.stock < 0 ||
          seenProductIds.has(prod.id)
        ) {
          throw new Error('ATOMIC_ROLLBACK_INVALID_PRODUCT: شناسه، موجودی یا تکرار کالای فاکتور نامعتبر است.');
        }
        seenProductIds.add(prod.id);
        const req = prodStore.put(prod);
        req.onerror = () => abortAndReject(req.error ?? new Error('Product store write failed'));
      }

      // 2. General Ledger (Double-Entry Voucher) — enforce strict Debit === Credit balance
      if (payload.voucher) {
        const v = payload.voucher;
        if (typeof v.id !== 'string' || !v.id.trim() || !Array.isArray(v.lines) || v.lines.length < 2) {
          throw new Error('ATOMIC_ROLLBACK_INVALID_VOUCHER: سند حسابداری باید حداقل ۲ ردیف معتبر داشته باشد.');
        }
        let totalDebit = 0;
        let totalCredit = 0;
        for (const line of v.lines) {
          const debit = line?.debit;
          const credit = line?.credit;
          if (
            !Number.isSafeInteger(debit) ||
            Number(debit) < 0 ||
            !Number.isSafeInteger(credit) ||
            Number(credit) < 0 ||
            (Number(debit) > 0 && Number(credit) > 0)
          ) {
            throw new Error('ATOMIC_ROLLBACK_INVALID_VOUCHER_LINE: مبلغ ردیف سند باید عدد صحیح امن و نامنفی باشد و هر ردیف فقط یک‌طرفه ثبت شود.');
          }
          totalDebit += Number(debit);
          totalCredit += Number(credit);
          if (!Number.isSafeInteger(totalDebit) || !Number.isSafeInteger(totalCredit)) {
            throw new Error('ATOMIC_ROLLBACK_INVALID_VOUCHER_TOTAL: جمع سند از محدوده عدد صحیح امن خارج است.');
          }
        }
        if (totalDebit !== totalCredit || totalDebit <= 0) {
          throw new Error(
            `ATOMIC_ROLLBACK_UNBALANCED_VOUCHER: سند حسابداری تراز نیست (بدهکار=${totalDebit}، بستانکار=${totalCredit}).`
          );
        }
        const req = tx.objectStore('vouchers').put(v);
        req.onerror = () => abortAndReject(req.error ?? new Error('Voucher store write failed'));
      }

      // 3. Treasury (Sayadi Cheques — single or multiple on create/cancel)
      const allCheques: Cheque[] = [
        ...(payload.cheque ? [payload.cheque] : []),
        ...(Array.isArray(payload.cheques) ? payload.cheques : []),
      ];
      if (allCheques.length > 0) {
        const chequeStore = tx.objectStore('cheques');
        const seenChequeIds = new Set<string>();
        for (const chq of allCheques) {
          if (
            !chq ||
            typeof chq.id !== 'string' ||
            !chq.id.trim() ||
            !Number.isSafeInteger(chq.amount) ||
            chq.amount <= 0 ||
            seenChequeIds.has(chq.id)
          ) {
            throw new Error('ATOMIC_ROLLBACK_INVALID_CHEQUE: شناسه تکراری یا مبلغ نامعتبر چک خزانه است.');
          }
          seenChequeIds.add(chq.id);
          const req = chequeStore.put(chq);
          req.onerror = () => abortAndReject(req.error ?? new Error('Cheque store write failed'));
        }
      }

      // 4. Invoice Document
      if (!payload.invoice || typeof payload.invoice.id !== 'string' || !payload.invoice.id.trim()) {
        throw new Error('ATOMIC_ROLLBACK_INVALID_INVOICE: شناسه فاکتور نامعتبر است.');
      }
      const invReq = tx.objectStore('invoices').put(payload.invoice);
      invReq.onerror = () => abortAndReject(invReq.error ?? new Error('Invoice store write failed'));

      // 5. Monotonic Workspace Revision Metadata
      const metaStore = tx.objectStore('meta');
      const revReq = metaStore.get('workspace_meta');
      revReq.onsuccess = () => {
        try {
          const existing = revReq.result as { localRevision?: number } | undefined;
          const currentRevision = Number(existing?.localRevision ?? 0);
          if (
            !Number.isSafeInteger(currentRevision) ||
            currentRevision < 0 ||
            currentRevision >= Number.MAX_SAFE_INTEGER
          ) {
            throw new Error('ATOMIC_ROLLBACK_INVALID_REVISION: شماره بازبینی فضای کاری معتبر نیست.');
          }
          const metaPutReq = metaStore.put({
            key: 'workspace_meta',
            localRevision: currentRevision + 1,
            updatedAt: committedAt,
            schemaVersion: OP_DB_VERSION,
          });
          metaPutReq.onerror = () => abortAndReject(metaPutReq.error ?? new Error('Workspace meta write failed'));
        } catch (err) {
          abortAndReject(err);
        }
      };
      revReq.onerror = () => abortAndReject(revReq.error ?? new Error('Workspace meta read failed'));

      tx.oncomplete = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          resolve(true);
        }
      };
      tx.onerror = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic invoice IndexedDB commit failed'));
        }
      };
      tx.onabort = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic invoice IndexedDB transaction aborted (ROLLBACK complete)'));
        }
      };
    } catch (err) {
      abortAndReject(err);
    }
  });
}

/**
 * Atomically dispatches a local sales order against its current IndexedDB record.
 * The live status, owner, version, order update, and workspace revision are checked
 * and committed in one readwrite transaction to prevent stale React-state dispatches.
 */
export async function commitSalesOrderDispatchOperationalTx(input: {
  orderId: string;
  ownerId: string;
  dispatchNumber: string;
  dispatchDate: string;
  driverName: string;
  plateNumber: string;
  items: SalesOrder['items'];
  updatedByDevice: string;
}, options?: { dbOverride?: IDBDatabase }): Promise<SalesOrder> {
  const usingOverride = Boolean(options?.dbOverride);
  if (!usingOverride && !isIndexedDbAvailable()) {
    throw new Error('پایگاه‌داده عملیاتی محلی در دسترس نیست؛ حواله خروج ثبت نشد.');
  }
  const db = options?.dbOverride ?? (await openOperationalDb());
  const closeIfOwned = () => { if (!usingOverride) db.close(); };
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    let committedOrder: SalesOrder | null = null;
    try {
      tx = db.transaction(['salesOrders', 'meta'], 'readwrite');
      const orderStore = tx.objectStore('salesOrders');
      const metaStore = tx.objectStore('meta');
      const orderRequest = orderStore.get(input.orderId);
      const metaRequest = metaStore.get('workspace_meta');
      let orderReady = false;
      let metaReady = false;
      let nextRevision = 0;

      const commitIfReady = () => {
        if (!orderReady || !metaReady || committedOrder) return;
        const liveOrder = orderRequest.result as SalesOrder | undefined;
        const meta = metaRequest.result as { localRevision?: number } | undefined;
        if (!liveOrder || liveOrder.ownerId !== input.ownerId) {
          tx.abort();
          reject(new Error('سفارش در فضای کاری محلی یافت نشد یا متعلق به این شرکت نیست.'));
          return;
        }
        if (liveOrder.status !== 'ordered') {
          tx.abort();
          reject(new Error('این سفارش قبلاً حواله شده یا در وضعیت قابل ارسال نیست.'));
          return;
        }
        const revision = Math.max(1, Number(meta?.localRevision) || 1);
        const version = Math.max(1, Number(liveOrder._version) || 1);
        if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER ||
            !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) {
          tx.abort();
          reject(new Error('نسخه سفارش یا فضای کاری از محدوده امن خارج شده است.'));
          return;
        }
        nextRevision = revision + 1;
        committedOrder = {
          ...liveOrder,
          dispatchNumber: liveOrder.dispatchNumber || input.dispatchNumber,
          dispatchDate: input.dispatchDate,
          driverName: input.driverName,
          plateNumber: input.plateNumber,
          items: input.items,
          status: 'dispatched',
          _version: version + 1,
          updatedByDevice: input.updatedByDevice.slice(0, 64),
        };
        orderStore.put(committedOrder);
        metaStore.put({
          key: 'workspace_meta',
          localRevision: nextRevision,
          updatedAt: new Date().toISOString(),
          schemaVersion: OP_DB_VERSION,
        });
      };

      orderRequest.onsuccess = () => { orderReady = true; commitIfReady(); };
      orderRequest.onerror = () => { try { tx.abort(); } catch { /* transaction already inactive */ } };
      metaRequest.onsuccess = () => { metaReady = true; commitIfReady(); };
      metaRequest.onerror = () => { try { tx.abort(); } catch { /* transaction already inactive */ } };
      tx.oncomplete = () => {
        closeIfOwned();
        if (committedOrder) resolve(committedOrder);
        else reject(new Error('ثبت اتمیک حواله خروج کامل نشد.'));
      };
      tx.onerror = () => {
        closeIfOwned();
        reject(tx.error ?? new Error('خطا در ثبت اتمیک حواله خروج.'));
      };
      tx.onabort = () => {
        closeIfOwned();
        reject(tx.error ?? new Error('تراکنش حواله خروج لغو شد؛ هیچ تغییری اعمال نشد.'));
      };
    } catch (error) {
      closeIfOwned();
      reject(error);
    }
  });
}

/**
 * Hydrates the full operational workspace from IndexedDB on application boot.
 * Returns null if the operational database has not been seeded yet.
 */
export async function loadOperationalWorkspace(): Promise<OperationalWorkspaceData | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    const db = await openOperationalDb();
    const entityStores: OperationalStoreName[] = [
      'meta',
      'accounts',
      'parties',
      'products',
      'vouchers',
      'invoices',
      'cheques',
      'employees',
      'assets',
      'costCenters',
      'currencies',
      'exchangeRates',
      'importDossiers',
      'salesOrders',
      'subcontractJobs',
      'rbacOperators',
      'auditLogs',
      'warehouses',
      'taxReports',
      'localProfiles',
      'syncOutbox',
      'syncInbox',
    ];
    const tx = db.transaction(entityStores, 'readonly');
    const [
      metaRows,
      accounts,
      parties,
      products,
      vouchers,
      invoices,
      cheques,
      employees,
      assets,
      costCenters,
      currencies,
      exchangeRates,
      importDossiers,
      salesOrders,
      subcontractJobs,
      rbacOperators,
      auditLogs,
      warehouses,
      taxReports,
      localProfiles,
      syncOutbox,
      syncInbox,
    ] = await Promise.all([
      readAllFromStore<{ key: string; value?: unknown; localRevision?: number; updatedAt?: string }>(
        tx,
        'meta'
      ),
      readAllFromStore<Account>(tx, 'accounts'),
      readAllFromStore<Party>(tx, 'parties'),
      readAllFromStore<Product>(tx, 'products'),
      readAllFromStore<Voucher>(tx, 'vouchers'),
      readAllFromStore<Invoice>(tx, 'invoices'),
      readAllFromStore<Cheque>(tx, 'cheques'),
      readAllFromStore<import('../types/accounting').Employee>(tx, 'employees'),
      readAllFromStore<FixedAsset>(tx, 'assets'),
      readAllFromStore<CostCenter>(tx, 'costCenters'),
      readAllFromStore<CurrencyDefinition>(tx, 'currencies'),
      readAllFromStore<ExchangeRateEntry>(tx, 'exchangeRates'),
      readAllFromStore<ImportDossier>(tx, 'importDossiers'),
      readAllFromStore<SalesOrder>(tx, 'salesOrders'),
      readAllFromStore<SubcontractJob>(tx, 'subcontractJobs'),
      readAllFromStore<RbacOperator>(tx, 'rbacOperators'),
      readAllFromStore<AuditActivityLog>(tx, 'auditLogs'),
      readAllFromStore<Record<string, unknown>>(tx, 'warehouses'),
      readAllFromStore<Record<string, unknown>>(tx, 'taxReports'),
      readAllFromStore<Record<string, unknown>>(tx, 'localProfiles'),
      readAllFromStore<SyncOutboxOperation>(tx, 'syncOutbox'),
      readAllFromStore<SyncInboxRecord>(tx, 'syncInbox'),
    ]);
    db.close();

    const profileRow = metaRows.find((r) => r.key === 'profile');
    const wsMeta = metaRows.find((r) => r.key === 'workspace_meta');
    if (!profileRow?.value || accounts.length === 0) {
      return null;
    }

    return {
      profile: profileRow.value as CompanyProfile,
      accounts,
      parties,
      products,
      vouchers: vouchers.sort((a, b) => a.voucherNumber - b.voucherNumber),
      invoices: invoices.sort((a, b) => b.date.localeCompare(a.date)),
      cheques,
      employees,
      assets,
      costCenters,
      currencies,
      exchangeRates,
      importDossiers,
      salesOrders,
      subcontractJobs,
      rbacOperators,
      auditLogs,
      warehouses,
      taxReports,
      localProfiles,
      syncOutbox,
      syncInbox,
      businessLocalState: captureBusinessLocalStateSnapshot(),
      localRevision: wsMeta?.localRevision ?? 1,
      updatedAt: wsMeta?.updatedAt,
    };
  } catch (error) {
    // A failed read is not an empty workspace: propagate it so callers cannot
    // silently hydrate fallback/demo data over an unreadable operational DB.
    throw error;
  }
}

export function countOperationalWorkspaceRecords(workspace: OperationalWorkspaceData): number {
  const collections = [
    workspace.accounts, workspace.parties, workspace.products, workspace.vouchers,
    workspace.invoices, workspace.cheques, workspace.employees, workspace.assets,
    workspace.costCenters, workspace.currencies, workspace.exchangeRates,
    workspace.importDossiers, workspace.salesOrders, workspace.subcontractJobs,
    workspace.rbacOperators, workspace.auditLogs,
    workspace.warehouses ?? [], workspace.taxReports ?? [], workspace.localProfiles ?? [],
    workspace.syncOutbox ?? [], workspace.syncInbox ?? [],
  ];
  if (!collections.every(Array.isArray)) {
    throw new Error('ساختار مجموعه رکوردهای فضای کاری معتبر نیست.');
  }
  const total = collections.reduce((sum, rows) => sum + rows.length, 0) +
    (workspace.businessLocalState ? countBusinessLocalStateSnapshotRecords(workspace.businessLocalState) : 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('تعداد رکوردهای فضای کاری خارج از محدوده مجاز است.');
  }
  return total;
}

export function parseOperationalWorkspaceSnapshot(snapshotJson: string): OperationalWorkspaceData {
  let parsed: Partial<OperationalWorkspaceData>;
  try {
    parsed = JSON.parse(snapshotJson) as Partial<OperationalWorkspaceData>;
  } catch {
    throw new Error('محتوای فضای کاری رمزگذاری‌شده JSON معتبر نیست.');
  }
  if (
    !parsed.profile || typeof parsed.profile !== 'object' ||
    typeof parsed.profile.uid !== 'string' || !parsed.profile.uid.trim() ||
    typeof parsed.profile.companyName !== 'string' || !parsed.profile.companyName.trim() ||
    typeof parsed.profile.fiscalYear !== 'string' || !parsed.profile.fiscalYear.trim() ||
    !Array.isArray(parsed.accounts) || parsed.accounts.length === 0 ||
    !parsed.accounts.every((account) => !!account && typeof account.id === 'string' &&
      typeof account.code === 'string' && typeof account.title === 'string') ||
    !Array.isArray(parsed.parties) || !Array.isArray(parsed.products) ||
    !Array.isArray(parsed.vouchers) || !Array.isArray(parsed.invoices) ||
    !Array.isArray(parsed.cheques) || !Array.isArray(parsed.employees) ||
    !Array.isArray(parsed.assets) || !Array.isArray(parsed.costCenters) ||
    !Array.isArray(parsed.currencies) || !Array.isArray(parsed.exchangeRates) ||
    !Array.isArray(parsed.importDossiers) || !Array.isArray(parsed.salesOrders) ||
    !Array.isArray(parsed.subcontractJobs) || !Array.isArray(parsed.rbacOperators) ||
    !Array.isArray(parsed.auditLogs) ||
    (parsed.warehouses !== undefined && !Array.isArray(parsed.warehouses)) ||
    (parsed.taxReports !== undefined && !Array.isArray(parsed.taxReports)) ||
    (parsed.localProfiles !== undefined && !Array.isArray(parsed.localProfiles)) ||
    (parsed.syncOutbox !== undefined && !Array.isArray(parsed.syncOutbox)) ||
    (parsed.syncInbox !== undefined && !Array.isArray(parsed.syncInbox)) ||
    (parsed.businessLocalState !== undefined && (() => {
      try { validateBusinessLocalStateSnapshot(parsed.businessLocalState); return false; }
      catch { return true; }
    })())
  ) {
    throw new Error('ساختار فضای کاری رمزگذاری‌شده ناقص یا ناسازگار است.');
  }
  return {
    ...parsed,
    warehouses: parsed.warehouses ?? [],
    taxReports: parsed.taxReports ?? [],
    localProfiles: parsed.localProfiles ?? [],
    syncOutbox: parsed.syncOutbox ?? [],
    syncInbox: parsed.syncInbox ?? [],
  } as OperationalWorkspaceData;
}

/**
 * Non-destructive phase-1 migration preparation:
 * encrypts and verifies a complete workspace snapshot into a dedicated store.
 * Legacy entity stores are intentionally retained until every writer/reader has
 * been switched and an explicit cutover procedure is validated.
 */
/**
 * Writes a verified encrypted workspace snapshot without touching legacy entity stores.
 * The revision comparison and secureWorkspace put share one IndexedDB transaction,
 * preventing a stale asynchronous encryption result from replacing a newer snapshot.
 */
export async function writeEncryptedOperationalWorkspaceSnapshot(
  workspaceId: string,
  workspace: OperationalWorkspaceData,
  expectedSourceRevision: number
): Promise<EncryptedOperationalWorkspaceMeta> {
  if (isOperationalRestoreBarrierActive()) {
    throw new Error('ذخیره نسخه عملیاتی رمزگذاری‌شده تا پایان بازیابی متوقف است.');
  }
  const cleanWorkspaceId = workspaceId.trim();
  if (!cleanWorkspaceId || cleanWorkspaceId.length > 180) {
    throw new Error('شناسه فضای کاری برای ذخیره رمزگذاری‌شده معتبر نیست.');
  }
  if (!Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 1) {
    throw new Error('شماره بازبینی مبنا برای ذخیره رمزگذاری‌شده معتبر نیست.');
  }
  const snapshotJson = JSON.stringify(workspace);
  parseOperationalWorkspaceSnapshot(snapshotJson);
  const passphrase = requireBackupSessionPassphrase();
  const envelope = await encryptBackupEnvelope(snapshotJson, passphrase);
  const verification = await decryptAndVerifyBackupEnvelope(JSON.stringify(envelope), passphrase);
  if (!verification.ok || verification.snapshotJson !== snapshotJson || verification.sha256 !== envelope.plaintextSha256) {
    throw new Error(verification.error || 'اعتبارسنجی نسخه رمزگذاری‌شده فضای کاری ناموفق بود.');
  }

  if (isOperationalRestoreBarrierActive()) {
    throw new Error('ذخیره نسخه عملیاتی رمزگذاری‌شده تا پایان بازیابی متوقف است.');
  }
  const recordCount = countOperationalWorkspaceRecords(workspace);
  const record: EncryptedOperationalWorkspaceRecord = {
    workspaceId: cleanWorkspaceId,
    envelopeJson: JSON.stringify(envelope),
    schemaVersion: 2,
    recordCount,
    sourceRevision: expectedSourceRevision,
    plaintextSha256: envelope.plaintextSha256,
    preparedAt: new Date().toISOString(),
    migrationState: 'prepared',
  };
  if (!validateEncryptedOperationalWorkspaceRecordMetadata(record, cleanWorkspaceId)) {
    throw new Error('فراداده نسخه رمزگذاری‌شده تولیدشده معتبر نیست.');
  }
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB در این محیط در دسترس نیست.');
  const db = await openOperationalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const tx = db.transaction(['meta', 'secureWorkspace'], 'readwrite');
      const metaReq = tx.objectStore('meta').get('workspace_meta');
      metaReq.onsuccess = () => {
        if (isOperationalRestoreBarrierActive()) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          if (!settled) { settled = true; reject(new Error('ذخیره نسخه عملیاتی رمزگذاری‌شده تا پایان بازیابی متوقف است.')); }
          return;
        }
        const current = metaReq.result as { localRevision?: number } | undefined;
        const currentRevision = Math.max(1, Number(current?.localRevision) || 1);
        if (currentRevision !== expectedSourceRevision) {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          if (!settled) {
            settled = true;
            reject(new Error('داده‌های عملیاتی هنگام رمزگذاری تغییر کرده‌اند؛ ذخیره نسخه رمزگذاری‌شده متوقف شد.'));
          }
          return;
        }
        const putReq = tx.objectStore('secureWorkspace').put(record);
        putReq.onerror = () => {
          if (!settled) {
            settled = true;
            reject(putReq.error ?? new Error('نوشتن نسخه رمزگذاری‌شده فضای کاری ناموفق بود.'));
          }
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
        };
      };
      metaReq.onerror = () => {
        if (!settled) {
          settled = true;
          reject(metaReq.error ?? new Error('خواندن نسخه عملیاتی برای ذخیره رمزگذاری‌شده ناموفق بود.'));
        }
        try { tx.abort(); } catch { /* transaction may already be inactive */ }
      };
      tx.oncomplete = () => {
        if (!settled) { settled = true; resolve(); }
      };
      tx.onerror = () => {
        if (!settled) { settled = true; reject(tx.error ?? new Error('Encrypted workspace write failed.')); }
      };
      tx.onabort = () => {
        if (!settled) { settled = true; reject(tx.error ?? new Error('Encrypted workspace write aborted.')); }
      };
    });
  } finally {
    db.close();
  }
  return {
    workspaceId: record.workspaceId,
    schemaVersion: record.schemaVersion,
    recordCount: record.recordCount,
    sourceRevision: record.sourceRevision,
    plaintextSha256: record.plaintextSha256,
    preparedAt: record.preparedAt,
    migrationState: record.migrationState,
  };
}

export async function prepareEncryptedOperationalWorkspaceMigration(
  workspaceId: string
): Promise<EncryptedOperationalWorkspaceMeta> {
  const workspace = await loadOperationalWorkspace();
  if (!workspace) {
    throw new Error('داده عملیاتی محلی برای آماده‌سازی مهاجرت یافت نشد.');
  }
  return writeEncryptedOperationalWorkspaceSnapshot(
    workspaceId,
    workspace,
    Math.max(1, Number(workspace.localRevision) || 1)
  );
}

export async function loadPreparedEncryptedOperationalWorkspace(
  workspaceId: string
): Promise<OperationalWorkspaceData | null> {
  const cleanWorkspaceId = workspaceId.trim();
  if (!cleanWorkspaceId || !isIndexedDbAvailable()) return null;
  const db = await openOperationalDb();
  let record: EncryptedOperationalWorkspaceRecord | undefined;
  let currentRevision = 0;
  try {
    const tx = db.transaction(['meta', 'secureWorkspace'], 'readonly');
    const [storedRecord, workspaceMeta] = await Promise.all([
      new Promise<EncryptedOperationalWorkspaceRecord | undefined>((resolve, reject) => {
        const req = tx.objectStore('secureWorkspace').get(cleanWorkspaceId);
        req.onsuccess = () => resolve(req.result as EncryptedOperationalWorkspaceRecord | undefined);
        req.onerror = () => reject(req.error);
      }),
      new Promise<{ localRevision?: number } | undefined>((resolve, reject) => {
        const req = tx.objectStore('meta').get('workspace_meta');
        req.onsuccess = () => resolve(req.result as { localRevision?: number } | undefined);
        req.onerror = () => reject(req.error);
      }),
    ]);
    record = storedRecord;
    currentRevision = Math.max(1, Number(workspaceMeta?.localRevision) || 1);
  } finally {
    db.close();
  }
  if (!record) return null;
  if (!validateEncryptedOperationalWorkspaceRecordMetadata(record, cleanWorkspaceId)) {
    throw new Error('فراداده نسخه عملیاتی رمزگذاری‌شده نامعتبر است؛ بازیابی متوقف شد.');
  }

  if (currentRevision !== record.sourceRevision) {
    throw new Error('نسخه رمزگذاری‌شده آماده‌شده قدیمی است و با داده عملیاتی فعلی تطابق ندارد.');
  }

  const result = await decryptAndVerifyBackupEnvelope(
    record.envelopeJson,
    requireBackupSessionPassphrase()
  );
  if (!result.ok || !result.snapshotJson) {
    throw new Error(result.error || 'رمزگشایی فضای کاری مهاجرت‌شده ناموفق بود.');
  }
  if (result.sha256 !== record.plaintextSha256) {
    throw new Error('اثر انگشت نسخه عملیاتی رمزگذاری‌شده با فراداده آن مطابقت ندارد.');
  }
  const workspace = parseOperationalWorkspaceSnapshot(result.snapshotJson);
  const actualRecordCount = countOperationalWorkspaceRecords(workspace);
  if (actualRecordCount !== record.recordCount) {
    throw new Error('تعداد رکوردهای فضای کاری با فراداده نسخه رمزگذاری‌شده مطابقت ندارد.');
  }
  return workspace;
}

export async function getPreparedEncryptedOperationalWorkspaceMeta(
  workspaceId: string
): Promise<EncryptedOperationalWorkspaceMeta | null> {
  const cleanWorkspaceId = workspaceId.trim();
  if (!cleanWorkspaceId || !isIndexedDbAvailable()) return null;
  const db = await openOperationalDb();
  try {
    const tx = db.transaction(['secureWorkspace'], 'readonly');
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore('secureWorkspace').get(cleanWorkspaceId);
      req.onsuccess = () => {
        const row = req.result as EncryptedOperationalWorkspaceRecord | undefined;
        if (!row) return resolve(null);
        if (!validateEncryptedOperationalWorkspaceRecordMetadata(row, cleanWorkspaceId)) {
          return reject(new Error('فراداده نسخه عملیاتی رمزگذاری‌شده نامعتبر است.'));
        }
        resolve({
          workspaceId: row.workspaceId,
          schemaVersion: row.schemaVersion,
          recordCount: row.recordCount,
          sourceRevision: row.sourceRevision,
          plaintextSha256: row.plaintextSha256,
          preparedAt: row.preparedAt,
          migrationState: row.migrationState,
        });
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function enqueueSyncOutboxOperation(op: SyncOutboxOperation): Promise<void> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB unavailable: sync outbox was not persisted.');
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      tx.objectStore('syncOutbox').put(op);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    throw err instanceof Error ? err : new Error('Failed to persist sync outbox operation');
  }
}

export async function listPendingSyncOutboxOperations(): Promise<SyncOutboxOperation[]> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB unavailable: cannot safely read durable sync outbox');
  const db = await openOperationalDb();
  try {
    const tx = db.transaction('syncOutbox', 'readonly');
    const all = await readAllFromStore<SyncOutboxOperation>(tx, 'syncOutbox');
    return all
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally {
    db.close();
  }
}

export async function markSyncOutboxOperationStatus(
  operationId: string,
  status: 'synced' | 'conflict'
): Promise<void> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB unavailable: sync outbox status was not persisted.');
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('syncOutbox', 'readwrite');
      const store = tx.objectStore('syncOutbox');
      if (status === 'synced') {
        store.delete(operationId);
      } else {
        const req = store.get(operationId);
        req.onsuccess = () => {
          const item = req.result as SyncOutboxOperation | undefined;
          if (item) {
            store.put({ ...item, status, retryCount: item.retryCount + 1 });
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    throw err instanceof Error ? err : new Error('Failed to update sync outbox operation status');
  }
}

export async function clearPendingSyncOutboxOperations(): Promise<void> {
  if (!isIndexedDbAvailable()) return;
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['syncOutbox'], 'readwrite');
      tx.objectStore('syncOutbox').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore silently
  }
}

/** Records a processed inbound sync operation in durable syncInbox for duplicate detection */
export async function recordInboxOperation(rec: SyncInboxRecord): Promise<void> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB unavailable: inbound sync deduplication record was not persisted.');
  const db = await openOperationalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['syncInbox'], 'readwrite');
      tx.objectStore('syncInbox').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Inbound sync deduplication write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Inbound sync deduplication write aborted'));
    });
  } catch (err) {
    // A missing durable deduplication record can cause an already-applied remote
    // operation to be replayed. Surface storage failures instead of reporting success.
    throw err instanceof Error ? err : new Error('Failed to persist inbound sync deduplication record');
  } finally {
    db.close();
  }
}

/** Checks whether an inbound operationId was already durably applied to this device */
export async function isInboxOperationProcessed(operationId: string): Promise<boolean> {
  if (!isIndexedDbAvailable()) throw new Error('IndexedDB unavailable: cannot safely verify inbound sync deduplication.');
  const db = await openOperationalDb();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(['syncInbox'], 'readonly');
      const req = tx.objectStore('syncInbox').get(operationId);
      req.onsuccess = () => resolve(Boolean(req.result));
      req.onerror = () => reject(req.error ?? new Error('Inbound sync deduplication read failed'));
      tx.onerror = () => reject(tx.error ?? new Error('Inbound sync deduplication transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Inbound sync deduplication transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Atomic Stocktaking Adjustment commit in Operational IndexedDB (products + permanent voucher) */
/** Atomically commits a local cheque status transition and its optional ledger voucher. */
export async function commitChequeStatusOperationalTx(
  payload: { cheque: Cheque; expectedStatus: Cheque['status']; voucher?: Voucher | null },
  options?: { dbOverride?: IDBDatabase }
): Promise<boolean> {
  const usingOverride = Boolean(options?.dbOverride);
  if (!usingOverride && !isIndexedDbAvailable()) return false;
  const cheque = payload?.cheque;
  if (
    !cheque ||
    typeof cheque.id !== 'string' ||
    !cheque.id.trim() ||
    !Number.isSafeInteger(cheque.amount) ||
    cheque.amount <= 0 ||
    typeof cheque.status !== 'string' ||
    !cheque.status.trim()
  ) {
    throw new Error('ATOMIC_CHEQUE_INVALID: اطلاعات چک برای تغییر وضعیت معتبر نیست.');
  }

  const voucher = payload.voucher;
  if (voucher) {
    if (typeof voucher.id !== 'string' || !voucher.id.trim() || !Array.isArray(voucher.lines) || voucher.lines.length < 2) {
      throw new Error('ATOMIC_CHEQUE_INVALID_VOUCHER: سند تغییر وضعیت چک معتبر نیست.');
    }
    let debit = 0;
    let credit = 0;
    for (const line of voucher.lines) {
      if (
        !Number.isSafeInteger(line?.debit) || Number(line.debit) < 0 ||
        !Number.isSafeInteger(line?.credit) || Number(line.credit) < 0 ||
        (Number(line.debit) > 0 && Number(line.credit) > 0)
      ) {
        throw new Error('ATOMIC_CHEQUE_INVALID_VOUCHER_LINE: ردیف سند چک نامعتبر است.');
      }
      debit += Number(line.debit);
      credit += Number(line.credit);
      if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
        throw new Error('ATOMIC_CHEQUE_INVALID_VOUCHER_TOTAL: جمع سند چک خارج از محدوده امن است.');
      }
    }
    if (debit <= 0 || debit !== credit) {
      throw new Error('ATOMIC_CHEQUE_UNBALANCED_VOUCHER: سند تغییر وضعیت چک تراز نیست.');
    }
  }

  const db = options?.dbOverride ?? (await openOperationalDb());
  const committedAt = new Date().toISOString();
  const closeIfOwned = () => {
    if (!usingOverride) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
  };

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    let settled = false;
    const abortAndReject = (error: unknown) => {
      if (tx) {
        try { tx.abort(); } catch { /* ignore abort race */ }
      }
      if (!settled) {
        settled = true;
        closeIfOwned();
        reject(error instanceof Error ? error : new Error(String(error || 'Atomic cheque transition rollback')));
      }
    };

    try {
      tx = db.transaction(['meta', 'cheques', 'vouchers'], 'readwrite');
      const chequeStore = tx.objectStore('cheques');
      const currentChequeReq = chequeStore.get(cheque.id);
      currentChequeReq.onsuccess = () => {
        try {
          const currentCheque = currentChequeReq.result as Cheque | undefined;
          if (!currentCheque) {
            throw new Error('ATOMIC_CHEQUE_NOT_FOUND: چک محلی برای تغییر وضعیت پیدا نشد.');
          }
          if (currentCheque.status !== payload.expectedStatus && currentCheque.status !== cheque.status) {
            throw new Error('ATOMIC_CHEQUE_STALE_STATUS: وضعیت چک هم‌زمان تغییر کرده است؛ داده‌ها را تازه‌سازی کنید.');
          }
          const chequeReq = chequeStore.put(cheque);
          chequeReq.onerror = () => abortAndReject(chequeReq.error ?? new Error('Cheque status write failed'));
        } catch (error) {
          abortAndReject(error);
        }
      };
      currentChequeReq.onerror = () => abortAndReject(currentChequeReq.error ?? new Error('Cheque status read failed'));
      if (voucher) {
        const voucherReq = tx.objectStore('vouchers').put(voucher);
        voucherReq.onerror = () => abortAndReject(voucherReq.error ?? new Error('Cheque transition voucher write failed'));
      }

      const metaStore = tx.objectStore('meta');
      const revisionReq = metaStore.get('workspace_meta');
      revisionReq.onsuccess = () => {
        try {
          const existing = revisionReq.result as { localRevision?: number } | undefined;
          const revision = Number(existing?.localRevision ?? 0);
          if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('ATOMIC_CHEQUE_INVALID_REVISION: شماره بازبینی فضای کاری معتبر نیست.');
          }
          const metaReq = metaStore.put({
            key: 'workspace_meta',
            localRevision: revision + 1,
            updatedAt: committedAt,
            schemaVersion: OP_DB_VERSION,
          });
          metaReq.onerror = () => abortAndReject(metaReq.error ?? new Error('Cheque transition revision write failed'));
        } catch (error) {
          abortAndReject(error);
        }
      };
      revisionReq.onerror = () => abortAndReject(revisionReq.error ?? new Error('Cheque transition revision read failed'));

      tx.oncomplete = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          resolve(true);
        }
      };
      tx.onerror = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic cheque transition commit failed'));
        }
      };
      tx.onabort = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic cheque transition aborted'));
        }
      };
    } catch (error) {
      resetOperationalDiffCache();
      if (tx) {
        try { tx.abort(); } catch { /* ignore abort race */ }
      }
      closeIfOwned();
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}


/** Atomically commits local fixed-asset depreciation balances and their permanent ledger voucher. */
export async function commitDepreciationOperationalTx(
  payload: {
    assetUpdates: Array<{
      id: string;
      expectedAccumulatedDepreciation: number;
      expectedPurchaseCost: number;
      expectedSalvageValue: number;
      expectedUsefulLifeYears: number;
      expectedPurchaseDate: string;
      depreciationAmount: number;
      accumulatedDepreciation: number;
    }>;
    voucher: Voucher;
  },
  options?: { dbOverride?: IDBDatabase }
): Promise<boolean> {
  const usingOverride = Boolean(options?.dbOverride);
  if (!usingOverride && !isIndexedDbAvailable()) return false;
  const { assetUpdates, voucher } = payload ?? ({} as typeof payload);
  if (!Array.isArray(assetUpdates) || assetUpdates.length === 0 || assetUpdates.length > 400) {
    throw new Error('ATOMIC_DEPRECIATION_INVALID_ASSETS: فهرست دارایی‌های استهلاک معتبر نیست.');
  }
  const seenAssetIds = new Set<string>();
  let totalDepreciation = 0;
  for (const update of assetUpdates) {
    if (
      !update ||
      typeof update.id !== 'string' ||
      !update.id.trim() ||
      seenAssetIds.has(update.id) ||
      !Number.isSafeInteger(update.expectedAccumulatedDepreciation) ||
      update.expectedAccumulatedDepreciation < 0 ||
      !Number.isSafeInteger(update.expectedPurchaseCost) ||
      update.expectedPurchaseCost <= 0 ||
      !Number.isSafeInteger(update.expectedSalvageValue) ||
      update.expectedSalvageValue < 0 ||
      update.expectedSalvageValue > update.expectedPurchaseCost ||
      !Number.isFinite(update.expectedUsefulLifeYears) ||
      update.expectedUsefulLifeYears <= 0 ||
      typeof update.expectedPurchaseDate !== 'string' ||
      !update.expectedPurchaseDate.trim() ||
      !Number.isSafeInteger(update.depreciationAmount) ||
      update.depreciationAmount <= 0 ||
      !Number.isSafeInteger(update.accumulatedDepreciation) ||
      update.accumulatedDepreciation !== update.expectedAccumulatedDepreciation + update.depreciationAmount
    ) {
      throw new Error('ATOMIC_DEPRECIATION_INVALID_ASSET_UPDATE: تغییر مانده استهلاک دارایی نامعتبر یا تکراری است.');
    }
    totalDepreciation += update.depreciationAmount;
    if (!Number.isSafeInteger(totalDepreciation)) {
      throw new Error('ATOMIC_DEPRECIATION_UNSAFE_ASSET_TOTAL: جمع استهلاک دارایی‌ها خارج از محدوده امن است.');
    }
    seenAssetIds.add(update.id);
  }
  if (
    !voucher ||
    typeof voucher.id !== 'string' ||
    !voucher.id.trim() ||
    typeof voucher.ownerId !== 'string' ||
    !voucher.ownerId.trim() ||
    !Number.isSafeInteger(voucher.voucherNumber) ||
    voucher.voucherNumber <= 0 ||
    voucher.status !== 'permanent' ||
    voucher.voucherType !== 'depreciation' ||
    typeof voucher.referenceId !== 'string' ||
    !voucher.referenceId.trim() ||
    !Array.isArray(voucher.lines) ||
    voucher.lines.length < 2 ||
    !Number.isSafeInteger(voucher.totalDebit) ||
    !Number.isSafeInteger(voucher.totalCredit) ||
    voucher.totalDebit <= 0 ||
    voucher.totalDebit !== voucher.totalCredit
  ) {
    throw new Error('ATOMIC_DEPRECIATION_INVALID_VOUCHER: سند دائمی استهلاک معتبر یا متوازن نیست.');
  }
  let debit = 0;
  let credit = 0;
  for (const line of voucher.lines) {
    if (
      !Number.isSafeInteger(line?.debit) || Number(line.debit) < 0 ||
      !Number.isSafeInteger(line?.credit) || Number(line.credit) < 0 ||
      (Number(line.debit) > 0 && Number(line.credit) > 0)
    ) {
      throw new Error('ATOMIC_DEPRECIATION_INVALID_LINE: ردیف سند استهلاک نامعتبر است.');
    }
    debit += Number(line.debit);
    credit += Number(line.credit);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
      throw new Error('ATOMIC_DEPRECIATION_UNSAFE_TOTAL: جمع سند استهلاک خارج از محدوده امن است.');
    }
  }
  if (debit !== voucher.totalDebit || credit !== voucher.totalCredit || debit !== credit) {
    throw new Error('ATOMIC_DEPRECIATION_UNBALANCED_VOUCHER: جمع ردیف‌ها با سربرگ سند استهلاک تراز نیست.');
  }
  if (totalDepreciation !== voucher.totalDebit) {
    throw new Error('ATOMIC_DEPRECIATION_ASSET_VOUCHER_MISMATCH: جمع استهلاک دارایی‌ها با مبلغ سند حسابداری برابر نیست.');
  }

  const db = options?.dbOverride ?? (await openOperationalDb());
  const committedAt = new Date().toISOString();
  const closeIfOwned = () => {
    if (!usingOverride) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
  };
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    let settled = false;
    const abortAndReject = (error: unknown) => {
      if (tx) {
        try { tx.abort(); } catch { /* ignore abort race */ }
      }
      if (!settled) {
        settled = true;
        closeIfOwned();
        reject(error instanceof Error ? error : new Error(String(error || 'Atomic depreciation rollback')));
      }
    };
    try {
      tx = db.transaction(['meta', 'assets', 'vouchers'], 'readwrite');
      const assetStore = tx.objectStore('assets');
      const voucherStore = tx.objectStore('vouchers');
      const liveAssets = new Map<string, FixedAsset>();
      let remainingReads = assetUpdates.length + 2;
      const finishRead = () => {
        if (settled || --remainingReads !== 0) return;
        try {
          const currentVoucher = (tx as IDBTransaction).objectStore('vouchers');
          if (voucherExists) {
            throw new Error('ATOMIC_DEPRECIATION_DUPLICATE_VOUCHER: سند استهلاک این دوره قبلاً ثبت شده است.');
          }
          for (const update of assetUpdates) {
            const live = liveAssets.get(update.id);
            if (!live) {
              throw new Error(`ATOMIC_DEPRECIATION_ASSET_NOT_FOUND: دارایی ${update.id} در پایگاه محلی پیدا نشد.`);
            }
            if (
              live.ownerId !== voucher.ownerId ||
              live.accumulatedDepreciation !== update.expectedAccumulatedDepreciation ||
              live.purchaseCost !== update.expectedPurchaseCost ||
              live.salvageValue !== update.expectedSalvageValue ||
              live.usefulLifeYears !== update.expectedUsefulLifeYears ||
              live.purchaseDate !== update.expectedPurchaseDate ||
              !Number.isSafeInteger(live.purchaseCost) ||
              live.purchaseCost <= 0 ||
              !Number.isSafeInteger(live.salvageValue) ||
              live.salvageValue < 0 ||
              live.salvageValue > live.purchaseCost ||
              update.accumulatedDepreciation > live.purchaseCost - live.salvageValue
            ) {
              throw new Error(`ATOMIC_DEPRECIATION_STALE_OR_INVALID_ASSET: دارایی ${update.id} تغییر کرده یا مانده استهلاک آن نامعتبر است.`);
            }
          }
          for (const update of assetUpdates) {
            const live = liveAssets.get(update.id)!;
            const request = assetStore.put({
              ...live,
              accumulatedDepreciation: update.accumulatedDepreciation,
            });
            request.onerror = () => abortAndReject(request.error ?? new Error('Depreciation asset write failed'));
          }
          const voucherWrite = currentVoucher.put(voucher);
          voucherWrite.onerror = () => abortAndReject(voucherWrite.error ?? new Error('Depreciation voucher write failed'));
          const metaWrite = tx!.objectStore('meta').put({
            key: 'workspace_meta',
            localRevision: nextRevision,
            updatedAt: committedAt,
            schemaVersion: OP_DB_VERSION,
          });
          metaWrite.onerror = () => abortAndReject(metaWrite.error ?? new Error('Depreciation revision write failed'));
        } catch (error) {
          abortAndReject(error);
        }
      };
      let voucherExists = false;
      let nextRevision = 0;
      const voucherRead = voucherStore.get(voucher.id);
      voucherRead.onsuccess = () => {
        voucherExists = Boolean(voucherRead.result);
        finishRead();
      };
      voucherRead.onerror = () => abortAndReject(voucherRead.error ?? new Error('Depreciation voucher read failed'));
      const metaRead = tx.objectStore('meta').get('workspace_meta');
      metaRead.onsuccess = () => {
        try {
          const revision = Number((metaRead.result as { localRevision?: number } | undefined)?.localRevision ?? 0);
          if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('ATOMIC_DEPRECIATION_INVALID_REVISION: شماره بازبینی فضای کاری معتبر نیست.');
          }
          nextRevision = revision + 1;
          finishRead();
        } catch (error) {
          abortAndReject(error);
        }
      };
      metaRead.onerror = () => abortAndReject(metaRead.error ?? new Error('Depreciation revision read failed'));
      for (const update of assetUpdates) {
        const request = assetStore.get(update.id);
        request.onsuccess = () => {
          const live = request.result as FixedAsset | undefined;
          if (live) liveAssets.set(update.id, live);
          finishRead();
        };
        request.onerror = () => abortAndReject(request.error ?? new Error('Depreciation asset read failed'));
      }
      tx.oncomplete = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          resolve(true);
        }
      };
      tx.onerror = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic depreciation commit failed'));
        }
      };
      tx.onabort = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic depreciation aborted'));
        }
      };
    } catch (error) {
      resetOperationalDiffCache();
      if (tx) {
        try { tx.abort(); } catch { /* ignore abort race */ }
      }
      closeIfOwned();
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

export async function commitStockAdjustmentOperationalTx(
  payload: {
    updatedProducts: Product[];
    voucher?: Voucher | null;
  },
  options?: { dbOverride?: IDBDatabase }
): Promise<boolean> {
  const usingOverride = Boolean(options?.dbOverride);
  if (!usingOverride && !isIndexedDbAvailable()) return false;
  if (!Array.isArray(payload.updatedProducts)) {
    throw new Error('ATOMIC_STOCK_INVALID_PRODUCTS: فهرست کالاهای اصلاح‌شده معتبر نیست.');
  }

  const seenProductIds = new Set<string>();
  for (const product of payload.updatedProducts) {
    if (
      !product ||
      typeof product.id !== 'string' ||
      !product.id.trim() ||
      !Number.isFinite(product.stock) ||
      product.stock < 0 ||
      seenProductIds.has(product.id)
    ) {
      throw new Error('ATOMIC_STOCK_INVALID_PRODUCT: شناسه، موجودی یا تکرار کالای اصلاح‌شده نامعتبر است.');
    }
    seenProductIds.add(product.id);
  }

  if (payload.voucher) {
    const voucher = payload.voucher;
    if (!voucher.id || !Array.isArray(voucher.lines) || voucher.lines.length < 2) {
      throw new Error('ATOMIC_STOCK_INVALID_VOUCHER: سند تعدیل باید حداقل دو ردیف معتبر داشته باشد.');
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of voucher.lines) {
      const debit = line?.debit;
      const credit = line?.credit;
      if (
        !Number.isSafeInteger(debit) || Number(debit) < 0 ||
        !Number.isSafeInteger(credit) || Number(credit) < 0 ||
        (Number(debit) > 0 && Number(credit) > 0)
      ) {
        throw new Error('ATOMIC_STOCK_INVALID_VOUCHER_LINE: مبلغ بدهکار یا بستانکار سند تعدیل نامعتبر است.');
      }
      totalDebit += Number(debit);
      totalCredit += Number(credit);
      if (!Number.isSafeInteger(totalDebit) || !Number.isSafeInteger(totalCredit)) {
        throw new Error('ATOMIC_STOCK_INVALID_VOUCHER_TOTAL: جمع مبالغ سند تعدیل خارج از محدوده امن است.');
      }
    }
    if (totalDebit <= 0 || totalDebit !== totalCredit) {
      throw new Error('ATOMIC_STOCK_UNBALANCED_VOUCHER: سند تعدیل انبار تراز نیست.');
    }
  }

  const db = options?.dbOverride ?? (await openOperationalDb());
  const committedAt = new Date().toISOString();
  const closeIfOwned = () => {
    if (!usingOverride) {
      try { db.close(); } catch { /* ignore close errors */ }
    }
  };

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction | null = null;
    let settled = false;
    const abortAndReject = (error: unknown) => {
      if (tx) {
        try { tx.abort(); } catch { /* transaction may already be inactive */ }
      }
      if (!settled) {
        settled = true;
        closeIfOwned();
        reject(error instanceof Error ? error : new Error(String(error || 'Atomic stock adjustment rollback')));
      }
    };

    try {
      tx = db.transaction(['meta', 'products', 'vouchers'], 'readwrite');
      const productStore = tx.objectStore('products');
      for (const product of payload.updatedProducts) {
        const req = productStore.put(product);
        req.onerror = () => abortAndReject(req.error ?? new Error('Atomic stock product write failed'));
      }

      if (payload.voucher) {
        const voucherReq = tx.objectStore('vouchers').put(payload.voucher);
        voucherReq.onerror = () => abortAndReject(voucherReq.error ?? new Error('Atomic stock voucher write failed'));
      }

      const metaStore = tx.objectStore('meta');
      const revisionReq = metaStore.get('workspace_meta');
      revisionReq.onsuccess = () => {
        try {
          const existing = revisionReq.result as { localRevision?: number } | undefined;
          const currentRevision = Number(existing?.localRevision ?? 0);
          if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('ATOMIC_STOCK_INVALID_REVISION: شماره بازبینی فضای کاری معتبر نیست.');
          }
          const metaReq = metaStore.put({
            key: 'workspace_meta',
            localRevision: currentRevision + 1,
            updatedAt: committedAt,
            schemaVersion: OP_DB_VERSION,
          });
          metaReq.onerror = () => abortAndReject(metaReq.error ?? new Error('Atomic stock revision write failed'));
        } catch (error) {
          abortAndReject(error);
        }
      };
      revisionReq.onerror = () => abortAndReject(revisionReq.error ?? new Error('Atomic stock revision read failed'));

      tx.oncomplete = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          resolve(true);
        }
      };
      tx.onerror = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic stock adjustment IndexedDB commit failed'));
        }
      };
      tx.onabort = () => {
        resetOperationalDiffCache();
        if (!settled) {
          settled = true;
          closeIfOwned();
          reject(tx?.error ?? new Error('Atomic stock adjustment IndexedDB transaction aborted'));
        }
      };
    } catch (error) {
      resetOperationalDiffCache();
      if (tx) {
        try { tx.abort(); } catch { /* ignore abort race */ }
      }
      closeIfOwned();
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

function countStoreRecords(tx: IDBTransaction, storeName: OperationalStoreName): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(typeof req.result === 'number' ? req.result : 0);
    req.onerror = () => reject(req.error);
  });
}

function countStoreByIndex(
  tx: IDBTransaction,
  storeName: OperationalStoreName,
  indexName: string,
  query: IDBValidKey
): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const req = tx.objectStore(storeName).index(indexName).count(query);
      req.onsuccess = () => resolve(typeof req.result === 'number' ? req.result : 0);
      req.onerror = () => reject(req.error);
    } catch {
      resolve(0);
    }
  });
}

function readSingleRecord<T>(
  tx: IDBTransaction,
  storeName: OperationalStoreName,
  key: IDBValidKey
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getOperationalDbStats(): Promise<OperationalDbStats> {
  if (!isIndexedDbAvailable()) {
    return {
      supported: false,
      ready: false,
      dbName: OP_DB_NAME,
      storeCount: 0,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
    };
  }
  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readonly');
    let totalRecords = 0;
    let pendingOutboxCount = 0;
    let localRevision = 0;
    let lastCommitAt: string | null = null;

    for (const storeName of OPERATIONAL_STORES) {
      if (storeName === 'meta') {
        const meta = await readSingleRecord<Record<string, unknown>>(tx, 'meta', 'workspace_meta');
        localRevision = Number(meta?.localRevision || 0);
        lastCommitAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : null;
      } else if (storeName === 'syncOutbox') {
        pendingOutboxCount = await countStoreByIndex(tx, 'syncOutbox', 'status', 'pending');
      } else if (storeName === 'syncInbox' || storeName === 'secureWorkspace') {
        // Inbox rows and encrypted migration snapshots are infrastructure records,
        // not active accounting entities.
      } else {
        totalRecords += await countStoreRecords(tx, storeName);
      }
    }
    db.close();
    return {
      supported: true,
      ready: totalRecords > 0,
      dbName: OP_DB_NAME,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords,
      pendingOutboxCount,
      localRevision,
      lastCommitAt,
    };
  } catch {
    return {
      supported: true,
      ready: false,
      dbName: OP_DB_NAME,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
    };
  }
}

export interface OperationalStoreCount {
  store: OperationalStoreName;
  label: string;
  count: number;
}

export interface OperationalDbDetailedReport extends OperationalDbStats {
  dbVersion: number;
  probeLatencyMs: number;
  outboxBreakdown: {
    pending: number;
    synced: number;
    conflict: number;
    total: number;
  };
  storeBreakdown: OperationalStoreCount[];
  errorMessage: string | null;
}

const OPERATIONAL_STORE_LABELS: Record<OperationalStoreName, string> = {
  meta: 'ابرداده و نسخه محلی (meta)',
  accounts: 'کدینگ حساب‌ها (accounts)',
  parties: 'طرف‌حساب‌ها (parties)',
  products: 'کالاها و انبار (products)',
  vouchers: 'اسناد حسابداری (vouchers)',
  invoices: 'فاکتورها (invoices)',
  cheques: 'چک‌های صیادی (cheques)',
  employees: 'پرسنل و حقوق (employees)',
  assets: 'اموال و دارایی‌ها (assets)',
  costCenters: 'مراکز هزینه (costCenters)',
  currencies: 'ارزها (currencies)',
  exchangeRates: 'نرخ‌های ارز (exchangeRates)',
  importDossiers: 'پرونده‌های واردات (importDossiers)',
  salesOrders: 'سفارش‌ها و باسکول (salesOrders)',
  subcontractJobs: 'پیمانکاری رنگرزی (subcontractJobs)',
  rbacOperators: 'اپراتورها و دسترسی (rbacOperators)',
  auditLogs: 'گزارش فعالیت‌ها (auditLogs)',
  syncOutbox: 'صف خروجی سینک (syncOutbox)',
  syncInbox: 'صندوق ورودی سینک (syncInbox)',
  localProfiles: 'پروفایل‌های محلی آفلاین (localProfiles)',
  warehouses: 'انبارها (warehouses)',
  taxReports: 'گزارش‌های مالیاتی و کش‌شده (taxReports)',
  preUpdateBackups: 'پشتیبان ایمنی پیش از بروزرسانی (preUpdateBackups)',
  secureWorkspace: 'نسخه رمزگذاری‌شده فضای کاری (secureWorkspace)',
};

export interface PreUpdateSafetyBackupRecord {
  id: string;
  reason: 'pwa_update' | 'schema_migration' | 'manual_guard';
  schemaVersion: number;
  sha256: string;
  envelopeJson: string;
  createdAt: string;
}

/** Saves an immutable encrypted pre-update / pre-migration safety backup inside IndexedDB. */
export async function savePreUpdateSafetyBackup(
  rec: PreUpdateSafetyBackupRecord
): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  if (
    !rec || typeof rec.id !== 'string' || !rec.id.trim() ||
    !Number.isSafeInteger(rec.schemaVersion) || rec.schemaVersion < 1 ||
    !/^[a-f0-9]{64}$/i.test(rec.sha256) ||
    typeof rec.envelopeJson !== 'string' || !rec.envelopeJson.trim() ||
    typeof rec.createdAt !== 'string' || !Number.isFinite(Date.parse(rec.createdAt))
  ) {
    throw new Error('فراداده نسخه پشتیبان پیش از به‌روزرسانی معتبر نیست.');
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rec.envelopeJson) as Record<string, unknown>;
  } catch {
    throw new Error('پاکت رمزگذاری‌شده نسخه پشتیبان معتبر نیست.');
  }
  if (
    envelope.format !== 'holoo-apex-encrypted-backup' ||
    envelope.kdf !== 'PBKDF2-SHA256' ||
    envelope.cipher !== 'AES-256-GCM' ||
    envelope.plaintextSha256 !== rec.sha256 ||
    typeof envelope.ciphertextB64 !== 'string' || !envelope.ciphertextB64 ||
    typeof envelope.saltB64 !== 'string' || !envelope.saltB64 ||
    typeof envelope.ivB64 !== 'string' || !envelope.ivB64
  ) {
    throw new Error('نسخه پشتیبان پیش از به‌روزرسانی باید پاکت AES-256-GCM معتبر داشته باشد.');
  }
  const verifiedEnvelope = await decryptAndVerifyBackupEnvelope(
    rec.envelopeJson,
    requireBackupSessionPassphrase()
  );
  if (!verifiedEnvelope.ok) {
    throw new Error('نسخه پشتیبان پیش از به‌روزرسانی از نظر رمزنگاری یا یکپارچگی معتبر نیست.');
  }
  const db = await openOperationalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['preUpdateBackups'], 'readwrite');
      tx.objectStore('preUpdateBackups').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Pre-update backup write failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Pre-update backup write aborted.'));
    });
    return true;
  } finally {
    db.close();
  }
}

export async function listPreUpdateSafetyBackups(): Promise<PreUpdateSafetyBackupRecord[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const db = await openOperationalDb();
    const tx = db.transaction(['preUpdateBackups'], 'readonly');
    const rows = await readAllFromStore<PreUpdateSafetyBackupRecord>(tx, 'preUpdateBackups');
    db.close();
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Indexed cursor-based pagination query for high-volume IndexedDB operational stores */
export async function queryOperationalStorePaginated<T>(
  storeName: OperationalStoreName,
  options: { page?: number; pageSize?: number; indexName?: string; direction?: IDBCursorDirection } = {}
): Promise<{ items: T[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.max(1, Math.min(500, Math.trunc(options.pageSize ?? 50)));
  // The encrypted migration envelope is managed only by dedicated verified APIs.
  // Do not expose it through generic operational-store pagination.
  if (storeName === 'secureWorkspace' || !isIndexedDbAvailable()) {
    return { items: [], total: 0, page, pageSize };
  }
  try {
    const db = await openOperationalDb();
    const result = await new Promise<{ items: T[]; total: number }>((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const source: IDBObjectStore | IDBIndex =
        options.indexName && store.indexNames.contains(options.indexName)
          ? store.index(options.indexName)
          : store;
      const countReq = source.count();
      let total = 0;
      countReq.onsuccess = () => {
        total = countReq.result;
      };
      const items: T[] = [];
      const offset = (page - 1) * pageSize;
      let skipped = false;
      const cursorReq = source.openCursor(null, options.direction ?? 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || items.length >= pageSize) {
          return;
        }
        if (!skipped && offset > 0) {
          skipped = true;
          cursor.advance(offset);
          return;
        }
        items.push(cursor.value as T);
        cursor.continue();
      };
      tx.oncomplete = () => resolve({ items, total });
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { items: result.items, total: result.total, page, pageSize };
  } catch {
    return { items: [], total: 0, page, pageSize };
  }
}

export async function getOperationalDbDetailedReport(): Promise<OperationalDbDetailedReport> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const emptyOutbox = { pending: 0, synced: 0, conflict: 0, total: 0 };

  if (!isIndexedDbAvailable()) {
    return {
      supported: false,
      ready: false,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: 0,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
      probeLatencyMs: 0,
      outboxBreakdown: emptyOutbox,
      storeBreakdown: [],
      errorMessage: 'مرورگر فعلی از IndexedDB پشتیبانی نمی‌کند یا دسترسی محدود شده است.',
    };
  }

  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readonly');
    let totalRecords = 0;
    let localRevision = 0;
    let lastCommitAt: string | null = null;
    const outboxBreakdown = { pending: 0, synced: 0, conflict: 0, total: 0 };
    const storeBreakdown: OperationalStoreCount[] = [];

    for (const storeName of OPERATIONAL_STORES) {
      const count = await countStoreRecords(tx, storeName);
      storeBreakdown.push({
        store: storeName,
        label: OPERATIONAL_STORE_LABELS[storeName],
        count,
      });

      if (storeName === 'meta') {
        const meta = await readSingleRecord<Record<string, unknown>>(tx, 'meta', 'workspace_meta');
        localRevision = Number(meta?.localRevision || 0);
        lastCommitAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : null;
      } else if (storeName === 'syncOutbox') {
        outboxBreakdown.total = count;
        outboxBreakdown.pending = await countStoreByIndex(tx, 'syncOutbox', 'status', 'pending');
        outboxBreakdown.synced = await countStoreByIndex(tx, 'syncOutbox', 'status', 'synced');
        outboxBreakdown.conflict = await countStoreByIndex(tx, 'syncOutbox', 'status', 'conflict');
      } else if (storeName === 'syncInbox' || storeName === 'secureWorkspace') {
        // Inbox rows and encrypted migration snapshots are infrastructure records,
        // not active accounting entities.
      } else {
        totalRecords += count;
      }
    }

    db.close();
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      supported: true,
      ready: totalRecords > 0,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords,
      pendingOutboxCount: outboxBreakdown.pending,
      localRevision,
      lastCommitAt,
      probeLatencyMs: Math.max(1, Math.round(ended - started)),
      outboxBreakdown,
      storeBreakdown,
      errorMessage: null,
    };
  } catch (err) {
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      supported: true,
      ready: false,
      dbName: OP_DB_NAME,
      dbVersion: OP_DB_VERSION,
      storeCount: OPERATIONAL_STORES.length,
      totalRecords: 0,
      pendingOutboxCount: 0,
      localRevision: 0,
      lastCommitAt: null,
      probeLatencyMs: Math.max(1, Math.round(ended - started)),
      outboxBreakdown: emptyOutbox,
      storeBreakdown: [],
      errorMessage: err instanceof Error ? err.message : 'خطا در خواندن وضعیت IndexedDB',
    };
  }
}

export const ALL_HOLOO_INDEXED_DBS = [
  OP_DB_NAME,
  'holoo_apex_local_backups_v1',
  'holoo_apex_document_vault_v1',
  'holoo_apex_health_probe_v1',
  'holoo_apex_mesh_dexie_v1',
] as const;

function deleteSingleIndexedDb(dbName: string): Promise<'deleted' | 'blocked' | 'error'> {
  return new Promise((resolve) => {
    if (!isIndexedDbAvailable()) {
      resolve('error');
      return;
    }
    try {
      const req = window.indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve('deleted');
      req.onerror = () => resolve('error');
      req.onblocked = () => resolve('blocked');
    } catch {
      resolve('error');
    }
  });
}

/**
 * Clears all operational IndexedDB stores and deletes all Holoo IndexedDB databases
 * (operational DB, local snapshot vault, document attachment vault, health probe).
 */
export async function wipeAllLocalIndexedDbs(): Promise<{
  deletedDbs: string[];
  blockedDbs: string[];
  failedDbs: string[];
}> {
  const deletedDbs: string[] = [];
  const blockedDbs: string[] = [];
  const failedDbs: string[] = [];

  if (!isIndexedDbAvailable()) {
    return { deletedDbs, blockedDbs, failedDbs: [...ALL_HOLOO_INDEXED_DBS] };
  }

  // First empty every objectStore in the primary operational DB so even blocked handles hold 0 records
  try {
    const db = await openOperationalDb();
    const tx = db.transaction([...OPERATIONAL_STORES], 'readwrite');
    for (const storeName of OPERATIONAL_STORES) {
      tx.objectStore(storeName).clear();
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    // proceed directly to deleteDatabase
  }

  for (const name of ALL_HOLOO_INDEXED_DBS) {
    const outcome = await deleteSingleIndexedDb(name);
    if (outcome === 'deleted') deletedDbs.push(name);
    else if (outcome === 'blocked') blockedDbs.push(name);
    else failedDbs.push(name);
  }

  resetOperationalDiffCache();
  return { deletedDbs, blockedDbs, failedDbs };
}

/**
 * Removes all Holoo Apex localStorage preferences, caches, revisions, and offline outbox entries.
 */
export function clearHolooLocalStorageKeys(options?: { preserveTheme?: boolean }): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const key of keys) {
      if (options?.preserveTheme && (key === 'holoo_theme' || key === 'theme')) {
        continue;
      }
      if (key.startsWith('holoo') || key.startsWith('sbw_') || key.startsWith('atlasris')) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {
    // ignore storage access issues
  }
  return removed;
}

