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
