# Primary Operational Store Encryption Cutover Audit

Status: design/audit only. No primary-store encryption cutover is enabled by this document.

## Executive finding

The encrypted `secureWorkspace` record is a verified encrypted shadow/checkpoint, not the authoritative operational database. The live stores in `holoo_apex_operational_db_v1` remain plaintext and are still read and written by the application. The current implementation must not be described as full IndexedDB encryption at rest.

The current branch has a green CI run for commit `185170d89d4b520e9f399ecc747b1da36eb1fcdd`; that verifies the current behavior and tests, not a primary-store encryption migration.

## Confirmed primary database boundary

Source: `src/lib/operationalDb.ts` (reviewed at blob `e90bfdc2d9a7bdd6f23cb0f0bb50bbfeb0e66bb8`).

- Database: `holoo_apex_operational_db_v1`.
- Schema version: `OP_DB_VERSION = 5`.
- The operational store list includes `meta`, accounting entity stores (`accounts`, `parties`, `products`, `vouchers`, `invoices`, `cheques`, `employees`, `assets`, `costCenters`, `currencies`, `exchangeRates`, `importDossiers`, `salesOrders`, `subcontractJobs`, `rbacOperators`, `auditLogs`), auxiliary business stores (`warehouses`, `taxReports`, `localProfiles`), sync stores (`syncOutbox`, `syncInbox`), backup infrastructure (`preUpdateBackups`, `secureWorkspace`).
- The durable restore journal is an additional store managed by the same database lifecycle.
- `saveOperationalWorkspaceTx` writes the operational entity rows and profile/meta data directly as plaintext objects in one IndexedDB read-write transaction.
- `loadOperationalWorkspace` reads those same active entity stores directly and assembles the in-memory workspace.
- Other financial mutation functions in `operationalDb.ts` perform their own multi-store read-write transactions (including product/voucher/cheque/invoice, sales-order, asset, and stock-related commits). These are not all routed through a single generic repository adapter.
- `writeEncryptedOperationalWorkspaceSnapshot` reads the active workspace, encrypts a serialized snapshot, then writes the resulting envelope to `secureWorkspace`. It does not replace or delete the source rows.
- The encrypted snapshot uses source-revision checks to avoid committing a stale shadow, but this is not a write-through encrypted primary-store protocol.

## Adjacent persistence boundaries reviewed

| Area | Current boundary | Cutover implication |
|---|---|---|
| Accounting UI | `AccountingContext.tsx` hydrates via `loadOperationalWorkspace` and persists via `saveOperationalWorkspaceTx`; several local profile/PIN-related localStorage keys are separate | Preserve existing financial transaction semantics and keep credentials/device secrets out of business snapshots |
| Repository abstraction | `repositoryAbstraction.ts` delegates workspace load/save to the operational DB | This is a useful integration seam, but it does not yet cover every specialized transaction function |
| Workspace extensions | `WorkspaceExtensionsContext.tsx` persists the aggregate extension state in localStorage and synchronizes a cloud extension document | Must migrate with an explicit revision/generation protocol; the existing encrypted shadow snapshot allowlists selected extension keys |
| Dual-cloud sync | `dualCloudSync.ts` maintains localStorage sync metadata and a diagnostic queue; the durable operation outbox is in operational IndexedDB | Distinguish business payloads from cursors/preferences; do not assume every outbox payload is encrypted |
| Local backup | `localBackup.ts` owns a separate IndexedDB backup store and legacy close-snapshot keys | Keep backup lifecycle separate from primary operational row encryption; legacy plaintext close data remains migration-only |
| Document Vault | `documentVault.ts` owns a separate IndexedDB database for attachments; attachment bytes are encrypted for new writes, while metadata remains queryable | A separate database cannot join an operational-store transaction; retain the existing staged forward-recovery protocol |
| Browser bootstrap | `main.tsx` has no direct IndexedDB open in the reviewed source | Startup/unlock sequencing still needs an end-to-end call-site audit before cutover |

This is a bounded review of the high-impact paths above, not a claim that every source file and every storage call site has been exhaustively enumerated.

## Security and correctness constraints

1. Do not enable a migration flag, change active readers to encrypted records, clear legacy stores, or bump the database schema as a speculative encryption step.
2. WebCrypto encryption is asynchronous. Do not await PBKDF2/AES-GCM while relying on an IndexedDB transaction remaining active; browser transactions can become inactive between asynchronous work.
3. Preserve atomic financial operations. A voucher/product/stock/cheque update must not be split into independent encrypted writes that can partially commit.
4. A ciphertext record stored beside its decryption secret does not provide meaningful at-rest confidentiality. The active session key must remain in memory and have an explicit unlock/recovery lifecycle.
5. Avoid plaintext leakage through indexes, debug reports, error messages, logs, sync payloads, localStorage mirrors, backups, and temporary staging stores.
6. Keep a recoverable copy of legacy records until the encrypted replacement has been decrypted, schema-validated, reconciled, and verified after reload.
7. Concurrent tabs/devices and background sync must be fenced by a monotonic workspace revision/generation. A stale encrypt operation must never overwrite a newer commit.
8. Restore and encryption migration are distinct workflows. Restore-journal recovery must remain available even when the encrypted workspace cannot be unlocked.

## Recommended implementation sequence

### 1. Complete the call-site inventory

- Enumerate every `openOperationalDb`, direct `indexedDB.open`, operational store transaction, and localStorage mirror touching durable business data.
- Classify each field as business data, query metadata, sync metadata, user/device secret, transient state, or derived cache.
- Trace startup hydration, login/unlock, tab coordination, offline writes, cloud replay, export/import, wipe, and recovery.
- Identify every specialized transaction API that must be preserved by the repository boundary.

Exit: a checked-in read/write matrix with a named owner and tests for every durable store and writer.

### 2. Define the encrypted record format and key lifecycle

- Use a versioned, authenticated envelope with explicit algorithm/KDF parameters, random salt/nonce, schema version, workspace identity, record type/id, and integrity metadata.
- Decide whether records are encrypted individually or in bounded encrypted partitions. Preserve required atomicity and define the query/index leakage trade-off before implementation.
- Derive or unwrap the data key only after explicit unlock; cache the CryptoKey in memory for the active session and clear it on lock/session teardown.
- Do not persist a raw key or passphrase beside ciphertext.

Exit: format specification, threat model, key lifecycle tests, and compatibility fixtures.

### 3. Introduce a transaction-safe encrypted repository

- Make the repository boundary cover ordinary CRUD and every specialized financial transaction.
- Prepare ciphertext before opening the final IndexedDB write transaction.
- In the final transaction, re-read and compare the expected workspace revision/generation, then commit all affected encrypted records and the revision atomically.
- Reads fetch ciphertext in a short readonly transaction, decrypt outside the transaction, then validate schema and ownership before exposing records to the application.
- Preserve indexes only for explicitly approved non-sensitive metadata; do not silently add plaintext secondary copies.

Exit: all writers/readers route through the repository; existing financial atomicity and idempotency tests pass against the encrypted adapter.

### 4. Add non-destructive, resumable migration

- Add a new versioned encrypted store namespace rather than rewriting legacy stores in place on first rollout.
- Migrate in bounded batches with a durable journal containing source revision, target generation, per-store progress, counts, and authenticated digests.
- Re-check source revision before final promotion. If source data changed during encryption, discard/retry the staged generation rather than promoting stale data.
- Verify counts, IDs, accounting invariants, decryptability, and representative financial totals before setting the active-generation pointer.
- Keep legacy stores intact and read-only until rollback and restore tests pass.

Exit: interruption at every batch boundary is recoverable; a failed migration leaves the old workspace usable.

### 5. Prove rollback, recovery, and operational behavior

Required tests include:
- fresh profile, existing plaintext profile, and upgrade from each supported DB schema;
- wrong passphrase, locked vault, corrupted envelope, truncated record, unsupported version, and tampered metadata;
- quota exhaustion, transaction abort, tab termination, browser crash, and simultaneous tab writes;
- concurrent revision changes during encryption and during migration promotion;
- atomic multi-entity financial commits and idempotent offline replay;
- restore journal recovery while locked and after partial cross-database attachment restore;
- no new plaintext writes to active business stores, localStorage, sync payloads, or logs;
- decrypt/reload/reconcile on at least two real devices and supported browsers.

Exit: full CI on the exact candidate commit plus real-browser/device evidence. CI alone does not prove Android lifecycle, WebCrypto persistence, or cross-device recovery.

## Release gate

Primary-store encryption is complete only after all readers and writers use the encrypted repository, the active generation is encrypted, legacy data has a verified rollback path, and real-browser recovery tests pass. Until then, retain the current plaintext primary stores and the encrypted shadow as a non-authoritative checkpoint. Do not merge or deploy based solely on this audit.


## Follow-up source-level inventory (branch audit)

The following callable persistence APIs and transaction groups were confirmed by source inspection. This is a concrete implementation checklist for the repository refactor; it is not an exhaustive proof that no other module writes directly to IndexedDB.

### Operational database API surface

The active database module exports these durable-data boundaries:

- Workspace CRUD: `saveOperationalWorkspaceTx`, `loadOperationalWorkspace`.
- Invoice transaction: `commitInvoiceOperationalTx` — one transaction over `meta`, `products`, `vouchers`, `cheques`, and `invoices`.
- Sales dispatch: `commitSalesOrderDispatchOperationalTx` — one transaction over `salesOrders` and `meta`.
- Cheque lifecycle: `commitChequeStatusOperationalTx` — one transaction over `meta`, `cheques`, and `vouchers`.
- Depreciation: `commitDepreciationOperationalTx` — one transaction over `meta`, `assets`, and `vouchers`.
- Stock adjustment: `commitStockAdjustmentOperationalTx` — one transaction over `meta`, `products`, and `vouchers`.
- Sync idempotency: `enqueueSyncOutboxOperation`, `listPendingSyncOutboxOperations`, `markSyncOutboxOperationStatus`, `clearPendingSyncOutboxOperations`, `recordInboxOperation`, `isInboxOperationProcessed`.
- Restore and recovery: `createOperationalRestoreJournal`, `updateStagingOperationalRestoreJournal`, `applyOperationalRestoreJournalWorkspace`, `discardStagingOperationalRestoreJournal`, `transitionOperationalRestoreJournal`.
- Backup/diagnostics: `writeEncryptedOperationalWorkspaceSnapshot`, `prepareEncryptedOperationalWorkspaceMigration`, `loadPreparedEncryptedOperationalWorkspace`, `savePreUpdateSafetyBackup`, paginated store reads, statistics, and wipe operations.

The module has direct IndexedDB transactions beyond the generic repository adapter. These include specialized business commits, outbox/inbox writes, restore-journal operations, encrypted-shadow writes, pre-update backups, diagnostics, and destructive wipe. A future adapter must preserve the specialized transaction contracts rather than replacing them with separate per-record writes.

### Current repository abstraction gap

`src/lib/repositoryAbstraction.ts` exposes an `IndexedDbLocalRepository` and `SerializableLocalRepository`, but its IndexedDB adapter delegates the general workspace read/write path to `loadOperationalWorkspace` and `saveOperationalWorkspaceTx`. The specialized financial transaction APIs remain separate imports from `operationalDb.ts` in `AccountingContext.tsx`.

Required action: extend the repository contract with explicit atomic commands for invoice commit, sales dispatch, cheque status, depreciation, stock adjustment, sync outbox/inbox, and restore. Keep transaction inputs typed and validate expected workspace revision inside the same final read-write transaction.

### Persistence domains and required handling

| Domain / source | Observed persistence | Required migration treatment |
|---|---|---|
| Operational entities | Plain object records in `holoo_apex_operational_db_v1` | Encrypted active generation; preserve indexes and multi-store atomic commands |
| Operational sync outbox/inbox | Dedicated stores in operational DB | Encrypt payloads and preserve idempotency/status transitions |
| Workspace extension aggregate | `holoo_apex96_workspace_extensions_v2` in localStorage plus legacy keys | Versioned extension envelope; explicit legacy precedence and surfaced write failures |
| Supabase sync metadata | localStorage cursors, workspace locator, conflict preference, retry/diagnostic queue | Classify each as secret, preference, cursor, or business payload; never treat locator/cursor as authority |
| Local backup | Separate `holoo_apex_local_backup_db_v1`-style store and legacy close-snapshot key | Keep encrypted backup envelope and migration-only legacy reader; do not confuse with primary-store encryption |
| Document Vault | Separate `holoo_apex_document_vault_v1` database | Retain attachment envelope encryption and staged restore; separately encrypt or classify queryable metadata |
| Profile photo and RBAC PIN hash | localStorage keys read/written by AccountingContext | Profile image is personal content requiring explicit policy; PIN hash is authentication material and must remain outside business backups |
| Device identity/label and close-backup preference | localStorage in localBackup module | Device-scoped metadata/preferences; exclude from business snapshot unless a documented restore requirement exists |

### Implementation order refined by the source inventory

1. Add a typed repository command interface mirroring each specialized operational transaction, initially delegating to the existing functions with no behavior change.
2. Move all AccountingContext imports/calls to the repository interface; add structural tests proving it no longer imports specialized functions directly from `operationalDb.ts`.
3. Add a test-only IndexedDB adapter that can assert each command opens exactly one transaction with its complete store set and aborts all writes on any failure.
4. Define an encrypted repository adapter that serializes and encrypts payloads before opening the commit transaction, then checks the live revision and atomically writes the encrypted records plus generation metadata.
5. Route sync outbox/inbox through the same encrypted repository boundary while preserving deduplication and replay state.
6. Only after the above is tested, add a parallel encrypted store generation and resumable migration journal. Do not alter the current active store names or database version as part of the adapter-only step.
7. Migrate extension localStorage, backup metadata, and Document Vault as separate bounded workstreams with explicit ownership, recovery, and compatibility gates.

No production code was changed by this follow-up inventory. The current plaintext operational stores remain authoritative, and the encrypted shadow remains non-authoritative until a separately reviewed cutover.


## Follow-up implementation status — 2026-11-28

The first repository-command seam has now been introduced:

- `operationalTransactionPort` in `src/lib/repositoryAbstraction.ts` delegates invoice commits, sales-order dispatch, cheque transitions, depreciation, and stock adjustments to the existing specialized IndexedDB transaction functions.
- `AccountingContext.tsx` now calls the port for invoice creation/cancellation/proforma conversion, cheque status transitions, depreciation, and sales-order dispatch. It no longer imports those five specialized transaction functions directly from `operationalDb.ts`.
- The generic workspace load/save, operational DB statistics, restore barrier, and encrypted migration preparation APIs are still imported directly by AccountingContext. This is an intentional incomplete boundary, not a claim that all persistence access is abstracted.
- `tests/operational-transaction-port.test.ts` verifies that all five port members are the exact existing transaction implementations. The test is included in the main test script.
- The atomicity audit now expects the port call for the three invoice lifecycle paths. The full CI run must pass before treating this seam as validated.

Remaining before an encrypted adapter is eligible for implementation: route the remaining operational DB access through a typed repository boundary; add IndexedDB transaction-store-set/abort tests for each command; specify encrypted record envelopes, key unlock/rotation/recovery and schema/index strategy; and implement a parallel generation with resumable migration and rollback. The authoritative operational stores are still plaintext. No cutover or database-version migration has been activated.


## Direct operational DB consumer inventory — 2026-11-28

A follow-up source scan after introducing `operationalTransactionPort` confirms that the repository boundary is still intentionally partial. The remaining direct imports are not all interchangeable CRUD calls; they cover distinct lifecycle and safety responsibilities:

| Consumer | Direct operational DB responsibilities | Boundary treatment |
|---|---|---|
| `src/App.tsx` | Lazy-loaded operational DB bootstrap path | Move behind a bootstrap/runtime facade only after startup ordering and failure behavior are covered by tests |
| `src/hooks/useDualCloudSync.ts` | Restore-journal barrier checks; durable outbox enqueue/status and inbox idempotency | Introduce a sync-persistence port preserving atomic outbox/inbox semantics and restore barrier checks |
| `src/hooks/useLocalFirstMeshSync.ts` | Restore-journal checks plus inbox deduplication/recording | Share the same sync-persistence port; keep replay idempotency inside the persistence transaction |
| `src/components/SettingsView.tsx` | Restore journal inspection/resume, workspace read and encrypted snapshot/migration UI | Use a recovery/backup service boundary; do not mix recovery orchestration into the ordinary entity repository |
| `src/components/OfflineFirstControlPanel.tsx` | Operational DB version and pre-update safety backup | Use a backup/maintenance service boundary with explicit backup completion/failure results |
| `src/components/OfflineSyncHealthDashboard.tsx` | Operational DB diagnostics/reporting | Use a read-only diagnostics interface; diagnostics must not expose decrypted business payloads |
| `src/components/SystemResetCenter.tsx` | Destructive local IndexedDB wipe and local-storage cleanup | Keep as a privileged maintenance command with confirmation, scope reporting, and recovery guard |

The inventory also identifies a separation-of-concerns requirement: a single broad repository interface should not become a dumping ground for bootstrap, sync, recovery, diagnostics, backup, and destructive maintenance. The safer design is a small set of typed ports (business transactions, sync persistence, recovery/backup, diagnostics, maintenance) sharing one encrypted storage implementation underneath.

### Revised implementation sequence

1. Keep the five financial command delegations behavior-preserving and require green CI for the current branch head.
2. Extract sync outbox/inbox and restore-barrier operations behind a typed sync-persistence port; test duplicate replay, malformed payload rejection, pending status transitions, and restore blocking.
3. Extract recovery/backup operations behind a dedicated service; test interrupted restore at every journal transition and verify that ordinary writes remain blocked until recovery resolves.
4. Add read-only diagnostics and privileged maintenance interfaces without allowing either to bypass the restore barrier or expose plaintext records.
5. Specify and test the encrypted storage format, key derivation/unlock lifecycle, key rotation, schema/index strategy, and multi-store atomic commit semantics before implementing the encrypted adapter.
6. Implement a parallel encrypted generation with resumable, checksummed migration and tested rollback; switch authority only after full validation and explicit migration gating.

No additional production persistence behavior was changed by this inventory. It records observed call sites and constrains the next refactor. The active primary operational stores remain plaintext; the encrypted snapshot remains a shadow/checkpoint, not the authoritative database.

## Current branch re-audit — 2026-11-28

The repository-port extraction has progressed beyond the earlier inventory above. On branch `fix/phase-1-financial-core` at commit `f6c5341111bec50ae89a5b7e98906628e50cbd78`, source inspection confirms:

- `AccountingContext.tsx` uses `operationalTransactionPort`, `operationalWorkspacePersistencePort`, `operationalDiagnosticsPort`, and `operationalEncryptionPreparationPort`.
- `useDualCloudSync.ts` and `useLocalFirstMeshSync.ts` use `operationalSyncPersistencePort`.
- `SettingsView.tsx`, `OfflineFirstControlPanel.tsx`, `OfflineSyncHealthDashboard.tsx`, and `SystemResetCenter.tsx` use the recovery, backup-maintenance, health-report, and reset ports respectively.
- `App.tsx` dynamically loads the backup-maintenance port through `repositoryAbstraction`.
- `tests/operational-transaction-port.test.ts` statically scans all TypeScript/TSX files in `src/App.tsx`, `src/components`, `src/hooks`, and `src/context` to reject direct `operationalDb` imports. The remaining implementation imports are concentrated in the adapter module; tests intentionally import low-level functions to verify delegation.

This improves the application boundary, but does not make the adapter encrypted and does not change the plaintext-primary status described above.

### Newly confirmed shadow freshness gap: workspace extensions

Source inspection of `WorkspaceExtensionsContext.tsx` and the encrypted-shadow scheduling effect in `AccountingContext.tsx` found a consistency gap:

1. Extension mutations persist `holoo_apex96_workspace_extensions_v2` and compatibility keys through `persistLocalMirror`.
2. Those writes do not publish a revision/generation change consumed by the encrypted-shadow scheduler.
3. The shadow scheduler is driven by the accounting context's entity/profile dependencies. Extension-only mutations do not necessarily change those dependencies and therefore do not necessarily trigger a new encrypted shadow.
4. The encrypted shadow's `sourceRevision` is currently the operational IndexedDB `localRevision`. Extension-only writes do not advance that revision, so the existing revision fence cannot detect that the extension payload changed after the last shadow was prepared.

Impact: the encrypted shadow may be internally valid and revision-matched to the accounting stores while containing stale workspace-extension data. It must not be treated as a complete current workspace snapshot or promoted as a migration source.

Required remediation before cutover:
- Define a monotonic, durable extension revision/generation and include it in the authenticated snapshot contract.
- Ensure every successful local extension mutation advances that generation; handle failed/rolled-back localStorage writes without advancing it.
- Make shadow preparation capture both accounting and extension revisions, then re-check both before publishing the prepared snapshot. A changed revision must reject/retry the stale result.
- Add regression tests proving an extension-only mutation schedules a new shadow, advances the extension generation, and rejects a snapshot prepared against an older generation.
- Add interrupted-write and restore tests for extension generation and payload consistency.

## Extension shadow freshness mitigation — 2026-11-28

The branch now contains a partial mitigation for the extension-only stale-shadow gap described above (source commit `6d92129d91605014af9554f8503efcd6caca004a`):

- `writeEncryptedOperationalWorkspaceSnapshot` compares the snapshot's captured business-local extension stores with the current localStorage capture before encryption and again in the final IndexedDB write callback. A mismatch rejects the write rather than publishing a known-stale shadow.
- `loadPreparedEncryptedOperationalWorkspace` compares the decrypted snapshot's extension-store capture with current localStorage before returning the prepared workspace. A mismatch rejects the read even when the IndexedDB `localRevision` is unchanged.
- `tests/encrypted-operational-workspace-migration.test.ts` covers an extension-only localStorage mutation after snapshot preparation, verifies that loading rejects it, and verifies that restoring the original localStorage value makes the snapshot readable again.
- CI for commit `6d92129d91605014af9554f8503efcd6caca004a` completed successfully, including TypeScript, the test suite, Firestore emulator security tests, and production build.

This is a freshness guard, not a durable extension revision protocol. It does not make localStorage and IndexedDB atomic, cannot prevent a mutation immediately after a successful freshness check, and does not guarantee cross-tab ordering or automatic shadow refresh after extension-only changes. The migration test now also pauses WebCrypto encryption, mutates the extension localStorage value while encryption is in flight, and verifies that the final IndexedDB callback rejects the stale write while preserving the previously prepared shadow. This is a deterministic same-tab race test; it does not establish cross-tab ordering, browser-process crash safety, or atomicity across localStorage and IndexedDB. A monotonic durable extension generation and explicit scheduling/retry behavior remain required before migration or cutover.

No primary-store encryption cutover, schema bump, merge, or deployment was performed. The primary IndexedDB stores remain plaintext and authoritative; `secureWorkspace` remains a non-authoritative encrypted shadow/checkpoint.
