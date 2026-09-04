# V6 Bootstrap Provenance

Date: 2026-08-20
Status: initial V6 baseline, product identifiers still inherited from V5BT
Publication target: `/home/sentrapa/Downloads/v6`

## Construction policy

- The V5 workspace was read-only throughout this bootstrap.
- The destination was assembled under a mode `0700` staging directory.
- No wall-clock backup directory was created.
- No final ZIP was produced.
- Commercial V2 remains disabled unless explicitly enabled through runtime configuration.

## Source baseline

Input:

`/home/sentrapa/cassa V5BT/V5BT-codice-attuale-20260818.zip`

SHA-256:

`efe494c84b1182cd8c34854ea0956d2f80495c8ce4597c93879ef37afa7d92fe`

Verification:

- ZIP integrity: pass
- ZIP entries: 3332
- ZIP symlink entries: 0
- internal source manifest entries checked: 3331
- internal source manifest mismatches: 0
- live V5 files represented by the manifest: 3330
- live V5 missing, linked, or changed files: 0
- generated archive-only information file: 1
- internal manifest SHA-256: `03ded77a98e74c0e186ade9a87b592f9251cd9021f8ffe964b7366873e8af76c`

The baseline contains the two explicitly packaged SQLite provisioning copies and
compressed database provisioning sources. It must therefore be handled as
sensitive even though runtime credentials and private evidence are excluded.

## Commercial V2

Input:

`/home/sentrapa/Downloads/V5BT_IMPLEMENTAZIONE_COMMERCIALE_V2_20260819.zip`

SHA-256:

`9a6c12c9f24f6f4884c99c46894363ab3f7d619e018c242feb4fd4f5b7d1a4b9`

Verification:

- ZIP integrity: pass
- ZIP entries: 130
- ZIP symlink entries: 0
- package manifest files checked: 76
- package manifest mismatches: 0
- expected unmanifested metadata: `MANIFEST.sha256`, `FILE_INVENTORY.txt`
- internal manifest SHA-256: `7061c30cab55766161d1d91c2cb6a026f76999cef014e6adb6fd4dfa5b464db4`
- patch SHA-256: `3b531c878e5516d173fdbeb750415ad5c1de80cf688779215998a8b89af6458a`

Application method:

1. `git apply --check` against the extracted baseline.
2. `git apply` of `0001-commercial-configuration-v2-integration.patch`.
3. Manual `rsync` of `OVERLAY/` into the staging root.
4. No invocation of `apply-overlay.sh` and no `.commercial-v2-backups` tree.

Post-application checks:

- patched files matching `MERGED_REFERENCE`: 13/13
- overlay files matching the package: 34/34
- reverse patch applicability check: pass

## Explicit V5 additions

The following served distributions were copied from the current V5 tree after
regular-file, symlink, sensitive-name, private-key-marker, and known-secret
checks:

- `SORGENTE_SISTEMA/cassa-frontend/dist`
- `SORGENTE_SISTEMA/mobile-frontend/dist`
- `SORGENTE_SISTEMA/postazione/dist`
- `SORGENTE_SISTEMA/monitor-frontend/dist`
- `SORGENTE_SISTEMA/reservation-frontend/dist`
- `SORGENTE_SISTEMA/battery-dashboard/dist`

Selected distribution files: 213

Aggregate SHA-256 of the sorted `hash, size, relative path` records:

`d6cc4fd82c54f3b79b8a598b9ee183deeb99016394a2ff4ee99c41a62c58e31c`

`settings-frontend/dist` is supplied and rebuilt by Commercial V2, so the old
V5 settings distribution was intentionally not copied over it.

Four test-only PKCS#12 fixtures omitted by the source archive allowlist were
copied explicitly:

- Palmare valid: `9918078b009ce248ccbcd1f3f55078e382f2b8084f0752c25a958f52460bdcfb`
- Palmare expired: `bdfb5c009641a1f2518c1fd5ea94f283c0c8f02f88b4e767e150d026eb6f3a93`
- Postazione valid: `9918078b009ce248ccbcd1f3f55078e382f2b8084f0752c25a958f52460bdcfb`
- Postazione expired: `bdfb5c009641a1f2518c1fd5ea94f283c0c8f02f88b4e767e150d026eb6f3a93`

Fixture aggregate SHA-256:

`55729f103a5af29fe134c65a3e89e39b585dd56495fe0af780001cb0cdaf7d39`

These are deterministic test stores with the password documented in their test
source. They are not runtime certificates.

## Verification results

- Commercial V2 package tests: 13 passed, 0 failed
- Commercial settings source syntax and build: pass
- Commercial backend JavaScript syntax checks: pass
- Modified mobile TypeScript/TSX parser checks: 8 passed, 0 failed
- PKCS#12 fixture readability: 4 passed, 0 failed
- served distribution entrypoints present: 7 passed, 0 failed
- post-build overlay comparison: 34/34 identical

The full mobile typecheck, mobile test suite, Android Gradle suite, backend full
suite, and real hardware tests were not run during bootstrap. Dependency and
build caches are intentionally absent from this baseline.

## Security and filesystem checks

- final symlinks: 0
- final special filesystem entries: 0
- forbidden runtime/private/cache directories: 0
- private-key PEM markers: 0
- known token and secret value matches introduced: 0
- group- or world-writable files and directories after normalization: 0
- only secret-like paths retained: two `.env.example` files and the four
  explicitly approved test PKCS#12 fixtures

A six-character local hardware password produced matches in 14 pre-existing
source files. Every match was independently confirmed in the immutable source
archive, and no match was introduced by Commercial V2 or the manual additions.
The value is not recorded here.

## Excluded material

The baseline does not contain `.runtime`, `.v5bt-private`, `private`,
`node_modules`, `.gradle`, Android build trees, logs, artifacts, local Android
SDK paths, real TLS material, hardware configuration, or previous archives.

V5BT names, application IDs, service names, database names, ports, report IDs,
and signed historical evidence remain unchanged. Their migration is a separate
V6 identity and coexistence task.
