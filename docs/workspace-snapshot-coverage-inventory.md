# Workspace Snapshot Coverage Inventory

Status: audit baseline; no storage cutover is authorized by this document.

## Purpose and exit boundary

The encrypted operational shadow is not a complete workspace backup until it covers both the IndexedDB operational workspace and the business extension state listed below. This inventory freezes the required data boundary for Phase 4. Newly discovered fields must be added here or explicitly classified as transient/out of scope with a reason; they must not silently expand the release gate.

## IndexedDB operational workspace

The existing `loadOperationalWorkspace()` / `secureWorkspace` shadow includes the core collections and auxiliary collections documented in `operational-db-cutover-plan.md`: profile, accounts, parties, products, vouchers, invoices, cheques, employees, assets, cost centers, currencies, exchange rates, import dossiers, sales orders, subcontract jobs, RBAC operators, audit logs, warehouses, tax reports, local profiles, sync outbox, and sync inbox.

This shadow remains non-authoritative. Existing operational stores are still plaintext and remain the active read/write source.

## Workspace extension state — required in the complete snapshot

Source: `src/context/WorkspaceExtensionsContext.tsx`, `src/lib/apexExtensions.ts`, and `src/lib/smartIntelligence.ts`.

The typed `WorkspaceExtensionsState` contract currently contains:

- `reservedInvoices`
- `productMetaMap`
- `favoriteMenus`
- `pettyCashCeilingIrr`
- `pettyCashItems`
- `recurringTemplates`
- `bankLoans`
- `dyeLots`
- `warehouseSlips`
- `bomFormulas`
- `installmentPlans`
- `volumeDiscountRules`
- `moadianLinks`
- `fiscalArchives`

Separate smart-intelligence persistence helpers also store dashboard view mode, favorite menus, product metadata, and reserved invoices. Their legacy keys and migration precedence must be explicitly represented so duplicate copies do not overwrite newer state:

- `holoo_apex96_dashboard_mode`
- `holoo_apex96_favorite_menus`
- `holoo_apex96_product_meta_v1`
- `holoo_apex96_reserved_invoices_v1`

The aggregate extension localStorage key is `holoo_apex96_workspace_extensions_v2`.

## Cloud extension state and concurrency

The Firestore document path is `workspaceExtensions/{uid}`. It currently stores bounded extension fields and an `_version` counter, with `updatedByDevice` and timestamps. A live snapshot listener merges incoming fields with local state. The current implementation is not a conflict-safe migration protocol: a future encrypted design must use explicit revision/generation checks and must not rely on blind last-write-wins.

Device presence under `devicePresence` is transient coordination data (heartbeat and editing-lock hints), not business backup content. It should be classified separately and must not be restored as durable workspace records.

## Known correctness/security gaps to close

1. `persistLocalMirror` catches and suppresses localStorage write/quota errors. Business-critical extension updates can therefore appear successful without durable local persistence.
2. The extension state is not part of the current encrypted `secureWorkspace` payload.
3. Several values have duplicate legacy persistence paths. Migration must define precedence and verify equality before removing or retiring any legacy key.
4. Firestore extension sync uses a monotonically incremented client-side `_version`; it is not an atomic cross-device compare-and-swap.
5. The cloud listener merges partial data with prior local state. Restore must distinguish intentionally absent optional fields from missing/corrupt fields.
6. Presence/heartbeat data must remain separate from durable extension snapshots.

## Bounded implementation sequence

1. Define a versioned, typed `WorkspaceSnapshotVNext` envelope with `operational` and `extensions` sections, workspace identity, schema version, source revision/generation, and integrity digest.
2. Add strict parsers and migration adapters for the aggregate extension key and four legacy smart-intelligence keys. Validate every field; reject malformed business-critical data rather than silently defaulting it.
3. Make extension persistence report failures to the caller. Do not claim an update succeeded if the durable local write failed. Keep compatibility behavior explicit for offline mode.
4. Include extension state in encrypted staging with a consistent generation fence. Any change during encryption must invalidate the prepared snapshot.
5. Specify cloud restore/conflict behavior for `workspaceExtensions`; require authenticated ownership, monotonic revisions, and explicit conflict handling.
6. Add tests for round-trip of every field, legacy-key precedence, malformed values, quota/write failure, stale generation, interrupted migration, cloud conflict, and restore rollback.
7. Only after all checks pass, plan a separate reviewed cutover. Keep legacy keys and operational stores until the encrypted replacement is decrypted, validated, and recoverable.

## Phase 4 exit criteria

Phase 4 is complete only when all of the following are true:

- Every durable business field in the operational and extension inventories is represented in the versioned encrypted snapshot.
- All writers and readers use the agreed repository boundary, including atomic financial transactions.
- No new plaintext business snapshot is written to localStorage, IndexedDB, or cloud storage.
- Legacy data has a tested, non-destructive migration and rollback path.
- Encrypted restore is tested on a clean browser profile and a second device.
- Stale revisions, interrupted writes, corrupt envelopes, wrong passphrases, and storage quota failures fail safely.
- CI (lint, all tests, Firestore emulator tests, production build) passes on the exact release commit.
- The release remains unmerged and undeployed until separately authorized.

## Explicitly not required for this phase

Transient device-presence heartbeats, UI-only in-memory state, and cache/service-worker assets are not durable business workspace records. They must be documented and handled by their own lifecycle, but do not expand the encrypted business snapshot boundary.

## Additional durable localStorage datasets found in the repository audit

The following stores are separate from `WorkspaceExtensionsState` and must be included in the versioned snapshot contract because they contain durable operational decisions or business configuration:

| Dataset | Storage key | Classification | Snapshot treatment |
|---|---|---|---|
| Custom voucher templates | `holoo_apex_voucher_templates_v1` | Accounting workflow configuration | Include custom templates; built-in system templates remain code-defined |
| Voucher template usage map | `holoo_apex_voucher_template_usage_v1` | Usage telemetry / convenience | Optional; may be regenerated, but preserve if practical |
| Bank reconciliation sessions and decisions | `holoo_apex_bank_recon_sessions_v1` | Financial operational work product | Include; validate account/date/session references |
| Tracked warehouse transfers | `holoo_apex_warehouse_transfers_v1` | Inventory movement records, including in-transit state and transferred FIFO layers | Include as business records; reconcile against product and warehouse state |
| Invoice print settings | `holoo_apex_invoice_settings_v1` | Company document configuration, may contain logo and bank/contact details | Include in encrypted snapshot; validate fields and cap embedded asset size |

These are not transient UI caches. In particular, bank reconciliation decisions and tracked warehouse transfers must not be lost when restoring the accounting database. They currently persist independently in localStorage and are not part of the IndexedDB operational shadow.

### Explicit exclusion class

Pure presentation preferences (theme, audio feedback, dashboard layout, recent action search, and notification display preferences) are not part of the financial data integrity snapshot. They may be restored separately as user/device preferences and must never be treated as authoritative business records. Credentials, PIN material, device identity, and live device-presence heartbeats must not be copied into workspace backups; they require separate security lifecycle handling.

## Additional sync and attachment stores found in follow-up audit

### Supabase offline queue and sync metadata

`src/lib/dualCloudSync.ts` defines the following localStorage keys:

- `holoo_apex_offline_outbox_v1`: bounded queue of sync summary records (id, queuedAt, summary, and entity counts). It is not the durable operation payload outbox; that lives in the operational IndexedDB syncOutbox store. Preserve this queue only as retry/diagnostic metadata or replace it with a derived view during migration.
- `holoo_apex_conflict_policy_v1`: user-selected conflict policy. Preserve as configuration, but do not treat it as a data-authority rule.
- `holoo_apex_supabase_revision_v1`, `holoo_apex_supabase_last_sync_v1`: sync cursors/diagnostics. Migrate as non-authoritative metadata and revalidate against the server.
- `holoo_apex_supabase_workspace_id_v1`: workspace locator, not authentication proof.
- `holoo_apex_supabase_auto_backup_v1`: preference only.

### Separate document and attachment vault

`src/lib/documentVault.ts` opens an independent IndexedDB database `holoo_apex_document_vault_v1`, store `attachments`. Each record includes business metadata and a Base64 `dataUrl` for PDFs/images attached to invoices, vouchers, cheques, contracts, and operations.

This is a separate durable business dataset and is currently outside the operational encrypted shadow. The content is stored as plaintext Base64 in IndexedDB; SHA-256 verifies integrity but does not provide confidentiality. The future snapshot contract must include attachment metadata and binary content (or separately encrypted attachment envelopes) and preserve entity references and sensitivity labels.

Critical reliability finding: save/delete operations in this vault catch IndexedDB failures and fall back to an in-memory Map, while save may still return success. This can acknowledge a document write that is not durable and can lose it on reload. Before release, persistent-storage failure must be surfaced; in-memory fallback must be explicitly test-only or return a non-durable status that cannot be mistaken for success.

### Credential and device secrets — explicitly excluded

Do not include authentication secrets in workspace snapshots. The repository also has device/PIN-related local state, including mesh passphrase and RBAC PIN hash keys. These require a separate security audit and migration to an appropriate secret lifecycle; they must not be copied into backups or cloud snapshots as ordinary business data.

## Document attachment encryption implementation status

The Document Vault now encrypts newly saved attachment content before IndexedDB persistence using the existing backup envelope contract (PBKDF2-SHA256 + AES-256-GCM, per-envelope random salt and IV). The backup-session passphrase is required for new writes and reads. Listing returns metadata only and strips the ciphertext envelope from the UI result.

Legacy plaintext attachment records remain readable only after the backup vault is unlocked. On authorized retrieval, the SHA-256 digest is checked before encrypting and replacing the legacy record; a failed migration is surfaced and does not report success. Browser IndexedDB read/write/delete failures fail closed; the in-memory map is restricted to non-browser test runtimes.

Remaining controls before phase-4 exit:
- Add browser IndexedDB integration tests for encrypted-at-rest bytes, legacy migration, wrong-passphrase/tamper rejection, and failed atomic replacement.
- Extend the complete-backup package to cloud sync and the encrypted operational shadow; those flows still do not include Document Vault attachments. The Settings manual restore now uses the forward-recovery journal protocol in `docs/complete-backup-restore-protocol.md`, but this is not a cross-database atomic transaction.
- Evaluate whether attachment metadata (file names, entity labels, notes, uploader identity) needs field-level encryption; these fields remain queryable in plaintext to support listing and RBAC.
- Document shared passphrase/key recovery requirements across devices. A device that lacks the passphrase cannot decrypt attachment content.

The Document Vault now exposes a validated encrypted attachment bundle export/restore API. Export refuses to include any legacy plaintext row and authenticates every encrypted payload before returning the bundle. Restore validates the entire bundle (metadata allowlists, size limits, envelope authentication, MIME agreement, and SHA-256) before writing; IndexedDB restore uses one read-write transaction. The bundle format is `holoo-apex-encrypted-document-vault` schema 1.

This is a secure attachment-level backup primitive. The Settings manual complete-backup package now explicitly composes it with `exportBackupJson` and encrypts that workspace payload as schema 2; other callers of `exportBackupJson` and cloud-sync payloads remain separate, so those flows must not claim that they include Document Vault files.

## Complete backup package integration status

Settings now exports a versioned `holoo-apex-complete-backup` schema 2 package containing an AES-256-GCM/PBKDF2 encrypted accounting workspace envelope plus the separately authenticated encrypted Document Vault bundle. Schema 1 packages are accepted only after an explicit warning because their accounting workspace payload is plaintext. Export requires an unlocked backup session and refuses to proceed if any attachment remains legacy plaintext. Restore accepts the complete package only with the matching backup passphrase, prevalidates the workspace shape, and delegates attachment validation and write to the Document Vault's one-transaction restore API before importing workspace state. Legacy workspace-only JSON files remain importable, with an explicit warning that they do not contain attachments. The complete package reader is capped at 100 MiB. Attachment metadata remains plaintext for listing and search; workspace business records and attachment file bytes are encrypted.

Important atomicity boundary: the Document Vault and operational workspace are separate IndexedDB databases and cannot participate in one browser transaction. Schema-2 Settings restore now uses the durable `restoreJournal`, non-live attachment staging, idempotent per-database apply transactions, and a fail-closed recovery barrier. This is forward recovery, not a distributed atomic transaction. Cloud sync and the encrypted operational shadow still do not include Document Vault attachments. Phase 4 remains open pending real-browser failure-injection tests, broader recovery verification, and cloud/shadow integration.

The manual complete-backup exporter also enforces the current workspace importer limit (8,000,000 bytes for the accounting JSON) and the complete package reader limit (100 MiB), preventing generation of a package that this version cannot accept through its own restore path.

### Document Vault restore replacement semantics

The encrypted attachment bundle restore is now a full-vault replacement, not an additive merge. After every row in the incoming bundle has passed envelope authentication, metadata allowlists, MIME agreement, size checks, and SHA-256 verification, the implementation clears and repopulates the attachments object store in one IndexedDB read-write transaction. The non-browser test adapter mirrors replacement semantics. A regression test creates an attachment after taking a backup and verifies that restoring the earlier backup removes that later attachment while restoring the original one. This guarantees atomic replacement within the Document Vault database only; it does not solve cross-database atomicity with the accounting workspace.

The complete-backup package was hardened after review: schema 2 encrypts the accounting workspace JSON with the existing PBKDF2-SHA256 + AES-256-GCM envelope before packaging it with the already encrypted attachment bundle. Restore authenticates/decrypts this workspace envelope before any attachment write. Schema 1 packages are retained only as a compatibility path with a specific plaintext-warning confirmation. The workspace payload limit remains 8,000,000 bytes, which is below the current encrypted-envelope decoder limit.

The schema-2 manual complete-backup export now also reads the operational IndexedDB snapshot and includes `warehouses`, `taxReports`, `localProfiles`, `syncOutbox`, `syncInbox`, and `localRevision`; the base accounting export already includes bank-reconciliation decisions, which are now validated and restored as part of the journaled workspace apply. These additions do not yet cover the separate WorkspaceExtensions aggregate localStorage dataset or all smart-intelligence duplicate keys; that remains a known coverage gap.
