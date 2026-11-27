# Recoverable Complete Backup Restore Protocol

Status: design specification; implementation is not yet complete.

## Current behavior and boundary

The Settings manual export produces `holoo-apex-complete-backup` schema 2. The accounting workspace is encrypted with the existing PBKDF2-SHA256 + AES-256-GCM envelope. Document Vault file contents are independently encrypted and authenticated. Attachment metadata remains plaintext for listing/search. Restore verifies/decrypts the workspace envelope and validates the attachment bundle before replacing the Document Vault contents in one transaction.

The accounting workspace and Document Vault use separate IndexedDB databases. A browser cannot include both databases in one IndexedDB transaction. The current Settings restore therefore asks for confirmation and can still leave a partial restore if the second database operation fails. It must not be described as atomic. This design specifies forward recovery before that warning can be removed.

## Required invariants

1. No live record in either database changes until the entire incoming package has passed structural, cryptographic, business-schema, MIME, size, metadata, and digest validation.
2. Both databases must durably stage their incoming data before a commit intent is written.
3. Once commit intent exists, normal workspace hydration, editing, attachment access, and cloud sync must be blocked until recovery reaches a terminal state.
4. Applying either staged dataset must be idempotent. Repeating it after a crash must produce the same live state.
5. The restore is reported successful only after both databases confirm application and the authoritative journal is marked committed.
6. If recovery cannot proceed, keep the journal and staged data. Never silently fall back to the old workspace, demo data, or a partially restored workspace.
7. A restore from a backup is a full replacement: attachments absent from the backup must not survive.

## Storage changes

### Operational database

Upgrade operational DB schema to v5 and add infrastructure store `restoreJournal`, keyed by `restoreId`. It is excluded from workspace exports, record counts, and ordinary generic queries.

A journal record contains:
- `restoreId`, package format/schema version, workspaceId, createdAt
- `state`: `staging` | `commit_requested` | `workspace_applied` | `committed` | `failed_recovery_required`
- encrypted workspace envelope, plaintext digest, record count and schema version
- attachment manifest digest and attachment count
- package digest and last recovery error (sanitized)

The same operational database transaction that replaces live workspace stores must advance the journal to `workspace_applied`. Do not call the existing React-state importer as the durable commit mechanism; write the validated workspace into operational stores in a single read-write transaction, including profile/meta and a monotonic localRevision.

### Document Vault database

Upgrade Document Vault schema to v2 and add:
- `restoreManifests`, keyed by `restoreId`
- `restoreStaging`, keyed by [`restoreId`, `attachmentId`] with an index on `restoreId`

Staged attachment rows contain only validated metadata and encrypted envelopes. A manifest records package digest, row count, and state. The transaction replacing the live `attachments` store must also mark that restore's vault manifest as applied in the same Vault database transaction.

## Protocol

### Phase A — prepare and validate (read-only)

1. Read the complete package with strict size caps.
2. For schema 2, authenticate/decrypt the workspace envelope with the currently unlocked backup session. For legacy schema 1, require an explicit plaintext-legacy warning and immediately re-encrypt the workspace for staging.
3. Validate workspace structure and all domain constraints that can be checked without mutating state.
4. Authenticate every attachment envelope; validate metadata allowlists, MIME agreement, size limits, and SHA-256.
5. Compute stable package and manifest digests. Generate a cryptographically random restoreId.
6. No writes to live stores are allowed in this phase.

### Phase B — stage (non-live writes only)

1. Write the encrypted workspace snapshot and journal state `staging` into the operational DB.
2. Write all encrypted attachment rows and a manifest into Document Vault staging stores.
3. Read back both staging manifests and verify restoreId, digest, count, schema and state.
4. If either staging write/readback fails, delete only the staging records for this restoreId. Live stores remain untouched.
5. Only after both stage manifests are verified, change the operational journal to `commit_requested`. This is the commit point. No commit intent may be written before both stages are durable.

### Phase C — forward commit and recovery

1. Before normal application hydration, check for a nonterminal journal. If found, enter restore-recovery mode and block normal reads/writes/sync.
2. Apply the staged workspace to all operational entity stores in one IndexedDB read-write transaction. Replace collections (do not merge), write profile and workspace metadata, and update the journal to `workspace_applied` in that same transaction.
3. Apply staged attachments by clearing and repopulating the live Document Vault attachments store in one read-write transaction. Mark the vault manifest applied in that same transaction.
4. Verify both live datasets against staged digests/counts.
5. Mark the operational journal `committed`. Only then update React context and release the application recovery barrier.
6. Cleanup staging records asynchronously after commit. Cleanup failure must not invalidate a committed restore; retry cleanup on next boot.

If the browser crashes between steps 2 and 3, boot sees `workspace_applied` and repeats the attachment apply. If it crashes after step 3 but before step 5, boot re-verifies/re-applies both datasets and then marks committed. Both apply operations are idempotent.

## Failure handling

- Before `commit_requested`: abort and remove staging rows; old live data remains unchanged.
- After `commit_requested`: never discard the journal or silently revert to normal app startup. Retry forward recovery. If an IndexedDB error, quota failure, blocked database, or digest mismatch persists, show a dedicated recovery-required screen with retry and safe diagnostic export. Keep the app locked.
- Do not implement an automatic rollback that updates only one database. A rollback protocol would itself need two staged old-state snapshots and the same forward-recovery journal.
- Ensure destructive workspace reset and database wipe explicitly detect and resolve pending restore journals; they must not delete the authoritative journal while live stores are mixed.
- Coordinate tabs with a durable journal lease plus BroadcastChannel notification. A tab that did not initiate restore must still observe the recovery barrier before it can hydrate or write.
- Cloud sync and P2P sync remain paused until restore is committed and the new workspace revision is published.

## Test matrix required before enabling the protocol

Use real browser IndexedDB integration tests (prefer the browser test runner already supported by the project; otherwise add a maintained IndexedDB test adapter and pin it in the lockfile).

- Crash/failure before either staging write, between the two staging writes, and after both stages but before commit intent.
- Crash after commit intent, after workspace apply, after attachment apply, and before final journal commit.
- Re-running each recovery step is idempotent.
- Wrong passphrase, malformed envelope, ciphertext tampering, MIME mismatch, digest mismatch, duplicate attachment IDs and invalid workspace structure leave both live stores byte-for-byte unchanged.
- Injected quota/write/abort errors never clear the journal or expose partial workspace data.
- Empty attachment bundle clears the live attachment store only after commit intent.
- Concurrent tabs cannot read/write during recovery.
- Legacy schema 1 package migration stages an encrypted workspace envelope and never writes plaintext into staging.
- Successful restore replaces both datasets exactly and only then reports success.

## Exit criteria

The current confirmation-based restore remains in place until the v5/v2 staging stores, boot-time recovery barrier, idempotent apply transactions, real IndexedDB failure-injection tests, and cloud/P2P pause behavior are implemented and CI passes. Merge and deployment remain separate, explicitly authorized actions.
