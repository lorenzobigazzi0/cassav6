# B0 Raspberry Hardware Inventory Report

## Report scope

- Phase: B0 - Hardware capability gate
- Evidence date: 2026-07-19
- Target: `raspberrypi` (`192.168.1.79`)
- Evidence source: read-only SSH inventory
- Decision: PENDING

This report records the Raspberry hardware and software inventory available to
support B0 and the later B4 BlueZ node work. It is not an Android device
certification report and does not close the B0 gate.

## System inventory

| Item | Observed value |
| --- | --- |
| Hostname | `raspberrypi` |
| Operating system | Debian GNU/Linux 13.5 (trixie) |
| Kernel | `6.18.37-rt+` |
| Architecture | `arm64` |
| BlueZ service | Active |
| Node.js | `24.15.0` |
| npm | `11.12.1` |
| RAM | 4 GB total, 2.8 GB available at observation time |
| Disk | 58 GB total, 33 GB available at observation time |

## Bluetooth controller inventory

| Item | Observed value |
| --- | --- |
| Controller address | `D8:3A:DD:AC:F5:91` |
| Powered | Yes |
| Controller roles | Central, peripheral |
| Low Energy support | Supported |
| Advertising support | Supported |
| Advertising instances | 5 |
| Maximum advertising data length | 31 bytes |
| Maximum scan response length | 31 bytes |

## B0 capability matrix

The statuses below distinguish controller capability from runtime protocol
testing. A controller-reported feature is not treated as a successful
end-to-end test.

| B0 capability | Status | Evidence and limitation |
| --- | --- | --- |
| BLE scan support | PASS_RUNTIME | BlueZ reported `Discovery started` during a controlled 12-second scan. No new nearby devices were observed. |
| BLE advertise support | PASS_RUNTIME | A transient BlueZ advertisement registered successfully and exited with status 0. |
| GATT client | NOT_TESTED | Controller role data alone does not prove a working application-level GATT client. |
| GATT server | NOT_TESTED | No GATT application was registered or opened. |
| Scan and advertise concurrently | PASS_RUNTIME | While both operations ran, BlueZ reported `Discovering: yes` and one active advertising instance. |
| Wi-Fi and BLE coexistence | NOT_TESTED | No coexistence load test was performed. |
| Background operation | NOT_APPLICABLE_TO_ANDROID_B0 | Raspberry service lifecycle belongs to B4/B11 validation. |
| Ten-node consecutive discovery | NOT_TESTED | This is the B4 gate and was not executed during inventory. |

## Evidence summary

- The host has an active BlueZ service and a powered BLE controller.
- The controller reports both central and peripheral roles.
- LE advertising is supported with five available advertising instances.
- Legacy advertising and scan-response payload capacity is 31 bytes each.
- The installed Node.js and npm runtimes are present for later Raspberry node
  implementation work.
- A controlled 12-second scan started successfully and was explicitly stopped;
  the final controller state reported `Discovering: no`.
- A controlled concurrent scan/advertise test registered one advertising
  instance while discovery was active. Cleanup restored zero active instances
  and `Discovering: no`.
- No persistent configuration, service, controller state, or application files
  were changed while collecting this inventory.

## Findings

1. The observed controller capabilities are suitable for beginning B4
   implementation and controlled radio tests.
2. The 31-byte advertising limit must be respected when the B2 advertisement
   layout is frozen.
3. Runtime GATT, coexistence, restart, leak, and multi-node behavior remain
   unverified.
4. B0 still requires the roadmap's real Android device matrix, including scan,
   advertise, GATT client/server, concurrent operation, and OEM background
   behavior.
5. B0 also requires at least two certified Android `FULL_NODE` devices in the
   laboratory before its peer-to-peer requirement can pass.

## Phase gate record

- Phase: B0
- Decision: PENDING
- Tests: BlueZ runtime scan start/stop and concurrent scan/advertise passed; no
  target device was discovered.
- Metrics: 5 advertising instances; 31-byte maximum advertising data; 31-byte
  maximum scan response.
- Findings: Raspberry controller capability is present; Android certification
  and runtime radio validation remain open.
- Rollback: Not applicable. The evidence collection was read-only and made no
  target changes.
