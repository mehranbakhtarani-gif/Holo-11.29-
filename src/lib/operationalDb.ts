/**
 * Operational Local IndexedDB Engine for Holoo Apex 9.6
 * Elevates IndexedDB from a backup-only store to the primary operational local
 * database with dedicated entity object stores, atomic multi-store commits, and
 * an idempotent multi-device sync outbox.
 */

import type { FinancialCollectionKind } from './offlineFirstCore';
import { encryptBackupEnvelope, decryptAndVerifyBackupEnvelope } from './offlineFirstCore';
import { requireBackupSessionPassphrase } from './backupSession';
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

const OP_DB_NAME = 'holoo_apex_operational_db_v1';
export const OP_DB_VERSION = 4;

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
  localRevision?: number;
  updatedAt?: string;
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
    record.schemaVersion === 1 &&
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

function openOperationalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(OP_DB_NAME, OP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const upgradeTx = req.transaction;
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
    req.onsuccess = () => resolve(req.result);
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
      localRevision: wsMeta?.localRevision ?? 1,
      updatedAt: wsMeta?.updatedAt,
    };
  } catch {
    return null;
  }
}

export function countOperationalWorkspaceRecords(workspace: OperationalWorkspaceData): number {
  const collections = [
    workspace.accounts, workspace.parties, workspace.products, workspace.vouchers,
    workspace.invoices, workspace.cheques, workspace.employees, workspace.assets,
    workspace.costCenters, workspace.currencies, workspace.exchangeRates,
    workspace.importDossiers, workspace.salesOrders, workspace.subcontractJobs,
    workspace.rbacOperators, workspace.auditLogs,
  ];
  if (!collections.every(Array.isArray)) {
    throw new Error('ساختار مجموعه رکوردهای فضای کاری معتبر نیست.');
  }
  const total = collections.reduce((sum, rows) => sum + rows.length, 0);
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
    !parsed.profile || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0 ||
    !Array.isArray(parsed.parties) || !Array.isArray(parsed.products) ||
    !Array.isArray(parsed.vouchers) || !Array.isArray(parsed.invoices) ||
    !Array.isArray(parsed.cheques) || !Array.isArray(parsed.employees) ||
    !Array.isArray(parsed.assets) || !Array.isArray(parsed.costCenters) ||
    !Array.isArray(parsed.currencies) || !Array.isArray(parsed.exchangeRates) ||
    !Array.isArray(parsed.importDossiers) || !Array.isArray(parsed.salesOrders) ||
    !Array.isArray(parsed.subcontractJobs) || !Array.isArray(parsed.rbacOperators) ||
    !Array.isArray(parsed.auditLogs)
  ) {
    throw new Error('ساختار فضای کاری رمزگذاری‌شده ناقص یا ناسازگار است.');
  }
  return parsed as OperationalWorkspaceData;
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

  const recordCount = countOperationalWorkspaceRecords(workspace);
  const record: EncryptedOperationalWorkspaceRecord = {
    workspaceId: cleanWorkspaceId,
    envelopeJson: JSON.stringify(envelope),
    schemaVersion: 1,
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
  snapshotJson: string;
  createdAt: string;
}

/** Saves an immutable pre-update / pre-migration safety backup inside IndexedDB */
export async function savePreUpdateSafetyBackup(
  rec: PreUpdateSafetyBackupRecord
): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  try {
    const db = await openOperationalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['preUpdateBackups'], 'readwrite');
      tx.objectStore('preUpdateBackups').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
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

