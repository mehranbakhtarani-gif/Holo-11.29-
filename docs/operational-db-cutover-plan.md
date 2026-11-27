# Encrypted operational database cutover plan

## Status

**Preparation only — cutover is not enabled.** The `secureWorkspace` store contains an encrypted, revision-checked shadow snapshot. Existing entity stores remain authoritative and continue to contain operational plaintext. This document defines the gates required before changing that authority.

## Current storage boundary

| Store | Current role | Cutover treatment |
| --- | --- | --- |
| `accounts`, `parties`, `products`, `vouchers`, `invoices`, `cheques`, `employees`, `assets`, `costCenters`, `currencies`, `exchangeRates`, `importDossiers`, `salesOrders`, `subcontractJobs`, `rbacOperators`, `auditLogs` | Primary operational entity stores | Must move together; no mixed plaintext/encrypted authority |
| `warehouses`, `taxReports`, `localProfiles` | Auxiliary workspace data | Must be included in the same logical workspace revision and recovery boundary |
| `syncOutbox`, `syncInbox` | Durable delivery and deduplication state | Must be transactionally preserved with workspace changes; never replay partially restored operations |
| `meta` | Profile and workspace revision metadata | Revision is the commit fence; migration state and active format pointer must be atomic with promotion |
| `preUpdateBackups` | Separate pre-update recovery records | Retain their own encrypted-envelope lifecycle; do not recursively include them in the workspace snapshot |
| `secureWorkspace` | Encrypted shadow snapshot | Staging only until cutover gates pass |

## Verified preparation behavior

- Snapshot reads include all core entity collections and the auxiliary stores listed above.
- Snapshot JSON is structurally validated before encryption and after decryption.
- The encrypted envelope is round-trip checked; the plaintext SHA-256 is checked after authenticated decryption.
- Record count and source revision are checked before a staged snapshot is accepted.
- The final `secureWorkspace` write compares the current `meta.workspace_meta.localRevision` with the revision used to prepare the ciphertext in the same IndexedDB transaction.
- Snapshot schema version is 2. Older schema metadata is rejected by the metadata validator.
- The shadow write is non-destructive. It does not change readers or delete plaintext records.

## Blocking architecture issue

The current `saveOperationalWorkspaceTx` writes core entity stores and increments `meta.workspace_meta.localRevision` in one IndexedDB transaction, while auxiliary and sync stores have their own write paths. The atomic financial operations also write directly to named stores, including:

- `commitInvoiceOperationalTx`
- `commitChequeStatusOperationalTx`
- `commitDepreciationOperationalTx`
- `commitStockAdjustmentOperationalTx`
- `commitSalesOrderDispatchOperationalTx`

A whole-workspace encrypted blob cannot simply replace these stores: doing so would break indexed entity access, atomic multi-entity commits, outbox/inbox delivery, and optimistic revision checks. A cutover that only changes `loadOperationalWorkspace` would create split-brain reads and writes.

## Required target architecture

1. **Encrypted record format:** define a versioned per-record envelope (or bounded encrypted partitions) with stable logical keys, schema version, entity kind, record revision, and authenticated context. Bind workspace ID, store name, record ID, and format version as AES-GCM additional authenticated data so ciphertext cannot be transplanted between records or tenants.
2. **Key lifecycle:** derive or unwrap a session-only, non-extractable CryptoKey after operator unlock. Do not persist the passphrase or raw key. Cross-device restore must continue to use the operator's passphrase and per-record random salt/nonce policy.
3. **Repository boundary:** centralize reads, writes, queries, and deletes behind one encrypted repository. Components and accounting contexts must not access plaintext entity stores directly after cutover.
4. **Atomic financial transactions:** implement encrypted versions of every multi-store transaction. Validate/decrypt before transaction creation where possible; keep all IndexedDB requests inside one active readwrite transaction; abort all writes on any encryption, validation, quota, or request error. Do not perform asynchronous WebCrypto work after opening an IndexedDB transaction because the transaction may auto-close.
5. **Revision protocol:** use compare-and-swap on workspace/entity revisions inside the same transaction as encrypted record updates, audit metadata, and outbox enqueue. Sync inbox deduplication and outbox status changes must remain durable and atomic with their related entity commit.
6. **Indexes:** decide which fields may remain as non-sensitive blind/index metadata. Do not leak names, balances, invoice descriptions, or other sensitive values in ordinary IndexedDB indexes. If exact query indexes require plaintext, document the exposure and obtain an explicit security decision.
7. **Recovery:** restore into a separate staging namespace; decrypt and validate every record, verify counts and references, replay no outbox item automatically until operator confirmation, then atomically switch an active-format pointer. Failed restore must leave the current active workspace untouched.
8. **Rollback:** retain a verified encrypted pre-cutover checkpoint and a reversible format pointer. Rollback must be tested on process termination, quota errors, wrong passphrase, malformed records, and interrupted multi-store writes.
9. **Cross-tab/device coordination:** use a migration lease/fencing token and block writes from older tabs/releases during promotion. A stale tab must fail closed rather than write plaintext over encrypted state.
10. **Performance and size:** measure PBKDF2/AES-GCM latency and storage use on representative Android devices and large ledgers. The whole-workspace shadow snapshot is not a substitute for indexed encrypted records; Firestore document limits do not define IndexedDB limits.

## Mandatory cutover gates

- [ ] Inventory every IndexedDB read/write/query/delete callsite and prove all operational access is behind the repository boundary.
- [ ] Every atomic accounting function has an encrypted implementation and rollback tests.
- [ ] Auxiliary stores, sync outbox/inbox, audit logs, and revision metadata participate in the documented consistency model.
- [ ] AAD prevents cross-workspace, cross-store, and cross-record ciphertext substitution.
- [ ] Wrong key, tampering, quota exhaustion, transaction abort, app termination, and stale-tab tests all pass.
- [ ] Migration is idempotent and can resume after interruption without duplicating vouchers, invoices, cheques, or sync operations.
- [ ] Restore and rollback have been exercised against a production-sized synthetic workspace on Android.
- [ ] All supported devices are upgraded to the same encrypted storage protocol before the active pointer is switched.
- [ ] Security review confirms the remaining plaintext metadata and query-index exposure.
- [ ] CI, Firestore Emulator tests, and production build pass on the exact cutover commit.

## Rollout sequence

1. Complete the access inventory and define the encrypted record/AAD contract.
2. Implement and test the encrypted repository in parallel with legacy storage; keep legacy authoritative.
3. Port and test atomic financial transactions one operation family at a time.
4. Add staging restore, integrity verification, migration lease, and rollback.
5. Run dual-read comparison and shadow writes on test workspaces; stop on any mismatch.
6. Perform an explicitly operator-triggered migration on a copy, not the live workspace.
7. After all gates pass and all devices are upgraded, promote the encrypted format pointer atomically.
8. Keep rollback material until a defined retention period and independent restore verification complete.

**Release rule:** no automatic cutover, no deletion of legacy stores, no plaintext fallback, and no claim of encrypted-at-rest operational data until every mandatory gate is checked and CI passes.
