/**
 * Session-only backup passphrase vault.
 * The secret is held in module memory only and is never persisted to browser storage.
 */
let activePassphrase: string | null = null;

export function unlockBackupSession(passphrase: string): void {
  const clean = passphrase.trim();
  if (clean.length < 6) throw new Error('رمز پشتیبان باید حداقل ۶ کاراکتر باشد.');
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto در این محیط در دسترس نیست.');
  activePassphrase = clean;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('holoo:backup-session-changed'));
}

export function lockBackupSession(): void {
  activePassphrase = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('holoo:backup-session-changed'));
}

export function isBackupSessionUnlocked(): boolean {
  return activePassphrase !== null;
}

export function requireBackupSessionPassphrase(): string {
  if (!activePassphrase) {
    throw new Error('برای پشتیبان‌گیری رمزگذاری‌شده، ابتدا قفل پشتیبان را در تنظیمات باز کنید.');
  }
  return activePassphrase;
}
