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
