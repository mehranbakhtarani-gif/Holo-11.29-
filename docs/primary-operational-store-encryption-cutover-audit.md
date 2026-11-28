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


## Extension durability design decision — 2026-11-28

A focused re-audit of `WorkspaceExtensionsContext.tsx`, `businessLocalStateSnapshot.ts`, and the operational database upgrade path rules out a localStorage-only generation counter as a durable consistency protocol.

### Confirmed write and concurrency characteristics

- The extension aggregate and three compatibility mirrors are written sequentially to four localStorage keys. The current code rolls back keys already written if a later `setItem` fails, but rollback itself can fail and the four-key sequence is not atomic.
- Ordinary `updateExtensions` is synchronous: it computes from `stateRef.current`, writes the local mirror, updates React state, and starts cloud propagation without awaiting it. Cloud snapshot hydration also writes the mirror. Tracked warehouse transfer persistence uses the same local mirror helper.
- The Firestore path has its own transaction/version behavior. A local persistence redesign must not conflate the local IndexedDB generation with the Firestore document `_version`, nor overwrite newer cloud changes during hydration/replay.
- `captureBusinessLocalStateSnapshot` reads an allowlist of independent localStorage keys one at a time. A snapshot can therefore observe a mixed set if another tab mutates those keys during capture.
- IndexedDB schema is currently version 5. Its upgrade handler creates object stores and indexes in the versionchange transaction. The existing operational stores, specialized multi-store financial transactions, restore journal, and restore barrier are separate compatibility constraints.

### Rejected approach: increment a counter beside localStorage writes

A counter in IndexedDB (or localStorage) does not make the payload and counter atomic when they live in different storage systems. Increment-before-write can leave a permanently advanced counter after a crash; increment-after-write leaves a crash window where changed payload is paired with the old counter. A localStorage counter also remains vulnerable to cross-tab read/modify/write races. BroadcastChannel/storage events are notifications, not a durable transaction or serialization primitive. The existing freshness comparison is useful as a rejection guard, but it cannot close these windows.

### Recommended target: one authoritative IndexedDB extension aggregate

Before implementing generation tracking, move the authoritative extension aggregate into a dedicated record in the operational IndexedDB database (for example, a `workspaceExtensions` object store keyed by workspace ID). Store the aggregate payload, schema version, and monotonically increasing generation in the same record. A single IndexedDB readwrite transaction then atomically replaces the aggregate and advances its generation. For any command that must atomically affect both core accounting entities and extensions, include both stores in the same transaction; do not split the business invariant across independent commits.

The intended contract is:

1. All extension mutations enter a typed asynchronous persistence command. The command reads the current aggregate/generation and applies a validated patch inside one readwrite transaction; stale expected generations are rejected or explicitly rebased.
2. React may render an optimistic state, but persistence completion/failure is observable. A failed durable write must not be reported as committed or silently disappear behind a fire-and-forget promise.
3. Cloud hydration and outbox replay use the same command boundary and explicit source/version metadata. Firestore `_version`, local IndexedDB generation, and sync operation IDs remain distinct fields with documented ordering rules.
4. Legacy localStorage keys become migration inputs and, only if compatibility requires them, derived mirrors. They are never used as the authority for generation or encrypted-shadow freshness. Mirror writes are repairable and must not roll back a committed IndexedDB transaction.
5. Encrypted shadow preparation reads the extension aggregate and generation from IndexedDB, includes both in the authenticated snapshot, and verifies the same generation in the final IndexedDB transaction that publishes the shadow. Because both records share one database, the final freshness fence can be transactionally enforced.
6. Restore stages and validates the extension aggregate, then commits it under the existing restore barrier/journal with an explicit target generation. Recovery must be idempotent and must not expose a partially restored aggregate.

### Migration and test gates before implementation

- Inventory every reader/writer of the four compatibility keys, including helpers outside `WorkspaceExtensionsContext`; classify each as authoritative read, migration-only fallback, or derived mirror. No key can be retired until this inventory is complete.
- Define behavior for existing profiles, empty profiles, corrupted legacy JSON, simultaneous tabs on old and new app versions, quota failure, blocked/versionchange upgrades, and rollback to an older application build. An older build that still treats localStorage as authoritative is a compatibility hazard; rollout must either be gated or retain a proven downgrade bridge.
- Add transaction tests for concurrent tab writes, compare-and-swap generation conflicts, abort after payload put but before commit, and crash/reopen recovery. Test that generation never advances without its matching payload and vice versa.
- Add migration tests for interruption before/after each journal transition, legacy mirror disagreement, duplicate migration attempts, and rollback. Test cloud hydration racing a local mutation and outbox replay racing restore.
- Only after the extension aggregate is authoritative in IndexedDB should the encrypted repository migration consume it. Do not add an extension generation to the current localStorage snapshot and describe it as durable.
- Keep the current freshness guard and encrypted shadow non-authoritative until this migration, the repository encryption work, and real-device recovery gates are complete.

This is an architecture decision and source-level audit only. No schema bump, data migration, localStorage authority change, encrypted cutover, merge, or deployment was performed.


## Legacy extension-key consumer inventory — 2026-11-28

A branch-pinned source inspection of the four extension compatibility keys found the following direct access paths:

| Key | Current direct access | Classification |
|---|---|---|
| `holoo_apex96_workspace_extensions_v2` | `WorkspaceExtensionsContext.loadInitialExtensions` reads it; `persistLocalMirror` writes it and attempts rollback on failure. | Current aggregate bootstrap input and compatibility mirror. |
| `holoo_apex96_reserved_invoices_v1` | `WorkspaceExtensionsContext.persistLocalMirror` writes it; `smartIntelligence.loadReservedInvoices` reads it as a fallback when the aggregate omits the field. | Compatibility mirror plus legacy bootstrap fallback. |
| `holoo_apex96_favorite_menus` | `WorkspaceExtensionsContext.persistLocalMirror` writes it; `smartIntelligence.loadFavoriteMenus` reads it as a fallback. | Compatibility mirror plus legacy bootstrap fallback. |
| `holoo_apex96_product_meta_v1` | `WorkspaceExtensionsContext.persistLocalMirror` writes it; `smartIntelligence.loadProductApexMetaMap` reads it as a fallback. | Compatibility mirror plus legacy bootstrap fallback. |

The three legacy loaders and corresponding save helpers are defined in `src/lib/smartIntelligence.ts`. On the inspected branch, only the three load helpers are imported by `WorkspaceExtensionsContext.tsx`, and each is used only as fallback when the aggregate record does not provide that field. The three exported save helpers have no call sites in the inspected context. The dashboard view-mode key in the same module is separate UI preference state and is not part of the four-key business snapshot allowlist.

### Migration implications

- The aggregate key remains the primary local bootstrap source today; the other three keys are fallback/mirror paths. Migration must explicitly preserve fallback precedence for profiles whose aggregate is absent, malformed, or missing individual fields.
- Once the IndexedDB aggregate is authoritative, migration should read the legacy aggregate and the three fallback keys once under a migration journal, validate and merge deterministically, then commit the normalized aggregate and migration marker in one IndexedDB transaction.
- A malformed aggregate must not silently mask valid fallback values for individual fields. Conversely, a valid aggregate field must not be overwritten by an older mirror. The precedence and conflict diagnostics need tests and an explicit policy.
- After successful migration, legacy readers should become migration-only (or be removed after the supported downgrade window); legacy writers should be removed rather than retained as a second authority. If compatibility mirrors remain temporarily, write them only after the IndexedDB commit and treat failures as repairable mirror drift.
- This is a source-level inventory of the four named keys, not proof that every dynamically constructed key or indirect access in the entire repository has been found. Before retiring localStorage, perform a repository-wide search for `localStorage`, the exact key strings, and the exported smartIntelligence helper names, then review every result on the target branch.

No code, data, IndexedDB schema, or runtime behavior was changed by this inventory.


## Migration protocol and compatibility gates — 2026-11-28

The four-key inventory is intentionally not treated as a complete repository-wide proof. Before implementation, the exact-key search and a full source scan must be repeated against the migration commit, including dynamically accessed storage wrappers and tests.

### Deterministic legacy import policy

The migration must be a one-way, journaled import into a dedicated IndexedDB extension aggregate. It must not perform a blind object spread across all four legacy values.

1. Read and retain the raw value and parse/validation result for each legacy key. Distinguish absent, valid, malformed, and inaccessible storage; do not collapse these states into an empty object.
2. Validate the aggregate record and each of its fields independently. A valid aggregate field wins over a compatibility mirror. If that field is absent or invalid, a valid corresponding legacy mirror may be used as a fallback. This preserves the current bootstrap intent without allowing a stale mirror to overwrite valid aggregate data.
3. If the aggregate JSON itself is malformed, record a recoverable migration diagnostic and construct only those fields that can be safely recovered from individually valid mirrors. Never silently delete or overwrite the raw legacy values during this phase.
4. Apply existing domain limits and validators before commit (including reserved-invoice and product metadata bounds); do not truncate or coerce financial/business records without an explicit domain rule.
5. In one IndexedDB readwrite transaction, write the normalized aggregate, its schema version, generation 1 (or a formally specified initial generation), and a migration journal state that proves the payload and marker committed together.
6. On restart, if no committed marker exists, rerun validation/import idempotently. If the marker exists, verify the target record and schema before treating migration as complete. A marker without a valid aggregate must be impossible by transaction design and treated as corruption if observed.
7. Keep the original localStorage values unchanged until migration verification and a defined rollback/downgrade window have passed. Compatibility mirrors, if retained, are derived writes after the IndexedDB commit and are never rollback authority.

### Required conflict and compatibility decisions

- Two tabs migrating simultaneously: use a single IndexedDB readwrite transaction and a compare-and-swap check on the migration marker/generation; the loser must read and validate the winner's committed record rather than overwrite it.
- Old and new application versions running concurrently: an older build that continues writing localStorage can reintroduce stale values. A rollout gate or explicit cross-version protocol is required; storage events alone do not provide atomic ordering.
- Existing aggregate plus disagreeing mirrors: aggregate field wins when valid; emit diagnostics for disagreements. A mirror may only fill a missing/invalid aggregate field under the policy above.
- Quota/security failure: abort the IndexedDB transaction and leave all legacy values untouched. Never claim migration complete.
- IndexedDB blocked/versionchange: surface a retryable migration state; do not clear legacy data or repeatedly force reloads.
- Rollback to an older build: retain a tested downgrade bridge or block downgrade after the authority switch. Merely continuing to mirror writes is not enough unless stale-write ordering is defined and verified.
- Restore in progress: the existing restore barrier takes precedence. Migration must not run concurrently with restore staging/commit, and recovery must be journal-idempotent.
- Encryption: the imported aggregate remains subject to the separate encryption-at-rest cutover gates. Moving extension data into IndexedDB does not itself encrypt it.

### Minimum migration test matrix

Tests must cover: missing all keys; aggregate-only; mirror-only; valid aggregate with stale mirrors; partial aggregate with valid per-field mirrors; malformed aggregate with recoverable mirrors; malformed individual mirrors; disagreement diagnostics; duplicate migration; two tabs racing; crash before transaction commit; restart after commit but before UI hydration; blocked database upgrade; quota failure; restore barrier active; cloud hydration racing a local edit; outbox replay racing migration; old-version writer racing the new build; downgrade/rollback behavior.

No migration code or schema change is authorized by this document alone. The next implementation gate is a complete branch-pinned storage-access inventory and a reviewed compatibility decision for old application versions.


## Wider localStorage dependency scan — targeted source pass, 2026-11-28

A branch-pinned source pass at the current migration-protocol commit inspected the main extension/context, snapshot, operational database, backup, sync, settings, and storage utility modules. This is a targeted pass, not yet an exhaustive repository-wide proof: remaining source files, tests, dynamically constructed keys, and indirect storage wrappers still require review.

### Additional storage families found

| Storage family / key(s) | Observed access | Migration classification |
|---|---|---|
| `holoo_apex_voucher_templates_v1`, `holoo_apex_voucher_template_usage_v1` | `voucherTemplates.ts` reads/writes; included in business snapshot allowlist | Durable business configuration; separate domain schema and validation required |
| `holoo_apex_bank_recon_sessions_v1`, `holoo_apex_warehouse_transfers_v1` | Included in business snapshot allowlist; full writer/reader inventory still pending | Potentially operational business state; inspect all producers/consumers before authority move |
| `holoo_apex_invoice_settings_v1` | `invoiceSettings.ts` reads/writes; included in business snapshot allowlist | Durable business configuration |
| `holoo_apex_sync_conflict_default_v1` | Included in business snapshot allowlist; direct access inventory pending | Sync configuration |
| `holoo_apex_conflict_policy_v1`, `holoo_apex_offline_outbox_v1`, `holoo_apex_supabase_revision_v1`, `holoo_apex_supabase_last_sync_v1`, `holoo_apex_supabase_workspace_id_v1`, `holoo_apex_supabase_auto_backup_v1` | `dualCloudSync.ts` reads/writes; most are in the business snapshot allowlist | Sync state/configuration; outbox requires payload sensitivity and replay semantics review |
| `holoo_apex_mesh_device_peer_id_v1`, `holoo_apex_mesh_vector_clock_v1` | `p2pMeshSync.ts` reads/writes | Device identity and sync metadata; not business snapshot data |
| `holoo_apex_mesh_passphrase_v1` | `p2pMeshSync.ts` reads/writes a generated or user-supplied pairing passphrase directly in localStorage | Sensitive credential material. Excluded from business snapshot allowlist; requires a separate credential-storage remediation decision and must not be copied into the business aggregate |
| `holoo_apex_imported_backup_digests_v1` | `offlineFirstCore.ts` reads/writes imported backup digests | Import deduplication metadata |
| `holoo_apex_invoice_settings_v1` | `invoiceSettings.ts` reads/writes | Included in business snapshot; inspect whether settings overlap other persistence sources before moving |
| `holoo_dashboard_layout_v1`, `holoo_ui_theme_customizer_v1`, `holoo_theme_mode`, `holoo_apex96_dashboard_mode` | Dashboard/theme modules and `App.tsx` read/write | Presentation preferences; separate from operational business authority |
| `holoo_profile_photo_*`, `holoo_apex_rbac_pin_hash_v1` | `AccountingContext.tsx` reads/writes/removes | Profile media and authentication/RBAC material; separate security and lifecycle review |
| Device label/ID, auto-close preference, encrypted close snapshot | `localBackup.ts` reads/writes | Device metadata, preference, and encrypted snapshot; not part of extension aggregate |

### Important security observation

The mesh pairing passphrase is persisted as a raw localStorage string by `loadMeshPassphrase` and `saveMeshPassphrase`. This is not the backup encryption passphrase and must not be confused with the in-memory backup-session key lifecycle. Because localStorage is accessible to same-origin JavaScript, this is a distinct credential-at-rest exposure. Do not silently migrate it into the business extension record or claim it is protected by the encrypted operational shadow. A separate remediation should define platform-backed credential storage where available, rotation/re-pairing behavior, and a safe legacy cleanup plan.

### Snapshot allowlist boundary

The business snapshot allowlist contains 16 keys, including the four extension compatibility keys, voucher templates/usage, bank reconciliation sessions, warehouse transfers, invoice settings, and selected sync configuration/outbox keys. It intentionally excludes mesh passphrase, device identity, profile photo, RBAC PIN hash, and presentation preferences. The allowlist is therefore a restore boundary, not proof that every durable localStorage key has already been migrated to IndexedDB.

### CI trigger behavior

The checked-in CI workflow runs on pull requests targeting `main` and pushes to the configured branches, including `fix/phase-1-financial-core`. It has no path filter excluding documentation. The successful CI run for the current documentation commit confirms that docs-only commits do trigger verification on this branch.

### Remaining scan gate

Before implementation, inspect the remaining source modules and all test files for direct storage access, wrapper abstractions, computed key names, `Storage` enumeration, and storage event listeners. Reconcile every durable business key with its writer, reader, snapshot/restore behavior, validation, and concurrency semantics. The targeted pass above must not be described as complete repository-wide inventory.


## Repository-wide source/test storage scan — 2026-11-28

A literal-access scan was completed against the branch-pinned tree at `6db7594c9643d4f9bc2cd6834b09548447c5a061`: all 129 TypeScript/TSX/JS/JSX files under `src/` and all 39 corresponding test files under `tests/` were inspected for direct `localStorage`/`sessionStorage` use, storage events, known key prefixes, and the extension helper names. This closes the previously stated source-file scan gate for literal references in those directories. It does not prove the absence of reflective/computed property access, storage use in public assets or build scripts, or third-party package behavior; those remain outside this bounded scan.

### Additional direct-access keys and consumers found

| Key / namespace | Reader/writer | Data class and migration treatment |
|---|---|---|
| `holoo_apex_report_columns_v1` | `accountingReportExport.ts` load/save | Report layout preference; not operational accounting data |
| `holoo_apex_recent_dashboard_actions_v1` | `DashboardActionSearch.tsx` load/save | UI navigation history; preference only |
| `holoo_apex_cached_live_fx_v1` | `LiveFxTickerCard.tsx` load/save | Cached external FX display payload; derived cache, not accounting rate authority |
| `holoo_apex_audio_feedback_v1` | `audioFeedback.ts` load/save | UI sound preference |
| `holoo_billion_local_slm_weights_v2` | `localSmallLlm.ts` load/save | Local AI model weights and optimization history; user-local model state, not financial source of truth |
| `holoo_apex_operating_mode_v1` | `offlineFirstCore.ts` load/save | Local/online/hybrid operating-mode preference |
| `holoo_apex_imported_backup_digests_v1` | `offlineFirstCore.ts` read/write | Backup import deduplication metadata; preserve with backup lifecycle |
| `holoo_apex_mesh_device_peer_id_v1` | `p2pMeshSync.ts` read/write | Device peer-role selection |
| `holoo_apex_mesh_passphrase_v1` | `p2pMeshSync.ts` read/write | Pairing secret; sensitive credential, separate secure-storage remediation required |
| `holoo_apex_mesh_vector_clock_v1` | `p2pMeshSync.ts` read/write | P2P synchronization metadata |
| `holoo_ws_<workspace>__local_offline_credential_v1` | `OfflineFirstControlPanel.tsx` read/write; key generated by `buildIsolatedWorkspaceStorageKey` | Workspace-scoped offline credential verifier. The record contains salted PBKDF2-SHA-256 hash metadata, not the plaintext PIN; nevertheless it is authentication material and must stay outside the business aggregate and receive a separate device/credential lifecycle policy |

Previously inventoried direct-access families also include voucher templates and usage, bank reconciliation sessions, warehouse transfers, invoice settings, sync conflict policy/revision/outbox/configuration, smart rules, cheque-alert preferences, native-notification preferences/history/sent-cheque IDs, theme/brand settings, device ID/label and close-backup preference, and the four extension compatibility keys. Their classification remains as documented above: operational business records, sync state, device metadata, caches, and UI preferences are not one homogeneous migration domain.

### Dynamic namespace and security boundary

The offline credential key is assembled from a sanitized workspace identifier and the fixed `local_offline_credential_v1` suffix. The stored record is generated with PBKDF2-SHA-256 and a random salt; it is explicitly `authScope: 'local_only'`. It is not a plaintext PIN, but moving it into the extension aggregate would still be a category error: it is authentication verifier material, not business state.

The mesh pairing passphrase is generated from cryptographically secure random bytes when available and then persisted as plaintext in `localStorage`; the fallback generator uses time and `Math.random` only when secure randomness is unavailable. A separate remediation should fail closed or surface a security warning when secure randomness is unavailable, define rotation/re-pairing, and migrate the existing secret without logging or exposing it. Do not silently copy the secret into the encrypted business snapshot: that snapshot's encryption is a separate backup/session mechanism and is not an at-rest primary-store cutover.

### Test coverage confirmed by the scan

Existing tests cover business-local snapshot validation/restore and interrupted localStorage replay, encrypted operational shadow freshness against extension localStorage changes (including a mutation during asynchronous encryption), restore of business-local snapshot keys, backup-session prohibition on localStorage access, and exclusion of plaintext close snapshots from automatic hydration.

The scan did not find a dedicated versioned extension-import journal test suite, a real two-tab IndexedDB migration race test, old-build/new-build writer compatibility tests, or rollback/downgrade tests for an authority switch. Those remain required before any migration implementation can become a cutover candidate. Existing snapshot restore tests do not substitute for those migration-specific cases.

### Consolidated migration boundary

The source scan confirms localStorage currently holds several distinct categories:
1. Business extension aggregate and compatibility mirrors.
2. Other business state/configuration already included in the 16-key business snapshot allowlist.
3. Sync/outbox metadata and P2P device/vector state.
4. Authentication and pairing credential material.
5. Device identity, backup metadata, and preferences.
6. Derived display caches and UI personalization.

Only categories 1 and selected, explicitly allowlisted items in category 2 are candidates for the proposed extension aggregate. Categories 3–6 require separate stores, retention policies, encryption decisions, or may remain local preferences/caches. No blanket "move every localStorage key into the encrypted operational workspace" operation is safe.

No source behavior, database schema, migration marker, or authority switch was changed by this scan.


## Current implementation boundary and startup cutover implications

A branch-pinned review of the operational database and extension provider confirms:

- `OP_DB_VERSION` is currently 5. Its operational store allowlist includes `meta`, the accounting entities, `syncOutbox`, `syncInbox`, `localProfiles`, `preUpdateBackups`, and `secureWorkspace`; it has no dedicated `workspaceExtensions` store.
- `WorkspaceExtensionsProvider` initializes React state synchronously with `useState(() => loadInitialExtensions())`. That loader reads the aggregate extension JSON directly from localStorage and falls back field-by-field to three legacy helper readers.
- `persistLocalMirror` writes the aggregate and three mirrors to localStorage. It has rollback-on-error, but no atomic transaction or durable generation.
- Firestore extension synchronization is a separate path using a Firestore transaction and the cloud document's `_version`. This version is not a local IndexedDB generation and cannot serve as its compare-and-swap token.
- Offline extension writes are separately encrypted into the existing extension outbox after a backup session unlock. That outbox's operation identity and replay semantics must remain distinct from the local extension aggregate's generation.

### Required application integration order

A future migration cannot safely be added only inside `loadInitialExtensions`: the current provider expects a synchronous value and renders immediately. The application needs an explicit asynchronous persistence bootstrap/readiness boundary before the provider exposes extension state. That boundary must:

1. Open/upgrade IndexedDB and verify the extension and migration stores exist.
2. Respect the restore barrier before reading or writing migration state.
3. Read the existing localStorage aggregate and mirrors, preserving raw values and classifying absent/valid/malformed/inaccessible separately.
4. Execute the versioned, deterministic import protocol above in one IndexedDB transaction, with the aggregate generation and migration journal committed atomically.
5. Read back and validate the committed IndexedDB aggregate before resolving provider readiness.
6. Route every extension mutation through the same IndexedDB transaction/generation mechanism; localStorage mirrors, if retained, are post-commit compatibility output only.
7. Keep Firestore `_version`, local IndexedDB generation, and encrypted outbox operation IDs separate.
8. Prevent old application versions from writing localStorage after the new build becomes authoritative, or define and test an explicit compatibility lease/bridge. There is no safe default assumption that an old tab has stopped writing.

The store addition requires a database version upgrade (currently version 5). The upgrade itself must be backward-compatible with existing operational stores and must handle blocked upgrades/versionchange events. A schema bump without the startup gate, writer redirection, cross-tab protocol, and rollback behavior would create a split-brain state where one build reads IndexedDB while another continues writing localStorage.

### Implementation decision

Do not introduce the new store, increment `OP_DB_VERSION`, or redirect extension reads/writes in this change set. The next code change must be a separately reviewable vertical slice: IndexedDB extension repository + generation CAS + migration journal + deterministic legacy importer + async provider bootstrap, with the complete two-tab, old/new build, restore-barrier, crash/restart, quota, blocked-upgrade, and downgrade tests in place before enabling the authority switch. Encryption-at-rest remains an independent gate and must not be implied by this storage relocation.


## Extension persistence implementation readiness (branch-pinned source review)

This section narrows the next code change to a separate, non-cutover vertical slice. It records implementation constraints observed in the current branch and the acceptance contract for an IndexedDB-backed extension repository. It does not authorize a schema bump or switch of authority.

### Source facts that affect the implementation

- `openOperationalDb` currently opens the database at the module-level `OP_DB_VERSION`, creates the restore journal and declared operational stores during upgrade, then checks the restore journal before returning a usable connection. The reviewed implementation has no explicit `IDBOpenDBRequest.onblocked` handler and no `IDBDatabase.onversionchange` close handler. A future version bump must add both and must expose a recoverable blocked-upgrade state rather than silently waiting.
- The current `WorkspaceExtensionsProvider` constructs state synchronously with `useState(() => loadInitialExtensions())`. That initializer reads the aggregate localStorage key and falls back to three legacy helper readers. React children can therefore observe extension state before any durable asynchronous repository bootstrap exists.
- `persistLocalMirror` writes four localStorage keys sequentially and attempts reverse rollback on failure. This is compensating behavior, not an atomic commit.
- `updateExtensions` currently computes the next state, persists localStorage synchronously, updates the ref and React state, then starts cloud propagation. The API is synchronous and has multiple specialized mutation paths (including transfer-state persistence); converting only this one callback would leave bypasses.
- `AccountingContext` hydrates the financial workspace asynchronously in its own effect. `main.tsx` currently composes `AccountingProvider` and `WorkspaceExtensionsProvider` directly; any extension readiness gate must not block restore-journal recovery or cause accounting fallback/demo data to become authoritative.

### Required first-slice contract

1. Introduce a typed `WorkspaceExtensionRepository` behind `repositoryAbstraction`; keep IndexedDB implementation details in the repository adapter. Its initial API should be limited to `bootstrap(workspaceId)`, `read(workspaceId)`, and `commit(workspaceId, expectedGeneration, nextSnapshot)`. The commit result returns the committed generation and timestamp. Do not add cloud sync, encryption-at-rest, or a mirror writer to this first contract.
2. Add a dedicated `workspaceExtensions` object store with `keyPath: 'workspaceId'`. A row contains only the workspace identity, extension schema version, monotonically increasing generation, validated snapshot, and commit timestamp. The snapshot and generation must be written in the same readwrite transaction. Use a conditional compare-and-swap: read the existing generation inside that transaction and abort unless it equals `expectedGeneration`; do not rely on a React ref, localStorage counter, BroadcastChannel message, or pre-transaction read for concurrency control.
3. Persist the migration journal in the same operational database and transaction boundary. It must distinguish at least `not_started`, `staging`, `verified`, and `committed`; record the source-key presence/parse status, source digest, target generation, schema version, record counts, and timestamps. Never mark migration committed before a read-back from IndexedDB passes structural validation and generation verification.
4. The legacy importer must read the four known keys without collapsing distinct outcomes: absent, valid, malformed, and inaccessible (e.g. SecurityError). Preserve the current field-level fallback semantics for the three legacy helper keys, but make precedence deterministic: a valid aggregate field wins; an absent or invalid aggregate field may be filled by a valid legacy field/default; a malformed aggregate must not mask valid legacy data. Record import diagnostics without copying credentials, mesh secrets, device IDs, sync cursors, or unrelated localStorage categories into the business extension row.
5. Bootstrap must be asynchronous and fail closed. The provider must expose an explicit readiness/error state and must not publish default or partially imported extension state to consumers until the repository read and validation finish. If IndexedDB is unavailable, blocked, quota-failed, or corrupt, surface a recoverable error; do not silently fall back to writable localStorage authority.
6. Convert every extension mutation path, including `updateExtensions`, transfer persistence, initial dye-lot seeding, and any direct state setter, to one serialized repository commit path. UI optimism may be retained only with a defined rollback/error surface. A failed commit must not be reported as durable success and must not be followed by cloud propagation as if local persistence succeeded.
7. Keep cloud `_version`, local IndexedDB generation, encrypted extension outbox operation IDs, and financial `localRevision` as separate monotonic domains. A successful local commit is not evidence of cloud acknowledgement; an outbox replay is not a local-generation increment unless it changes the local snapshot.
8. During this first slice, keep the legacy localStorage keys read-only migration inputs. Do not keep writing them as mirrors until a separately tested old/new-client compatibility protocol exists. An older app tab can otherwise overwrite imported data after a newer app has taken authority.

### Required test matrix before authority switch

- Fresh install with no legacy keys; valid aggregate only; each legacy key independently; aggregate plus partial legacy keys; empty-but-valid arrays; malformed aggregate with valid legacy values; malformed individual legacy JSON; inaccessible localStorage; unknown/extra fields; prototype-pollution keys.
- IndexedDB transaction abort after snapshot put but before journal transition; process termination/reload during import; retry after interrupted import; repeated bootstrap idempotency; read-back mismatch; unsupported schema version.
- Two tabs committing the same expected generation: exactly one succeeds and the other receives a generation conflict. Verify snapshot and generation remain paired after every abort.
- Two tabs racing bootstrap/import: exactly one migration commits; the other reads the committed generation and does not re-import stale legacy values.
- Blocked upgrade while an older tab holds a connection; old tab receives `versionchange` and closes; user-visible recovery if the old tab does not close.
- Restore barrier active before bootstrap, activated during bootstrap, and active during commit: no normal extension read/write may bypass the barrier; restore recovery itself remains possible.
- Quota exhaustion, storage unavailable, malformed IndexedDB row, database deletion/recreation, reload after commit, and browser restart.
- Cloud mutation only after local commit; cloud failure leaves a durable local state plus explicit retry/outbox behavior; replay idempotency does not duplicate the extension mutation.
- Compatibility tests for the minimum supported old client version. Until these pass, do not activate the new store as authoritative for mixed-version deployments.

### Explicit non-goals for this slice

No `OP_DB_VERSION` change, no production reader redirection, no deletion of legacy keys, no encrypted-store cutover, no automatic shadow-refresh scheduler, and no merge/deploy. First land the repository and migration primitives with isolated tests; only a later reviewed change may enable the new provider bootstrap after the complete compatibility matrix passes.


## Workspace extension importer and mutation-path audit — 2026-11-28

The read-only legacy source classifier and field selector are now implemented in `src/lib/workspaceExtensionLegacyImport.ts`. They are migration primitives only: they do not access IndexedDB, mutate localStorage, choose application defaults, or switch the provider's authority. Tests cover independent source reads, absent/valid-empty/malformed/inaccessible states, malformed aggregate fallback, prototype-sensitive top-level keys, and deterministic field precedence.

### Verified precedence contract

- A valid aggregate field wins over its mirror, including an explicitly empty array or object.
- If the aggregate field is absent or malformed, a valid independent mirror may be selected.
- If neither source is valid, the selector returns both source states as unavailable; defaults are intentionally outside this low-level selection function.
- A malformed or inaccessible aggregate does not prevent independent mirror reads.
- The classifier validates only top-level JSON shape for arrays/records. It does not claim deep schema validation of each invoice, favorite entry, product metadata item, or full extension snapshot. Deep validation remains a repository/bootstrap responsibility.

### Existing provider behavior that must not be mistaken for the new contract

A branch-pinned review of `WorkspaceExtensionsContext.tsx` and `smartIntelligence.ts` found legacy behavior that the importer must deliberately replace or preserve by explicit policy:

- `loadInitialExtensions` parses the aggregate key as a generic object and then selects individual fields; it does not call the existing full-snapshot validator.
- `favoriteMenus` accepts the aggregate only when its array is non-empty. An explicit empty aggregate array therefore falls through to the legacy mirror/default path, unlike the new deterministic selector contract.
- `recurringTemplates` and `volumeDiscountRules` also treat empty aggregate arrays as a request for defaults. Other array fields accept empty arrays.
- The legacy `loadFavoriteMenus` helper also treats an empty stored array as absent and returns `DEFAULT_FAVORITE_KEYS`. The product metadata helper accepts any parsed object (including an array at runtime); the reserved-invoice helper accepts any array without validating row contents.
- These existing defaults are application bootstrap policy, not evidence that an empty persisted value is absent. The future importer must define explicit, versioned defaulting rules and must not accidentally overwrite a valid empty user choice.

### Mutation and hydration paths observed

| Path | Current ordering and persistence | Migration requirement |
|---|---|---|
| Initial provider state | Synchronous React state initializer calls `loadInitialExtensions`; it reads localStorage and helper fallbacks | Replace with readiness-gated async bootstrap; do not expose defaults before verified repository read |
| General `updateExtensions` | Computes from `stateRef`; writes four localStorage keys with compensating rollback; updates ref/state; then queues cloud propagation | Make the API asynchronous or provide an explicit durable command result; cloud propagation must follow successful IndexedDB commit |
| Initial dye-lot seed effect | Derives rows from products and calls React `setState` directly; it does not call `persistLocalMirror` or cloud propagation | Route seed through the same serialized repository commit path or make it a strictly derived non-persistent view |
| Warehouse transfer state | `persistTransferState` writes local mirrors and React state; cloud transfer path separately commits product + transfer record in a Firestore transaction | Preserve the cross-entity cloud transaction and add a local generation commit; never treat the local mirror as durable acknowledgement |
| Firestore extension listener | Merges remote fields into current state, writes local mirrors, then updates refs/state | Treat remote hydration as a repository command with generation/CAS and restore-barrier checks; distinguish cloud `_version` from local generation |
| Encrypted outbox replay | Decrypts and validates previous/next snapshots, then calls cloud push; operation IDs/status are in operational sync persistence | Keep replay idempotency separate from local generation; decide and test when a replayed state change commits locally |

The existing `cloudWriteQueueRef` serializes Firestore writes; it does not serialize or make localStorage writes atomic. The localStorage writer is still synchronous and independent of IndexedDB. The restore barrier is checked by the main mutation and hydration paths, but the initial React state initializer itself is synchronous and not an asynchronous repository readiness boundary.

### Scope and safety decision

The latest CI run for the branch-pinned importer selector commit passed all workflow steps, including TypeScript, the complete test suite, Firestore Emulator security tests, and production build. This validates the pure classifier/selector tests; it does not validate a provider cutover or IndexedDB migration.

No production precedence behavior was changed in this audit. In particular, no database version bump, new IndexedDB store, provider reader redirection, legacy key deletion, encryption-at-rest cutover, merge, or deployment was performed. The next safe implementation unit is a separately tested IndexedDB extension repository and migration journal behind the repository abstraction, followed by an async provider bootstrap only after concurrency, restore, compatibility, and rollback gates pass.


### Warehouse transfer local-durability boundary

A focused review of `createTrackedWarehouseTransfer` and `receiveTrackedWarehouseTransfer` adds a separate transaction boundary to the cutover checklist:

- In cloud mode, product stock/cost layers and the Firestore `workspaceExtensions.warehouseTransfers` document are updated in one Firestore transaction. After that remote commit, the provider updates React state and writes the four localStorage compatibility keys separately.
- In local mode, `updateProduct` is awaited before `persistTransferState` writes the extension transfer list. These are separate local persistence operations; a failure between them can leave product inventory and the transfer register divergent.
- Receipt uses the locally observed transfer to identify the product, but the cloud transaction correctly re-reads the remote transfer and requires its status to remain `in_transit` before applying stock changes. The local path does not gain equivalent cross-record atomicity from that remote guard.
- Consequently, the Firestore transaction is a remote atomicity guarantee only. It does not make the subsequent local mirror write durable or atomic, and the local mode path is not a multi-entity IndexedDB transaction.

The extension repository integration must therefore expose a transaction that can commit the extension transfer record and the corresponding operational product update together when both are local IndexedDB entities, with restore-barrier and expected-revision checks. Cloud propagation and its `_version` remain a later, separate step. Required failure-injection tests include a crash after local product staging, after transfer-row staging, cloud success followed by local mirror failure, duplicate receipt, and concurrent receipt from two tabs. No production transfer code was changed in this audit.
