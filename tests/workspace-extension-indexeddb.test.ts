import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { createWorkspaceExtensionIndexedDbRepository } from '../src/lib/workspaceExtensionIndexedDb';

const now = '2026-11-28T12:00:00.000Z';
const name = 'workspace-extension-test-' + Math.random().toString(16).slice(2);
const repo = await createWorkspaceExtensionIndexedDbRepository<{ values: string[] }>({ factory: indexedDB, databaseName: name });
try {
  const first = await repo.commit({ workspaceId: 'w1', expectedGeneration: 0, payload: { values: [] }, now });
  assert.equal(first.status, 'committed');
  if (first.status === 'committed') assert.equal(first.record.generation, 1);
  assert.deepEqual((await repo.read('w1'))?.payload, { values: [] });

  const stale = await repo.commit({ workspaceId: 'w1', expectedGeneration: 0, payload: { values: ['stale'] }, now });
  assert.deepEqual(stale, { status: 'conflict', expectedGeneration: 0, actualGeneration: 1 });

  const journal = {
    workspaceId: 'w1', migrationId: 'm1', sourceFingerprint: 'a'.repeat(64),
    targetGeneration: 2, state: 'not_started' as const, updatedAt: now,
  };
  const migrated = await repo.commit({
    workspaceId: 'w1', expectedGeneration: 1, payload: { values: ['migrated'] }, now,
    migration: { journal, nextState: 'staging' },
  });
  assert.equal(migrated.status, 'committed');
  assert.equal((await repo.read('w1'))?.generation, 2);

  const concurrent = await Promise.all([
    repo.commit({ workspaceId: 'w1', expectedGeneration: 2, payload: { values: ['A'] }, now }),
    repo.commit({ workspaceId: 'w1', expectedGeneration: 2, payload: { values: ['B'] }, now }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'committed').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'conflict').length, 1);
} finally {
  repo.close();
}

let abortAfterWrites = false;
const abortName = name + '-abort';
const abortRepo = await createWorkspaceExtensionIndexedDbRepository<{ ok: boolean }>({
  factory: indexedDB,
  databaseName: abortName,
  onWritesQueued: (tx) => { if (abortAfterWrites) { abortAfterWrites = false; tx.abort(); } },
});
try {
  abortAfterWrites = true;
  const abortJournal = {
    workspaceId: 'w-abort', migrationId: 'm-abort', sourceFingerprint: 'b'.repeat(64),
    targetGeneration: 1, state: 'not_started' as const, updatedAt: now,
  };
  await assert.rejects(
    abortRepo.commit({
      workspaceId: 'w-abort', expectedGeneration: 0, payload: { ok: true }, now,
      migration: { journal: abortJournal, nextState: 'staging' },
    }),
    /abort/i,
  );
  assert.equal(await abortRepo.read('w-abort'), null);
  assert.equal(await abortRepo.readMigrationJournal('w-abort', 'm-abort'), null);
} finally {
  abortRepo.close();
}

let barrier = true;
const barrierName = name + '-barrier';
const barrierRepo = await createWorkspaceExtensionIndexedDbRepository<{ ok: boolean }>({
  factory: indexedDB, databaseName: barrierName, isRestoreBarrierActive: () => barrier,
});
try {
  await assert.rejects(
    barrierRepo.commit({ workspaceId: 'w-barrier', expectedGeneration: 0, payload: { ok: true }, now }),
    /restore barrier/i,
  );
  barrier = false;
  assert.equal((await barrierRepo.commit({
    workspaceId: 'w-barrier', expectedGeneration: 0, payload: { ok: true }, now,
  })).status, 'committed');
} finally {
  barrierRepo.close();
}

console.log('Workspace extension IndexedDB adapter tests passed');
