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

const VAULT_DB_NAME = 'holoo_apex_document_vault_v1';
const VAULT_DB_VERSION = 1;
const VAULT_STORE = 'attachments';

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

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        const store = db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
        store.createIndex('entityKey', ['entityType', 'entityId'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open Document Vault IndexedDB'));
  });
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
  if (!params.dataUrl.toLowerCase().startsWith(`data:${mime};base64,`)) {
    return { ok: false, error: 'قالب محتوای فایل معتبر نیست.' };
  }

  const estimatedBytes =
    params.sizeBytes ?? Math.round((params.dataUrl.length * 3) / 4);
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
    const envelope = await encryptBackupEnvelope(JSON.stringify({ dataUrl: params.dataUrl, mimeType: mime, sha256 }), passphrase);
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

  if (!stored) {
    return { ok: false, error: 'مدرک مورد نظر در بایگانی محلی یافت نشد.' };
  }
  if (!canRoleAccessSensitivity(viewerRole, stored.sensitivity)) {
    return {
      ok: false,
      error: 'سطح دسترسی نقش فعلی برای مشاهده این مدرک محرمانه کافی نیست.',
    };
  }

  let dataUrl: string;
  if (stored.encryptedEnvelope) {
    if (!isBackupSessionUnlocked()) return { ok: false, error: 'برای بازکردن پیوست رمزگذاری‌شده، ابتدا قفل پشتیبان را باز کنید.' };
    const verified = await decryptAndVerifyBackupEnvelope(stored.encryptedEnvelope, requireBackupSessionPassphrase());
    if (!verified.ok || !verified.snapshotJson) return { ok: false, error: verified.error || 'رمزگشایی پیوست ناموفق بود.' };
    try {
      const payload = JSON.parse(verified.snapshotJson) as { dataUrl?: unknown; mimeType?: unknown; sha256?: unknown };
      if (typeof payload.dataUrl !== 'string' || typeof payload.mimeType !== 'string' || typeof payload.sha256 !== 'string' || payload.mimeType !== stored.mimeType || payload.sha256 !== stored.sha256) return { ok: false, error: 'ساختار یا فراداده پیوست رمزگذاری‌شده معتبر نیست.' };
      dataUrl = payload.dataUrl;
    } catch { return { ok: false, error: 'محتوای رمزگشایی‌شده پیوست ساختار معتبری ندارد.' }; }
  } else if (typeof stored.dataUrl === 'string') {
    if (!isBackupSessionUnlocked()) return { ok: false, error: 'این پیوست از نسخه قدیمی و رمزگذاری‌نشده است؛ برای مهاجرت امن ابتدا قفل پشتیبان را باز کنید.' };
    dataUrl = stored.dataUrl;
    if (await computeSha256Hex(dataUrl) !== stored.sha256) return { ok: false, error: 'مهر SHA-256 پیوست قدیمی معتبر نیست؛ مهاجرت انجام نشد.' };
    try {
      const envelope = await encryptBackupEnvelope(JSON.stringify({ dataUrl, mimeType: stored.mimeType, sha256: stored.sha256 }), requireBackupSessionPassphrase());
      const migrated: StoredDocumentAttachmentRecord = { ...stored, encryptedEnvelope: JSON.stringify(envelope) };
      delete migrated.dataUrl;
      if (isIdbAvailable()) {
        const db = await openVaultDb();
        try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(VAULT_STORE, 'readwrite'); tx.objectStore(VAULT_STORE).put(migrated); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
        finally { db.close(); }
      } else if (isNonBrowserTestRuntime()) memoryVault.set(migrated.id, migrated);
    } catch (err) { return { ok: false, error: `مهاجرت رمزگذاری‌شده پیوست قدیمی ناموفق بود: ${err instanceof Error ? err.message : ''}` }; }
  } else return { ok: false, error: 'پیوست فاقد محتوای قابل بازیابی است.' };

  const recomputed = await computeSha256Hex(dataUrl);
  const integrityValid = recomputed === stored.sha256;
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
  schemaVersion: 1;
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

  for (const row of rows) {
    if (!row.encryptedEnvelope || typeof row.dataUrl === 'string') {
      throw new Error(`پیوست قدیمی «${row.fileName}» هنوز رمزگذاری نشده است؛ ابتدا آن را از مسیر مهاجرت امن باز کنید.`);
    }
    const verified = await decryptAndVerifyBackupEnvelope(row.encryptedEnvelope, passphrase);
    if (!verified.ok || !verified.snapshotJson) throw new Error(verified.error || 'اعتبارسنجی رمزگذاری پیوست ناموفق بود.');
    const payload = JSON.parse(verified.snapshotJson) as { dataUrl?: unknown; mimeType?: unknown; sha256?: unknown };
    if (typeof payload.dataUrl !== 'string' || payload.mimeType !== row.mimeType || payload.sha256 !== row.sha256 ||
        await computeSha256Hex(payload.dataUrl) !== row.sha256) {
      throw new Error(`اعتبار محتوای پیوست «${row.fileName}» تأیید نشد.`);
    }
  }

  const bundle: EncryptedDocumentAttachmentBundle = {
    format: 'holoo-apex-encrypted-document-vault',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    attachments: rows,
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
  if (!bundle || bundle.format !== 'holoo-apex-encrypted-document-vault' || bundle.schemaVersion !== 1 ||
      !Array.isArray(bundle.attachments)) {
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
    let payload: { dataUrl?: unknown; mimeType?: unknown; sha256?: unknown };
    try { payload = JSON.parse(verified.snapshotJson) as typeof payload; }
    catch { throw new Error('محتوای رمزگشایی‌شده یکی از پیوست‌ها خراب است.'); }
    if (typeof payload.dataUrl !== 'string' || !payload.dataUrl.toLowerCase().startsWith(`data:${candidate.mimeType};base64,`) || payload.mimeType !== candidate.mimeType ||
        payload.sha256 !== candidate.sha256 || await computeSha256Hex(payload.dataUrl) !== candidate.sha256) {
      throw new Error('مهر صحت یا فراداده محتوای یکی از پیوست‌ها معتبر نیست.');
    }
    const { dataUrl: _plaintext, ...encryptedRecord } = candidate;
    validated.push(encryptedRecord);
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

/** Test/diagnostics helper to verify tampering detection without altering production DB */
export async function verifyAttachmentRecordIntegrity(
  record: DocumentAttachmentRecord
): Promise<boolean> {
  const hash = await computeSha256Hex(record.dataUrl);
  return hash === record.sha256;
}
