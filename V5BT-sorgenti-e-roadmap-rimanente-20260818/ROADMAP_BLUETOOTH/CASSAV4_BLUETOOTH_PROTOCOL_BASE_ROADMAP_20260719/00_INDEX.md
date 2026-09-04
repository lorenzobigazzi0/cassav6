# Indice

## Roadmap

- `roadmap/MASTER_ROADMAP.md`
- `roadmap/SCOPE_AND_NON_GOALS.md`
- `roadmap/MILESTONES_AND_GATES.md`
- `roadmap/PHASE_B0_HARDWARE_CAPABILITY_GATE.md`
- `roadmap/PHASE_B1_PROTOCOL_IDENTITY_PROVISIONING.md`
- `roadmap/PHASE_B2_AUTOMATIC_BLE_DISCOVERY.md`
- `roadmap/PHASE_B3_ANDROID_CONNECTIVITY_AGENT.md`
- `roadmap/PHASE_B4_RASPBERRY_BLUEZ_NODE.md`
- `roadmap/PHASE_B5_ANDROID_RASPBERRY_DIRECT_SESSION.md`
- `roadmap/PHASE_B6_ANDROID_ANDROID_DIRECT_SESSION.md`
- `roadmap/PHASE_B7_RELIABLE_CHANNEL.md`
- `roadmap/PHASE_B8_LOCAL_DURABILITY.md`
- `roadmap/PHASE_B9_ROUTE_ADVERTISEMENT.md`
- `roadmap/PHASE_B10_COMMAND_BUS_SHADOW_INTEGRATION.md`
- `roadmap/PHASE_B11_TEST_PILOT.md`
- `roadmap/FUTURE_MULTIHOP_AND_LOAD_BALANCING.md`
- `roadmap/FUTURE_ESP32.md`

## Architettura

- `architecture/TARGET_ARCHITECTURE.md`
- `architecture/NODE_ROLES.md`
- `architecture/DISCOVERY_PROTOCOL.md`
- `architecture/DIRECT_SESSION_LIFECYCLE.md`
- `architecture/GATT_PROFILE.md`
- `architecture/CONNECTION_ROLE_ELECTION.md`
- `architecture/SECURITY_HANDSHAKE.md`
- `architecture/FRAME_PROTOCOL.md`
- `architecture/RELIABILITY_MODEL.md`
- `architecture/ANDROID_BACKGROUND_MODEL.md`
- `architecture/RASPBERRY_BLUEZ_MODEL.md`
- `architecture/RASPBERRY_GATT_SERVER.md`
- `architecture/LOCAL_STORAGE_MODEL.md`
- `architecture/OBSERVABILITY_MODEL.md`
- `architecture/UI_CONNECTIVITY_MODEL.md`

## Contratti

- `contracts/*.schema.json`
- `contracts/enrollment-request-v1.schema.json`
- `contracts/cassav4-bluetooth-base-v1.proto`
- `contracts/b5-campaign-authorization-v1.schema.json`: autorizzazione B0-B4
  vincolata alla campagna, senza promozione implicita.
- `contracts/b5-review-attestation-v1.schema.json`: sign-off indipendente
  vincolato allo SHA-256 dell'aggregato tecnico.
- `contracts/b5-technical-receipt-v1.schema.json`: receipt privato schema v1
  che lega la coppia tecnica alla campagna e alle evidenze byte-exact.
- `contracts/GATT_UUID_REGISTRY.md`
- `contracts/PROTOCOL_TEST_VECTORS.json`

## Scaffold

- `android/`
- `raspberry/`
- `backend/`
- `testing/`
- `scripts/`
- `prompts/`

## Riferimento eseguibile

- `shared/protocol/advertisement-v1.mjs`
- `shared/protocol/rotating-alias-v1.mjs`
- `shared/protocol/advertisement-v1.test.mjs`
- `shared/protocol/gatt-profile-v1.mjs`
- `shared/protocol/gatt-profile-v1.test.mjs`
- `shared/protocol/hello-v1.mjs`
- `shared/protocol/hello-v1.test.mjs`
- `shared/protocol/mutual-auth-v1.mjs`
- `shared/protocol/mutual-auth-v1.test.mjs`
- `shared/discovery/peer-directory-v1.mjs`
- `shared/discovery/peer-directory-v1.test.mjs`
- `shared/discovery/scan-window-policy-v1.mjs`
- `shared/discovery/scan-window-policy-v1.test.mjs`
- `shared/provisioning/device-registry-v1.mjs`
- `shared/provisioning/device-registry-v1.test.mjs`
- `shared/provisioning/enrollment-transport-v1.mjs`
- `shared/provisioning/enrollment-transport-v1.test.mjs`
- `shared/provisioning/README.md`
- `shared/session/direct-session-v1.mjs`
- `shared/session/direct-session-v1.test.mjs`
- `shared/session/README.md`
- `raspberry/scripts/enrollment-server.mjs`
- `raspberry/scripts/enrollment-server.test.mjs`
- `raspberry/systemd/cassav5bt-bluetooth-enrollment.service`
- `raspberry/src/config/NodeConfig.ts`
- `raspberry/src/bluez/BluezDbusPort.ts`
- `raspberry/src/bluez/DbusNextBluezPort.ts`
- `raspberry/src/bluez/BluezAdapter.ts`
- `raspberry/src/bluez/BluezGattServerPort.ts`
- `raspberry/src/bluez/DbusNextGattServerPort.ts`
- `raspberry/src/bluez/GattApplication.ts`
- `raspberry/src/gatt/CassaGattService.ts`
- `raspberry/src/node/BluezNode.ts`
- `raspberry/src/discovery/PeerScanner.ts`
- `raspberry/src/discovery/PeerRegistry.ts`
- `raspberry/src/metrics/MetricsRegistry.ts`
- `raspberry/systemd/cassav5bt-bluetooth-node.service`
- `raspberry/test/bluez-adapter.test.mjs`
- `raspberry/test/bluez-dbus-port.test.mjs`
- `raspberry/test/bluez-node.test.mjs`
- `raspberry/test/gatt-application.test.mjs`
- `raspberry/test/gatt-server-port.test.mjs`
- `raspberry/test/b4-physical-servicedata-gate.test.mjs`
- `raspberry/test/b4-ten-device-gate.test.mjs`
- `raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs`
- `raspberry/scripts/run-b5-android-hello-smoke.mjs`
- `raspberry/scripts/run-b5-mutual-auth-smoke.mjs`
- `raspberry/scripts/run-b5-campaign-supervisor.mjs`: owner degli slot
  ufficiali B5 e ledger tentativi privato schema v1.
- `raspberry/scripts/run-b5-hundred-session-gate.mjs`: gate tecnico che
  produce la coppia immutabile aggregato/receipt
  `TECHNICAL_PASS/PENDING_REVIEW` senza promuovere B5.
- `raspberry/scripts/run-b5-promotion-gate.mjs`: unica promozione B5 dopo
  review indipendente e verifica dell'aggregato tramite receipt.
- `raspberry/test/b5-gatt-physical-smoke.test.mjs`
- `raspberry/test/b5-android-hello-smoke.test.mjs`
- `raspberry/test/b5-mutual-auth-smoke.test.mjs`
- `raspberry/test/b5-campaign-supervisor.test.mjs`
- `raspberry/test/b5-hundred-session-gate.test.mjs`
- `raspberry/test/b5-promotion-gate.test.mjs`
- `scripts/run-b5-android-continuity-monitor.mjs`: continuita del Palmare
  `handheld` per l'intera finestra tentativi, con scheduling clampato e
  pubblicazione accoppiata recuperabile.
- `scripts/run-b5-raspberry-continuity-monitor.mjs`: continuita dei servizi e
  del processo Raspberry per l'intera finestra tentativi.
- `scripts/b5-campaign-governance.mjs`
- `scripts/b5-technical-receipt.mjs`: parser e builder esatti del receipt
  privato, condivisi da gate tecnico e promozione.
- `configs/cassav5bt-bluetooth-enrollment.env.example`
- `configs/raspberry.env.example`
- `configs/security-policy.json`
- `configs/advanced-certification-targets.json`: baseline pubblica unica per
  package, versione e SHA-256 degli APK Advanced certificati.

## Harness fisici

- `scripts/advanced-certification-targets.mjs`: loader fail-closed condiviso
  dai gate Android B2 e B3.
- `scripts/advanced-certification-targets.test.mjs`
- `scripts/run-b2-android-gate.mjs`: gate discovery stretto post-enrollment,
  100 cicli e report `DISCOVERY_ONLY_POST_ENROLLMENT`.
- `scripts/run-b2-android-adb-harness.mjs`: banco operatore esteso per
  enrollment B1 e raccolta discovery B2.
- `scripts/run-b2-android-adb-harness.test.mjs`
- `testing/B2_ANDROID_ADB_HARNESS.md`
- `scripts/run-b3-android-service-gate.mjs`: gate lifecycle B3 su due target
  Advanced, osservazione fisica non abbreviabile di 3600 secondi.
- `scripts/run-b3-android-service-gate.test.mjs`
- `testing/B3_ANDROID_SERVICE_GATE.md`
- `raspberry/scripts/run-b4-raspberry-servicedata-gate.mjs`: gate B4.3
  fail-closed da 90 secondi per callback ServiceData e cleanup Raspberry.
- `testing/B4_RASPBERRY_PHYSICAL_GATE.md`: prerequisiti, criteri PASS e
  verifica finale delle risorse per il gate fisico B4.3.
- `raspberry/scripts/run-b4-ten-device-gate.mjs`: aggregatore B4.4
  fail-closed per dieci device fisici distinti e autorizzati.
- `scripts/collect-b4-physical-device.mjs`: raccolta progressiva riprendibile
  con preflight ADB non mutante, deduplica hardware e staging privato delle
  evidenze.
- `scripts/collect-b4-physical-device.test.mjs`
- `testing/B4_TEN_DEVICE_GATE.md`: manifest privato, procedura e criteri PASS
  del gate finale B4.
- `raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs`: smoke B5.3 fisico
  fail-closed per registrazione, consumo ObjectManager e cleanup BlueZ.
- `raspberry/scripts/run-b5-android-hello-smoke.mjs`: gate B5.5 per un solo
  HELLO Android-Raspberry, zero autenticazioni e cleanup BlueZ.
- `raspberry/test/b5-android-hello-smoke.test.mjs`
- `testing/B5_RASPBERRY_GATT_PHYSICAL_SMOKE.md`: prerequisiti, comando e
  criteri PASS del lifecycle GATT Raspberry.
- `testing/B5_ANDROID_GATT_CLIENT.md`: build Lab, procedura fisica e criteri
  PASS del client GATT Android B5.4.
- `testing/B5_ANDROID_RASPBERRY_HELLO.md`: procedura e criteri PASS del gate
  HELLO B5.5.
- `raspberry/scripts/run-b5-mutual-auth-smoke.mjs`: gate B5.6 fail-closed per
  una sola autenticazione reciproca Android-Raspberry e cleanup BlueZ.
- `testing/B5_ANDROID_RASPBERRY_MUTUAL_AUTH.md`: procedura, criteri PASS ed
  esito fisico B5.6 su due Palmari.
- `testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md`: sequenza completa con inventario,
  autorizzazione, supervisor, monitor Android/Raspberry, gate tecnico, review
  e promozione.
- `checklists/B5_PHYSICAL_CAMPAIGN_CHECKLIST.md`: checklist fail-closed della
  campagna ufficiale.
- `scripts/run-b5-raspberry-continuity-monitor.mjs`: continuita di
  `cassav5bt.service`, `bluetooth.service`, boot e clock, con attestazione
  redatta e pubblicazione accoppiata recuperabile tramite journal privato.
- Dalla root workspace, `scripts/run-v5bt-bench-inventory.mjs`: inventario
  unico read-only; per UPS esegue solo discovery, senza driver presunti.
- Dalla root workspace, `scripts/verify-v5bt-advanced-build-consistency.mjs`:
  matrice/Gradle/APK e parita dei sorgenti Bluetooth Advanced.

## Report locali

- `reports/B0_ANDROID_CAPABILITY_IMPLEMENTATION_20260719.md`
- `reports/B0_RASPBERRY_HARDWARE_INVENTORY_20260719.md`
- `reports/B1_ADVERTISEMENT_PROTOCOL_GATE_20260719.md`
- `reports/B1_ANDROID_IDENTITY_GATE_20260719.md`
- `reports/B1_RASPBERRY_CONTROLLER_CAPTURE_20260719.md`
- `reports/B1_REGISTRY_ENROLLMENT_GATE_20260719.md`
- `reports/B1_NATIVE_ENROLLMENT_TRANSPORT_20260720.md`
- `reports/B2_DISCOVERY_CORE_GATE_20260719.md`
- `reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md`
- `reports/B2_ANDROID_ADB_HARNESS_20260720.md`
- `reports/V5BT_ANDROID_ENROLLMENT_DISCOVERY_BUILD_20260720.md`
- `reports/B3_ANDROID_CONNECTIVITY_AGENT_20260720.md`
- `reports/B4_RASPBERRY_BLUEZ_NODE_CORE_20260720.md`
- `reports/B4_RASPBERRY_BLUEZ_DBUS_ADAPTER_20260720.md`
- `reports/B4_3_RASPBERRY_PHYSICAL_SERVICEDATA_20260720.md`
- `reports/B4_4_TEN_DEVICE_GATE_HARNESS_20260720.md`
- `reports/B4_4_PHYSICAL_COLLECTION_PROGRESS_20260720.md`
- `reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_1_20260805.md`
- `reports/B5_1_DIRECT_SESSION_CORE_20260720.md`
- `reports/B5_2_RASPBERRY_GATT_SERVER_20260720.md`
- `reports/B5_3_RASPBERRY_GATT_PHYSICAL_20260720.md`
- `reports/B5_4_ANDROID_GATT_CLIENT_20260720.md`
- `reports/B5_5_ANDROID_RASPBERRY_HELLO_20260720.md`
- `reports/B5_6_MUTUAL_AUTH_20260721.md`
- `reports/B5_OFFLINE_CAMPAIGN_GOVERNANCE_20260803.md`
- `reports/B5_OFFLINE_EVIDENCE_BINDING_20260803.md`
- `reports/physical/v5bt-b4-3-servicedata-gate-20260720.json`
- `reports/physical/v5bt-b4-3-servicedata-node-20260720.log`
- `reports/physical/v5bt-b4-4-collection-progress-20260720.json`
- `reports/physical/v5bt-b5-3-gatt-smoke-20260720.json`
- `reports/physical/v5bt-b5-4-android-gatt-client-20260720.json`
- `reports/physical/v5bt-b5-5-android-hello-20260720.json`
- `reports/physical/v5bt-b5-5-raspberry-hello-20260720.json`
- `reports/physical/v5bt-b5-6-phone-a-20260721.json`
- `reports/physical/v5bt-b5-6-phone-b-20260721.json`
