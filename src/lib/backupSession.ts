/**
 * Session-only backup passphrase vault.
 * The secret is held in module memory only and is never persisted to browser storage.
 */
let activePassphrase: string | null = null;
let sessionGeneration = 0;

export interface BackupSessionLease {
  passphrase: string;
  generation: number;
}

function notifySessionChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('holoo:backup-session-changed'));
}

export function unlockBackupSession(passphrase: string): void {
  const clean = passphrase.trim();
  if (clean.length < 6) throw new Error('رمز پشتیبان باید حداقل ۶ کاراکتر باشد.');
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto در این محیط در دسترس نیست.');
  sessionGeneration += 1;
  activePassphrase = clean;
  notifySessionChanged();
}

export function lockBackupSession(): void {
  sessionGeneration += 1;
  activePassphrase = null;
  notifySessionChanged();
}

export function isBackupSessionUnlocked(): boolean {
  return activePassphrase !== null;
}

export function captureBackupSessionLease(): BackupSessionLease {
  return { passphrase: requireBackupSessionPassphrase(), generation: sessionGeneration };
}

/** Rejects asynchronous work started under a session that has since been locked or replaced. */
export function assertBackupSessionLease(lease: BackupSessionLease): void {
  if (!activePassphrase || lease.generation !== sessionGeneration || lease.passphrase !== activePassphrase) {
    throw new Error('نشست رمزگذاری هنگام اجرای عملیات قفل یا جایگزین شد؛ نتیجه قدیمی ذخیره نشد.');
  }
}

export function requireBackupSessionPassphrase(): string {
  if (!activePassphrase) {
    throw new Error('برای پشتیبان‌گیری رمزگذاری‌شده، ابتدا قفل پشتیبان را در تنظیمات باز کنید.');
  }
  return activePassphrase;
}

/** Return the non-secret generation used to fence dependent in-memory sessions. */
export function getBackupSessionGeneration(): number {
  return sessionGeneration;
}

/** Reject dependent work after the backup vault is locked or replaced. */
export function assertBackupSessionGeneration(expectedGeneration: number): void {
  if (!activePassphrase || expectedGeneration !== sessionGeneration) {
    throw new Error('Backup session lease expired; discard the pending operation.');
  }
}
