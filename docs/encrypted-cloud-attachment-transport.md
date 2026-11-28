# Encrypted Cloud Attachment Transport

Status: architecture decision draft; no cloud bucket, schema, or production configuration has been changed.

## Findings from the repository

- The manual complete-backup format already separates the encrypted workspace envelope from the encrypted Document Vault bundle.
- Document Vault exports authenticated AES-GCM envelopes; attachment plaintext is not required for transport.
- Supabase workspace authentication is currently a server-owned `sbw1` HttpOnly session. The server resolves the actor and uses a server-side Supabase secret/service key for PostgREST operations.
- Supabase workspace backups currently store encrypted snapshot JSON in PostgreSQL. The Express JSON body limit is 10 MiB, so large attachment bytes must not pass through the JSON API.
- The repository's Firebase app configuration contains a Storage bucket name, but `firebase.json` does not configure Storage rules and the app currently initializes Firebase Auth/Firestore only. A Firebase Storage client path would therefore need separate auth/rules work.
- No cloud attachment upload/download implementation or Storage bucket definition exists in the repository.

## Recommended first implementation: private Supabase Storage transport

Use Supabase Storage for the existing independent Supabase workspace mode first. Do not silently route Firebase-only workspaces into the Supabase account or create a second auth model in the browser.

### Object model

- Provision a private bucket named `holoo-apex-attachments`, with a strict maximum object size and no public access.
- Store one immutable, versioned encrypted Document Vault bundle per complete-backup revision. Keep the object separate from the Firestore/Postgres workspace snapshot so the existing 900 KiB Firestore and 10 MiB Express JSON limits are not bypassed accidentally.
- Server-generated object paths only: `<actor-uid>/<backup-id>/<random-object-id>.bin`. Never accept a caller-supplied bucket or arbitrary object path.
- Keep filenames, entity labels, MIME metadata, and document metadata out of object paths. The existing encrypted bundle format remains authoritative for attachment contents and metadata binding.
- Add a server-owned manifest keyed by workspace owner and backup ID, containing object key, schema version, byte length, SHA-256, attachment count, and lifecycle state (`staging` / `committed`). Do not expose Storage credentials or service keys to the browser.

### Authorization and upload flow

1. Browser must have an unlocked backup vault and build the encrypted attachment bundle. Locked vault, missing WebCrypto, or encryption failure means no upload.
2. Browser requests an upload intent from the existing server. Server validates the HttpOnly workspace session, CSRF guard, owner, size/count limits, rate limits, and restore/sync barrier.
3. Server creates a random immutable object key and a short-lived signed upload capability using its server-side Storage credential. The client cannot choose another workspace's prefix.
4. Upload ciphertext directly to the private bucket; never send binary content through Express JSON.
5. Use standard signed upload for small objects. For large or unstable-network transfers, use Supabase TUS resumable upload with 6 MiB chunks and persisted upload fingerprints. The current Supabase documentation recommends resumable uploads for files above 6 MiB and documents signed-token support for TUS.
6. Client calls a finalize endpoint. Server checks object existence and byte length, then commits the manifest and links it to the corresponding workspace backup revision. A staging object without a committed manifest is never presented as a valid backup.
7. Use a new object key for every revision; do not overwrite immutable backup objects.

### Restore flow

1. Server returns only a committed manifest belonging to the authenticated workspace.
2. Browser downloads the ciphertext from the private bucket using a short-lived signed download capability.
3. Browser verifies the manifest SHA-256 and bundle schema, then authenticates/decrypts every attachment envelope using the unlocked backup vault.
4. Compose the existing schema-2 complete-backup package and pass it through `restoreCompleteBackupPackage`. Do not introduce a second local restore implementation.
5. Local restore remains governed by the IndexedDB journal and forward-recovery barrier. Cloud download success is not equivalent to local restore success.

### Retention and cleanup

- Retain the same bounded backup-set policy as workspace snapshots, but prune a complete set only after its replacement is committed.
- Delete Storage objects through the Storage API, not direct SQL deletion from `storage.objects`.
- Add an orphan sweeper for expired staging manifests and unreferenced objects. Use strict owner-prefix matching and a grace period longer than the signed upload window.
- Never prune a backup manifest while an upload or restore lease is active.
- Treat object deletion failure as retryable cleanup; do not invalidate a newer committed backup.

### Security constraints

- Bucket must remain private. No public URLs.
- Server-side secret/service credentials must never reach browser bundles, logs, diagnostics, or API responses.
- Signed capabilities are bearer credentials; minimize lifetime and scope, and never log their token or full URL.
- Bind every intent/finalize/download/delete operation to the server-resolved actor, not a client-supplied owner ID.
- Use random object keys, immutable writes, strict size/count caps, content-type `application/octet-stream`, SHA-256 checks, and authenticated AES-GCM envelopes.
- Keep storage metadata minimal. Encrypted payloads are confidential; object sizes, timestamps, and coarse counts can still leak usage patterns.
- Do not rely on the `sbw1` custom cookie being accepted as a Supabase JWT by Storage. The server must mint signed capabilities using its server credential after validating the custom session.
- Do not use a public bucket or expose service-role/secret API keys.

## Required configuration gate

Before implementation or any hosted change, verify that the runtime `SUPABASE_URL` and server secret key point to the intended Holoo workspace project, and confirm the Storage service is enabled. The repository does not contain the deployed secret values, so the Supabase project currently connected in ChatGPT must not be assumed to be the same project used by the app server.

The Firebase bucket name in `firebase-applet-config.json` is not proof that Firebase Storage is configured or authorized. A Firebase implementation would require a separate `storage.rules` policy, Firebase Storage initialization, emulator coverage, and explicit support for Firebase-authenticated users.

## Test and rollout gates

- Unit tests for owner/path derivation, signed capability response validation, manifest lifecycle transitions, digest mismatch, size/count limits, and cross-workspace denial.
- Storage API integration tests with a private test bucket: create intent, upload, finalize, list, download, tamper, delete, expired intent, duplicate finalize, and orphan cleanup.
- TUS interruption/resume tests above 6 MiB, including expired upload URLs and duplicate/concurrent upload attempts.
- Verify no attachment plaintext or signed token appears in HTTP logs, browser storage, diagnostics, or cloud metadata.
- Restore tests prove that cloud download feeds the existing local restore journal and that failed downloads leave both local databases unchanged.
- CI must pass before any hosted bucket/schema provisioning. No production bucket, migration, merge, or deployment is authorized by this design document.
