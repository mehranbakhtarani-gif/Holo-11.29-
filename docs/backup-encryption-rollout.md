# Backup encryption rollout plan

## Current verified state

- Exported backup files can be encrypted with PBKDF2-HMAC-SHA-256 and AES-256-GCM.
- New encrypted exports use 600,000 PBKDF2 iterations.
- Envelope validation rejects unsupported KDF/cipher identifiers, malformed SHA-256 digests, oversized ciphertext, invalid salt/nonce lengths, and undersized GCM payloads.
- The local IndexedDB snapshot store, the synchronous localStorage close snapshot, and Firebase cloud backup documents still contain plaintext accounting payloads. The encrypted export flow does not protect these stores.

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

## Decision required before implementation

Choose the key lifecycle:
- **Session passphrase (recommended):** operator unlocks backups after each app restart; unattended encrypted backups run only while unlocked.
- **Platform-protected device key:** enables unattended backups on a supported device, but requires platform-specific secure storage and a separate recovery plan.

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
