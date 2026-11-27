# Backup encryption rollout plan

## Current verified state

- Exported backup files can be encrypted with PBKDF2-HMAC-SHA-256 and AES-256-GCM.
- New encrypted exports use 600,000 PBKDF2 iterations.
- Envelope validation rejects unsupported KDF/cipher identifiers, malformed SHA-256 digests, oversized ciphertext, invalid salt/nonce lengths, and undersized GCM payloads.
- Operational IndexedDB entity stores and sync outbox/inbox records remain plaintext. The separate local backup snapshot store, Firebase cloud backup documents, and Supabase workspace snapshot writes use encrypted envelopes for new writes. The synchronous localStorage close snapshot is disabled for new plaintext payloads; legacy entries remain migration-only.

## Security design constraints

1. A key stored beside ciphertext in localStorage or the same IndexedDB database does not provide meaningful at-rest confidentiality against same-origin script access or an extracted browser profile.
2. WebCrypto encryption is asynchronous. The current `beforeunload` / `pagehide` synchronous close-snapshot path cannot safely perform PBKDF2 or AES-GCM during unload.
3. Automatic local and cloud backups currently run without asking the user for a backup passphrase. Requiring encryption therefore needs an explicit key lifecycle and recovery UX.
4. Existing plaintext snapshots need a deliberate migration path. They must not be silently discarded or treated as encrypted.
5. Firestore documents have a 1 MiB document limit. Ciphertext envelope size and metadata must be checked before upload; large backups need chunking or object storage.

## Proposed rollout

### A. Key lifecycle
- Ask the operator to create a dedicated backup passphrase (not the account login password).
- Derive a non-extractable AES-256-GCM key with PBKDF2-SHA-256 (600,000 iterations, random 16-byte salt).
- Keep the key only in memory for the active unlocked session; never persist the passphrase or raw key beside the backup.
- Require the passphrase again after reload/restart. If unattended background backups are required, obtain explicit approval for a different threat model (for example, platform-protected device key storage).

### B. Local persistence
- Replace plaintext payload writes in IndexedDB with versioned encrypted envelopes.
- Keep only non-sensitive metadata outside the envelope.
- Introduce a versioned record discriminator so old plaintext records can be detected and migrated only after successful unlock.
- Replace synchronous plaintext close writes with periodic asynchronous encrypted checkpoints. On close, retain only the last completed encrypted checkpoint; do not fall back to plaintext.

### C. Firebase cloud persistence
- Encrypt the complete snapshot before writing Firestore; store ciphertext, salt, nonce, KDF/cipher metadata, and non-sensitive indexing metadata only.
- Decrypt and authenticate after download, then validate the decoded backup schema before restore.
- Enforce the Firestore size ceiling before upload; use chunked storage for larger payloads.
- Keep old plaintext cloud backups readable only through an explicit migration/export flow, then delete them only after the operator confirms successful encrypted replacement.

### D. Integrity and recovery
- AES-GCM authentication is the primary ciphertext integrity mechanism. Retain SHA-256 as a post-decryption consistency digest, not as a substitute for authentication.
- Validate decrypted JSON structure and accounting invariants before applying any restore.
- Restore into a staging workspace first; promote it atomically only after all validation passes.
- Wrong passphrase, unsupported format, truncated ciphertext, and failed restore must leave current operational data untouched.

## Release gates

- No new local or cloud backup write may persist plaintext after encrypted mode is enabled.
- Legacy plaintext migration has explicit operator consent and a verified encrypted copy before deletion.
- Tests cover restart/unlock, wrong passphrase, tampering, interrupted writes, large payload limits, offline close/reopen, cloud upload/download, and failed restore atomicity.
- Do not enable encrypted-only mode or delete legacy data until all three deployed devices support the same envelope version and key workflow.

## Key lifecycle decision

The current implementation uses the **session passphrase** model: the operator unlocks backups after each app restart, and encrypted backup operations are available only while the in-memory session vault is unlocked. A platform-protected device key is not implemented.

Do not store a passphrase or encryption key in localStorage, ordinary IndexedDB, Firestore, or source code.

## Implementation progress (2026-11-27)

- Local backup snapshots written through `saveLocalSnapshot` are now persisted as AES-256-GCM envelopes. The passphrase is required from the in-memory backup session vault; it is not persisted.
- Legacy plaintext close snapshots are no longer promoted into IndexedDB. They remain read-only restore/migration inputs.
- The synchronous page-unload path no longer writes plaintext. It intentionally leaves the last completed encrypted checkpoint untouched.
- Firebase cloud backup writes now store an encrypted envelope string, and Firestore rules reject new plaintext snapshot-map documents.
- Supabase workspace sync now encrypts snapshots in the client before transmission. The server validates the encrypted envelope wrapper and only adds synchronization metadata outside the ciphertext. Client restore and conflict paths decrypt before importing or comparing.
- Cloud backup and restore entry points are gated on the session vault being unlocked.

## Remaining security gates

- Operational IndexedDB entity stores (accounts, vouchers, invoices, products, parties, cheques, audit logs, and sync records) are still plaintext. Encrypting these stores requires a coordinated schema migration and changes to every atomic transaction/read path; it is not safe to claim at-rest protection for the operational database yet.
- Legacy plaintext Firebase/Supabase/local backups remain readable for migration/restore compatibility. New writes are encrypted; legacy data must not be treated as encrypted.
- Supabase rows created by older releases remain plaintext until explicitly migrated or replaced by new encrypted snapshots.
- Firestore documents are capped conservatively at 900 KiB for encrypted envelopes. Supabase payloads currently retain the existing API size ceiling; large encrypted backups still need a chunked/object-storage design.
- The app must be tested with the same passphrase across devices. Losing the passphrase means encrypted backups cannot be recovered.
- Automated verification must pass after the latest changes before this rollout can be considered validated.


### Operational database cutover gate

A separate technical gate plan now documents the store inventory, encrypted repository contract, atomic transaction requirements, revision fencing, restore/rollback design, cross-tab coordination, and mandatory release checklist: [operational-db-cutover-plan.md](./operational-db-cutover-plan.md). This is a design and audit artifact only; it does not authorize or enable cutover.

### Newly identified extension data outside the encrypted shadow (2026-11-28)

The application data inventory extends beyond the IndexedDB operational stores. `WorkspaceExtensionsContext` persists business-critical state under the localStorage key `holoo_apex96_workspace_extensions_v2`, including reserved invoices, product metadata, petty cash, recurring voucher templates, bank loans, dye lots, warehouse slips, BOM formulas, installment plans, volume-discount rules, Moadian invoice links, and fiscal archives. Selected extension state is also patched to the Firestore `workspaceExtensions` document.

This state is not included by `loadOperationalWorkspace()` or the current `secureWorkspace` encrypted shadow. Consequently, the shadow is not a complete application/workspace backup and is not eligible for cutover.

Required work before cutover:
- Define a typed, versioned extension snapshot contract covering every `WorkspaceExtensionsState` field and separate smart-intelligence persistence helpers.
- Include extension state in the encrypted staging payload and bind its revision to the same migration generation as accounting data.
- Surface localStorage quota/write failures for business-critical extension state instead of silently swallowing them.
- Define explicit cloud/local restore and conflict semantics for `workspaceExtensions`; do not use blind last-write-wins.
- Add round-trip, malformed/missing-field, stale-revision, interrupted-write, and restore-atomicity tests.
- Retain legacy localStorage values until an authenticated encrypted replacement has been verified.

### Encrypted operational shadow mirror (2026-11-27)

- When the session backup vault is unlocked, the application now schedules a debounced encrypted shadow snapshot after operational workspace changes.
- The shadow copy is written to the dedicated `secureWorkspace` IndexedDB store only after encryption/decryption round-trip and SHA-256 verification.
- The final IndexedDB write checks the source workspace revision in the same transaction as the encrypted record write. If the operational workspace changed while encryption was running, the stale encrypted copy is rejected.
- This is a non-destructive dual-write preparation stage. The existing entity stores remain authoritative and plaintext; the encrypted shadow is not yet used as the active read source. No legacy entity records are deleted or rewritten by this process.
