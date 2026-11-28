import {
  applyOperationalRestoreJournalWorkspace,
  createOperationalRestoreJournal,
  discardStagingOperationalRestoreJournal,
  getActiveOperationalRestoreJournal,
  setOperationalRestoreBarrier,
  parseOperationalWorkspaceSnapshot,
  countOperationalWorkspaceRecords,
  transitionOperationalRestoreJournal,
  updateStagingOperationalRestoreJournal,
  type OperationalRestoreJournalRecord,
} from './operationalDb';
import {
  applyStagedDocumentAttachmentBundle,
  discardStagedDocumentAttachmentBundle,
  stageEncryptedDocumentAttachmentBundle,
  verifyStagedDocumentAttachmentBundle,
  setDocumentVaultRestoreBarrier,
} from './documentVault';
import {
  computeSnapshotSha256Hex,
  decryptAndVerifyBackupEnvelope,
} from './offlineFirstCore';
import { assertBackupSessionLease, captureBackupSessionLease } from './backupSession';

interface CompleteBackupPackageV2 {
  format: 'holoo-apex-complete-backup';
  schemaVersion: 2;
  exportedAt: string;
  workspaceEnvelope: unknown;
  documentAttachments: unknown;
}

export interface CompleteBackupRestoreOptions {
  allowLegacyUnboundAttachmentMetadata?: boolean;
}

export interface CompleteBackupRestoreResult {
  restoreId: string;
  restoredAttachments: number;
  restoredWorkspaceRecords: number;
}

function announceRestoreBarrier(active: boolean, reload = false): void {
  const effectiveActive = reload ? true : active;
  setOperationalRestoreBarrier(effectiveActive);
  setDocumentVaultRestoreBarrier(effectiveActive);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('holoo:restore-barrier', {
      detail: { active: effectiveActive, reload },
    }));
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('holoo-complete-restore');
    channel.postMessage({ active: effectiveActive, reload });
    channel.close();
  }
}

function createRestoreId(): string {
  const bytes = new Uint8Array(20);
  if (!globalThis.crypto?.getRandomValues) throw new Error('مولد امن شناسه بازیابی در دسترس نیست.');
  globalThis.crypto.getRandomValues(bytes);
  return `restore_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function parsePackage(packageJson: string): CompleteBackupPackageV2 {
  let parsed: unknown;
  try { parsed = JSON.parse(packageJson); }
  catch { throw new Error('ساختار فایل پشتیبان معتبر نیست.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('ساختار فایل پشتیبان معتبر نیست.');
  const candidate = parsed as Partial<CompleteBackupPackageV2>;
  if (candidate.format !== 'holoo-apex-complete-backup' || candidate.schemaVersion !== 2 ||
      !candidate.workspaceEnvelope || typeof candidate.workspaceEnvelope !== 'object' ||
      !candidate.documentAttachments || typeof candidate.documentAttachments !== 'object') {
    throw new Error('فقط بسته کامل پشتیبان نسخه ۲ با هر دو بخش رمزگذاری‌شده قابل بازیابی است.');
  }
  return candidate as CompleteBackupPackageV2;
}

async function markRecoveryFailure(
  journal: OperationalRestoreJournalRecord,
  error: unknown
): Promise<void> {
  if (journal.state === 'committed' || journal.state === 'staging' || journal.state === 'failed_recovery_required') return;
  const message = error instanceof Error ? error.message.slice(0, 500) : 'خطای نامشخص بازیابی';
  try {
    await transitionOperationalRestoreJournal(
      journal.restoreId,
      [journal.state],
      'failed_recovery_required',
      { lastRecoveryError: message }
    );
  } catch {
    // Keep the last durable journal state. Never remove a commit-intent journal on failure.
  }
}

/**
 * Two-database forward restore. Both datasets are validated and staged before
 * commit intent; each database applies its own replacement atomically and the
 * operational journal coordinates crash recovery between those commits.
 */
async function restoreCompleteBackupPackageUnlocked(
  packageJson: string,
  options: CompleteBackupRestoreOptions = {}
): Promise<CompleteBackupRestoreResult> {
  const lease = captureBackupSessionLease();
  const passphrase = lease.passphrase;
  const parsed = parsePackage(packageJson);
  const workspaceEnvelopeJson = JSON.stringify(parsed.workspaceEnvelope);
  const verified = await decryptAndVerifyBackupEnvelope(workspaceEnvelopeJson, passphrase);
  assertBackupSessionLease(lease);
  if (!verified.ok || !verified.snapshotJson || !verified.sha256) {
    throw new Error(verified.error || 'رمزگشایی فضای کاری ناموفق بود.');
  }
  const workspace = parseOperationalWorkspaceSnapshot(verified.snapshotJson);
  const workspaceRecordCount = countOperationalWorkspaceRecords(workspace);
  const packageDigest = await computeSnapshotSha256Hex(packageJson);
  assertBackupSessionLease(lease);
  const attachmentBundleJson = JSON.stringify(parsed.documentAttachments);
  const restoreId = createRestoreId();

  // Freeze local persistence and all sync paths before any staging work begins.
  announceRestoreBarrier(true);
  let journalCreated = false;
  let commitIntentWritten = false;
  try {
    // Persist the preparation journal before writing any attachment staging rows.
    // A newly opened tab can now discover the in-progress preparation on startup.
    const now = new Date().toISOString();
    const journal: OperationalRestoreJournalRecord = {
      restoreId,
      workspaceId: workspace.profile.uid || 'local_workspace',
      packageDigest,
      workspaceEnvelopeJson,
      workspacePlaintextSha256: verified.sha256,
      workspaceSchemaVersion: 2,
      workspaceRecordCount,
      // Temporary valid digest until the staged attachment manifest is verified.
      attachmentManifestDigest: packageDigest,
      attachmentCount: 0,
      packageSchemaVersion: 2,
      state: 'staging',
      createdAt: now,
      updatedAt: now,
    };
    await createOperationalRestoreJournal(journal);
    assertBackupSessionLease(lease);
    journalCreated = true;
    // Re-broadcast after the durable write: tabs opened during DB initialization
    // may have missed the initial transient announcement but are now already listening.
    announceRestoreBarrier(true);

    const stagedManifest = await stageEncryptedDocumentAttachmentBundle(
      restoreId,
      attachmentBundleJson,
      packageDigest,
      options.allowLegacyUnboundAttachmentMetadata === true
    );
    assertBackupSessionLease(lease);
    await verifyStagedDocumentAttachmentBundle(restoreId, packageDigest);
    assertBackupSessionLease(lease);
    const stagedJournal = await updateStagingOperationalRestoreJournal(
      restoreId,
      stagedManifest.manifestDigest,
      stagedManifest.rowCount
    );
    assertBackupSessionLease(lease);
    await transitionOperationalRestoreJournal(restoreId, ['staging'], 'commit_requested', {});
    commitIntentWritten = true;

    const workspaceResult = await applyOperationalRestoreJournalWorkspace(restoreId);
    const attachmentResult = await applyStagedDocumentAttachmentBundle(
      restoreId,
      packageDigest,
      stagedJournal.attachmentManifestDigest,
      stagedJournal.attachmentCount
    );
    const active = await getActiveOperationalRestoreJournal();
    if (!active || active.restoreId !== restoreId || active.state !== 'workspace_applied') {
      throw new Error('وضعیت ژورنال پس از اعمال دو بخش قابل تأیید نیست.');
    }
    await transitionOperationalRestoreJournal(restoreId, ['workspace_applied'], 'committed', {});
    try { await discardStagedDocumentAttachmentBundle(restoreId); } catch { /* committed data is authoritative; cleanup retries later */ }
    // Keep the current tab blocked until it reloads from the committed workspace.
    // Other tabs receive reload=true and must reload rather than continue stale state.
    announceRestoreBarrier(true, true);
    return {
      restoreId,
      restoredAttachments: attachmentResult.applied,
      restoredWorkspaceRecords: workspaceResult.recordCount,
    };
  } catch (error) {
    const durableJournal = await getActiveOperationalRestoreJournal().catch(() => null);
    const durableCommitIntent = durableJournal?.restoreId === restoreId &&
      durableJournal.state !== 'staging' && durableJournal.state !== 'committed';
    if (!commitIntentWritten && !durableCommitIntent) {
      if (journalCreated) {
        // Stage writes may have partially succeeded before the staging call rejected.
        try { await discardStagedDocumentAttachmentBundle(restoreId); } catch { /* no live data was touched */ }
        try { await discardStagingOperationalRestoreJournal(restoreId); } catch { /* journal may already be absent */ }
      }
      const remainingJournal = await getActiveOperationalRestoreJournal().catch(() => ({ restoreId: 'unknown' } as OperationalRestoreJournalRecord));
      if (!remainingJournal) announceRestoreBarrier(false);
      else announceRestoreBarrier(true);
    } else if (durableJournal?.restoreId === restoreId) {
      await markRecoveryFailure(durableJournal, error);
    } else {
      // Another tab may have won the restore-journal race. Keep this tab fail-closed.
      announceRestoreBarrier(true);
    }
    throw error;
  }
}

/** Resume an interrupted commit after the user unlocks the backup vault. */
async function resumePendingCompleteBackupRestoreUnlocked(): Promise<CompleteBackupRestoreResult | null> {
  const journal = await getActiveOperationalRestoreJournal();
  if (!journal) return null;
  announceRestoreBarrier(true);
  if (journal.state === 'staging') {
    // The exclusive Web Lock proves no other tab is still preparing this restore.
    // A crashed pre-commit attempt has not touched live stores, so its staging
    // rows and journal can be discarded safely before normal startup resumes.
    await discardStagedDocumentAttachmentBundle(journal.restoreId);
    await discardStagingOperationalRestoreJournal(journal.restoreId);
    announceRestoreBarrier(false);
    return null;
  }
  if (journal.state === 'workspace_applied') {
    const attachments = await applyStagedDocumentAttachmentBundle(journal.restoreId, journal.packageDigest, journal.attachmentManifestDigest, journal.attachmentCount);
    await transitionOperationalRestoreJournal(journal.restoreId, ['workspace_applied'], 'committed', {});
    try { await discardStagedDocumentAttachmentBundle(journal.restoreId); } catch { /* cleanup is retryable */ }
    announceRestoreBarrier(true, true);
    return {
      restoreId: journal.restoreId,
      restoredAttachments: attachments.applied,
      restoredWorkspaceRecords: journal.workspaceRecordCount,
    };
  }

  const workspace = await applyOperationalRestoreJournalWorkspace(journal.restoreId);
  const attachments = await applyStagedDocumentAttachmentBundle(journal.restoreId, journal.packageDigest, journal.attachmentManifestDigest, journal.attachmentCount);
  const latest = await getActiveOperationalRestoreJournal();
  if (!latest || latest.restoreId !== journal.restoreId || latest.state !== 'workspace_applied') {
    throw new Error('بازیابی پس از اجرای مجدد به وضعیت پایدار نرسید.');
  }
  await transitionOperationalRestoreJournal(journal.restoreId, ['workspace_applied'], 'committed', {});
  try { await discardStagedDocumentAttachmentBundle(journal.restoreId); } catch { /* cleanup is retryable */ }
  announceRestoreBarrier(true, true);
  return {
    restoreId: journal.restoreId,
    restoredAttachments: attachments.applied,
    restoredWorkspaceRecords: workspace.recordCount,
  };
}


/**
 * Serialize restore preparation and recovery across tabs. Web Locks are held
 * for the complete two-database operation; if a tab crashes, the browser
 * releases the lock and the next tab can safely recover a pre-commit journal.
 * Browsers without Web Locks fail closed rather than risk concurrent restore.
 */
export async function withCompleteRestoreLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined') return operation();
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('قفل انحصاری چندتب برای بازیابی پشتیبان در این مرورگر در دسترس نیست؛ عملیات برای حفظ یکپارچگی داده متوقف شد.');
  }
  return navigator.locks.request(
    'holoo-complete-backup-restore',
    { mode: 'exclusive' },
    operation
  );
}

export function restoreCompleteBackupPackage(
  packageJson: string,
  options: CompleteBackupRestoreOptions = {}
): Promise<CompleteBackupRestoreResult> {
  return withCompleteRestoreLock(() => restoreCompleteBackupPackageUnlocked(packageJson, options));
}

export function resumePendingCompleteBackupRestore(): Promise<CompleteBackupRestoreResult | null> {
  return withCompleteRestoreLock(() => resumePendingCompleteBackupRestoreUnlocked());
}
