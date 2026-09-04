# B1 Device Registry And Enrollment Gate Report

## Scope

- Phase: B1 - protocol, identity and provisioning
- Evidence date: 2026-07-19
- Increment: Raspberry/shared offline registry and one-time enrollment
- Decision: LOCAL INCREMENT CONDITIONALLY PASS; COMPLETE B1 GATE PENDING

This increment does not deploy code, enable Bluetooth, start a Raspberry
runtime or carry POS/business data.

## Implemented controls

- Versioned JSON registry with schema contract.
- Exact registry mode `0600`; non-regular files and symlinks rejected.
- Exclusive cross-process lock for every mutation. Cleanup compares the open
  handle and pathname `dev`/`ino`; a replaced foreign lock is preserved.
- Durable atomic commit through a mode-`0600` temporary file, file `fsync`,
  rename and directory `fsync`.
- 256-bit random enrollment token with technical endpoint and expiry.
- Only the domain-separated SHA-256 token hash is persisted.
- Token consumption and device insertion are one locked commit.
- Replay and expiry are rejected with explicit error codes.
- Device-supplied RFC 4122 NodeId, generated certificate record UUID and
  32-byte aliasKey encoded as 43-character unpadded base64url. Enrollment
  rejects a missing NodeId instead of creating an identity independent from
  the Android public key.
- Ed25519 SPKI public key validation; private keys are explicitly rejected.
- AliasKey returned only by the first enrollment response; administrative
  inventory, public lookup and normal CLI never display it.
- Offline CLI stages token/provisioning material in a new `0600`
  `OUTPUT.pending`, synchronizes it before registry commit, then promotes it
  without overwrite and with directory `fsync` before and after removing the
  pending name.
- Retry on the same output path is idempotent. Recovery distinguishes
  `COMMITTED`, `NOT_COMMITTED` and `UNCERTAIN`; uncertain state preserves the
  pending secret and stops. A committed match includes the plaintext token
  against its persisted domain-separated hash and the aliasKey against the
  private device record, without exposing either through inventory output.
- Sensitive token/output files reject symlinks, permissive modes, wrong owner,
  unexpected hard links, oversized input, non-canonical JSON, extra QR fields
  and non-canonical QR payloads.
- CLI JSON is written synchronously to file descriptors 1/2, preventing the
  Node 22 short-path flush race observed on recovery and validation errors.
- Any future remote enrollment requires authenticated TLS in addition to the
  one-time token.

## Runtime state

`CASSA_BT_FEATURE_ENABLED` and
`CASSA_BT_ENROLLMENT_RUNTIME_ENABLED` are both `0` in the example
configuration. The Raspberry entrypoint checks the feature flag before it
dynamically imports or starts BlueZ, and the example systemd unit defaults to
`0` with `Restart=on-failure`. The library and CLI perform no radio operation.
The unit also applies `ProtectSystem=strict`, `ProtectHome=true` and an
explicit read-only mount for the production registry, separating runtime reads
from administrative enrollment writes.

The CLI writes and fsyncs a pending secret before registry commit. A retry
promotes it when the matching record committed, replaces it only when absence
is verified, and stops without deleting it when state is uncertain. The final
hard link is directory-synced before the pending name is removed.

This is not a complete crash-consistency certification. A pending file
truncated before the persistence callback returns is preserved for manual
review, and Node.js offers no atomic compare-and-unlink primitive after the
`dev`/`ino` ownership check. The security model therefore requires trusted,
non-group/world-writable registry/output directories. Target-filesystem power
loss injection is still pending.

## Test evidence

```text
node shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/device-registry-v1.test.mjs
tsc -p raspberry/tsconfig.json --noEmit
```

Result: 17 tests passed, 0 failed.
Both direct and `--test` invocations were repeated three times with the pinned
Node v22.23.1 runtime; every invocation exited zero.
The Raspberry TypeScript scaffold, including the shared registry re-export and
feature-gated entrypoint, also passes type-checking.

Covered cases:

1. Happy-path initialization and enrollment, file mode, redaction and absence
   of Android private material.
2. Rejection of enrollment without the stable NodeId supplied by Android.
3. Expiry at the exact token deadline.
4. Two concurrent consumers: exactly one success and one replay rejection.
5. Secure-output sink failure does not issue or consume registry state.
6. A replaced lock survives cleanup unchanged while committed registry state
   is reported explicitly.
7. CLI redaction, `0600` sensitive outputs and preservation of a pre-existing
   output path.
8. Idempotent promotion of a committed pending token without double issuance.
9. Idempotent completion when both hard-link names remain after interruption.
10. Verified removal/retry of a pending token whose commit did not occur.
11. Preservation plus explicit `UNCERTAIN` when registry state is unreadable.
12. Rejection of a pending token whose plaintext secret does not match the
    committed domain-separated hash.
13. Idempotent promotion of committed enrollment without token replay,
    including exact aliasKey verification without exposing it through list.
14. Rejection of symlinked, permissive and structurally altered token files.
15. Malformed, RSA and private key rejection without token consumption.
16. Runtime and schema rejection of uppercase UUID and non-canonical base64url
    storage.
17. Rejection of a registry changed from `0600` to `0644`.

Semantic contract validation also passes with 14 JSON contracts.
The generated registry, QR and one-time response are walked against their
complete contract structure without third-party dependencies; canonical UUID,
UTC date and base64 padding-bit negative cases are also rejected.

The corresponding Android identity implementation, negative-test matrix,
review findings and APK evidence are recorded in
`reports/B1_ANDROID_IDENTITY_GATE_20260719.md`.

## Remaining B1 work

- Exercise the validated enrollment exchange and Android Keystore behavior on
  certified physical Android devices.
- Run process-kill and power-loss fault injection on the target Raspberry
  filesystem and document manual handling for a truncated `.pending`.
- Implement the authenticated native transport that will deliver the complete
  enrollment response; no WebView bridge is permitted for this material.
- Capture the same accepted advertisement contract on the target Android
  controller models.

## Rollback

No runtime consumes these files by default. Rollback is removal of the
provisioning library, CLI, schemas and configuration keys; running V4/V5BT
services and databases are unaffected.
