/**
 * Pure state-machine and validation layer for primary operational-store encryption migration.
 *
 * This module intentionally does not open IndexedDB or change the source of truth.
 * Durable persistence, atomic target-batch/checkpoint commits, and cutover remain separate gates.
 */

export type OperationalMigrationPhase =
  | 'preparing'
  | 'copying'
  | 'verifying'
  | 'ready_to_cutover'
  | 'cutover_committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'failed_recovery_required';

export type OperationalMigrationStoreState =
  | 'pending'
  | 'copying'
  | 'verified'
  | 'committed'
  | 'rolled_back'
  | 'failed';

export interface OperationalMigrationStoreCheckpoint {
  storeName: string;
  state: OperationalMigrationStoreState;
  cursor: string | number | null;
  batchSequence: number;
  sourceRecordCount: number;
  copiedRecordCount: number;
  sourceDigest: string | null;
  targetDigest: string | null;
}

export interface OperationalMigrationJournalRecord {
  migrationId: string;
  workspaceId: string;
  sourceSchemaVersion: number;
  targetFormatVersion: number;
  sourceRevision: number;
  backupSessionGeneration: number;
  phase: OperationalMigrationPhase;
  stores: OperationalMigrationStoreCheckpoint[];
  createdAt: string;
  updatedAt: string;
}

export interface OperationalMigrationBinding {
  workspaceId: string;
  migrationId: string;
  sourceRevision: number;
  backupSessionGeneration: number;
}

const PHASE_TRANSITIONS: Record<OperationalMigrationPhase, readonly OperationalMigrationPhase[]> = {
  preparing: ['copying', 'failed_recovery_required'],
  copying: ['verifying', 'rolling_back', 'failed_recovery_required'],
  verifying: ['copying', 'ready_to_cutover', 'rolling_back', 'failed_recovery_required'],
  ready_to_cutover: ['cutover_committed', 'rolling_back', 'failed_recovery_required'],
  cutover_committed: ['rolling_back', 'failed_recovery_required'],
  rolling_back: ['rolled_back', 'failed_recovery_required'],
  rolled_back: [],
  failed_recovery_required: ['copying', 'verifying', 'rolling_back'],
};

const STORE_TRANSITIONS: Record<OperationalMigrationStoreState, readonly OperationalMigrationStoreState[]> = {
  pending: ['copying', 'rolled_back', 'failed'],
  copying: ['copying', 'verified', 'rolled_back', 'failed'],
  verified: ['committed', 'rolled_back'],
  committed: ['rolled_back'],
  rolled_back: [],
  failed: ['copying', 'rolled_back'],
};

const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const ID_PATTERN = /^[a-zA-Z0-9_-]{12,100}$/;
const ALLOWED_PHASES = Object.keys(PHASE_TRANSITIONS);
const ALLOWED_STORE_STATES = Object.keys(STORE_TRANSITIONS);
const ALLOWED_RUN_KEYS = new Set([
  'migrationId', 'workspaceId', 'sourceSchemaVersion', 'targetFormatVersion',
  'sourceRevision', 'backupSessionGeneration', 'phase', 'stores', 'createdAt', 'updatedAt',
]);
const ALLOWED_CHECKPOINT_KEYS = new Set([
  'storeName', 'state', 'cursor', 'batchSequence', 'sourceRecordCount',
  'copiedRecordCount', 'sourceDigest', 'targetDigest',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isValidOperationalMigrationJournalRecord(
  value: unknown
): value is OperationalMigrationJournalRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_RUN_KEYS)) return false;
  if (
    typeof value.migrationId !== 'string' || !ID_PATTERN.test(value.migrationId) ||
    typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 ||
    value.workspaceId.length > 180 || value.workspaceId.trim() !== value.workspaceId ||
    !isPositiveSafeInteger(value.sourceSchemaVersion) ||
    !isPositiveSafeInteger(value.targetFormatVersion) ||
    !isPositiveSafeInteger(value.sourceRevision) ||
    !isNonNegativeSafeInteger(value.backupSessionGeneration) ||
    !ALLOWED_PHASES.includes(String(value.phase)) ||
    !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) ||
    !Array.isArray(value.stores) || value.stores.length === 0
  ) return false;

  const names = new Set<string>();
  for (const raw of value.stores) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ALLOWED_CHECKPOINT_KEYS)) return false;
    if (
      typeof raw.storeName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.storeName) ||
      names.has(raw.storeName) ||
      !ALLOWED_STORE_STATES.includes(String(raw.state)) ||
      !(raw.cursor === null || (typeof raw.cursor === 'string' && raw.cursor.length <= 180) ||
        (typeof raw.cursor === 'number' && Number.isSafeInteger(raw.cursor))) ||
      !isNonNegativeSafeInteger(raw.batchSequence) ||
      !isNonNegativeSafeInteger(raw.sourceRecordCount) ||
      !isNonNegativeSafeInteger(raw.copiedRecordCount) ||
      Number(raw.copiedRecordCount) > Number(raw.sourceRecordCount) ||
      !(raw.sourceDigest === null || (typeof raw.sourceDigest === 'string' && DIGEST_PATTERN.test(raw.sourceDigest))) ||
      !(raw.targetDigest === null || (typeof raw.targetDigest === 'string' && DIGEST_PATTERN.test(raw.targetDigest)))
    ) return false;
    if (raw.state === 'pending' && (raw.batchSequence !== 0 || raw.copiedRecordCount !== 0)) return false;
    if (raw.state === 'copying' && (raw.batchSequence < 1 || typeof raw.sourceDigest !== 'string')) return false;
    if (raw.state === 'verified' || raw.state === 'committed') {
      if (
        raw.copiedRecordCount !== raw.sourceRecordCount ||
        typeof raw.sourceDigest !== 'string' || typeof raw.targetDigest !== 'string' ||
        raw.sourceDigest.toLowerCase() !== raw.targetDigest.toLowerCase()
      ) return false;
    }
    names.add(raw.storeName);
  }
  const stores = value.stores as OperationalMigrationStoreCheckpoint[];
  if (value.phase === 'ready_to_cutover' && stores.some((store) => store.state !== 'verified' && store.state !== 'committed')) return false;
  if (value.phase === 'cutover_committed' && stores.some((store) => store.state !== 'committed')) return false;
  if (value.phase === 'rolled_back' && stores.some((store) => store.state !== 'rolled_back')) return false;
  return true;
}

export function createOperationalMigrationJournalRecord(input: {
  migrationId: string;
  workspaceId: string;
  sourceSchemaVersion: number;
  targetFormatVersion: number;
  sourceRevision: number;
  backupSessionGeneration: number;
  storeNames: readonly string[];
  now?: string;
}): OperationalMigrationJournalRecord {
  const now = input.now ?? new Date().toISOString();
  const record: OperationalMigrationJournalRecord = {
    migrationId: input.migrationId,
    workspaceId: input.workspaceId,
    sourceSchemaVersion: input.sourceSchemaVersion,
    targetFormatVersion: input.targetFormatVersion,
    sourceRevision: input.sourceRevision,
    backupSessionGeneration: input.backupSessionGeneration,
    phase: 'preparing',
    stores: input.storeNames.map((storeName) => ({
      storeName,
      state: 'pending',
      cursor: null,
      batchSequence: 0,
      sourceRecordCount: 0,
      copiedRecordCount: 0,
      sourceDigest: null,
      targetDigest: null,
    })),
    createdAt: now,
    updatedAt: now,
  };
  if (!isValidOperationalMigrationJournalRecord(record)) {
    throw new Error('Operational migration journal initialization is invalid.');
  }
  return record;
}

export function assertOperationalMigrationBinding(
  record: OperationalMigrationJournalRecord,
  binding: OperationalMigrationBinding
): void {
  if (
    record.workspaceId !== binding.workspaceId ||
    record.migrationId !== binding.migrationId ||
    record.sourceRevision !== binding.sourceRevision ||
    record.backupSessionGeneration !== binding.backupSessionGeneration
  ) {
    throw new Error('Operational migration checkpoint binding is stale or belongs to another workspace/session.');
  }
}

export function transitionOperationalMigrationPhase(
  record: OperationalMigrationJournalRecord,
  nextPhase: OperationalMigrationPhase,
  now = new Date().toISOString()
): OperationalMigrationJournalRecord {
  if (!isValidOperationalMigrationJournalRecord(record)) {
    throw new Error('Operational migration journal record is invalid.');
  }
  if (!PHASE_TRANSITIONS[record.phase].includes(nextPhase)) {
    throw new Error(`Illegal operational migration phase transition: ${record.phase} -> ${nextPhase}.`);
  }
  if (nextPhase === 'ready_to_cutover' && record.stores.some((store) => store.state !== 'verified' && store.state !== 'committed')) {
    throw new Error('Every operational store must be verified before cutover can be prepared.');
  }
  if (nextPhase === 'cutover_committed' && record.stores.some((store) => store.state !== 'committed')) {
    throw new Error('Every operational store must be committed before cutover can be recorded.');
  }
  const next = { ...record, phase: nextPhase, updatedAt: now };
  if (!isValidOperationalMigrationJournalRecord(next)) {
    throw new Error('Operational migration phase transition produced an invalid journal.');
  }
  return next;
}

export function advanceOperationalMigrationStoreCheckpoint(
  record: OperationalMigrationJournalRecord,
  storeName: string,
  patch: {
    state: OperationalMigrationStoreState;
    cursor: string | number | null;
    batchSequence: number;
    sourceRecordCount: number;
    copiedRecordCount: number;
    sourceDigest: string | null;
    targetDigest: string | null;
  },
  binding: OperationalMigrationBinding,
  now = new Date().toISOString()
): OperationalMigrationJournalRecord {
  if (!isValidOperationalMigrationJournalRecord(record)) {
    throw new Error('Operational migration journal record is invalid.');
  }
  assertOperationalMigrationBinding(record, binding);
  const index = record.stores.findIndex((store) => store.storeName === storeName);
  if (index < 0) throw new Error('Operational migration store is not part of this run.');
  const current = record.stores[index];
  if (record.phase === 'rolling_back' && patch.state !== 'rolled_back') {
    throw new Error('Only rollback checkpoints may advance while the migration is rolling back.');
  }
  if (!STORE_TRANSITIONS[current.state].includes(patch.state)) {
    throw new Error(`Illegal operational store transition: ${current.state} -> ${patch.state}.`);
  }
  if (
    patch.batchSequence !== current.batchSequence + 1 ||
    patch.sourceRecordCount < current.sourceRecordCount ||
    patch.copiedRecordCount < current.copiedRecordCount ||
    (current.batchSequence > 0 && patch.sourceRecordCount !== current.sourceRecordCount) ||
    (current.sourceDigest !== null && patch.sourceDigest !== current.sourceDigest) ||
    (patch.state === 'copying' && (typeof patch.sourceDigest !== 'string' || !DIGEST_PATTERN.test(patch.sourceDigest)))
  ) {
    throw new Error('Operational migration checkpoint is non-monotonic or source-bound data changed.');
  }
  const updatedStore = { ...current, ...patch };
  const stores = record.stores.map((store, i) => i === index ? updatedStore : store);
  const next = { ...record, stores, updatedAt: now };
  if (!isValidOperationalMigrationJournalRecord(next)) {
    throw new Error('Operational migration checkpoint is invalid.');
  }
  return next;
}
