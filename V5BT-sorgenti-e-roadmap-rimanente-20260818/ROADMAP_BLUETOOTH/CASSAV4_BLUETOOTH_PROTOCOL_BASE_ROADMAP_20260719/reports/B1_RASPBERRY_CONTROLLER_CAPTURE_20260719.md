# B1 Raspberry Controller Advertisement Capture

## Report scope

- Phase: B1 - Protocol, identity and provisioning
- Evidence date: 2026-07-19
- Target: Raspberry BlueZ 5.82, transient laboratory execution
- Decision: PASS - physical advertisement content and budget

The controller accepted a 31-byte legacy advertisement containing the exact v1
service UUID, frozen 10-byte payload and Flags value. BlueZ emitted Service Data
before Flags. The interoperable contract now accepts that exact permutation in
addition to the Flags-first reference encoding, while rejecting every other
layout.

## Reference encoding and accepted observation

The B1 reference encoder emits this complete legacy AdvData:

```text
0201061b210100416c4b4f649a324f1f7d00a5c4b131aabbccddeeff112f66
```

Its components are:

| Component | Hex | Bytes |
| --- | --- | ---: |
| Flags | `020106` | 3 |
| Service Data header | `1b21` | 2 |
| UUID 128, little-endian | `0100416c4b4f649a324f1f7d00a5c4b1` | 16 |
| NodeAdvertisementV1 | `31aabbccddeeff112f66` | 10 |
| Total | | 31 |

No scan response, local name, TX power, UUID list or Manufacturer Data is
permitted by this contract.

The decoder accepts exactly the reference order and the BlueZ-observed order:

```text
Flags, Service Data 128
Service Data 128, Flags
```

Both orders require the exact same two structures. Duplicates, trailing bytes,
unknown types and additional structures remain invalid.

## Laboratory tool

`raspberry/scripts/register_advertisement_v1.py` exports one
`org.bluez.LEAdvertisement1` object. It supplies only:

- `Type=peripheral`;
- the 128-bit `ServiceData` key and exact 10-byte payload;
- `Discoverable=true`.

BlueZ therefore owns the required Flags structure. The tool accepts explicit
node fields, has a finite duration, unregisters in `finally`, handles
termination signals and contains an offline frozen-vector self-test.

The script was copied only to `/tmp` on the Raspberry. It was not installed,
did not create a service and did not write to `/opt/cassav4`.

## Controller evidence

The live `btmon` trace reported:

```text
Advertising data length: 31
Service Data UUID 128: Vendor specific
  Data[10]: 31aabbccddeeff112f66
Flags: 0x06
  LE General Discoverable Mode
  BR/EDR Not Supported
Scan response length: 0
LE Set Advertising Data: Length 31
LE Set Advertising Data: Status Success
```

The raw btsnoop management record sent through the kernel contained these exact
31 advertising bytes:

```text
1b210100416c4b4f649a324f1f7d00a5c4b131aabbccddeeff112f66020106
```

This proves all individual values and the complete budget:

- Service Data UUID bytes:
  `0100416c4b4f649a324f1f7d00a5c4b1`;
- payload bytes: `31aabbccddeeff112f66`;
- Flags bytes: `020106`;
- total AdvData: 31 bytes;
- scan response: 0 bytes.

It also records the interoperability finding: BlueZ serialized Service Data
before Flags, and the HCI trace decoded the same order. The observed bytes were
added as `bluezObservedAdvDataHex` in the frozen vectors. The strict decoder
accepts this exact permutation, but it does not normalize arbitrary AD
structures or accept duplicates, extra fields or trailing bytes.

## Runtime and cleanup evidence

Before the radio test:

- BlueZ was active;
- backend `/api/health` returned healthy production state with MySQL;
- systemd reported zero failed units;
- `ActiveInstances` was 0;
- `Discovering` was `no`.

During the controlled test, `ActiveInstances` was observed at 1. Registration,
advertising enable, advertising disable and unregister all completed
successfully.

After every attempt and after the final capture:

- `ActiveInstances` returned to 0;
- `Discovering` remained `no`;
- no laboratory `btmon` or Python process remained;
- all script, text and btsnoop files were removed from `/tmp`;
- backend health remained good, the frontend returned HTTP 200 and systemd
  still reported zero failed units.

The raw capture was deliberately not retained. Consequently, the original
capture cannot be independently replayed from this workspace; this report
records the public frozen test-vector bytes and transcript needed to reproduce
the controlled test.

## Validation evidence

```text
python3 raspberry/scripts/register_advertisement_v1.py --self-test
  SELF_TEST=PASS
  PAYLOAD_BYTES=10
  LEGACY_ADVDATA_BYTES=31

python3 -m unittest -v raspberry/scripts/test_register_advertisement_v1.py
  6 tests passed, 0 failed

remote self-test
  SELF_TEST=PASS

remote registration
  REGISTERED=1
  UNREGISTERED=1

node shared/protocol/advertisement-v1.test.mjs
  17 tests passed, 0 failed

node scripts/validate-contracts.mjs --root .
  both accepted orders and strict negative cases passed
```

## Gate decision

- Advertisement field values: PASS
- UUID byte order: PASS
- Payload size and bytes: PASS
- Complete 31-byte budget: PASS
- Empty scan response: PASS
- Reference encoder Flags-first order: PASS
- BlueZ-observed Service Data-first decoder interoperability: PASS
- Duplicate/extra/trailing structure rejection: PASS
- Physical B1 advertisement content and budget gate: PASS

BlueZ reordering remains a documented platform behavior, not an implicit
normalization rule. Future Android captures must match one of the same two exact
orders. Direct raw-HCI control is not introduced by this laboratory tool and
must not be used to bypass BlueZ ownership.
