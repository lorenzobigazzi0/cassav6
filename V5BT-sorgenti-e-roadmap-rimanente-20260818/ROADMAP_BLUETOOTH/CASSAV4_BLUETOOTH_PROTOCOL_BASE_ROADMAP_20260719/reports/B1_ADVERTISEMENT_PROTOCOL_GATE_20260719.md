# B1 Advertisement Protocol Gate Report

## Report scope

- Phase: B1 - Protocol, identity and provisioning
- Evidence date: 2026-07-19
- Scope: shared identity and legacy BLE advertisement contracts
- Decision: PROTOCOL CONTRACT PASS; COMPLETE B1 GATE PENDING

The 31-byte advertising budget is resolved at codec, test-vector and physical
controller level. The complete B1 phase remains open for its other gates. A
real BlueZ/controller capture verified the UUID, payload, Flags and budget and
showed that BlueZ emits Service Data before Flags. The decoder now accepts the
two exact structure permutations while preserving all other strictness. See
`reports/B1_RASPBERRY_CONTROLLER_CAPTURE_20260719.md`.

## Advertising decision

The old 17-byte application payload would require 38 bytes when encoded as
128-bit Service Data with the mandatory legacy flags:

| Component | Size |
| --- | ---: |
| Flags AD structure | 3 bytes |
| Service Data 128-bit envelope | 18 bytes |
| Old application payload | 17 bytes |
| Total | 38 bytes |

The frozen v1 format uses a single primary advertisement:

| Component | Size |
| --- | ---: |
| Flags AD structure | 3 bytes |
| Service Data 128-bit envelope | 18 bytes |
| NodeAdvertisementV1 payload | 10 bytes |
| Total | 31 bytes |

Here, 31 bytes is the complete legacy AdvData field supplied to the controller,
not the complete Link Layer PDU. The reference encoder emits Flags
`02 01 06` followed by one exact 128-bit Service Data structure. The decoder
also accepts the exact Service Data-then-Flags order observed from BlueZ. It
still requires exactly one structure of each type and rejects duplicates,
unknown or additional structures, alternate Flags, short input and trailing
bytes.

The Service Data field already identifies the custom service UUID. A separate
UUID list, local name, TX power, Manufacturer Data and mandatory scan response
are excluded.

The 10-byte payload packs protocol version, node kind and server reachability in
one header byte. It retains one-byte boot, capability and sequence values, and
reduces the rotating alias from 64 to 48 bits. For a 400-node discovery epoch,
the birthday-bound alias collision probability is approximately `2.84e-10`.
Authenticated identity remains the stable NodeId; the alias is never trusted as
authorization.

## Identity decision

The rotating alias reference algorithm is:

```text
HMAC-SHA256(aliasKey, "CASSAV4-BT-ALIAS-V1\0" || nodeId || "\0" || epoch_u64_be)
```

The message serialization is normative: NodeId is the 36-byte UTF-8 canonical
lowercase UUID text, followed by one NUL byte and an unsigned 64-bit big-endian
epoch. Uppercase UUID text is rejected rather than normalized.

The first 6 digest bytes form the alias. `aliasKey` is exactly 32 random bytes
and the default epoch is 60 seconds. The fixed vector verifies message framing,
epoch calculation and truncation.

## Files changed

- `architecture/DISCOVERY_PROTOCOL.md`
- `configs/discovery-policy.json`
- `configs/gatt-uuids.json`
- `configs/protocol-defaults.json`
- `contracts/GATT_UUID_REGISTRY.md`
- `contracts/PROTOCOL_TEST_VECTORS.json`
- `contracts/cassav4-bluetooth-base-v1.proto`
- `contracts/node-advertisement-v1.schema.json`
- `roadmap/PHASE_B1_PROTOCOL_IDENTITY_PROVISIONING.md`
- `roadmap/PHASE_B2_AUTOMATIC_BLE_DISCOVERY.md`
- `raspberry/scripts/register_advertisement_v1.py`
- `raspberry/scripts/test_register_advertisement_v1.py`
- `reports/B1_RASPBERRY_CONTROLLER_CAPTURE_20260719.md`
- `scripts/validate-contracts.mjs`
- `shared/protocol/*`

No running Android application, server, database or Raspberry production file
was changed. The laboratory script was copied only to `/tmp` and removed after
capture.

## Validation evidence

Lightweight checks:

```text
node --test shared/protocol/advertisement-v1.test.mjs
node scripts/validate-contracts.mjs --root .
node scripts/validate-roadmap-package.mjs --root .
node scripts/simulate-dialer-election.mjs --root .
node scripts/simulate-connectivity-state.mjs --root .
```

The codec tests cover the canonical payload, complete 31-byte AdvData, both
exact accepted structure orders, duplicate/extra/trailing rejection, UUID byte
order, every capability bit, reserved header/capability bits, modulo-256 serial
comparison, HMAC byte serialization and epoch rotation. Result: 17 tests
passed, 0 failed.

## Open work

1. Exercise the feature-gated Android encoder/decoder port on certified target
   devices and complete its production BlueZ runtime integration.
2. Exercise the implemented Android identity, Ed25519 private key and aliasKey
   handling on certified physical Android devices.
3. Implement the authenticated native TLS transport for the completed
   QR/one-time enrollment and registry contracts.
4. Capture the same two-structure contract on the target Android devices during
   B2/B3 interoperability testing.
5. Exercise alias-collision handling and boot/sequence wrap in integration tests.

## Phase gate record

- Phase: B1
- Decision: protocol contract pass; full phase pending
- Tests: reference codec, semantic contract validation and kit simulators
- Metrics: 10-byte payload; 31-byte complete legacy advertisement; no required
  scan response; 48-bit rotating alias; 60-second epoch
- Findings: wire budget and identity derivation are frozen; BlueZ reorders the
  two AD structures, and the strict decoder accepts that exact observed
  permutation without accepting duplicates or extra fields
- Rollback: Bluetooth feature flags remain off. Removing the shared codec and
  reverting the listed contract files changes no running V4/V5BT service
  state.
