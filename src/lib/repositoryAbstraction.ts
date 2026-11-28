/**
 * Offline-First Repository Abstraction & Professional Sync Engine
 *
 * Implements the layered Offline-First architecture for Holoo Apex:
 *   React Modules -> OfflineFirstSyncEngine -> LocalRepository (IndexedDB)
 *                                           -> Durable Outbox / Inbox
 *                                           -> RemoteSyncTransport (Firebase / Supabase)
 *                                           -> Financial Conflict Guard (No blind LWW)
 *
 * Guarantees:
 * 1. Stable operationId created & durably saved BEFORE any network send
 * 2. Restart-safe outbox resume using identical operationId
 * 3. Idempotent server replay (lost ACK never duplicates accounting data)
 * 4. SHA-256 snapshot equality checks
 * 5. Exponential backoff retry scheduling
 * 6. Strict financial conflict review (permanent vouchers, invoices, stock, cheques never silently overwritten)
 */

import {
  computeSnapshotSha256Hex,
  computeSyncBackoffMs,
  requiresManualFinancialConflictReview,
  resolveEffectiveOperatingMode,
  type FinancialCollectionKind,
  type OperatingMode,
} from './offlineFirstCore';
import {
  commitChequeStatusOperationalTx,
  commitDepreciationOperationalTx,
  commitInvoiceOperationalTx,
  commitSalesOrderDispatchOperationalTx,
  commitStockAdjustmentOperationalTx,
  clearPendingSyncOutboxOperations,
  enqueueSyncOutboxOperation,
  getActiveOperationalRestoreJournal,
  isInboxOperationProcessed,
  isOperationalRestoreBarrierActive,
  listPendingSyncOutboxOperations,
  loadOperationalWorkspace,
  markSyncOutboxOperationStatus,
  recordInboxOperation,
  savePreUpdateSafetyBackup,
  OP_DB_VERSION,
  type OperationalRestoreJournalRecord,
  saveOperationalWorkspaceTx,
  type OperationalWorkspaceData,
  type SyncInboxRecord,
  type SyncOutboxOperation,
} from './operationalDb';

export interface DurableSyncOperation {
  operationId: string;
  workspaceId: string;
  deviceId: string;
  entityKind: FinancialCollectionKind;
  entityId: string;
  baseRevision: number;
  clientRevision: number;
  payloadHashSha256: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
  nextRetryAtMs: number;
  status: 'pending' | 'synced' | 'conflict_requires_review';
  lastError?: string;
}

/**
 * Atomic business-command port.
 *
 * This is intentionally a behavior-preserving seam: each command still delegates to
 * its existing single IndexedDB transaction implementation. UI and sync orchestration
 * should depend on this port rather than importing operationalDb transaction functions.
 * The encrypted adapter can replace this implementation only after it preserves each
 * command's complete transaction and revision-check semantics.
 */
export const operationalTransactionPort = {
  commitInvoice: commitInvoiceOperationalTx,
  dispatchSalesOrder: commitSalesOrderDispatchOperationalTx,
  transitionChequeStatus: commitChequeStatusOperationalTx,
  commitDepreciation: commitDepreciationOperationalTx,
  adjustStock: commitStockAdjustmentOperationalTx,
};

export type OperationalTransactionPort = typeof operationalTransactionPort;

/** Durable sync-persistence facade; delegates to the existing target-aware IndexedDB operations. */
export const operationalSyncPersistencePort = {
  enqueueOutbox: enqueueSyncOutboxOperation,
  listPendingOutbox: listPendingSyncOutboxOperations,
  markOutboxStatus: markSyncOutboxOperationStatus,
  clearPendingOutbox: clearPendingSyncOutboxOperations,
  recordInbox: recordInboxOperation,
  hasProcessedInbox: isInboxOperationProcessed,
  getActiveRestoreJournal: getActiveOperationalRestoreJournal,
  isRestoreBarrierActive: isOperationalRestoreBarrierActive,
};
export type OperationalSyncPersistencePort = typeof operationalSyncPersistencePort;

/** Recovery/read boundary for settings and restore orchestration. */
export const operationalRecoveryPort = {
  getActiveRestoreJournal: getActiveOperationalRestoreJournal,
  isRestoreBarrierActive: isOperationalRestoreBarrierActive,
  loadWorkspace: loadOperationalWorkspace,
};
export type OperationalRecoveryPort = typeof operationalRecoveryPort;

/** Primary workspace read/write boundary used by application state hydration and persistence. */
export const operationalWorkspacePersistencePort = {
  loadWorkspace: loadOperationalWorkspace,
  saveWorkspace: saveOperationalWorkspaceTx,
  isRestoreBarrierActive: isOperationalRestoreBarrierActive,
};
export type OperationalWorkspacePersistencePort = typeof operationalWorkspacePersistencePort;

/** Backup and schema maintenance boundary for offline/PWA lifecycle workflows. */
export const operationalBackupMaintenancePort = {
  databaseVersion: OP_DB_VERSION,
  savePreUpdateSafetyBackup,
};
export type OperationalBackupMaintenancePort = typeof operationalBackupMaintenancePort;
export type { OperationalRestoreJournalRecord };

export interface LocalRepositoryAdapter {
  readonly kind: 'indexeddb' | 'memory';
  loadWorkspace: () => Promise<OperationalWorkspaceData | null>;
  saveWorkspace: (data: OperationalWorkspaceData) => Promise<{ localRevision: number; committedAt: string } | null>;
  appendOutbox: (op: DurableSyncOperation) => Promise<void>;
  listPendingOutbox: () => Promise<DurableSyncOperation[]>;
  updateOutbox: (op: DurableSyncOperation) => Promise<void>;
  removeOutbox: (operationId: string) => Promise<void>;
  recordInbox: (rec: SyncInboxRecord) => Promise<void>;
  hasInbox: (operationId: string) => Promise<boolean>;
}

/** Rehydrates a durable IndexedDB outbox row after a cold start. Legacy/incomplete rows fail closed. */
export function restoreDurableSyncOperation(row: SyncOutboxOperation): DurableSyncOperation {
  if (
    !row.payload ||
    typeof row.entityKind !== 'string' ||
    typeof row.entityId !== 'string' ||
    typeof row.baseRevision !== 'number'
  ) {
    throw new Error(
      `Outbox operation ${row.operationId} predates durable payload storage or is corrupt; automatic replay is blocked to prevent data loss.`
    );
  }
  return {
    operationId: row.operationId,
    workspaceId: row.workspaceId,
    deviceId: row.deviceId,
    entityKind: row.entityKind,
    entityId: row.entityId,
    baseRevision: row.baseRevision,
    clientRevision: row.clientRevision,
    payloadHashSha256: row.payloadHash,
    payload: row.payload,
    createdAt: row.createdAt,
    retryCount: row.retryCount,
    nextRetryAtMs: row.nextRetryAt ? Date.parse(row.nextRetryAt) || 0 : 0,
    status: row.status === 'conflict' ? 'conflict_requires_review' : row.status,
    lastError: row.lastError,
  };
}

export interface RemotePushOutcome {
  status: 'applied' | 'already_applied' | 'conflict' | 'network_error';
  serverRevision?: number;
  remoteRecord?: Record<string, unknown>;
  error?: string;
}

export interface RemoteSyncTransport {
  readonly provider: 'firebase' | 'supabase' | 'p2p_mesh' | 'mock';
  pushOperation: (op: DurableSyncOperation) => Promise<RemotePushOutcome>;
}

export interface SyncDrainSummary {
  mode: OperatingMode;
  isOnline: boolean;
  attempted: number;
  synced: number;
  deduplicatedOnServer: number;
  conflictsRequiringHumanReview: DurableSyncOperation[];
  deferredWithBackoff: number;
}

/** Generates a stable operationId persisted BEFORE transmission */
export function createStableOperationId(deviceId: string, seq: number): string {
  const cleanDev = deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'dev';
  let randHex = '';
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    randHex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    randHex = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  }
  return `op_${cleanDev}_${seq}_${randHex}`;
}

/**
 * Production Browser LocalRepository backed directly by Operational IndexedDB v3.
 */
export class IndexedDbLocalRepository implements LocalRepositoryAdapter {
  public readonly kind = 'indexeddb' as const;
  private readonly payloadCache = new Map<string, DurableSyncOperation>();

  public async loadWorkspace(): Promise<OperationalWorkspaceData | null> {
    return loadOperationalWorkspace();
  }

  public async saveWorkspace(
    data: OperationalWorkspaceData
  ): Promise<{ localRevision: number; committedAt: string } | null> {
    return saveOperationalWorkspaceTx(data);
  }

  public async appendOutbox(op: DurableSyncOperation): Promise<void> {
    this.payloadCache.set(op.operationId, op);
    const idbOp: SyncOutboxOperation = {
      operationId: op.operationId,
      target: 'supabase',
      workspaceId: op.workspaceId,
      deviceId: op.deviceId,
      clientRevision: op.clientRevision,
      baseRevision: op.baseRevision,
      entityKind: op.entityKind,
      entityId: op.entityId,
      payloadHash: op.payloadHashSha256,
      payload: op.payload,
      createdAt: op.createdAt,
      retryCount: op.retryCount,
      nextRetryAt: new Date(op.nextRetryAtMs).toISOString(),
      lastError: op.lastError,
      status: op.status === 'conflict_requires_review' ? 'conflict' : op.status,
    };
    await enqueueSyncOutboxOperation(idbOp);
  }

  public async listPendingOutbox(): Promise<DurableSyncOperation[]> {
    const idbOps = await listPendingSyncOutboxOperations();
    return idbOps.map((row) => {
      const cached = this.payloadCache.get(row.operationId);
      return cached ?? restoreDurableSyncOperation(row);
    });
  }

  public async updateOutbox(op: DurableSyncOperation): Promise<void> {
    await this.appendOutbox(op);
  }

  public async removeOutbox(operationId: string): Promise<void> {
    this.payloadCache.delete(operationId);
    await markSyncOutboxOperationStatus(operationId, 'synced');
  }

  public async recordInbox(rec: SyncInboxRecord): Promise<void> {
    await recordInboxOperation(rec);
  }

  public async hasInbox(operationId: string): Promise<boolean> {
    return isInboxOperationProcessed(operationId);
  }
}

/**
 * Serializable durable in-memory repository for deterministic restart, mid-sync crash,
 * and multi-device conflict testing in Node.js without external browser dependencies.
 */
export class SerializableLocalRepository implements LocalRepositoryAdapter {
  public readonly kind = 'memory' as const;
  private workspace: OperationalWorkspaceData | null = null;
  private outbox = new Map<string, DurableSyncOperation>();
  private inbox = new Map<string, SyncInboxRecord>();
  private revision = 0;

  public async loadWorkspace(): Promise<OperationalWorkspaceData | null> {
    return this.workspace ? JSON.parse(JSON.stringify(this.workspace)) : null;
  }

  public async saveWorkspace(
    data: OperationalWorkspaceData
  ): Promise<{ localRevision: number; committedAt: string }> {
    this.revision += 1;
    const committedAt = new Date().toISOString();
    this.workspace = JSON.parse(JSON.stringify({ ...data, localRevision: this.revision, updatedAt: committedAt }));
    return { localRevision: this.revision, committedAt };
  }

  public async appendOutbox(op: DurableSyncOperation): Promise<void> {
    this.outbox.set(op.operationId, JSON.parse(JSON.stringify(op)));
  }

  public async listPendingOutbox(): Promise<DurableSyncOperation[]> {
    return Array.from(this.outbox.values())
      .filter((op) => op.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((op) => JSON.parse(JSON.stringify(op)));
  }

  public async updateOutbox(op: DurableSyncOperation): Promise<void> {
    this.outbox.set(op.operationId, JSON.parse(JSON.stringify(op)));
  }

  public async removeOutbox(operationId: string): Promise<void> {
    this.outbox.delete(operationId);
  }

  public async recordInbox(rec: SyncInboxRecord): Promise<void> {
    this.inbox.set(rec.operationId, { ...rec });
  }

  public async hasInbox(operationId: string): Promise<boolean> {
    return this.inbox.has(operationId);
  }

  /** Serializes full local store to simulate app close / device reboot */
  public serializeDiskState(): string {
    return JSON.stringify({
      revision: this.revision,
      workspace: this.workspace,
      outbox: Array.from(this.outbox.entries()),
      inbox: Array.from(this.inbox.entries()),
    });
  }

  /** Hydrates a fresh repository instance from disk image (simulating cold boot after reboot) */
  public static restoreFromDiskState(serialized: string): SerializableLocalRepository {
    const parsed = JSON.parse(serialized);
    const repo = new SerializableLocalRepository();
    repo.revision = Number(parsed.revision || 0);
    repo.workspace = parsed.workspace ?? null;
    repo.outbox = new Map(parsed.outbox ?? []);
    repo.inbox = new Map(parsed.inbox ?? []);
    return repo;
  }
}

/**
 * Coordinates LocalRepository, Durable Outbox/Inbox, Operating Mode, Exponential Backoff,
 * SHA-256 Digest Verification, and Financial Conflict Governance.
 */
export class OfflineFirstSyncEngine {
  private readonly localRepo: LocalRepositoryAdapter;
  private readonly remoteTransport: RemoteSyncTransport | null;
  private readonly deviceId: string;
  private readonly workspaceId: string;
  private seq = 0;

  constructor(params: {
    localRepo: LocalRepositoryAdapter;
    remoteTransport?: RemoteSyncTransport | null;
    deviceId: string;
    workspaceId: string;
  }) {
    this.localRepo = params.localRepo;
    this.remoteTransport = params.remoteTransport ?? null;
    this.deviceId = params.deviceId;
    this.workspaceId = params.workspaceId;
  }

  /**
   * Commits a financial or operational change locally FIRST, then conditionally queues
   * an idempotent outbox record with a stable pre-generated operationId and SHA-256 digest.
   */
  public async recordLocalMutation(params: {
    mode: OperatingMode;
    isOnline: boolean;
    entityKind: FinancialCollectionKind;
    entityId: string;
    baseRevision: number;
    clientRevision: number;
    payload: Record<string, unknown>;
    nowMs?: number;
  }): Promise<{ queued: boolean; operation: DurableSyncOperation | null }> {
    const caps = resolveEffectiveOperatingMode(params.mode, params.isOnline);
    const payloadJson = JSON.stringify(params.payload);
    const payloadHashSha256 = await computeSnapshotSha256Hex(payloadJson);

    // Local Mode executes 100% locally with zero cloud outbox coupling
    if (caps.requestedMode === 'local') {
      return { queued: false, operation: null };
    }

    this.seq += 1;
    const now = params.nowMs ?? Date.now();
    const op: DurableSyncOperation = {
      operationId: createStableOperationId(this.deviceId, this.seq),
      workspaceId: this.workspaceId,
      deviceId: this.deviceId,
      entityKind: params.entityKind,
      entityId: params.entityId,
      baseRevision: params.baseRevision,
      clientRevision: params.clientRevision,
      payloadHashSha256,
      payload: JSON.parse(payloadJson),
      createdAt: new Date(now).toISOString(),
      retryCount: 0,
      nextRetryAtMs: now,
      status: 'pending',
    };

    await this.localRepo.appendOutbox(op);
    return { queued: true, operation: op };
  }

  /**
   * Drains durable pending outbox operations in chronological order with exponential backoff,
   * lost-ACK idempotent recovery, and strict financial conflict review gating.
   */
  public async drainOutbox(params: {
    mode: OperatingMode;
    isOnline: boolean;
    nowMs?: number;
  }): Promise<SyncDrainSummary> {
    const now = params.nowMs ?? Date.now();
    const caps = resolveEffectiveOperatingMode(params.mode, params.isOnline);
    const summary: SyncDrainSummary = {
      mode: params.mode,
      isOnline: params.isOnline,
      attempted: 0,
      synced: 0,
      deduplicatedOnServer: 0,
      conflictsRequiringHumanReview: [],
      deferredWithBackoff: 0,
    };

    if (!caps.allowCloudPush || !this.remoteTransport) {
      return summary;
    }

    const pending = await this.localRepo.listPendingOutbox();
    for (const op of pending) {
      if (op.nextRetryAtMs > now) {
        summary.deferredWithBackoff += 1;
        continue;
      }

      summary.attempted += 1;
      const outcome = await this.remoteTransport.pushOperation(op);

      if (outcome.status === 'applied') {
        await this.localRepo.removeOutbox(op.operationId);
        summary.synced += 1;
      } else if (outcome.status === 'already_applied') {
        // Server already committed this operationId earlier (e.g., lost ACK on prior disconnect)
        await this.localRepo.removeOutbox(op.operationId);
        summary.synced += 1;
        summary.deduplicatedOnServer += 1;
      } else if (outcome.status === 'conflict') {
        const mustReview = outcome.remoteRecord
          ? requiresManualFinancialConflictReview(op.entityKind, op.payload, outcome.remoteRecord)
          : true;

        const flagged: DurableSyncOperation = {
          ...op,
          status: 'conflict_requires_review',
          lastError: mustReview
            ? 'تعارض مالی شناسایی شد — بازنویسی خودکار متوقف و بررسی انسانی الزامی است.'
            : outcome.error || 'تعارض نسخه شناسایی شد.',
        };
        await this.localRepo.updateOutbox(flagged);
        summary.conflictsRequiringHumanReview.push(flagged);
      } else {
        // Transient network / mid-sync disconnect -> preserve exact operationId & schedule backoff
        const nextRetryCount = op.retryCount + 1;
        const delayMs = computeSyncBackoffMs(nextRetryCount, 2000, 5 * 60 * 1000, 0);
        await this.localRepo.updateOutbox({
          ...op,
          retryCount: nextRetryCount,
          nextRetryAtMs: now + delayMs,
          lastError: outcome.error || 'قطع شبکه حین همگام‌سازی — تلاش مجدد زمان‌بندی شد.',
        });
        summary.deferredWithBackoff += 1;
      }
    }

    return summary;
  }

  /**
   * Idempotently applies an inbound remote operation using durable syncInbox deduplication.
   * Returns `applied: false, duplicate: true` if the operationId was already processed.
   */
  public async applyInboundOperationIdempotent(params: {
    operationId: string;
    sourceDeviceId: string;
    payload: Record<string, unknown>;
    applyFn: (payload: Record<string, unknown>) => Promise<void> | void;
  }): Promise<{ applied: boolean; duplicate: boolean; sha256: string }> {
    const sha256 = await computeSnapshotSha256Hex(JSON.stringify(params.payload));
    if (await this.localRepo.hasInbox(params.operationId)) {
      return { applied: false, duplicate: true, sha256 };
    }
    await params.applyFn(params.payload);
    await this.localRepo.recordInbox({
      operationId: params.operationId,
      sourceDeviceId: params.sourceDeviceId,
      payloadHash: sha256,
      receivedAt: new Date().toISOString(),
    });
    return { applied: true, duplicate: false, sha256 };
  }
}
