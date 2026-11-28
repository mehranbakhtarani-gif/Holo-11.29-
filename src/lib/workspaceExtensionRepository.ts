/**
 * Domain contract for the future durable workspace-extension repository.
 *
 * This module is deliberately storage-agnostic: it defines generation-CAS,
 * migration-journal transitions, and validation without opening IndexedDB or
 * changing the current localStorage-backed production authority.
 */

export const WORKSPACE_EXTENSION_SCHEMA_VERSION = 1;

export interface WorkspaceExtensionRecord<T> {
  workspaceId: string;
  schemaVersion: number;
  generation: number;
  payload: T;
  updatedAt: string;
}

export type WorkspaceExtensionMigrationState =
  | 'not_started'
  | 'staging'
  | 'verified'
  | 'committed';

export interface WorkspaceExtensionMigrationJournal {
  workspaceId: string;
  migrationId: string;
  sourceFingerprint: string;
  targetGeneration: number;
  state: WorkspaceExtensionMigrationState;
  updatedAt: string;
}

export type WorkspaceExtensionCommitResult<T> =
  | { status: 'committed'; record: WorkspaceExtensionRecord<T> }
  | { status: 'conflict'; expectedGeneration: number; actualGeneration: number };

export function validateWorkspaceExtensionRecord<T>(
  value: unknown,
  expectedWorkspaceId?: string
): value is WorkspaceExtensionRecord<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<WorkspaceExtensionRecord<T>>;
  return typeof row.workspaceId === 'string' &&
    row.workspaceId.trim().length > 0 &&
    row.workspaceId.length <= 180 &&
    (!expectedWorkspaceId || row.workspaceId === expectedWorkspaceId) &&
    row.schemaVersion === WORKSPACE_EXTENSION_SCHEMA_VERSION &&
    Number.isSafeInteger(row.generation) && Number(row.generation) >= 0 &&
    Object.prototype.hasOwnProperty.call(row, 'payload') &&
    typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt));
}

/** Pure CAS decision. The adapter must execute this decision and row write in one IDB transaction. */
export function decideWorkspaceExtensionCommit<T>(params: {
  workspaceId: string;
  current: WorkspaceExtensionRecord<T> | null;
  expectedGeneration: number;
  payload: T;
  now: string;
}): WorkspaceExtensionCommitResult<T> {
  const actualGeneration = params.current?.generation ?? 0;
  if (!Number.isSafeInteger(params.expectedGeneration) || params.expectedGeneration < 0) {
    throw new Error('Expected workspace-extension generation must be a non-negative safe integer.');
  }
  if (actualGeneration !== params.expectedGeneration) {
    return { status: 'conflict', expectedGeneration: params.expectedGeneration, actualGeneration };
  }
  if (!Number.isFinite(Date.parse(params.now))) {
    throw new Error('Workspace-extension commit timestamp is invalid.');
  }
  const workspaceId = params.workspaceId;
  if (!workspaceId.trim() || workspaceId.length > 180) {
    throw new Error('A valid workspaceId is required for an extension commit.');
  }
  if (params.current && params.current.workspaceId !== workspaceId) {
    throw new Error('Current extension record belongs to a different workspace.');
  }
  return {
    status: 'committed',
    record: {
      workspaceId,
      schemaVersion: WORKSPACE_EXTENSION_SCHEMA_VERSION,
      generation: actualGeneration + 1,
      payload: params.payload,
      updatedAt: params.now,
    },
  };
}

const MIGRATION_ORDER: WorkspaceExtensionMigrationState[] = [
  'not_started', 'staging', 'verified', 'committed',
];

/** Migration is monotonic; retries may repeat the same state but cannot move backwards. */
export function advanceWorkspaceExtensionMigration(
  current: WorkspaceExtensionMigrationJournal,
  next: WorkspaceExtensionMigrationState,
  now: string
): WorkspaceExtensionMigrationJournal {
  const currentIndex = MIGRATION_ORDER.indexOf(current.state);
  const nextIndex = MIGRATION_ORDER.indexOf(next);
  if (currentIndex < 0 || nextIndex < 0 || nextIndex < currentIndex) {
    throw new Error('Workspace-extension migration journal cannot move backwards.');
  }
  if (!Number.isFinite(Date.parse(now))) throw new Error('Migration journal timestamp is invalid.');
  if (!current.workspaceId || !current.migrationId || !/^[a-f0-9]{64}$/i.test(current.sourceFingerprint)) {
    throw new Error('Workspace-extension migration journal identity is invalid.');
  }
  if (!Number.isSafeInteger(current.targetGeneration) || current.targetGeneration < 1) {
    throw new Error('Migration target generation must be a positive safe integer.');
  }
  return { ...current, state: next, updatedAt: now };
}
