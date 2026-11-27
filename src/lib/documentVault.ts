/**
 * Offline Document & Attachment Vault (مدیریت اسناد و مدارک آفلاین)
 *
 * Allows attaching images (JPEG/PNG/WEBP) and PDF files to:
 *  - Invoices, Accounting Vouchers, Cheques, Contracts, and General Operations
 *
 * Security & Integrity Guarantees:
 *  - Unique independent attachment ID
 *  - Cryptographic SHA-256 content integrity checksum verified on every read
 *  - Strict MIME-type allowlist & file size cap (10 MB max per document)
 *  - Role-based access control (`standard` | `confidential` | `restricted`)
 *  - Offline IndexedDB persistence with AES-256-GCM encrypted file content at rest
 *  - Legacy plaintext attachments are migrated on authorized retrieval when the backup vault is unlocked
 */

import { RbacRoleKey } from '../types/accounting';
import { computeSha256Hex } from './moneyMath';
import { decryptAndVerifyBackupEnvelope, encryptBackupEnvelope } from './offlineFirstCore';
import { isBackupSessionUnlocked, requireBackupSessionPassphrase } from './backupSession';

export type AttachmentEntityType =
  | 'invoice'
  | 'voucher'
  | 'cheque'
  | 'contract'
  | 'operation';

export type DocumentSensitivity = 'standard' | 'confidential' | 'restricted';

export interface DocumentAttachmentMeta {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  entityLabel: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sensitivity: DocumentSensitivity;
  uploadedAt: string;
  uploadedBy: string;
  uploadedByRole: RbacRoleKey;
  notes?: string;
}

export interface DocumentAttachmentRecord extends DocumentAttachmentMeta {
  dataUrl: string; // Decrypted content returned to authorized callers only
}

interface StoredDocumentAttachmentRecord extends DocumentAttachmentMeta {
  encryptedEnvelope?: string;
  /** Legacy plaintext field; retained only until explicit encrypted migration on read. */
  dataUrl?: string;
}

export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

let forcedDocumentVaultRestoreBarrier = false;

export function setDocumentVaultRestoreBarrier(active: boolean): void {
  forcedDocumentVaultRestoreBarrier = active;
}

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  const vaultRestoreBarrierChannel = new BroadcastChannel('holoo-complete-restore');
  vaultRestoreBarrierChannel.onmessage = (event) => {
    if (event.data?.reload === true) {
      forcedDocumentVaultRestoreBarrier = true;
      window.location.reload();
      return;
    }
    forcedDocumentVaultRestoreBarrier = event.data?.active !== false;
  };
}

const VAULT_DB_NAME = 'holoo_apex_document_vault_v1';
const VAULT_DB_VERSION = 2;
const VAULT_STORE = 'attachments';
const VAULT_RESTORE_STAGING_STORE = 'restoreStaging';
const VAULT_RESTORE_MANIFESTS_STORE = 'restoreManifests';

// In-memory storage is permitted only in non-browser test runtimes. A browser must never
// report a durable attachment write when IndexedDB is unavailable or has failed.
const memoryVault = new Map<string, StoredDocumentAttachmentRecord>();

function isNonBrowserTestRuntime(): boolean {
  return typeof window === 'undefined';
}

export function canRoleAccessSensitivity(
  role: RbacRoleKey,
  sensitivity: DocumentSensitivity
): boolean {
  if (sensitivity === 'standard') return true;
  if (sensitivity === 'confidential') {
    return (
      role === 'finance_manager' ||
      role === 'accountant' ||
      role === 'treasurer' ||
      role === 'auditor_readonly'
    );
  }
  // restricted: finance_manager & independent auditor only
  return role === 'finance_manager' || role === 'auditor_readonly';
}

function isIdbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openVaultDb(allowRestoreRecovery = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        const store = db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
        store.createIndex('entityKey', ['entityType', 'entityId'], { unique: false });
      }
      if (!db.objectStoreNames.contains(VAULT_RESTORE_STAGING_STORE)) {
        const staging = db.createObjectStore(VAULT_RESTORE_STAGING_STORE, { keyPath: ['restoreId', 'attachmentId'] });
        staging.createIndex('restoreId', 'restoreId', { unique: false });
      }
      if (!db.objectStoreNames.contains(VAULT_RESTORE_MANIFESTS_STORE)) {
        db.createObjectStore(VAULT_RESTORE_MANIFESTS_STORE, { keyPath: 'restoreId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (allowRestoreRecovery || !db.objectStoreNames.contains(VAULT_RESTORE_MANIFESTS_STORE)) {
        resolve(db);
        return;
      }
      const tx = db.transaction([VAULT_RESTORE_MANIFESTS_STORE], 'readonly');
      const request = tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE).getAll();
      request.onsuccess = () => {
        const manifests = (request.result ?? []) as Array<{ state?: string }>;
        const blocked = forcedDocumentVaultRestoreBarrier || manifests.some((manifest) => manifest.state === 'staged');
        if (!blocked) {
          resolve(db);
          return;
        }
        const guarded = new Proxy(db, {
          get(target, property) {
            if (property === 'transaction') {
              return (..._args: Parameters<IDBDatabase['transaction']>) => {
                throw new Error('بازیابی پیوست‌های پشتیبان در حال انجام است؛ عملیات عادی خزانه اسناد موقتاً مسدود است.');
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        resolve(guarded);
      };
      request.onerror = () => {
        db.close();
        reject(request.error ?? new Error('بررسی وضعیت بازیابی خزانه اسناد ناموفق بود.'));
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('تراکنش بررسی بازیابی خزانه اسناد شکست خورد.'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('تراکنش بررسی بازیابی خزانه اسناد لغو شد.'));
      };
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to open Document Vault IndexedDB'));
  });
}

function getBase64DataUrlByteLength(dataUrl: string, mimeType: string): number | null {
  const prefix = `data:${mimeType};base64,`;
  if (!dataUrl.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const payload = dataUrl.slice(prefix.length);
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = (payload.length / 4) * 3 - padding;
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_ATTACHMENT_BYTES ? bytes : null;
}

function buildAttachmentMetadataBinding(meta: DocumentAttachmentMeta) {
  return {
    id: meta.id,
    entityType: meta.entityType,
    entityId: meta.entityId,
    entityLabel: meta.entityLabel,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
    sensitivity: meta.sensitivity,
    uploadedAt: meta.uploadedAt,
    uploadedBy: meta.uploadedBy,
    uploadedByRole: meta.uploadedByRole,
    notes: meta.notes ?? null,
  };
}

async function computeAttachmentMetadataSha256(meta: DocumentAttachmentMeta): Promise<string> {
  return computeSha256Hex(JSON.stringify(buildAttachmentMetadataBinding(meta)));
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || 'document';
}

export async function saveDocumentAttachment(params: {
  entityType: AttachmentEntityType;
  entityId: string;
  entityLabel: string;
  fileName: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes?: number;
  sensitivity?: DocumentSensitivity;
  uploadedBy: string;
  uploadedByRole: RbacRoleKey;
  notes?: string;
}): Promise<{ ok: true; meta: DocumentAttachmentMeta } | { ok: false; error: string }> {
  const mime = params.mimeType.toLowerCase().trim();
  if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
    return {
      ok: false,
      error: 'تنها فایل‌های PDF و تصاویر استاندارد (JPEG, PNG, WEBP) مجاز به پیوست هستند.',
    };
  }
  if (!params.entityId.trim()) {
    return { ok: false, error: 'شناسه سند یا عملیات مرتبط الزامی است.' };
  }
  const actualBytes = getBase64DataUrlByteLength(params.dataUrl, mime);
  if (actualBytes === null) {
    return { ok: false, error: 'قالب Base64 یا محتوای فایل معتبر نیست.' };
  }
  if (params.sizeBytes !== undefined &&
      (!Number.isSafeInteger(params.sizeBytes) || params.sizeBytes !== actualBytes)) {
    return { ok: false, error: 'اندازه اعلام‌شده فایل با محتوای واقعی پیوست مطابقت ندارد.' };
  }
  const estimatedBytes = actualBytes;
  if (estimatedBytes <= 0 || estimatedBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: 'حجم فایل پیوست باید کمتر از ۱۰ مگابایت باشد.',
    };
  }

  if (!isBackupSessionUnlocked()) {
    return { ok: false, error: 'برای ذخیره امن پیوست، ابتدا قفل پشتیبان رمزگذاری‌شده را در تنظیمات باز کنید.' };
  }
  let passphrase: string;
  try { passphrase = requireBackupSessionPassphrase(); }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'قفل پشتیبان باز نیست.' }; }

  const sha256 = await computeSha256Hex(params.dataUrl);
  const meta: DocumentAttachmentMeta = {
    id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    entityType: params.entityType,
    entityId: params.entityId.trim(),
    entityLabel: params.entityLabel.trim() || params.entityId.trim(),
    fileName: sanitizeFileName(params.fileName),
    mimeType: mime,
    sizeBytes: estimatedBytes,
    sha256,
    sensitivity: params.sensitivity || 'standard',
    uploadedAt: new Date().toISOString(),
    uploadedBy: params.uploadedBy,
    uploadedByRole: params.uploadedByRole,
    notes: params.notes?.trim() || undefined,
  };
  let encryptedEnvelope: string;
  try {
    const metadataSha256 = await computeAttachmentMetadataSha256(meta);
    const envelope = await encryptBackupEnvelope(JSON.stringify({
      dataUrl: params.dataUrl,
      mimeType: mime,
      sha256,
      metadataSha256,
    }), passphrase);
    encryptedEnvelope = JSON.stringify(envelope);
  } catch (err) {
    return { ok: false, error: `رمزگذاری پیوست ناموفق بود؛ فایل ذخیره نشد. ${err instanceof Error ? err.message : ''}`.trim() };
  }
  const storedRecord: StoredDocumentAttachmentRecord = { ...meta, encryptedEnvelope };

  if (isIdbAvailable()) {
    let db: IDBDatabase | null = null;
    try {
      db = await openVaultDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(VAULT_STORE, 'readwrite');
        tx.objectStore(VAULT_STORE).put(storedRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Document Vault transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Document Vault transaction aborted'));
      });
    } catch (err) {
      return { ok: false, error: `ذخیره پایدار مدرک در IndexedDB ناموفق بود؛ فایل ذخیره نشد. ${err instanceof Error ? err.message : ''}`.trim() };
    } finally {
      db?.close();
    }
  } else if (isNonBrowserTestRuntime()) {
    memoryVault.set(storedRecord.id, storedRecord);
  } else {
    return { ok: false, error: 'ذخیره پایدار اسناد در این مرورگر در دسترس نیست؛ برای جلوگیری از ازدست‌رفتن فایل، عملیات لغو شد.' };
  }

  return { ok: true, meta };
}

export async function listDocumentAttachments(filter?: {
  entityType?: AttachmentEntityType;
  entityId?: string;
  viewerRole?: RbacRoleKey;
}): Promise<DocumentAttachmentMeta[]> {
  let rows: StoredDocumentAttachmentRecord[] = [];
  if (isIdbAvailable()) {
    let db: IDBDatabase | null = null;
    try {
      db = await openVaultDb();
      rows = await new Promise<StoredDocumentAttachmentRecord[]>((resolve, reject) => {
        const tx = db!.transaction(VAULT_STORE, 'readonly');
        const req = tx.objectStore(VAULT_STORE).getAll();
        req.onsuccess = () => resolve((req.result as StoredDocumentAttachmentRecord[]) || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw new Error(`خواندن فهرست اسناد از بایگانی پایدار ناموفق بود: ${err instanceof Error ? err.message : 'خطای IndexedDB'}`);
    } finally {
      db?.close();
    }
  } else if (isNonBrowserTestRuntime()) {
    rows = Array.from(memoryVault.values());
  } else {
    throw new Error('بایگانی پایدار اسناد در این مرورگر در دسترس نیست.');
  }

  return rows
    .filter((r) => {
      if (filter?.entityType && r.entityType !== filter.entityType) return false;
      if (filter?.entityId && r.entityId !== filter.entityId) return false;
      if (filter?.viewerRole && !canRoleAccessSensitivity(filter.viewerRole, r.sensitivity)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .map(({ dataUrl: _legacy, encryptedEnvelope: _envelope, ...meta }) => meta);
}

/**
 * Retrieves an attachment offline with RBAC enforcement and cryptographic SHA-256 integrity check.
 */
export async function retrieveVerifiedAttachment(
  attachmentId: string,
  viewerRole: RbacRoleKey
): Promise<
  | { ok: true; record: DocumentAttachmentRecord; integrityValid: boolean }
  | { ok: false; error: string }
> {
  let stored: StoredDocumentAttachmentRecord | undefined;
  if (isIdbAvailable()) {
    let db: IDBDatabase | null = null;
    try {
      db = await openVaultDb();
      stored = await new Promise<StoredDocumentAttachmentRecord | undefined>((resolve, reject) => {
        const tx = db!.transaction(VAULT_STORE, 'readonly');
        const req = tx.objectStore(VAULT_STORE).get(attachmentId);
        req.onsuccess = () => resolve(req.result as StoredDocumentAttachmentRecord | undefined);
        req.onerror = () => reject(req.error ?? new Error('Document Vault read failed'));
      });
    } catch (err) {
      return { ok: false, error: `خواندن پایدار مدرک ناموفق بود: ${err instanceof Error ? err.message : 'خطای IndexedDB'}` };
    } finally {
      db?.close();
    }
  } else if (isNonBrowserTestRuntime()) {
    stored = memoryVault.get(attachmentId);
  } else {
    return { ok: false, error: 'بایگانی پایدار اسناد در این مرورگر در دسترس نیست.' };
  }

  if (!stored) return { ok: false, error: 'مدرک مورد نظر در بایگانی محلی یافت نشد.' };
  if (!canRoleAccessSensitivity(viewerRole, stored.sensitivity)) {
    return { ok: false, error: 'سطح دسترسی نقش فعلی برای مشاهده این مدرک محرمانه کافی نیست.' };
  }
  if (!isBackupSessionUnlocked()) {
    return { ok: false, error: 'برای بازکردن یا مهاجرت پیوست رمزگذاری‌شده، ابتدا قفل پشتیبان را باز کنید.' };
  }

  const passphrase = requireBackupSessionPassphrase();
  let dataUrl: string;
  let needsMetadataBindingMigration = false;
  if (stored.encryptedEnvelope) {
    const verified = await decryptAndVerifyBackupEnvelope(stored.encryptedEnvelope, passphrase);
    if (!verified.ok || !verified.snapshotJson) return { ok: false, error: verified.error || 'رمزگشایی پیوست ناموفق بود.' };
    try {
      const payload = JSON.parse(verified.snapshotJson) as {
        dataUrl?: unknown;
        mimeType?: unknown;
        sha256?: unknown;
        metadataSha256?: unknown;
      };
      if (typeof payload.dataUrl !== 'string' ||
          getBase64DataUrlByteLength(payload.dataUrl, stored.mimeType) === null ||
          payload.mimeType !== stored.mimeType || payload.sha256 !== stored.sha256 ||
          await computeSha256Hex(payload.dataUrl) !== stored.sha256) {
        return { ok: false, error: 'ساختار یا محتوای پیوست رمزگذاری‌شده معتبر نیست.' };
      }
      const expectedMetadataSha256 = await computeAttachmentMetadataSha256(stored);
      if (payload.metadataSha256 !== undefined && payload.metadataSha256 !== expectedMetadataSha256) {
        return { ok: false, error: 'فراداده پیوست با مهر اصالت رمزگذاری‌شده مطابقت ندارد.' };
      }
      needsMetadataBindingMigration = payload.metadataSha256 === undefined;
      dataUrl = payload.dataUrl;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'محتوای رمزگشایی‌شده پیوست ساختار معتبری ندارد.' };
    }
  } else if (typeof stored.dataUrl === 'string') {
    dataUrl = stored.dataUrl;
    if (getBase64DataUrlByteLength(dataUrl, stored.mimeType) === null ||
        await computeSha256Hex(dataUrl) !== stored.sha256) {
      return { ok: false, error: 'مهر SHA-256 یا قالب Base64 پیوست قدیمی معتبر نیست؛ مهاجرت انجام نشد.' };
    }
    needsMetadataBindingMigration = true;
  } else {
    return { ok: false, error: 'پیوست فاقد محتوای قابل بازیابی است.' };
  }

  if (needsMetadataBindingMigration) {
    try {
      const metadataSha256 = await computeAttachmentMetadataSha256(stored);
      const envelope = await encryptBackupEnvelope(JSON.stringify({
        dataUrl,
        mimeType: stored.mimeType,
        sha256: stored.sha256,
        metadataSha256,
      }), passphrase);
      const migrated: StoredDocumentAttachmentRecord = { ...stored, encryptedEnvelope: JSON.stringify(envelope) };
      delete migrated.dataUrl;
      if (isIdbAvailable()) {
        const db = await openVaultDb();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(VAULT_STORE, 'readwrite');
            tx.objectStore(VAULT_STORE).put(migrated);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('Metadata binding migration failed'));
            tx.onabort = () => reject(tx.error ?? new Error('Metadata binding migration aborted'));
          });
        } finally { db.close(); }
      } else if (isNonBrowserTestRuntime()) {
        memoryVault.set(migrated.id, migrated);
      }
      stored = migrated;
    } catch (err) {
      return { ok: false, error: `مهاجرت اصالت فراداده پیوست ناموفق بود: ${err instanceof Error ? err.message : ''}` };
    }
  }

  const integrityValid = (await computeSha256Hex(dataUrl)) === stored.sha256;
  const { encryptedEnvelope: _envelope, dataUrl: _legacy, ...meta } = stored;
  return { ok: true, record: { ...meta, dataUrl }, integrityValid };
}

export async function deleteDocumentAttachment(
  attachmentId: string,
  operatorRole: RbacRoleKey
): Promise<{ ok: boolean; error?: string }> {
  if (operatorRole !== 'finance_manager' && operatorRole !== 'accountant') {
    return { ok: false, error: 'فقط مدیر مالی یا حسابدار ارشد مجاز به حذف مدرک پیوست هستند.' };
  }
  if (isIdbAvailable()) {
    let db: IDBDatabase | null = null;
    try {
      db = await openVaultDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction(VAULT_STORE, 'readwrite');
        tx.objectStore(VAULT_STORE).delete(attachmentId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Document Vault delete failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Document Vault delete aborted'));
      });
    } catch (err) {
      return { ok: false, error: `حذف پایدار مدرک ناموفق بود: ${err instanceof Error ? err.message : 'خطای IndexedDB'}` };
    } finally {
      db?.close();
    }
  } else if (isNonBrowserTestRuntime()) {
    memoryVault.delete(attachmentId);
  } else {
    return { ok: false, error: 'حذف مدرک انجام نشد؛ بایگانی پایدار در دسترس نیست.' };
  }
  return { ok: true };
}

export interface EncryptedDocumentAttachmentBundle {
  format: 'holoo-apex-encrypted-document-vault';
  schemaVersion: 1 | 2;
  exportedAt: string;
  attachments: StoredDocumentAttachmentRecord[];
}

/**
 * Exports only already-encrypted attachment records. Legacy plaintext rows are
 * rejected rather than copied into a portable backup.
 */
export async function exportEncryptedDocumentAttachmentBundle(): Promise<string> {
  if (!isBackupSessionUnlocked()) throw new Error('برای خروجی امن پیوست‌ها ابتدا قفل پشتیبان را باز کنید.');
  const passphrase = requireBackupSessionPassphrase();
  let rows: StoredDocumentAttachmentRecord[];
  if (isIdbAvailable()) {
    const db = await openVaultDb();
    try {
      rows = await new Promise<StoredDocumentAttachmentRecord[]>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readonly');
        const req = tx.objectStore(VAULT_STORE).getAll();
        req.onsuccess = () => resolve((req.result as StoredDocumentAttachmentRecord[]) || []);
        req.onerror = () => reject(req.error ?? new Error('Document Vault export read failed'));
      });
    } finally { db.close(); }
  } else if (isNonBrowserTestRuntime()) {
    rows = Array.from(memoryVault.values());
  } else {
    throw new Error('بایگانی پایدار اسناد در این مرورگر در دسترس نیست.');
  }

  const normalizedRows = [...rows];
  let migratedAny = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.encryptedEnvelope || typeof row.dataUrl === 'string') {
      throw new Error(`پیوست قدیمی «${row.fileName}» هنوز رمزگذاری نشده است؛ ابتدا آن را از مسیر مهاجرت امن باز کنید.`);
    }
    const verified = await decryptAndVerifyBackupEnvelope(row.encryptedEnvelope, passphrase);
    if (!verified.ok || !verified.snapshotJson) throw new Error(verified.error || 'اعتبارسنجی رمزگذاری پیوست ناموفق بود.');
    const payload = JSON.parse(verified.snapshotJson) as {
      dataUrl?: unknown; mimeType?: unknown; sha256?: unknown; metadataSha256?: unknown;
    };
    if (typeof payload.dataUrl !== 'string' ||
        getBase64DataUrlByteLength(payload.dataUrl, row.mimeType) === null ||
        payload.mimeType !== row.mimeType || payload.sha256 !== row.sha256 ||
        await computeSha256Hex(payload.dataUrl) !== row.sha256) {
      throw new Error(`اعتبار محتوای پیوست «${row.fileName}» تأیید نشد.`);
    }
    const expectedMetadataSha256 = await computeAttachmentMetadataSha256(row);
    if (payload.metadataSha256 !== undefined && payload.metadataSha256 !== expectedMetadataSha256) {
      throw new Error(`اصالت فراداده پیوست «${row.fileName}» تأیید نشد.`);
    }
    if (payload.metadataSha256 === undefined) {
      const envelope = await encryptBackupEnvelope(JSON.stringify({
        dataUrl: payload.dataUrl,
        mimeType: row.mimeType,
        sha256: row.sha256,
        metadataSha256: expectedMetadataSha256,
      }), passphrase);
      normalizedRows[index] = { ...row, encryptedEnvelope: JSON.stringify(envelope) };
      migratedAny = true;
    }
  }

  // Persist metadata-binding migrations only after every attachment has passed validation.
  if (migratedAny) {
    if (isIdbAvailable()) {
      const db = await openVaultDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(VAULT_STORE, 'readwrite');
          normalizedRows.forEach((row) => tx.objectStore(VAULT_STORE).put(row));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('ذخیره مهاجرت اصالت فراداده پیوست‌ها ناموفق بود.'));
          tx.onabort = () => reject(tx.error ?? new Error('تراکنش مهاجرت اصالت فراداده پیوست‌ها لغو شد.'));
        });
      } finally { db.close(); }
    } else if (isNonBrowserTestRuntime()) {
      normalizedRows.forEach((row) => memoryVault.set(row.id, row));
    }
  }

  const bundle: EncryptedDocumentAttachmentBundle = {
    format: 'holoo-apex-encrypted-document-vault',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    attachments: normalizedRows,
  };
  return JSON.stringify(bundle);
}

/**
 * Validates every attachment envelope before writing any row, then commits the
 * complete bundle in one IndexedDB transaction (or one synchronous test-map pass).
 */
export async function restoreEncryptedDocumentAttachmentBundle(bundleJson: string): Promise<{ restored: number }> {
  if (!isBackupSessionUnlocked()) throw new Error('برای بازیابی امن پیوست‌ها ابتدا قفل پشتیبان را باز کنید.');
  const passphrase = requireBackupSessionPassphrase();
  let bundle: EncryptedDocumentAttachmentBundle;
  try { bundle = JSON.parse(bundleJson) as EncryptedDocumentAttachmentBundle; }
  catch { throw new Error('ساختار بسته پیوست‌های رمزگذاری‌شده معتبر نیست.'); }
  if (!bundle || bundle.format !== 'holoo-apex-encrypted-document-vault' ||
      (bundle.schemaVersion !== 1 && bundle.schemaVersion !== 2) || !Array.isArray(bundle.attachments)) {
    throw new Error('نسخه یا ساختار بسته پیوست‌های رمزگذاری‌شده پشتیبانی نمی‌شود.');
  }

  const seen = new Set<string>();
  const validated: StoredDocumentAttachmentRecord[] = [];
  for (const candidate of bundle.attachments) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim() ||
        seen.has(candidate.id) || 'dataUrl' in candidate ||
        typeof candidate.fileName !== 'string' || !candidate.fileName.trim() ||
        typeof candidate.mimeType !== 'string' || !ALLOWED_ATTACHMENT_MIMES.has(candidate.mimeType) ||
        typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256) ||
        typeof candidate.encryptedEnvelope !== 'string' || candidate.encryptedEnvelope.length > 15 * 1024 * 1024 ||
        !['invoice', 'voucher', 'cheque', 'contract', 'operation'].includes(candidate.entityType) ||
        typeof candidate.entityId !== 'string' || !candidate.entityId.trim() ||
        typeof candidate.entityLabel !== 'string' ||
        !['standard', 'confidential', 'restricted'].includes(candidate.sensitivity) ||
        !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 || candidate.sizeBytes > MAX_ATTACHMENT_BYTES ||
        typeof candidate.uploadedAt !== 'string' || !Number.isFinite(Date.parse(candidate.uploadedAt)) ||
        typeof candidate.uploadedBy !== 'string' || !candidate.uploadedBy.trim() ||
        !['finance_manager', 'accountant', 'warehouse_keeper', 'sales_officer', 'treasurer', 'auditor_readonly'].includes(candidate.uploadedByRole) ||
        (candidate.notes !== undefined && typeof candidate.notes !== 'string')) {
      throw new Error('فراداده یکی از پیوست‌های بسته نامعتبر یا تکراری است.');
    }
    seen.add(candidate.id);
    const verified = await decryptAndVerifyBackupEnvelope(candidate.encryptedEnvelope, passphrase);
    if (!verified.ok || !verified.snapshotJson) throw new Error(verified.error || 'رمزگشایی یکی از پیوست‌ها ناموفق بود.');
    let payload: { dataUrl?: unknown; mimeType?: unknown; sha256?: unknown; metadataSha256?: unknown };
    try { payload = JSON.parse(verified.snapshotJson) as typeof payload; }
    catch { throw new Error('محتوای رمزگشایی‌شده یکی از پیوست‌ها خراب است.'); }
    if (typeof payload.dataUrl !== 'string' || getBase64DataUrlByteLength(payload.dataUrl, candidate.mimeType) === null || payload.mimeType !== candidate.mimeType ||
        payload.sha256 !== candidate.sha256 || await computeSha256Hex(payload.dataUrl) !== candidate.sha256) {
      throw new Error('مهر صحت یا فراداده محتوای یکی از پیوست‌ها معتبر نیست.');
    }
    const expectedMetadataSha256 = await computeAttachmentMetadataSha256(candidate);
    if (payload.metadataSha256 !== undefined && payload.metadataSha256 !== expectedMetadataSha256) {
      throw new Error('اصالت فراداده یکی از پیوست‌ها معتبر نیست.');
    }
    if (bundle.schemaVersion === 2 && payload.metadataSha256 !== expectedMetadataSha256) {
      throw new Error('بسته پیوست نسخه ۲ فاقد مهر اصالت فراداده معتبر است.');
    }
    let normalizedEnvelope = candidate.encryptedEnvelope;
    if (payload.metadataSha256 === undefined) {
      const upgradedEnvelope = await encryptBackupEnvelope(JSON.stringify({
        dataUrl: payload.dataUrl,
        mimeType: candidate.mimeType,
        sha256: candidate.sha256,
        metadataSha256: expectedMetadataSha256,
      }), passphrase);
      normalizedEnvelope = JSON.stringify(upgradedEnvelope);
    }
    const { dataUrl: _plaintext, ...encryptedRecord } = candidate;
    validated.push({ ...encryptedRecord, encryptedEnvelope: normalizedEnvelope });
  }

  if (isIdbAvailable()) {
    const db = await openVaultDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readwrite');
        const store = tx.objectStore(VAULT_STORE);
        // A backup restore is a full vault replacement, not a merge. Clear and repopulate
        // inside the same transaction so stale attachments cannot survive a successful restore.
        store.clear();
        validated.forEach((row) => store.put(row));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Document Vault restore failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Document Vault restore transaction aborted'));
      });
    } finally { db.close(); }
  } else if (isNonBrowserTestRuntime()) {
    memoryVault.clear();
    validated.forEach((row) => memoryVault.set(row.id, row));
  } else {
    throw new Error('بازیابی پایدار اسناد در این مرورگر در دسترس نیست.');
  }
  return { restored: validated.length };
}


export interface StagedDocumentRestoreManifest {
  restoreId: string;
  packageDigest: string;
  manifestDigest: string;
  rowCount: number;
  state: 'staged' | 'applied';
  stagedAt: string;
  appliedAt?: string;
}

function validateRestoreId(restoreId: string): void {
  if (!/^[a-zA-Z0-9_-]{12,100}$/.test(restoreId)) {
    throw new Error('شناسه بازیابی معتبر نیست.');
  }
}

/**
 * Validate and stage encrypted attachment rows without touching the live attachments store.
 * Staging and manifest are committed in one transaction in the Document Vault database.
 */
export async function stageEncryptedDocumentAttachmentBundle(
  restoreId: string,
  bundleJson: string,
  packageDigest: string,
  allowLegacyUnboundMetadata = false
): Promise<StagedDocumentRestoreManifest> {
  validateRestoreId(restoreId);
  if (!/^[a-f0-9]{64}$/i.test(packageDigest)) throw new Error('اثر انگشت بسته پشتیبان معتبر نیست.');
  if (!isBackupSessionUnlocked()) throw new Error('برای staging پیوست‌ها ابتدا قفل پشتیبان را باز کنید.');
  const passphrase = requireBackupSessionPassphrase();
  let bundle: EncryptedDocumentAttachmentBundle;
  try { bundle = JSON.parse(bundleJson) as EncryptedDocumentAttachmentBundle; }
  catch { throw new Error('ساختار بسته پیوست‌های رمزگذاری‌شده معتبر نیست.'); }
  if (!bundle || bundle.format !== 'holoo-apex-encrypted-document-vault' ||
      (bundle.schemaVersion !== 1 && bundle.schemaVersion !== 2) ||
      !Array.isArray(bundle.attachments)) throw new Error('نسخه یا ساختار بسته پیوست‌ها پشتیبانی نمی‌شود.');
  if (bundle.schemaVersion === 1 && !allowLegacyUnboundMetadata) {
    throw new Error('بسته پیوست نسخه قدیمی است و فراداده آن به محتوای رمزگذاری‌شده متصل نیست؛ تأیید صریح مسیر سازگاری لازم است.');
  }

  const seen = new Set<string>();
  const validated: StoredDocumentAttachmentRecord[] = [];
  for (const candidate of bundle.attachments) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim() ||
        seen.has(candidate.id) || 'dataUrl' in candidate ||
        typeof candidate.fileName !== 'string' || !candidate.fileName.trim() ||
        typeof candidate.mimeType !== 'string' || !ALLOWED_ATTACHMENT_MIMES.has(candidate.mimeType) ||
        typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.sha256) ||
        typeof candidate.encryptedEnvelope !== 'string' || candidate.encryptedEnvelope.length > 15 * 1024 * 1024 ||
        !['invoice', 'voucher', 'cheque', 'contract', 'operation'].includes(candidate.entityType) ||
        typeof candidate.entityId !== 'string' || !candidate.entityId.trim() ||
        typeof candidate.entityLabel !== 'string' ||
        !['standard', 'confidential', 'restricted'].includes(candidate.sensitivity) ||
        !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 || candidate.sizeBytes > MAX_ATTACHMENT_BYTES ||
        typeof candidate.uploadedAt !== 'string' || !Number.isFinite(Date.parse(candidate.uploadedAt)) ||
        typeof candidate.uploadedBy !== 'string' || !candidate.uploadedBy.trim() ||
        !['finance_manager', 'accountant', 'warehouse_keeper', 'sales_officer', 'treasurer', 'auditor_readonly'].includes(candidate.uploadedByRole) ||
        (candidate.notes !== undefined && typeof candidate.notes !== 'string')) {
      throw new Error('فراداده یکی از پیوست‌های بسته نامعتبر یا تکراری است.');
    }
    seen.add(candidate.id);
    const verified = await decryptAndVerifyBackupEnvelope(candidate.encryptedEnvelope, passphrase);
    if (!verified.ok || !verified.snapshotJson) throw new Error(verified.error || 'رمزگشایی یکی از پیوست‌ها ناموفق بود.');
    let payload: { dataUrl?: unknown; mimeType?: unknown; sha256?: unknown; metadataSha256?: unknown };
    try { payload = JSON.parse(verified.snapshotJson) as typeof payload; }
    catch { throw new Error('محتوای رمزگشایی‌شده یکی از پیوست‌ها خراب است.'); }
    if (typeof payload.dataUrl !== 'string' || getBase64DataUrlByteLength(payload.dataUrl, candidate.mimeType) === null ||
        payload.mimeType !== candidate.mimeType || payload.sha256 !== candidate.sha256 ||
        await computeSha256Hex(payload.dataUrl) !== candidate.sha256) {
      throw new Error('مهر صحت یا فراداده محتوای یکی از پیوست‌ها معتبر نیست.');
    }
    const expectedMetadataSha256 = await computeAttachmentMetadataSha256(candidate);
    if (payload.metadataSha256 !== undefined && payload.metadataSha256 !== expectedMetadataSha256) {
      throw new Error('اصالت فراداده یکی از پیوست‌ها معتبر نیست.');
    }
    if (bundle.schemaVersion === 2 && payload.metadataSha256 !== expectedMetadataSha256) {
      throw new Error('بسته پیوست نسخه ۲ فاقد مهر اصالت فراداده معتبر است.');
    }
    let normalizedEnvelope = candidate.encryptedEnvelope;
    if (payload.metadataSha256 === undefined) {
      const upgradedEnvelope = await encryptBackupEnvelope(JSON.stringify({
        dataUrl: payload.dataUrl,
        mimeType: candidate.mimeType,
        sha256: candidate.sha256,
        metadataSha256: expectedMetadataSha256,
      }), passphrase);
      normalizedEnvelope = JSON.stringify(upgradedEnvelope);
    }
    const { dataUrl: _plaintext, ...encryptedRecord } = candidate;
    validated.push({ ...encryptedRecord, encryptedEnvelope: normalizedEnvelope });
  }

  validated.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const manifestDigest = await computeSha256Hex(JSON.stringify(validated));
  const manifest: StagedDocumentRestoreManifest = {
    restoreId, packageDigest, manifestDigest, rowCount: validated.length,
    state: 'staged', stagedAt: new Date().toISOString(),
  };
  if (!isIdbAvailable()) throw new Error('ذخیره staging پایدار پیوست‌ها در این محیط در دسترس نیست.');
  const db = await openVaultDb(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([VAULT_RESTORE_STAGING_STORE, VAULT_RESTORE_MANIFESTS_STORE], 'readwrite');
      const staging = tx.objectStore(VAULT_RESTORE_STAGING_STORE);
      const index = staging.index('restoreId');
      const remove = index.openKeyCursor(IDBKeyRange.only(restoreId));
      remove.onsuccess = () => {
        const cursor = remove.result;
        if (cursor) { staging.delete(cursor.primaryKey); cursor.continue(); }
        else {
          validated.forEach((row) => staging.put({ restoreId, attachmentId: row.id, record: row }));
          tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE).put(manifest);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('ثبت staging پیوست‌ها ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش staging پیوست‌ها لغو شد.'));
    });
  } finally { db.close(); }
  return manifest;
}

/** Verify staged attachment count and digest without exposing ciphertext to callers. */
export async function verifyStagedDocumentAttachmentBundle(
  restoreId: string,
  expectedPackageDigest: string,
  expectedManifestDigest?: string,
  expectedRowCount?: number
): Promise<StagedDocumentRestoreManifest> {
  validateRestoreId(restoreId);
  if (!isIdbAvailable()) throw new Error('خواندن staging پیوست‌ها در این محیط در دسترس نیست.');
  const db = await openVaultDb(true);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([VAULT_RESTORE_STAGING_STORE, VAULT_RESTORE_MANIFESTS_STORE], 'readonly');
      const manifestRequest = tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE).get(restoreId);
      const rowsRequest = tx.objectStore(VAULT_RESTORE_STAGING_STORE).index('restoreId').getAll(restoreId);
      let manifest: StagedDocumentRestoreManifest | null = null;
      let rows: Array<{ restoreId: string; attachmentId: string; record: StoredDocumentAttachmentRecord }> = [];
      manifestRequest.onsuccess = () => { manifest = manifestRequest.result ?? null; };
      rowsRequest.onsuccess = () => { rows = rowsRequest.result ?? []; };
      tx.oncomplete = async () => {
        if (!manifest || manifest.packageDigest !== expectedPackageDigest ||
            (expectedManifestDigest && manifest.manifestDigest !== expectedManifestDigest) ||
            (expectedRowCount !== undefined && manifest.rowCount !== expectedRowCount) ||
            (manifest.state !== 'staged' && manifest.state !== 'applied') || rows.length !== manifest.rowCount) {
          reject(new Error('manifest staging پیوست‌ها با بسته بازیابی مطابقت ندارد.'));
          return;
        }
        const digest = await computeSha256Hex(JSON.stringify(rows.map((row) => row.record).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
        if (digest !== manifest.manifestDigest) {
          reject(new Error('اثر انگشت staging پیوست‌ها معتبر نیست.'));
          return;
        }
        resolve(manifest);
      };
      tx.onerror = () => reject(tx.error ?? new Error('بررسی staging پیوست‌ها ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش بررسی staging پیوست‌ها لغو شد.'));
    });
  } finally { db.close(); }
}

/**
 * Idempotently replace the live vault from verified staged rows. The manifest's
 * applied marker and attachment replacement share one IndexedDB transaction.
 */
export async function applyStagedDocumentAttachmentBundle(
  restoreId: string,
  expectedPackageDigest: string,
  expectedManifestDigest?: string,
  expectedRowCount?: number
): Promise<{ applied: number }> {
  validateRestoreId(restoreId);
  if (!isIdbAvailable()) throw new Error('اعمال staging پیوست‌ها در این محیط در دسترس نیست.');
  // Re-authenticate the staged manifest and its complete encrypted row set before
  // the live attachments store is touched. This also supports crash recovery retries.
  await verifyStagedDocumentAttachmentBundle(restoreId, expectedPackageDigest, expectedManifestDigest, expectedRowCount);
  const db = await openVaultDb(true);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([VAULT_STORE, VAULT_RESTORE_STAGING_STORE, VAULT_RESTORE_MANIFESTS_STORE], 'readwrite');
      const manifestStore = tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE);
      const manifestRequest = manifestStore.get(restoreId);
      const rowsRequest = tx.objectStore(VAULT_RESTORE_STAGING_STORE).index('restoreId').getAll(restoreId);
      let appliedCount = 0;
      let ready = 0;
      const fail = (message: string) => {
        try { tx.abort(); } catch { /* transaction already completed */ }
        reject(new Error(message));
      };
      const applyIfReady = () => {
        ready += 1;
        if (ready !== 2) return;
        const manifest = manifestRequest.result as StagedDocumentRestoreManifest | undefined;
        const rows = (rowsRequest.result ?? []) as Array<{ restoreId: string; attachmentId: string; record: StoredDocumentAttachmentRecord }>;
        if (!manifest || manifest.packageDigest !== expectedPackageDigest ||
            (manifest.state !== 'staged' && manifest.state !== 'applied') ||
            rows.length !== manifest.rowCount) {
          fail('manifest staging پیوست‌ها برای اعمال معتبر نیست.');
          return;
        }
        try {
          const live = tx.objectStore(VAULT_STORE);
          live.clear();
          rows.forEach((row) => live.put(row.record));
          appliedCount = rows.length;
          manifestStore.put({ ...manifest, state: 'applied', appliedAt: manifest.appliedAt ?? new Date().toISOString() });
        } catch (error) {
          // A transaction can become inactive synchronously (for example, if
          // IndexedDB aborts while clearing the live store). Surface that as a
          // rejected restore operation instead of leaking an uncaught event error.
          fail(error instanceof Error ? error.message : 'تراکنش اعمال پیوست‌ها پیش از ثبت کامل متوقف شد.');
        }
      };
      manifestRequest.onsuccess = applyIfReady;
      rowsRequest.onsuccess = applyIfReady;
      tx.oncomplete = () => resolve({ applied: appliedCount });
      tx.onerror = () => reject(tx.error ?? new Error('اعمال پیوست‌های staging ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('تراکنش اعمال پیوست‌های staging لغو شد.'));
    });
  } finally { db.close(); }
}

/** Remove only the non-live staging rows for a restore attempt. */
export async function discardStagedDocumentAttachmentBundle(restoreId: string): Promise<void> {
  validateRestoreId(restoreId);
  if (!isIdbAvailable()) throw new Error('پاک‌سازی staging پایدار پیوست‌ها در این محیط در دسترس نیست.');
  const db = await openVaultDb(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([VAULT_RESTORE_STAGING_STORE, VAULT_RESTORE_MANIFESTS_STORE], 'readwrite');
      const staging = tx.objectStore(VAULT_RESTORE_STAGING_STORE);
      const cursorRequest = staging.index('restoreId').openKeyCursor(IDBKeyRange.only(restoreId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) { staging.delete(cursor.primaryKey); cursor.continue(); }
        else tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE).delete(restoreId);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('پاک‌سازی staging پیوست‌ها ناموفق بود.'));
      tx.onabort = () => reject(tx.error ?? new Error('پاک‌سازی staging پیوست‌ها لغو شد.'));
    });
  } finally { db.close(); }
}

/** Remove pre-commit staging manifests left by a crash before the operational journal was created. */
export async function cleanupOrphanedStagedDocumentAttachmentBundles(): Promise<number> {
  if (!isIdbAvailable()) return 0;
  const db = await openVaultDb(true);
  let orphanIds: string[] = [];
  try {
    orphanIds = await new Promise((resolve, reject) => {
      const tx = db.transaction([VAULT_RESTORE_MANIFESTS_STORE], 'readonly');
      const request = tx.objectStore(VAULT_RESTORE_MANIFESTS_STORE).getAll();
      request.onsuccess = () => resolve(
        ((request.result ?? []) as Array<{ restoreId?: string; state?: string; stagedAt?: string }>)
          .filter((row) => row.state === 'staged' && typeof row.restoreId === 'string' &&
            typeof row.stagedAt === 'string' && Number.isFinite(Date.parse(row.stagedAt)) &&
            Date.now() - Date.parse(row.stagedAt) > 60 * 60 * 1000)
          .map((row) => row.restoreId as string)
      );
      request.onerror = () => reject(request.error ?? new Error('خواندن manifestهای staging ناموفق بود.'));
    });
  } finally { db.close(); }
  for (const restoreId of orphanIds) {
    await discardStagedDocumentAttachmentBundle(restoreId);
  }
  return orphanIds.length;
}

/** Test/diagnostics helper to verify tampering detection without altering production DB */
export async function verifyAttachmentRecordIntegrity(
  record: DocumentAttachmentRecord
): Promise<boolean> {
  const hash = await computeSha256Hex(record.dataUrl);
  return hash === record.sha256;
}
