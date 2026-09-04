import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from './advanced-certification-targets.mjs';
import {
  isRoadmapPromotionAllowed,
  loadCurrentRoadmapStatus
} from './current-roadmap-status.mjs';
import { compareRoadmapManifest } from './roadmap-package-inventory.mjs';
import {
  validateB11MixedPhysicalAttestation,
  validateB11MixedPhysicalVirtualReport
} from '../raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs';
const root=path.resolve(process.argv.includes('--root')?process.argv[process.argv.indexOf('--root')+1]:'.');
const required=[
  '.gitignore',
  'README.md',
  'roadmap/MASTER_ROADMAP.md',
  'roadmap/PHASE_B5_ANDROID_RASPBERRY_DIRECT_SESSION.md',
  'roadmap/PHASE_B11_TEST_PILOT.md',
  'architecture/DIRECT_SESSION_LIFECYCLE.md',
  'architecture/GATT_PROFILE.md',
  'architecture/RASPBERRY_BLUEZ_MODEL.md',
  'architecture/RASPBERRY_GATT_SERVER.md',
  'configs/cassav5bt-bluetooth-enrollment.env.example',
  'configs/advanced-certification-targets.json',
  'configs/current-roadmap-status.json',
  'configs/device-capability-matrix.json',
  'configs/external-evidence-status.json',
  'configs/raspberry.env.example',
  'configs/security-policy.json',
  'contracts/GATT_UUID_REGISTRY.md',
  'contracts/PROTOCOL_TEST_VECTORS.json',
  'contracts/ack-v1.schema.json',
  'contracts/b0-device-capability-matrix-v1.schema.json',
  'contracts/b0-device-capability-report-v1.schema.json',
  'contracts/auth-challenge-v1.schema.json',
  'contracts/auth-finish-v1.schema.json',
  'contracts/auth-response-v1.schema.json',
  'contracts/auth-server-proof-v1.schema.json',
  'contracts/b11-mixed-physical-attestation-v1.schema.json',
  'contracts/b11-mixed-physical-virtual-non-gate-v3.schema.json',
  'contracts/b11-maximum-virtualized-system-non-gate-v2.schema.json',
  'contracts/b5-campaign-authorization-v1.schema.json',
  'contracts/b5-review-attestation-v1.schema.json',
  'contracts/b5-technical-receipt-v1.schema.json',
  'contracts/current-roadmap-status-v1.schema.json',
  'contracts/device-registry-v1.schema.json',
  'contracts/enrollment-qr-v1.schema.json',
  'contracts/enrollment-request-v1.schema.json',
  'contracts/enrollment-response-v1.schema.json',
  'contracts/hello-v1.schema.json',
  'contracts/transport-frame-v1.schema.json',
  'android/AndroidManifest.fragment.xml',
  'raspberry/package-lock.json',
  'raspberry/package.json',
  'raspberry/src/index.ts',
  'raspberry/src/bluez/BluezAdapter.ts',
  'raspberry/src/bluez/BluezDbusPort.ts',
  'raspberry/src/bluez/BluezGattServerPort.ts',
  'raspberry/src/bluez/DbusNextBluezPort.ts',
  'raspberry/src/bluez/DbusNextGattServerPort.ts',
  'raspberry/src/bluez/GattApplication.ts',
  'raspberry/src/gatt/CassaGattService.ts',
  'raspberry/src/session/GattHelloExchangeV1.ts',
  'raspberry/scripts/device-registry.mjs',
  'raspberry/scripts/enrollment-server.mjs',
  'raspberry/scripts/enrollment-server.test.mjs',
  'raspberry/scripts/run-b4-raspberry-servicedata-gate.mjs',
  'raspberry/scripts/run-b4-ten-device-gate.mjs',
  'raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs',
  'raspberry/scripts/run-b5-android-hello-smoke.mjs',
  'raspberry/scripts/run-b5-campaign-supervisor.mjs',
  'raspberry/scripts/run-b5-direct-control-smoke.mjs',
  'raspberry/scripts/run-b5-mutual-auth-smoke.mjs',
  'raspberry/scripts/run-b5-promotion-gate.mjs',
  'raspberry/scripts/b11-virtual-business-workload.mjs',
  'raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs',
  'raspberry/scripts/run-b11-software-non-gate.mjs',
  'raspberry/systemd/cassav5bt-bluetooth-node.service',
  'raspberry/systemd/cassav5bt-bluetooth-enrollment.service',
  'raspberry/test/b4-physical-servicedata-gate.test.mjs',
  'raspberry/test/b4-ten-device-gate.test.mjs',
  'raspberry/test/b5-gatt-physical-smoke.test.mjs',
  'raspberry/test/b5-android-hello-smoke.test.mjs',
  'raspberry/test/b5-campaign-supervisor.test.mjs',
  'raspberry/test/b5-direct-control-smoke.test.mjs',
  'raspberry/test/b5-mutual-auth-smoke.test.mjs',
  'raspberry/test/b5-promotion-gate.test.mjs',
  'raspberry/test/b11-software-non-gate.test.mjs',
  'raspberry/test/b11-hybrid-report-validation.test.mjs',
  'raspberry/test/b11-mixed-physical-virtual-non-gate.test.mjs',
  'raspberry/test/b11-virtual-business-workload.test.mjs',
  'raspberry/test/direct-control-handshake.test.mjs',
  'raspberry/test/gatt-direct-control.test.mjs',
  'raspberry/test/gatt-mutual-auth.test.mjs',
  'raspberry/test/mutual-auth-handshake.test.mjs',
  'raspberry/test/bluez-adapter.test.mjs',
  'raspberry/test/bluez-dbus-port.test.mjs',
  'raspberry/test/bluez-node.test.mjs',
  'raspberry/test/gatt-application.test.mjs',
  'raspberry/test/gatt-server-port.test.mjs',
  'reports/B1_NATIVE_ENROLLMENT_TRANSPORT_20260720.md',
  'reports/B2_ANDROID_DISCOVERY_IMPLEMENTATION_20260719.md',
  'reports/B2_DISCOVERY_CORE_GATE_20260719.md',
  'reports/B4_3_RASPBERRY_PHYSICAL_SERVICEDATA_20260720.md',
  'reports/B4_4_PHYSICAL_COLLECTION_PROGRESS_20260720.md',
  'reports/B4_4_TEN_DEVICE_GATE_HARNESS_20260720.md',
  'reports/B4_RASPBERRY_BLUEZ_DBUS_ADAPTER_20260720.md',
  'reports/B5_1_DIRECT_SESSION_CORE_20260720.md',
  'reports/B5_2_RASPBERRY_GATT_SERVER_20260720.md',
  'reports/B5_3_RASPBERRY_GATT_PHYSICAL_20260720.md',
  'reports/B5_4_ANDROID_GATT_CLIENT_20260720.md',
  'reports/B5_5_ANDROID_RASPBERRY_HELLO_20260720.md',
  'reports/B5_6_MUTUAL_AUTH_20260721.md',
  'reports/B5_7_DIRECT_CONTROL_20260721.md',
  'reports/B5_HUNDRED_SESSION_GATE_PREPARATION_20260803.md',
  'reports/B5_OFFLINE_CERTIFICATION_HARDENING_20260803.md',
  'reports/V5BT_PALMARE_LAB_RECERTIFICATION_20260804.md',
  'reports/V5BT_B4_MATRIX3_LEDGER_INITIALIZATION_20260805.md',
  'reports/V5BT_B4_TWO_PHYSICAL_EIGHT_SIMULATED_NON_GATE_20260806.md',
  'reports/V5BT_TWO_ANDROID_PHYSICAL_RESUME_20260803.md',
  'reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json',
  'reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md',
  'reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.json',
  'reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md',
  'reports/physical/V5BT_B11_MIXED_PHYSICAL_ATTESTATION_REDACTED_20260818.json',
  'reports/physical/v5bt-b0-two-handheld-supplemental-20260803.json',
  'reports/physical/v5bt-b0-two-handheld-supplemental-20260804.json',
  'reports/physical/v5bt-b2-two-handheld-non-gate-20260803.json',
  'reports/physical/v5bt-b2-two-handheld-non-gate-20260803-retry1.json',
  'reports/physical/v5bt-b2-two-handheld-non-gate-20260803-retry2.json',
  'reports/physical/v5bt-b2-two-handheld-non-gate-20260804-retry3.json',
  'reports/physical/v5bt-b4-3-servicedata-gate-20260720.json',
  'reports/physical/v5bt-b4-4-collection-progress-20260720.json',
  'reports/physical/v5bt-b5-3-gatt-smoke-20260720.json',
  'reports/physical/v5bt-b5-4-android-gatt-client-20260720.json',
  'reports/physical/v5bt-b5-5-android-hello-20260720.json',
  'reports/physical/v5bt-b5-5-raspberry-hello-20260720.json',
  'reports/physical/v5bt-raspberry-continuity-supplemental-20260804.json',
  'reports/physical/v5bt-two-handheld-final-inventory-redacted-20260804.json',
  'reports/V5BT_ANDROID_ENROLLMENT_DISCOVERY_BUILD_20260720.md',
  'scripts/collect-b4-physical-device.mjs',
  'scripts/collect-b4-physical-device.test.mjs',
  'scripts/current-roadmap-status.mjs',
  'scripts/current-roadmap-status.test.mjs',
  'scripts/run-b4-monitored-slot-gate.mjs',
  'scripts/run-b4-monitored-slot-gate.test.mjs',
  'scripts/run-b4-offline-hybrid-non-gate.mjs',
  'scripts/run-b4-offline-hybrid-non-gate.test.mjs',
  'scripts/advanced-certification-targets.mjs',
  'scripts/advanced-certification-targets.test.mjs',
  'scripts/b5-account-device-commitment.mjs',
  'scripts/b5-account-device-commitment.test.mjs',
  'scripts/b5-campaign-governance.mjs',
  'scripts/b5-campaign-governance.test.mjs',
  'scripts/b5-technical-receipt.mjs',
  'scripts/generate-device-capability-report.mjs',
  'scripts/generate-device-capability-report.test.mjs',
  'scripts/generate-roadmap-manifest.mjs',
  'scripts/roadmap-package-inventory.mjs',
  'scripts/roadmap-package-inventory.test.mjs',
  'scripts/run-b0-android-supplemental-gate.mjs',
  'scripts/run-b0-android-supplemental-gate.test.mjs',
  'scripts/run-b0-android-formal-gate.mjs',
  'scripts/run-b0-android-formal-gate.test.mjs',
  'scripts/run-api31-compat-non-gate.mjs',
  'scripts/run-api31-compat-non-gate.test.mjs',
  'scripts/run-b5-android-continuity-monitor.mjs',
  'scripts/run-b5-android-continuity-monitor.test.mjs',
  'scripts/run-b5-raspberry-continuity-monitor.mjs',
  'scripts/run-b5-raspberry-continuity-monitor.test.mjs',
  'scripts/validate-contracts.mjs',
  'scripts/run-b2-android-adb-harness.mjs',
  'scripts/run-b2-android-adb-harness.test.mjs',
  'scripts/run-b2-android-gate.mjs',
  'scripts/run-b2-android-gate.test.mjs',
  'scripts/run-b3-android-service-gate.mjs',
  'scripts/run-b3-android-service-gate.test.mjs',
  'scripts/simulate-discovery-soft-state.mjs',
  'shared/discovery/README.md',
  'shared/discovery/peer-directory-v1.mjs',
  'shared/discovery/peer-directory-v1.test.mjs',
  'shared/discovery/scan-window-policy-v1.mjs',
  'shared/discovery/scan-window-policy-v1.test.mjs',
  'shared/protocol/gatt-profile-v1.d.mts',
  'shared/protocol/gatt-profile-v1.mjs',
  'shared/protocol/gatt-profile-v1.test.mjs',
  'shared/protocol/hello-v1.d.mts',
  'shared/protocol/hello-v1.mjs',
  'shared/protocol/hello-v1.test.mjs',
  'shared/protocol/direct-control-v1.d.mts',
  'shared/protocol/direct-control-v1.mjs',
  'shared/protocol/direct-control-v1.test.mjs',
  'shared/protocol/mutual-auth-v1.d.mts',
  'shared/protocol/mutual-auth-v1.mjs',
  'shared/protocol/mutual-auth-v1.test.mjs',
  'shared/provisioning/device-registry-v1.d.mts',
  'shared/provisioning/device-registry-v1.mjs',
  'shared/provisioning/device-registry-v1.test.mjs',
  'shared/provisioning/enrollment-transport-v1.mjs',
  'shared/provisioning/enrollment-transport-v1.test.mjs',
  'shared/session/README.md',
  'shared/session/direct-session-v1.d.mts',
  'shared/session/direct-session-v1.mjs',
  'shared/session/direct-session-v1.test.mjs',
  'testing/B2_ANDROID_ADB_HARNESS.md',
  'testing/B4_RASPBERRY_PHYSICAL_GATE.md',
  'testing/B4_TEN_DEVICE_GATE.md',
  'testing/B5_ANDROID_GATT_CLIENT.md',
  'testing/B5_ANDROID_RASPBERRY_HELLO.md',
  'testing/B5_ANDROID_RASPBERRY_MUTUAL_AUTH.md',
  'testing/B5_ANDROID_RASPBERRY_DIRECT_CONTROL.md',
  'testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md',
  'testing/B5_RASPBERRY_GATT_PHYSICAL_SMOKE.md',
  'checklists/B5_PHYSICAL_CAMPAIGN_CHECKLIST.md',
  'raspberry/scripts/collect-b5-direct-control-session.mjs',
  'raspberry/scripts/run-b5-hundred-session-gate.mjs',
  'raspberry/test/b5-direct-control-session-collector.test.mjs',
  'raspberry/test/b5-hundred-session-gate.test.mjs',
  'testing/MASTER_TEST_PLAN.md',
  'checklists/B0_DEVICE_CAPABILITY_CHECKLIST.md'
];
const workspaceRoot=path.resolve(root,'..','..');
const workspaceRequired=[
  'scripts/run-b11-mixed-physical-collector.mjs',
  'scripts/run-v5bt-bench-inventory.mjs',
  'scripts/run-v5bt-b4-android-continuity-monitor.mjs',
  'scripts/run-v5bt-b4-raspberry-continuity-monitor.mjs',
  'scripts/run-v5bt-physical-raspberry-monitor.mjs',
  'scripts/verify-v5bt-advanced-build-consistency.mjs',
  'tests/run-b11-mixed-physical-collector.test.mjs',
  'tests/run-v5bt-bench-inventory.test.mjs',
  'tests/run-v5bt-b4-android-continuity-monitor.test.mjs',
  'tests/run-v5bt-b4-raspberry-continuity-monitor.test.mjs',
  'tests/run-v5bt-physical-raspberry-monitor.test.mjs',
  'tests/verify-v5bt-advanced-build-consistency.test.mjs'
];
const missing=[
  ...required.filter(x=>!fs.existsSync(path.join(root,x))),
  ...workspaceRequired
    .filter(x=>!fs.existsSync(path.join(workspaceRoot,x)))
    .map(x=>`workspace:${x}`)
];
const isolationErrors=[];
const manifestErrors=[];
const externalEvidenceBlockers=[];
let currentRoadmapStatus=null;
if(
  ADVANCED_CERTIFICATION_TARGETS.schemaVersion!==3||
  Object.values(ADVANCED_CERTIFICATION_TARGETS.roles).some(
    target=>
      typeof target.signingCertificateSha256!=="string"||
      !/^[0-9a-f]{64}$/.test(target.signingCertificateSha256)||
      /^0{64}$/.test(target.signingCertificateSha256)
  )
){
  isolationErrors.push('Certification target matrix must pin one signing certificate per role');
}
try{
  currentRoadmapStatus=loadCurrentRoadmapStatus(
    path.join(root,'configs/current-roadmap-status.json'),
    {matrixBinding:ADVANCED_CERTIFICATION_TARGETS_BINDING}
  );
}catch(error){
  isolationErrors.push(
    `Current roadmap status is invalid or stale: ${error instanceof Error?error.message:'unknown error'}`
  );
}
try{
  const manifestResult=compareRoadmapManifest(root,path.join(root,'MANIFEST.txt'));
  manifestErrors.push(...manifestResult.errors);
  manifestErrors.push(
    ...manifestResult.missingFromManifest.map(
      entry=>`Package file is missing from MANIFEST.txt: ${entry}`
    )
  );
  manifestErrors.push(
    ...manifestResult.missingFromPackage.map(
      entry=>`MANIFEST.txt references an unavailable package file: ${entry}`
    )
  );
}catch(error){
  manifestErrors.push(`Manifest inventory failed: ${error instanceof Error?error.message:'unknown error'}`);
}
const externalEvidenceStatusPath=path.join(root,'configs/external-evidence-status.json');
if(fs.existsSync(externalEvidenceStatusPath)){
  try{
    const status=JSON.parse(fs.readFileSync(externalEvidenceStatusPath,'utf8'));
    const topLevelFields=Object.keys(status).sort();
    const expectedTopLevelFields=['items','promotionAllowed','schemaVersion','statusAsOf'];
    if(JSON.stringify(topLevelFields)!==JSON.stringify(expectedTopLevelFields)){
      isolationErrors.push('External evidence status fields do not match the package contract');
    }
    if(
      status.schemaVersion!==1||
      status.promotionAllowed!==false||
      typeof status.statusAsOf!=='string'||
      !Array.isArray(status.items)||
      status.items.length===0
    ){
      isolationErrors.push('External evidence status header is invalid');
    }else{
      const seenExternalPaths=new Set();
      for(const item of status.items){
        const fields=Object.keys(item??{}).sort();
        if(
          JSON.stringify(fields)!==JSON.stringify(['mustNotBeSynthesized','path','status'])||
          typeof item.path!=='string'||
          item.status!=='UNAVAILABLE'||
          item.mustNotBeSynthesized!==true||
          path.isAbsolute(item.path)||
          item.path.split('/').includes('..')||
          seenExternalPaths.has(item.path)||
          fs.existsSync(path.join(root,item.path))
        ){
          isolationErrors.push('External evidence blocker is malformed, duplicated or stale');
          continue;
        }
        seenExternalPaths.add(item.path);
        externalEvidenceBlockers.push({path:item.path,status:item.status});
      }
      const sortedPaths=[...seenExternalPaths].sort((left,right)=>left.localeCompare(right,'en'));
      if([...seenExternalPaths].some((entry,index)=>entry!==sortedPaths[index])){
        isolationErrors.push('External evidence blockers must be sorted canonically');
      }
    }
  }catch{
    isolationErrors.push('External evidence status is malformed');
  }
}
const raspberryEnvironmentPath=path.join(root,'configs/raspberry.env.example');
const enrollmentEnvironmentExamplePath=path.join(root,'configs/cassav5bt-bluetooth-enrollment.env.example');
const enrollmentUnitPath=path.join(root,'raspberry/systemd/cassav5bt-bluetooth-enrollment.service');
const bluezNodeUnitPath=path.join(root,'raspberry/systemd/cassav5bt-bluetooth-node.service');
const raspberryPackagePath=path.join(root,'raspberry/package.json');
const b4PhysicalReportPath=path.join(root,'reports/physical/v5bt-b4-3-servicedata-gate-20260720.json');
const b4PhysicalLogPath=path.join(root,'reports/physical/v5bt-b4-3-servicedata-node-20260720.log');
const b4CollectionProgressPath=path.join(root,'reports/physical/v5bt-b4-4-collection-progress-20260720.json');
const b5GattPhysicalReportPath=path.join(root,'reports/physical/v5bt-b5-3-gatt-smoke-20260720.json');
const b5AndroidGattPhysicalReportPath=path.join(root,'reports/physical/v5bt-b5-4-android-gatt-client-20260720.json');
const b55AndroidHelloReportPath=path.join(root,'reports/physical/v5bt-b5-5-android-hello-20260720.json');
const b55RaspberryHelloReportPath=path.join(root,'reports/physical/v5bt-b5-5-raspberry-hello-20260720.json');
const b5GattSmokeHarnessPath=path.join(root,'raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs');
const gitignorePath=path.join(root,'.gitignore');
const b0FormalGatePath=path.join(root,'scripts/run-b0-android-formal-gate.mjs');
const b4CollectorPath=path.join(root,'scripts/collect-b4-physical-device.mjs');
const b4MonitoredSlotGatePath=path.join(root,'scripts/run-b4-monitored-slot-gate.mjs');
const b4HybridNonGatePath=path.join(root,'scripts/run-b4-offline-hybrid-non-gate.mjs');
const api31CompatNonGatePath=path.join(root,'scripts/run-api31-compat-non-gate.mjs');
const b11MaximumVirtualizedNonGatePath=path.join(root,'raspberry/scripts/run-b11-software-non-gate.mjs');
const b11MaximumVirtualizedSchemaPath=path.join(root,'contracts/b11-maximum-virtualized-system-non-gate-v2.schema.json');
const b11MaximumVirtualizedReportPath=path.join(root,'reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json');
const b11MixedPhysicalCollectorPath=path.join(workspaceRoot,'scripts/run-b11-mixed-physical-collector.mjs');
const b11MixedPhysicalAttestationSchemaPath=path.join(root,'contracts/b11-mixed-physical-attestation-v1.schema.json');
const b11MixedPhysicalAttestationPath=path.join(root,'reports/physical/V5BT_B11_MIXED_PHYSICAL_ATTESTATION_REDACTED_20260818.json');
const b11MixedPhysicalVirtualNonGatePath=path.join(root,'raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs');
const b11MixedPhysicalVirtualSchemaPath=path.join(root,'contracts/b11-mixed-physical-virtual-non-gate-v3.schema.json');
const b11MixedPhysicalVirtualReportPath=path.join(root,'reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.json');
const b4AuthoritativeGatePath=path.join(root,'raspberry/scripts/run-b4-ten-device-gate.mjs');
const b4AndroidMonitorPath=path.join(workspaceRoot,'scripts/run-v5bt-b4-android-continuity-monitor.mjs');
const b4RaspberryMonitorPath=path.join(workspaceRoot,'scripts/run-v5bt-b4-raspberry-continuity-monitor.mjs');
const b5CollectorPath=path.join(root,'raspberry/scripts/collect-b5-direct-control-session.mjs');
const b5AndroidMonitorPath=path.join(root,'scripts/run-b5-android-continuity-monitor.mjs');
const b5RaspberryMonitorPath=path.join(root,'scripts/run-b5-raspberry-continuity-monitor.mjs');
const b5CampaignGovernancePath=path.join(root,'scripts/b5-campaign-governance.mjs');
const b5AccountDeviceCommitmentPath=path.join(root,'scripts/b5-account-device-commitment.mjs');
const b5TechnicalReceiptPath=path.join(root,'scripts/b5-technical-receipt.mjs');
const b5TechnicalReceiptSchemaPath=path.join(root,'contracts/b5-technical-receipt-v1.schema.json');
const b5CampaignSupervisorPath=path.join(root,'raspberry/scripts/run-b5-campaign-supervisor.mjs');
const b5HundredSessionGatePath=path.join(root,'raspberry/scripts/run-b5-hundred-session-gate.mjs');
const b5PromotionGatePath=path.join(root,'raspberry/scripts/run-b5-promotion-gate.mjs');
const benchInventoryPath=path.join(workspaceRoot,'scripts/run-v5bt-bench-inventory.mjs');
const buildConsistencyPath=path.join(workspaceRoot,'scripts/verify-v5bt-advanced-build-consistency.mjs');
const directSessionPath=path.join(root,'shared/session/direct-session-v1.mjs');
const directSessionPattern='^[A-Za-z0-9_-]{21}[AQgw]$';
const raspberryRuntimePaths=[
  path.join(root,'raspberry/src/index.ts'),
  path.join(root,'raspberry/src/node/BluezNode.ts')
];
const certificationMatrixConsumers=[
  'scripts/run-b0-android-formal-gate.mjs',
  'scripts/run-b2-android-gate.mjs',
  'scripts/run-b2-android-adb-harness.mjs',
  'scripts/run-b3-android-service-gate.mjs',
  'scripts/collect-b4-physical-device.mjs',
  'raspberry/scripts/run-b4-ten-device-gate.mjs',
  'scripts/run-b5-android-continuity-monitor.mjs'
];
const b5CorePath=path.join(root,'shared/session/direct-session-v1.mjs');
const raspberryIndexPath=path.join(root,'raspberry/src/index.ts');
const bluezNodePath=path.join(root,'raspberry/src/node/BluezNode.ts');
const nodeConfigPath=path.join(root,'raspberry/src/config/NodeConfig.ts');
const gattApplicationPath=path.join(root,'raspberry/src/bluez/GattApplication.ts');
const gattServerPortPath=path.join(root,'raspberry/src/bluez/DbusNextGattServerPort.ts');
const gattServicePath=path.join(root,'raspberry/src/gatt/CassaGattService.ts');
for(const relativePath of certificationMatrixConsumers){
  const consumerPath=path.join(root,relativePath);
  if(
    fs.existsSync(consumerPath)&&
    !fs.readFileSync(consumerPath,'utf8').includes('advanced-certification-targets.mjs')
  ){
    isolationErrors.push(`Certification target matrix is not consumed by ${relativePath}`);
  }
}
if(fs.existsSync(b4HybridNonGatePath)){
  const hybridNonGate=fs.readFileSync(b4HybridNonGatePath,'utf8');
  for(const requiredControl of [
    'withB4CollectionStateLock',
    'normalizePublicReport',
    'deepFreeze',
    'NON_GATE_EVIDENCE',
    'simulatedDevicesCountedTowardGate: 0',
    'b4TenPhysicalDeviceGate: "PENDING"',
    'OUTPUT_NOT_SEPARATED',
    'OUTPUT_ROLLBACK_INCOMPLETE',
    'fsyncDirectory(parent)'
  ]){
    if(!hybridNonGate.includes(requiredControl)){
      isolationErrors.push(`B4 hybrid non-gate runner is missing control: ${requiredControl}`);
    }
  }
  if(/export\s+function\s+writeB4OfflineHybridReportNoOverwrite/u.test(hybridNonGate)){
    isolationErrors.push('B4 hybrid non-gate report writer must remain internal');
  }
}
if(fs.existsSync(api31CompatNonGatePath)){
  const api31CompatNonGate=fs.readFileSync(api31CompatNonGatePath,'utf8');
  for(const requiredControl of [
    'API31_COMPAT_NON_GATE',
    'NON_GATE_EVIDENCE',
    'gateImpact: "NONE"',
    'b0DeviceCapabilityGate: "PENDING"',
    'b1EnrollmentGate: "PENDING"',
    'b2DiscoveryGate: "PENDING"',
    'b3SoakGate: "PENDING"',
    'b5HundredSessionGate: "PENDING"',
    'b6AndroidPairGate: "BLOCKED"',
    'formalGateEligible: false',
    'TEST_CONFIGURATION_ONLY',
    'API31_COMPAT_TEST_CONFIGURATION_NOT_PHYSICAL',
    'acceptedAsFormalEvidence: false',
    'officialCampaignAuthorized: false',
    'authoritativeGateExecuted: false',
    'gatePromoted: false',
    'roadmapStatusChanged: false',
    '"/v2/enroll"',
    'status.nlink !== 1',
    'fs.constants.O_EXCL',
    'fs.constants.O_NOFOLLOW',
    'OUTPUT_ROLLBACK_INCOMPLETE',
    'currentIdentity.dev === createdIdentity.dev'
  ]){
    if(!api31CompatNonGate.includes(requiredControl)){
      isolationErrors.push(`API31 compatibility runner is missing non-gate control: ${requiredControl}`);
    }
  }
  if(/export\s+function\s+writeReportExclusive/u.test(api31CompatNonGate)){
    isolationErrors.push('API31 compatibility report writer must remain internal');
  }
}
if(fs.existsSync(b11MaximumVirtualizedNonGatePath)){
  const b11MaximumVirtualizedNonGate=fs.readFileSync(b11MaximumVirtualizedNonGatePath,'utf8');
  for(const requiredControl of [
    'schemaVersion: 2',
    'MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE',
    'evidenceClass: "NON_GATE_EVIDENCE"',
    'gateImpact: "NONE"',
    'promotionAllowed: false',
    'officialEvidence: false',
    'statusMutationAllowed: false',
    'officialProgressPercent: B11_OFFICIAL_PROGRESS_PERCENT',
    'b11Gate: "PENDING"',
    'hardwareAccess: false',
    'radioAccess: false',
    'adbAccess: false',
    'sshAccess: false',
    'serviceAccess: false',
    'realPeripheralAccess: false',
    'report.businessPlane?.bluetoothBusinessMessagesForwarded !== 0',
    'validateB11HybridSoftwareNonGateReport'
  ]){
    if(!b11MaximumVirtualizedNonGate.includes(requiredControl)){
      isolationErrors.push(`B11 maximum virtualized runner is missing non-gate control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b11MaximumVirtualizedSchemaPath)){
  try{
    const schemaBytes=fs.readFileSync(b11MaximumVirtualizedSchemaPath);
    const schemaHash=crypto.createHash('sha256').update(schemaBytes).digest('hex');
    const schema=JSON.parse(schemaBytes.toString('utf8'));
    const properties=schema.properties??{};
    if(
      schemaHash!=='1c9bce096fd18a3730333128d6edf4315ae05312ce6f5cfca86a4c7fb7e6b520'||
      schema.additionalProperties!==false||
      properties.schemaVersion?.const!==2||
      properties.mode?.const!=='MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE'||
      properties.evidenceClass?.const!=='NON_GATE_EVIDENCE'||
      properties.gateImpact?.const!=='NONE'||
      properties.promotionAllowed?.const!==false||
      properties.officialEvidence?.const!==false||
      properties.statusMutationAllowed?.const!==false||
      properties.officialProgressPercent?.const!==49||
      properties.b11Gate?.const!=='PENDING'||
      properties.hardwareAccess?.const!==false||
      properties.radioAccess?.const!==false||
      properties.adbAccess?.const!==false||
      properties.sshAccess?.const!==false||
      properties.serviceAccess?.const!==false||
      properties.realPeripheralAccess?.const!==false
    ){
      isolationErrors.push('B11 maximum virtualized schema is not safely non-promotable');
    }
  }catch{
    isolationErrors.push('B11 maximum virtualized schema is malformed');
  }
}
if(fs.existsSync(b11MaximumVirtualizedReportPath)){
  try{
    const reportMetadata=fs.lstatSync(b11MaximumVirtualizedReportPath);
    const reportBytes=fs.readFileSync(b11MaximumVirtualizedReportPath);
    const reportFileHash=crypto.createHash('sha256').update(reportBytes).digest('hex');
    const report=JSON.parse(reportBytes.toString('utf8'));
    const {reportDigest,...reportBody}=report;
    const calculatedDigest=crypto.createHash('sha256').update(JSON.stringify(reportBody)).digest('hex');
    const schema=JSON.parse(fs.readFileSync(b11MaximumVirtualizedSchemaPath,'utf8'));
    const expectedTopLevelKeys=[...(schema.required??[])].sort((left,right)=>left.localeCompare(right,'en'));
    const actualTopLevelKeys=Object.keys(report).sort((left,right)=>left.localeCompare(right,'en'));
    if(
      !reportMetadata.isFile()||
      reportMetadata.isSymbolicLink()||
      reportMetadata.nlink!==1||
      (reportMetadata.mode&0o777)!==0o600||
      reportFileHash!=='a439a52f1d7b2405359509f7c715a5f68ea7f673b0d86ea1b468f7c02ae0629a'||
      reportDigest!=='6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37'||
      calculatedDigest!==reportDigest||
      JSON.stringify(actualTopLevelKeys)!==JSON.stringify(expectedTopLevelKeys)||
      report.schemaVersion!==2||
      report.mode!=='MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE'||
      report.evidenceClass!=='NON_GATE_EVIDENCE'||
      report.gateImpact!=='NONE'||
      report.promotionAllowed!==false||
      report.officialEvidence!==false||
      report.statusMutationAllowed!==false||
      report.officialProgressPercent!==49||
      report.b11Gate!=='PENDING'||
      report.hardwareAccess!==false||
      report.radioAccess!==false||
      report.adbAccess!==false||
      report.sshAccess!==false||
      report.serviceAccess!==false||
      report.realPeripheralAccess!==false||
      report.verdict!=='NON_GATE_PASS'||
      report.timeBasis!=='VIRTUAL_MONOTONIC'||
      !/^[a-f0-9]{64}$/u.test(report.seedCommitment)||
      report.actors?.totalActors!==16||
      report.actors?.virtualizedActors!==16||
      report.actors?.physicalActors!==0||
      report.actors?.roles?.HANDHELD!==10||
      report.actors?.roles?.STATION!==3||
      report.actors?.roles?.RASPBERRY_VIRTUAL!==1||
      report.actors?.roles?.AUTOMATIC_CASH_VIRTUAL!==1||
      report.actors?.roles?.FISCAL_RT_VIRTUAL!==1||
      report.topology?.nodeCount!==14||
      report.topology?.usefulPairCount!==91||
      report.workload?.expectedConnectDisconnectCycles!==9100||
      report.workload?.completedConnectDisconnectCycles!==9100||
      report.businessPlane?.bluetoothBusinessMessagesForwarded!==0||
      report.businessWorkload?.expectedActions!==2600||
      report.businessWorkload?.completedActions!==2600||
      report.businessWorkload?.automaticCash?.completedTransactions!==100||
      report.businessWorkload?.fiscalRt?.completedTransactions!==100||
      report.businessWorkload?.bluetoothBusinessMessagesForwarded!==0||
      report.businessWorkload?.externalAccess!==false||
      report.virtualPeripherals?.realInstances!==0||
      report.persistence?.openSessionCount!==0||
      report.persistence?.outboxDepth!==0||
      report.teardown?.temporaryWorkspaceRemoved!==true||
      report.teardown?.persistentArtifactsRetained!==0||
      Object.keys(report.checks??{}).length!==28||
      Object.values(report.checks??{}).some((value)=>value!==true)
    ){
      isolationErrors.push('B11 maximum virtualized report is not a complete offline PASS');
    }
  }catch{
    isolationErrors.push('B11 maximum virtualized report failed immutable package validation');
  }
}
if(fs.existsSync(b11MixedPhysicalCollectorPath)){
  const collector=fs.readFileSync(b11MixedPhysicalCollectorPath,'utf8');
  for(const requiredControl of [
    'B11_MIXED_PHYSICAL_ATTESTATION',
    'FIXTURE_FORBIDDEN',
    'captureMode === "LIVE"',
    'fixtureUsed: captureMode !== "LIVE"',
    'configuredPhysicalActors: 4',
    'captureScope: "INVENTORY_ONLY"',
    'hardwareAccess: captureMode === "LIVE"',
    'readOnly: true',
    'stationSigningPolicy',
    'secureWriteJsonNoOverwrite'
  ]){
    if(!collector.includes(requiredControl)){
      isolationErrors.push(`B11 mixed physical collector is missing control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b11MixedPhysicalVirtualNonGatePath)){
  const composer=fs.readFileSync(b11MixedPhysicalVirtualNonGatePath,'utf8');
  for(const requiredControl of [
    'MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE',
    'MIXED_NON_GATE_INCOMPLETE',
    'v3 accepts only inventory evidence with every physical campaign NOT_RUN',
    'gateImpact: "NONE"',
    'promotionAllowed: false',
    'officialEvidence: false',
    'statusMutationAllowed: false',
    'b11Gate: "PENDING"',
    'virtualSubstitutionAllowed: false',
    'physicalSlotSurrogateCyclesExcluded: 600',
    'softwareAttributedCycles: 8_500',
    'B11_MIXED_REQUIRED_PHYSICAL_CYCLES = 600',
    'readSecureJsonBytes',
    'writeB11MixedPhysicalVirtualReport',
    'both evidence inputs and --output are required'
  ]){
    if(!composer.includes(requiredControl)){
      isolationErrors.push(`B11 mixed composer is missing non-gate control: ${requiredControl}`);
    }
  }
}
for(const [schemaPath,expectedHash,expectedVersion,expectedMode] of [
  [
    b11MixedPhysicalAttestationSchemaPath,
    '545b47dae7711d3675946881d0442f612d5a9bb4eaae327b6a8c145fb188f1b6',
    1,
    'B11_MIXED_PHYSICAL_ATTESTATION'
  ],
  [
    b11MixedPhysicalVirtualSchemaPath,
    '8b70d646a45cc89c998275bd0342d17c06c1c9b13c48a7f1906ce7be2bf3f946',
    3,
    'MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE'
  ]
]){
  if(!fs.existsSync(schemaPath))continue;
  try{
    const schemaBytes=fs.readFileSync(schemaPath);
    const schemaHash=crypto.createHash('sha256').update(schemaBytes).digest('hex');
    const schema=JSON.parse(schemaBytes.toString('utf8'));
    const incompleteOnly=
      expectedVersion===1
        ? schema.properties?.captureScope?.const==='INVENTORY_ONLY'
        : schema.properties?.verdict?.const==='MIXED_NON_GATE_INCOMPLETE';
    if(
      schemaHash!==expectedHash||
      schema.additionalProperties!==false||
      schema.properties?.schemaVersion?.const!==expectedVersion||
      schema.properties?.mode?.const!==expectedMode||
      !incompleteOnly
    ){
      isolationErrors.push(`B11 mixed schema contract changed: ${path.relative(root,schemaPath)}`);
    }
  }catch{
    isolationErrors.push(`B11 mixed schema is malformed: ${path.relative(root,schemaPath)}`);
  }
}
let b11MixedAttestation=null;
let b11MixedAttestationFileHash=null;
if(fs.existsSync(b11MixedPhysicalAttestationPath)){
  try{
    const metadata=fs.lstatSync(b11MixedPhysicalAttestationPath);
    const bytes=fs.readFileSync(b11MixedPhysicalAttestationPath);
    b11MixedAttestationFileHash=crypto.createHash('sha256').update(bytes).digest('hex');
    b11MixedAttestation=JSON.parse(bytes.toString('utf8'));
    validateB11MixedPhysicalAttestation(b11MixedAttestation,{
      now:new Date(b11MixedAttestation.generatedAt)
    });
    if(
      !metadata.isFile()||
      metadata.isSymbolicLink()||
      metadata.nlink!==1||
      (metadata.mode&0o777)!==0o600||
      b11MixedAttestationFileHash!=='b57275d16504e7b6a017cd4be38a36883aadb971a665bd46cf71f9c5bbd7c587'||
      b11MixedAttestation.captureMode!=='LIVE'||
      b11MixedAttestation.fixtureUsed!==false||
      b11MixedAttestation.readinessStatus!=='MIXED_PHYSICAL_INCOMPLETE'||
      b11MixedAttestation.configuredPhysicalActors!==4||
      b11MixedAttestation.observedPhysicalActors!==2||
      b11MixedAttestation.physicalPresenceComplete!==false||
      b11MixedAttestation.functionalReadinessComplete!==false||
      b11MixedAttestation.stationSigningPolicy!=='WAIVED_NON_GATE'||
      b11MixedAttestation.stationSigningVerified!==false||
      b11MixedAttestation.gateEligible!==false||
      b11MixedAttestation.inventory?.adb?.connectedDevices!==2||
      b11MixedAttestation.inventory?.android?.filter(entry=>entry.role==='handheld'&&entry.connected===true).length!==2||
      b11MixedAttestation.inventory?.android?.filter(entry=>entry.role==='station'&&entry.connected===true).length!==0||
      b11MixedAttestation.inventory?.raspberry?.reachable!==false||
      b11MixedAttestation.radioWorkload?.status!=='NOT_RUN'||
      b11MixedAttestation.physicalBusiness?.status!=='NOT_RUN'||
      b11MixedAttestation.continuityMonitoring?.status!=='NOT_RUN'||
      b11MixedAttestation.physicalSoak?.status!=='NOT_RUN'||
      b11MixedAttestation.campaignEvidenceCommitment!==null
    ){
      isolationErrors.push('B11 mixed physical attestation does not match the redacted incomplete capture');
    }
  }catch{
    isolationErrors.push('B11 mixed physical attestation failed immutable package validation');
  }
}
if(fs.existsSync(b11MixedPhysicalVirtualReportPath)){
  try{
    const metadata=fs.lstatSync(b11MixedPhysicalVirtualReportPath);
    const bytes=fs.readFileSync(b11MixedPhysicalVirtualReportPath);
    const reportFileHash=crypto.createHash('sha256').update(bytes).digest('hex');
    const report=JSON.parse(bytes.toString('utf8'));
    validateB11MixedPhysicalVirtualReport(report);
    if(
      !metadata.isFile()||
      metadata.isSymbolicLink()||
      metadata.nlink!==1||
      (metadata.mode&0o777)!==0o600||
      reportFileHash!=='b509cb32b0a71a61edd8f0f2da73dc4d1f66aafc4788ed4bdcc06f44e90f90e2'||
      report.reportDigest!=='79b733a08b0a32cc6bc579bfb94f63d992ec195ad2451b4ab8b4560fd25c79ea'||
      report.verdict!=='MIXED_NON_GATE_INCOMPLETE'||
      report.gateImpact!=='NONE'||
      report.promotionAllowed!==false||
      report.officialEvidence!==false||
      report.statusMutationAllowed!==false||
      report.officialProgressPercent!==49||
      report.b11Gate!=='PENDING'||
      report.actorInventory?.roles?.HANDHELD?.physical!==2||
      report.actorInventory?.roles?.HANDHELD?.virtual!==8||
      report.actorInventory?.roles?.STATION?.physical!==1||
      report.actorInventory?.roles?.STATION?.virtual!==2||
      report.actorInventory?.roles?.RASPBERRY?.physical!==1||
      report.physicalPresence?.observedPhysicalActors!==2||
      report.physicalPresence?.observedHandhelds!==2||
      report.physicalPresence?.observedStations!==0||
      report.physicalPresence?.observedRaspberry!==0||
      report.physicalPresence?.virtualSubstitutionAllowed!==false||
      report.coveragePartition?.realReal?.completedPhysicalCycles!==0||
      report.coveragePartition?.logicalCrossDomain?.completedSoftwareCycles!==4000||
      report.coveragePartition?.virtualOnly?.completedSoftwareCycles!==4500||
      report.simulatedScaleCoverage?.softwareAttributedCycles!==8500||
      report.simulatedScaleCoverage?.physicalSlotSurrogateCyclesExcluded!==600||
      report.virtualPeripherals?.realInstances!==0||
      report.sourceBindings?.physicalAttestationSha256!==b11MixedAttestationFileHash||
      report.sourceBindings?.physicalAttestationDigest!==b11MixedAttestation?.attestationDigest||
      report.sourceBindings?.physicalInventorySha256!==b11MixedAttestation?.inventorySha256||
      report.sourceBindings?.simulatedReportSha256!=='a439a52f1d7b2405359509f7c715a5f68ea7f673b0d86ea1b468f7c02ae0629a'||
      report.sourceBindings?.simulatedReportDigest!=='6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37'
    ){
      isolationErrors.push('B11 mixed report does not match the immutable incomplete mixed evidence');
    }
  }catch{
    isolationErrors.push('B11 mixed report failed immutable package validation');
  }
}
for(const physicalGatePath of [b4AuthoritativeGatePath,b5HundredSessionGatePath,b5PromotionGatePath]){
  if(!fs.existsSync(physicalGatePath))continue;
  const physicalGate=fs.readFileSync(physicalGatePath,'utf8');
  for(const forbiddenReference of [
    'MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE',
    'V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM',
    'MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE',
    'V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL',
    '--virtualized-report'
  ]){
    if(physicalGate.includes(forbiddenReference)){
      isolationErrors.push(`Physical gate must not consume B11 virtual evidence: ${path.relative(root,physicalGatePath)}`);
    }
  }
}
if(fs.existsSync(b5CorePath)){
  const b5Core=fs.readFileSync(b5CorePath,'utf8');
  for(const forbiddenReference of ['node:crypto','BluetoothGatt','GattManager1']){
    if(b5Core.includes(forbiddenReference)){
      isolationErrors.push(`B5.1 pure core must not reference ${forbiddenReference}`);
    }
  }
  if(!b5Core.includes('DEFAULT_HEARTBEAT_MISSES_BEFORE_CLOSE = 3')){
    isolationErrors.push('B5.1 core must retain the three-missed-heartbeats fail-closed threshold');
  }
}
for(const runtimePath of [raspberryIndexPath,bluezNodePath]){
  if(!fs.existsSync(runtimePath))continue;
  const runtimeSource=fs.readFileSync(runtimePath,'utf8');
  for(const prematureRuntimeReference of [
    'direct-session-v1',
    'DirectSessionV1',
    'SessionManager'
  ]){
    if(runtimeSource.includes(prematureRuntimeReference)){
      isolationErrors.push(
        `B5.1 runtime isolation violated by ${path.relative(root,runtimePath)} reference to ${prematureRuntimeReference}`
      );
    }
  }
}
if(fs.existsSync(gitignorePath)){
  const ignored=fs.readFileSync(gitignorePath,'utf8').split(/\r?\n/);
  for(const pattern of [
    '*.b4-device-gate-state.json',
    '*.b4-device-gate-state.json.lock',
    '*.b4-device-gate-state.json.evidence/',
    '*.b5-session-gate-state.json',
    '*.b5-session-gate-state.json.lock',
    '*.b5-session-gate-state.json.pending',
    '*.b5-session-gate-state.json.evidence/'
  ]){
    if(!ignored.includes(pattern)){
      isolationErrors.push(`Missing private collector ignore rule: ${pattern}`);
    }
  }
}
if(fs.existsSync(b5CollectorPath)){
  const collector=fs.readFileSync(b5CollectorPath,'utf8');
  if(/["']--(?:report|runner)["']/.test(collector)){
    isolationErrors.push('B5 collector must not accept report imports or alternate runners');
  }
  for(const requiredControl of [
    'runPhysicalDirectControlSmoke',
    'PHYSICAL_CAPTURE_COMMIT',
    'const STATE_SCHEMA_VERSION = 3',
    'const PREVIOUS_STATE_SCHEMA_VERSION = 2',
    'const LEGACY_STATE_SCHEMA_VERSION = 1',
    'b5AccountDeviceBindingFromPrivateBaseline',
    'createB5AccountDeviceCommitmentSha256',
    'accountDeviceCommitmentSha256',
    'ACCOUNT_DEVICE_COMMITMENT_REQUIRED',
    '"--android-baseline"',
    'reserveCaptureBootId',
    'randomInt(1, 256)',
    'lastCaptureBootId',
    'A legacy collector state containing sessions cannot be upgraded',
    '["--preflight", "PREFLIGHT"]',
    '/usr/bin/flock',
    'RADIO_LOCK_DIRECTORY',
    'Pre-commit crash artifacts are discarded',
    'authoritativeB5GateExecuted: false',
    'b5GatePromoted: false',
    'physicalEvidenceConsumed: false'
  ]){
    if(!collector.includes(requiredControl)){
      isolationErrors.push(`B5 collector is missing fail-closed control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b5AccountDeviceCommitmentPath)){
  const commitment=fs.readFileSync(b5AccountDeviceCommitmentPath,'utf8');
  for(const requiredControl of [
    'V5BT:B5:ACCOUNT_DEVICE_COMMITMENT:1',
    'const BINDING_FIELDS = Object.freeze([',
    'parseB5AccountDeviceBinding',
    'createB5AccountDeviceCommitmentSha256',
    'b5AccountDeviceBindingFromPrivateBaseline',
    'operationalAccount:',
    'deviceIdentity:',
    'packageBuild:',
    'authenticatedSessionCommitmentSha256:',
    'signingCertificateSha256:',
    'createHash("sha256")'
  ]){
    if(!commitment.includes(requiredControl)){
      isolationErrors.push(`B5 account/device commitment is missing canonical control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b5AndroidMonitorPath)){
  const monitor=fs.readFileSync(b5AndroidMonitorPath,'utf8');
  for(const requiredControl of [
    'ADVANCED_CERTIFICATION_TARGETS',
    'parseApplicationExitCommitments',
    'sessionBindingHmac',
    'PROCESS_RESTARTED',
    'REPORTER_RESTARTED',
    'SESSION_BINDING_CHANGED',
    'AGENT_LIFECYCLE_CHANGED',
    'atomicWritePrivateJson',
    'buildAndroidMonitorSampleOffsets',
    'Math.ceil(durationMs / pollIntervalMs) + 1',
    'Math.min(index * pollIntervalMs, durationMs)',
    'androidMonitorPublicationJournalPath',
    'parseAndroidMonitorPublicationJournal',
    'publishAndroidMonitorArtifacts',
    'recoverAndroidMonitorArtifactPublication',
    '".publication-v1.journal.json"',
    'monitor !== "ANDROID"',
    'mode !== "MONITOR_ARTIFACT_PUBLICATION"',
    'journal.privateSha256 !== sha256(encodePrivateJson(journal.privateDocument))',
    'journal.attestationSha256 !== sha256(encodePrivateJson(journal.attestationDocument))',
    'path.resolve(journal.privateOutput) !== journal.privateOutput',
    'path.resolve(journal.attestationOutput) !== journal.attestationOutput',
    'journal.privateOutput === journal.attestationOutput',
    'new Set([privateOutput, attestationOutput, journalLocation]).size !== 3',
    'assertNoSymlinkComponents',
    'requirePrivateParent',
    'stat.nlink !== 1',
    '(stat.mode & 0o777) !== 0o600',
    '(stat.mode & 0o777) !== 0o700',
    'PRIVATE_OUTPUT_EXISTS',
    'PUBLICATION_CONFLICT',
    'fs.constants.O_EXCL',
    'fs.linkSync',
    'fs.fsyncSync',
    'serialIncluded',
    'processIdentifiersIncluded',
    'b5AccountDeviceBindingFromPrivateBaseline',
    'createB5AccountDeviceCommitmentSha256',
    'accountDeviceCommitmentSha256',
    'accountDeviceCommitmentIncluded',
    'accountDeviceBound',
    'LEGACY_B5_ANDROID_CONTINUITY_MONITOR_VERSION',
    'deviceSerial',
    'androidUserId',
    'appUid',
    'sessionBindingHmacSha256'
  ]){
    if(!monitor.includes(requiredControl)){
      isolationErrors.push(`B5 Android monitor is missing fail-closed control: ${requiredControl}`);
    }
  }
  for(const field of [
    'schemaVersion',
    'product',
    'phase',
    'monitor',
    'mode',
    'transactionId',
    'campaignId',
    'privateOutput',
    'attestationOutput',
    'privateSha256',
    'attestationSha256',
    'privateDocument',
    'attestationDocument'
  ]){
    if(!monitor.includes(`"${field}"`)){
      isolationErrors.push(`B5 Android monitor publication journal omits ${field}`);
    }
  }
}
if(fs.existsSync(b5CampaignSupervisorPath)){
  const supervisor=fs.readFileSync(b5CampaignSupervisorPath,'utf8');
  for(const requiredControl of [
    'const B5_REQUIRED_SESSION_REPORTS = 100',
    'const LEDGER_MODE = "PHYSICAL_B5_CAMPAIGN_SUPERVISION"',
    '["--init", "INIT"]',
    '["--preflight", "PREFLIGHT"]',
    '["--capture", "CAPTURE"]',
    '["--resume", "RESUME"]',
    '["--status", "STATUS"]',
    'DIRECT_CONTROL_ORCHESTRATION_TIMEOUT',
    'consecutiveTimeouts >= 3',
    'status = "SUSPENDED"',
    'status = "INVALIDATED"',
    'cleanupVerified',
    'previousEventSha256',
    'eventSha256',
    'eventCommitment',
    'recoverTransaction',
    'SUPERVISOR_CLOCK_REGRESSION',
    'const suspendedClockInvalidation =',
    'parsed.status === "SUSPENDED"',
    'input?.outcome === "INVALIDATED"',
    'input?.errorCode === "SUPERVISOR_CLOCK_REGRESSION"',
    'status.nlink !== 1',
    'fs.constants.O_EXCL',
    'fs.linkSync'
  ]){
    if(!supervisor.includes(requiredControl)){
      isolationErrors.push(`B5 campaign supervisor is missing fail-closed control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b5RaspberryMonitorPath)){
  const monitor=fs.readFileSync(b5RaspberryMonitorPath,'utf8');
  for(const requiredControl of [
    'const MAIN_SERVICE = "cassav5bt.service"',
    'const BLUETOOTH_SERVICE = "bluetooth.service"',
    '"MainPID"',
    '"NRestarts"',
    '"ActiveEnterTimestampMonotonic"',
    '"ExecMainStartTimestampMonotonic"',
    'BOOT_ID_CHANGED',
    'CLOCK_REGRESSION',
    'POLL_DEADLINE_MISSED',
    '["--capture-baseline", "BASELINE"]',
    '["--monitor", "MONITOR"]',
    'hostnameIncluded',
    'processIdentifiersIncluded',
    'localLocationsIncluded',
    'bootIdIncluded',
    'sourceStatusBodiesIncluded',
    'atomicWriteRaspberryMonitorPrivateJson',
    'raspberryMonitorPublicationJournalPath',
    'parseRaspberryMonitorPublicationJournal',
    'publishRaspberryMonitorArtifacts',
    'recoverRaspberryMonitorArtifactPublication',
    '".publication-v1.journal.json"',
    'monitor !== "RASPBERRY"',
    'mode !== "MONITOR_ARTIFACT_PUBLICATION"',
    'journal.privateSha256 !== sha256(encodePrivateJson(journal.privateDocument))',
    'journal.attestationSha256 !== sha256(encodePrivateJson(journal.attestationDocument))',
    'path.resolve(journal.privateOutput) !== journal.privateOutput',
    'path.resolve(journal.attestationOutput) !== journal.attestationOutput',
    'journal.privateOutput === journal.attestationOutput',
    'new Set([privateOutput, attestationOutput, journalLocation]).size !== 3',
    'assertNoSymlinkComponents',
    'requirePrivateParent',
    'status.nlink !== 1',
    '(status.mode & 0o777) !== 0o600',
    '(status.mode & 0o777) !== 0o700',
    'PRIVATE_OUTPUT_EXISTS',
    'PUBLICATION_CONFLICT',
    'fs.constants.O_EXCL',
    'fs.linkSync',
    'fs.fsyncSync',
    'campaignIdCommitmentSha256'
  ]){
    if(!monitor.includes(requiredControl)){
      isolationErrors.push(`B5 Raspberry monitor is missing fail-closed control: ${requiredControl}`);
    }
  }
  for(const field of [
    'schemaVersion',
    'product',
    'phase',
    'monitor',
    'mode',
    'transactionId',
    'campaignId',
    'privateOutput',
    'attestationOutput',
    'privateSha256',
    'attestationSha256',
    'privateDocument',
    'attestationDocument'
  ]){
    if(!monitor.includes(`"${field}"`)){
      isolationErrors.push(`B5 Raspberry monitor publication journal omits ${field}`);
    }
  }
}
const b5TechnicalReceiptFields=[
  'schemaVersion',
  'receiptVersion',
  'product',
  'phase',
  'mode',
  'issuedAt',
  'technicalAggregateSha256',
  'collectorStateSha256',
  'campaignAuthorizationSha256',
  'certificationMatrixSha256',
  'campaignIdCommitmentSha256',
  'accountDeviceCommitmentSha256',
  'collectionCommitmentSha256',
  'attemptLedgerHeadSha256',
  'prerequisiteEvidenceBundleSha256',
  'operatorCommitmentSha256',
  'androidAttestationSha256',
  'raspberryAttestationSha256',
  'gate',
  'privacy'
];
const b5TechnicalReceiptHashFields=[
  'technicalAggregateSha256',
  'collectorStateSha256',
  'campaignAuthorizationSha256',
  'certificationMatrixSha256',
  'campaignIdCommitmentSha256',
  'accountDeviceCommitmentSha256',
  'collectionCommitmentSha256',
  'attemptLedgerHeadSha256',
  'prerequisiteEvidenceBundleSha256',
  'operatorCommitmentSha256',
  'androidAttestationSha256',
  'raspberryAttestationSha256'
];
if(fs.existsSync(b5TechnicalReceiptPath)){
  const receipt=fs.readFileSync(b5TechnicalReceiptPath,'utf8');
  for(const requiredControl of [
    'const RECEIPT_FIELDS = Object.freeze([',
    'const COMMITMENT_FIELDS = Object.freeze([',
    'parseB5TechnicalReceipt',
    'createB5TechnicalReceipt',
    'requireExactFields(',
    'crypto.timingSafeEqual',
    'for (const field of commitmentFields)',
    'LEGACY_RECEIPT_FIELDS',
    'ACCOUNT_DEVICE_COMMITMENT_REQUIRED',
    'expected[field] !== undefined',
    'constantTimeHexEqual(value[field], expected[field])',
    'TECHNICAL_RECEIPT_INVALID',
    'TECHNICAL_RECEIPT_BINDING_INVALID',
    'technicalReceiptSha256(technicalAggregateBytes)',
    'technicalReceiptSha256(collectorStateBytes)',
    'technicalReceiptSha256(campaignAuthorizationBytes)',
    'technicalReceiptSha256(certificationMatrixBytes)',
    'technicalReceiptSha256(androidAttestationBytes)',
    'technicalReceiptSha256(raspberryAttestationBytes)',
    'PRIVATE_TECHNICAL_RECEIPT',
    'b5HundredSessionGate: "PENDING_REVIEW"',
    'b6: "PENDING"',
    'rawCampaignIdIncluded: false',
    'commitmentsIncluded: true'
  ]){
    if(!receipt.includes(requiredControl)){
      isolationErrors.push(`B5 technical receipt is missing exact binding control: ${requiredControl}`);
    }
  }
  for(const field of b5TechnicalReceiptHashFields){
    if(!receipt.includes(`"${field}"`)){
      isolationErrors.push(`B5 technical receipt does not bind ${field}`);
    }
  }
}
if(fs.existsSync(b5TechnicalReceiptSchemaPath)){
  try{
    const schema=JSON.parse(fs.readFileSync(b5TechnicalReceiptSchemaPath,'utf8'));
    const expectedFields=[...b5TechnicalReceiptFields].sort();
    const actualProperties=Object.keys(schema.properties??{}).sort();
    const actualRequired=[...(schema.required??[])].sort();
    if(
      schema.type!=='object'||
      schema.additionalProperties!==false||
      JSON.stringify(actualProperties)!==JSON.stringify(expectedFields)||
      JSON.stringify(actualRequired)!==JSON.stringify(expectedFields)||
      schema.properties?.schemaVersion?.const!==1||
      schema.properties?.receiptVersion?.const!=='1.1.0'||
      schema.properties?.product?.const!=='V5BT'||
      schema.properties?.phase?.const!=='B5'||
      schema.properties?.mode?.const!=='PRIVATE_TECHNICAL_RECEIPT'
    ){
      isolationErrors.push('B5 technical receipt schema does not enforce its exact root contract');
    }
    for(const field of b5TechnicalReceiptHashFields){
      if(schema.properties?.[field]?.$ref!=='#/$defs/sha256'){
        isolationErrors.push(`B5 technical receipt schema does not enforce SHA-256 for ${field}`);
      }
    }
    const gate=schema.properties?.gate;
    if(
      gate?.additionalProperties!==false||
      JSON.stringify([...(gate?.required??[])].sort())!==
        JSON.stringify(['b5HundredSessionGate','b5TechnicalGate','b6'])||
      gate?.properties?.b5TechnicalGate?.const!=='PASS'||
      gate?.properties?.b5HundredSessionGate?.const!=='PENDING_REVIEW'||
      gate?.properties?.b6?.const!=='PENDING'
    ){
      isolationErrors.push('B5 technical receipt schema gate contract is invalid');
    }
    const privacy=schema.properties?.privacy;
    const expectedPrivacy=[
      'addressesIncluded',
      'commitmentsIncluded',
      'cryptographicMaterialIncluded',
      'identifiersIncluded',
      'localLocationsIncluded',
      'rawCampaignIdIncluded'
    ];
    if(
      privacy?.additionalProperties!==false||
      JSON.stringify([...(privacy?.required??[])].sort())!==JSON.stringify(expectedPrivacy)||
      privacy?.properties?.commitmentsIncluded?.const!==true||
      expectedPrivacy
        .filter(field=>field!=='commitmentsIncluded')
        .some(field=>privacy?.properties?.[field]?.const!==false)||
      schema.$defs?.sha256?.pattern!=='^(?!0{64}$)[0-9a-f]{64}$'
    ){
      isolationErrors.push('B5 technical receipt schema privacy or digest contract is invalid');
    }
  }catch{
    isolationErrors.push('B5 technical receipt schema is malformed');
  }
}
if(fs.existsSync(b5CampaignGovernancePath)){
  const governance=fs.readFileSync(b5CampaignGovernancePath,'utf8');
  for(const requiredControl of [
    'parseB5CampaignAuthorization',
    'parseB5ReviewAttestation',
    'crypto.timingSafeEqual',
    '["b0", "b1", "b2", "b3", "b4"]',
    'continuousAndroidMonitor',
    'continuousRaspberryMonitor',
    'productionServiceMustRemainContinuous',
    'independentReviewRequired',
    'technicalAggregateSha256',
    'operatorCommitmentSha256',
    'reviewerCommitmentSha256',
    'REVIEW_NOT_INDEPENDENT',
    'value.gate.b5HundredSessionGate, "PENDING"',
    'value.gate.b6, "PENDING"'
  ]){
    if(!governance.includes(requiredControl)){
      isolationErrors.push(`B5 campaign governance is missing review control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b5HundredSessionGatePath)){
  const gate=fs.readFileSync(b5HundredSessionGatePath,'utf8');
  for(const requiredControl of [
    'parseCollectorCampaignState',
    'parseB5CampaignSupervisorLedger',
    'parseB5CampaignAuthorization',
    'parseB5AndroidContinuityAttestation',
    'parseB5RaspberryContinuityAttestation',
    'ANDROID_CAMPAIGN_BINDING_INVALID',
    'ANDROID_TIMELINE_INCOMPLETE',
    'continuity.monitoredFromMs > attemptLedger.coverageFromMs',
    'continuity.monitoredUntilMs < attemptLedger.coverageUntilMs',
    'continuity.report?.target?.role !== "handheld"',
    'ANDROID_TARGET_ROLE_INVALID',
    'RASPBERRY_ATTESTATION_REQUIRED',
    'authorization.issuedAtMs > attemptLedger.coverageFromMs',
    'CAMPAIGN_AUTHORIZATION_TIMELINE_INVALID',
    'ATTEMPT_STATE_REQUIRED',
    'CAMPAIGN_AUTHORIZATION_REQUIRED',
    'androidProcessContinuity',
    'androidSessionContinuity',
    'androidCrashAnrContinuity',
    'raspberryContinuity',
    'attemptRetryPolicy',
    'attemptTimelineCoverage',
    'authorizationBeforeFirstAttempt',
    'androidHandheldTarget',
    'createB5TechnicalReceipt',
    'atomicWriteTechnicalPair',
    'TECHNICAL_PUBLICATION_EXISTS',
    'fs.constants.O_EXCL',
    'fs.linkSync',
    'fs.fsyncSync',
    'collectorStateBytes',
    'b5AccountDeviceBindingFromPrivateBaseline',
    'createB5AccountDeviceCommitmentSha256',
    'accountDeviceCommitmentSha256:',
    'ACCOUNT_DEVICE_COMMITMENT_REQUIRED',
    'ACCOUNT_DEVICE_COMMITMENT_MISMATCH',
    'continuity.accountDeviceCommitmentSha256',
    'attemptStateBytes',
    'attemptLedgerHeadSha256: attemptLedger.headSha256',
    'androidAttestationSha256: sha256(androidEvidence.bytes)',
    'raspberryAttestationSha256: sha256(raspberryEvidence.bytes)',
    'campaignAuthorizationBytes',
    'certificationMatrixBytes: matrixBytes',
    'attemptLedgerHeadSha256: parsedAttemptLedger.headSha256',
    'campaignIdCommitmentSha256:',
    'collectionCommitmentSha256:',
    'prerequisiteEvidenceBundleSha256:',
    'operatorCommitmentSha256:',
    'androidAttestationBytes',
    'raspberryAttestationBytes',
    'verdict: "TECHNICAL_PASS"',
    'b5TechnicalGate: "PASS"',
    'b5HundredSessionGate: "PENDING_REVIEW"',
    'campaignCommitmentsIncluded: true',
    'campaignCommitmentsIncluded: false',
    'privateRecordIdentifiersIncluded: false',
    '"--campaign-state"',
    '"--attempt-state"',
    '"--android-attestation"',
    '"--raspberry-attestation"',
    '"--campaign-authorization"',
    '"--technical-receipt"'
  ]){
    if(!gate.includes(requiredControl)){
      isolationErrors.push(`B5 hundred-session gate is missing campaign binding: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b5PromotionGatePath)){
  const promotion=fs.readFileSync(b5PromotionGatePath,'utf8');
  for(const requiredControl of [
    'parseTechnicalAggregate',
    'const value = requireExactFields(',
    'const campaign = requireExactFields(',
    'const checks = requireExactFields(',
    'const totals = requireExactFields(',
    'const gate = requireExactFields(',
    'const privacy = requireExactFields(',
    'parseB5CampaignAuthorization',
    'parseB5ReviewAttestation',
    'parseB5TechnicalReceipt',
    'parseB5CampaignSupervisorLedger',
    'parseB5AndroidContinuityAttestation',
    'parseB5RaspberryContinuityAttestation',
    'technicalReceiptSha256',
    'technicalAggregateSha256: technicalReceiptSha256(technicalBytes)',
    'collectorStateSha256: technicalReceiptSha256(stateBytes)',
    'campaignAuthorizationSha256: technicalReceiptSha256(authorizationBytes)',
    'certificationMatrixSha256',
    'campaignIdCommitmentSha256: state.campaignIdCommitmentSha256',
    'accountDeviceCommitmentSha256:',
    'attemptLedgerHeadSha256: attemptLedger.headSha256',
    'androidAttestationSha256: technicalReceiptSha256(androidBytes)',
    'raspberryAttestationSha256: technicalReceiptSha256(raspberryBytes)',
    'const sourceExpected = Object.freeze({',
    'TECHNICAL_AGGREGATE_BINDING_INVALID',
    'SOURCE_EVIDENCE_BINDING_INVALID',
    'SOURCE_EVIDENCE_COMMITMENTS_REQUIRED',
    'ACCOUNT_DEVICE_COMMITMENT_REQUIRED',
    'ACCOUNT_DEVICE_COMMITMENT_MISMATCH',
    'collectionCommitmentSha256: state.collectionCommitmentSha256',
    'authorization.prerequisiteEvidenceBundleSha256',
    'authorization.operatorCommitmentSha256',
    'attemptTimelineCoverage',
    'authorizationBeforeFirstAttempt',
    'androidHandheldTarget',
    '["verdict", "TECHNICAL_PASS"]',
    'gate.b5HundredSessionGate, "PENDING_REVIEW"',
    'technicalAggregateSha256: sha256Hex(technicalBytes)',
    'technicalReceipt: "PASS"',
    'independentReview: "PASS"',
    'distinctReviewer: "PASS"',
    'b5HundredSessionGate: "PASS"',
    'b6: "PENDING"',
    '["--technical-aggregate", "technicalAggregate"]',
    '["--technical-receipt", "technicalReceipt"]',
    '["--attempt-state", "attemptState"]',
    '["--android-attestation", "androidAttestation"]',
    '["--raspberry-attestation", "raspberryAttestation"]',
    '["--campaign-authorization", "campaignAuthorization"]',
    '["--review-attestation", "reviewAttestation"]',
    'before.nlink !== 1',
    'fs.constants.O_NOFOLLOW'
  ]){
    if(!promotion.includes(requiredControl)){
      isolationErrors.push(`B5 promotion gate is missing independent-review control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(benchInventoryPath)){
  const inventory=fs.readFileSync(benchInventoryPath,'utf8');
  for(const requiredControl of [
    'ADVANCED_CERTIFICATION_TARGETS',
    'assertReadOnlyCommand',
    'const REMOTE_COMMANDS = Object.freeze',
    '/usr/bin/bluetoothctl --version',
    '/usr/bin/timedatectl show',
    '/usr/bin/upsc -l',
    '/usr/bin/systemctl show',
    'expectedApkSha256: target.sha256',
    'expectedSigningCertificateSha256: target.signingCertificateSha256',
    'signingCertificatePinCoveredByCertifiedApk: apkSha256Matches',
    'ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256',
    'permissionsGranted',
    'enrollmentReady',
    'registryBindingMatches',
    'mode: "PRIVATE_READ_ONLY_BENCH_INVENTORY"',
    'mode: "REDACTED_READ_ONLY_BENCH_INVENTORY"',
    'secureWriteJson(privateAbsolute, result.privateReport, 0o600)',
    'if (cli.fixture)',
    'fixture mode does not accept live targets'
  ]){
    if(!inventory.includes(requiredControl)){
      isolationErrors.push(`V5BT bench inventory is missing read-only control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(buildConsistencyPath)){
  const verifier=fs.readFileSync(buildConsistencyPath,'utf8');
  for(const requiredControl of [
    'loadAdvancedCertificationTargets',
    'parseGradleIdentity',
    'identity.packageId !== target.packageId',
    'identity.versionName !== target.versionName',
    'identity.versionCode !== target.versionCode',
    'apkSha256 !== target.sha256',
    'resolveApksignerPath',
    'parseApksignerCertificateSha256',
    'signingCertificateSha256 !== target.signingCertificateSha256',
    '`${role}.signingCertificateSha256`',
    'verifyBluetoothParity',
    'ALLOWED_MAIN_DIFFERENCES',
    'BuildConfig.BLUETOOTH_NODE_KIND',
    'fs.constants.O_NOFOLLOW'
  ]){
    if(!verifier.includes(requiredControl)){
      isolationErrors.push(`V5BT Advanced build consistency verifier is missing control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b0FormalGatePath)){
  const formalB0=fs.readFileSync(b0FormalGatePath,'utf8');
  for(const requiredControl of [
    'ADVANCED_CERTIFICATION_TARGETS_BINDING',
    'B0_FORMAL_ROLES',
    'B0_FORMAL_MODELS',
    'actual.signingCertificateSha256 === expected.signingCertificateSha256',
    'B0_REQUIRED_CONTROLS.every',
    'Object.values(continuity).every',
    'binding.model !== B0_FORMAL_MODELS[role]',
    'evidenceClass: passed ? "FORMAL" : "NON_GATE_EVIDENCE"',
    'formalGate: passed ? "PASS" : "PENDING"',
    'requiresExplicitSerials: true',
    'physicalAdbAccessed: false',
    'forceStopAllowed: false',
    'writeExclusiveEvidence'
  ]){
    if(!formalB0.includes(requiredControl)){
      isolationErrors.push(`B0 formal gate is missing fail-closed control: ${requiredControl}`);
    }
  }
  if(/\bUNKNOWN\b/.test(formalB0)){
    isolationErrors.push('B0 formal gate must not admit UNKNOWN evidence states');
  }
}
if(fs.existsSync(b4CollectorPath)){
  const collector=fs.readFileSync(b4CollectorPath,'utf8');
  if(/b4TenDeviceGate\s*:\s*["']PASS["']/.test(collector)){
    isolationErrors.push('Progressive B4 collector must never promote the authoritative gate');
  }
  if(!collector.includes('authoritativeB4GateExecuted: false')){
    isolationErrors.push('Progressive B4 collector must declare the authoritative gate untouched');
  }
  if(!collector.includes('collectorReport: COLLECTOR_REPORT_FILE')){
    isolationErrors.push('Progressive B4 collector must bind its report into the verifier manifest');
  }
  if(
    !collector.includes('["--preflight", "PREFLIGHT"]')||
    !collector.includes('operation: "DEVICE_PREFLIGHT"')||
    !collector.includes('raspberryEvidenceConsumed: false')||
    !collector.includes('privateStateWritten: false')
  ){
    isolationErrors.push('Progressive B4 collector must expose a non-mutating device preflight');
  }
  for(const requiredControl of [
    'const STATE_SCHEMA_VERSION = 2',
    'certificationMatrixBinding',
    'buildAdvancedCertificationTargetsBinding',
    'readCurrentCertificationMatrixBinding',
    'assertStateCertificationMatrixBinding',
    'withStableCertificationMatrix',
    'STATE_LEGACY_REJECTED',
    'CERTIFICATION_MATRIX_BINDING_MISMATCH',
    'CERTIFICATION_MATRIX_CHANGED_DURING_PROCESS'
  ]){
    if(!collector.includes(requiredControl)){
      isolationErrors.push(`Progressive B4 collector is missing matrix-binding control: ${requiredControl}`);
    }
  }
  for(const requiredControl of [
    '--capture-run-id',
    '--android-monitor-attestation',
    '--raspberry-monitor-attestation',
    'validateB4MonitoredSlotAuthorization',
    'MONITOR_AUTHORIZATION_INVALID',
    'captureRunCommitmentSha256',
    'captureRunId',
    'androidAttestationSha256',
    'raspberryAttestationSha256',
    'targetHardwareCommitmentSha256',
    'MONITOR_TARGET_HARDWARE_MISMATCH',
    '.android-monitor.json',
    '.raspberry-monitor.json',
    'collectionRunId: state.runId',
    'androidMonitorSha256',
    'raspberryMonitorSha256',
    'assertCollectionStateUnchanged',
    'STATE_CHANGED_DURING_COLLECTION'
  ]){
    if(!collector.includes(requiredControl)){
      isolationErrors.push(`Progressive B4 collector is missing monitored-slot control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b4MonitoredSlotGatePath)){
  const gate=fs.readFileSync(b4MonitoredSlotGatePath,'utf8');
  for(const requiredControl of [
    'V5BT:B4:COLLECTION_RUN:',
    'V5BT:B4:CAPTURE_RUN:',
    'parseB4AndroidContinuityAttestation',
    'parseB4RaspberryContinuityAttestation',
    'MONITOR_BINDING_MISMATCH',
    'MONITOR_MATRIX_MISMATCH',
    'MONITOR_COVERAGE_INCOMPLETE',
    'MONITOR_TARGET_INVALID',
    'buildB4TargetHardwareCommitment',
    'V5BT:B4:TARGET_HARDWARE:',
    'PHYSICAL_SINGLE_ADVERTISER'
  ]){
    if(!gate.includes(requiredControl)){
      isolationErrors.push(`B4 monitored-slot gate is missing fail-closed control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(b4AuthoritativeGatePath)){
  const gate=fs.readFileSync(b4AuthoritativeGatePath,'utf8');
  for(const requiredControl of [
    'manifest.schemaVersion !== 2',
    'collectionRunId',
    'certificationMatrixSha256',
    'androidMonitorSha256',
    'raspberryMonitorSha256',
    'loadB4MonitorAttestationParsers',
    'validateB4MonitoredSlotAuthorization',
    'validateCaptureMonitorEvidence',
    'MONITOR_EVIDENCE_HASH_MISMATCH',
    'monitorContinuityBinding: "PASS"'
  ]){
    if(!gate.includes(requiredControl)){
      isolationErrors.push(`Authoritative B4 gate is missing monitor revalidation control: ${requiredControl}`);
    }
  }
  for(const requiredControl of [
    'assertNoSymlinkPathComponents',
    'before.nlink !== 1',
    'before.uid !== process.getuid()',
    'before.dev !== after.dev',
    'before.ino !== after.ino',
    'before.size !== after.size',
    'before.mtimeMs !== after.mtimeMs',
    'before.ctimeMs !== after.ctimeMs',
    'after.dev !== pathStatus.dev',
    'after.ino !== pathStatus.ino'
  ]){
    if(!gate.includes(requiredControl)){
      isolationErrors.push(`Authoritative B4 private reader is missing immutable-file control: ${requiredControl}`);
    }
  }
}
for(const [monitorPath,label] of [
  [b4AndroidMonitorPath,'Android'],
  [b4RaspberryMonitorPath,'Raspberry']
]){
  if(!fs.existsSync(monitorPath)){
    isolationErrors.push(`Required B4 ${label} continuity monitor is unavailable`);
    continue;
  }
  const monitor=fs.readFileSync(monitorPath,'utf8');
  for(const requiredControl of [
    'V5BT:B4:COLLECTION_RUN:',
    'V5BT:B4:CAPTURE_RUN:',
    'collectionRunCommitmentSha256',
    'captureRunCommitmentSha256',
    'certificationMatrixSha256',
    'privateJournalSha256',
    ...(label==='Android'?[
      'targetHardwareCommitmentSha256',
      '--collector-state',
      'buildB4TargetHardwareCommitment',
      'readCollectorBinding(options.collectorState)',
      'packageName: TARGET.packageId',
      'identityKey.fill(0)',
      'duplicateSequence !== duplicateTimestamp',
      'linkSync(temporary, resolved)',
      'OUTPUT_ROLLBACK_INCOMPLETE'
    ]:[]),
    'verdict: "PASS"',
    'phase: "B4"'
  ]){
    if(!monitor.includes(requiredControl)){
      isolationErrors.push(`B4 ${label} monitor is missing binding control: ${requiredControl}`);
    }
  }
}
if(fs.existsSync(path.join(root,'scripts/run-b4-ten-device-gate.mjs'))){
  isolationErrors.push('Legacy root B4 runner duplicates the authoritative Raspberry gate');
}
if(fs.existsSync(directSessionPath)){
  const directSession=fs.readFileSync(directSessionPath,'utf8');
  if(!directSession.includes(`"${directSessionPattern}"`)){
    isolationErrors.push('B5 direct session must enforce canonical 128-bit base64url identifiers');
  }
  if(
    /^\s*import\s/m.test(directSession)||
    /\b(?:setTimeout|setInterval|fetch|WebSocket|BluetoothGatt|GattManager1|dbus)\b/.test(directSession)
  ){
    isolationErrors.push('B5.1 direct session core must remain free of I/O and hidden timers');
  }
}
for(const runtimePath of raspberryRuntimePaths){
  if(!fs.existsSync(runtimePath))continue;
  const runtime=fs.readFileSync(runtimePath,'utf8');
  if(/shared\/session|DirectSessionV1|SessionManager/.test(runtime)){
    isolationErrors.push('B5.2 must not wire the direct-session core before its gated adapter increment');
  }
}
if(fs.existsSync(nodeConfigPath)){
  const nodeConfig=fs.readFileSync(nodeConfigPath,'utf8');
  if(
    !nodeConfig.includes('readonly gattServerEnabled: boolean')||
    !/parseFlag\(\s*environment,\s*"CASSA_BT_GATT_SERVER_ENABLED",\s*false\s*\)/m.test(nodeConfig)||
    !nodeConfig.includes('CASSA_BT_GATT_SERVER_ENABLED requires CASSA_BT_FEATURE_ENABLED=1')
  ){
    isolationErrors.push('B5.2 GATT server flag must be explicit, default-off and depend on the global feature flag');
  }
  if(
    !nodeConfig.includes('readonly helloExchangeEnabled: boolean')||
    !/parseFlag\(\s*environment,\s*"CASSA_BT_HELLO_ENABLED",\s*false\s*\)/m.test(nodeConfig)||
    !nodeConfig.includes('CASSA_BT_HELLO_ENABLED requires CASSA_BT_FEATURE_ENABLED=1 and CASSA_BT_GATT_SERVER_ENABLED=1')
  ){
    isolationErrors.push('B5.5 HELLO flag must be explicit, default-off and depend on feature plus GATT server');
  }
}
if(fs.existsSync(raspberryIndexPath)){
  const raspberryIndex=fs.readFileSync(raspberryIndexPath,'utf8');
  if(
    !/gattServer:\s*config\.gattServerEnabled\s*\?\s*new DbusNextGattServerPort\(\{\s*application:\s*gattApplication\s*\}\)\s*:\s*undefined/m.test(raspberryIndex)
  ){
    isolationErrors.push('B5.2 GATT server runtime must be constructed only behind its dedicated flag');
  }
  if(
    !raspberryIndex.includes('enabled: config.helloExchangeEnabled')||
    !raspberryIndex.includes('identity: config.helloExchangeEnabled')
  ){
    isolationErrors.push('B5.5 HELLO runtime must be constructed behind its dedicated flag');
  }
}
if(fs.existsSync(bluezNodePath)){
  const bluezNode=fs.readFileSync(bluezNodePath,'utf8');
  if(
    !bluezNode.includes('gattServerEnabled !==')||
    !bluezNode.includes('provided exactly when')
  ){
    isolationErrors.push('B5.2 BluezNode must reject both missing and unexpected GATT server ownership');
  }
}
if(fs.existsSync(gattApplicationPath)){
  const application=fs.readFileSync(gattApplicationPath,'utf8');
  for(const requiredToken of [
    'org.freedesktop.DBus.ObjectManager',
    'org.bluez.GattService1',
    'org.bluez.GattCharacteristic1',
    'org.bluez.Error.NotAuthorized',
    'managedObjectRequestsTotal',
    'useConfiguredPrototypeMembers'
  ]){
    if(!application.includes(requiredToken)){
      isolationErrors.push(`B5.2 GATT application is missing ${requiredToken}`);
    }
  }
  if(/shared\/session|DirectSessionV1|SessionManager/.test(application)){
    isolationErrors.push('B5.2 GATT application must not implement the direct session adapter');
  }
}
if(fs.existsSync(gattServerPortPath)){
  const gattPort=fs.readFileSync(gattServerPortPath,'utf8');
  for(const requiredToken of [
    'RegisterApplication',
    'UnregisterApplication',
    'NameOwnerChanged',
    'retryScheduled',
    '#cleanupResources',
    '#unexportApplication',
    '#cancelRetry'
  ]){
    if(!gattPort.includes(requiredToken)){
      isolationErrors.push(`B5.2 GATT D-Bus port is missing ${requiredToken}`);
    }
  }
  if(/shared\/session|DirectSessionV1|SessionManager/.test(gattPort)){
    isolationErrors.push('B5.2 GATT D-Bus port must not own session or handshake state');
  }
}
if(fs.existsSync(gattServicePath)){
  const gattService=fs.readFileSync(gattServicePath,'utf8');
  if(/@jellybrick\/dbus-next|shared\/session|DirectSessionV1/.test(gattService)){
    isolationErrors.push('B5.2 CassaGattService must remain a transport-free profile model');
  }
}
if(fs.existsSync(b5GattSmokeHarnessPath)){
  const harness=fs.readFileSync(b5GattSmokeHarnessPath,'utf8');
  for(const requiredToken of [
    'B5_3_HARNESS_VERSION',
    'evaluatePhysicalGattEvidence',
    'managedObjectRequestsTotal',
    'objectManagerConsumed',
    'preSessionTraffic: "ZERO"',
    'sessionsOpened: 0',
    'b5HundredSessionGate: "PENDING"',
    'physicalRadioAccessed: true',
    'activeV4Changes: false'
  ]){
    if(!harness.includes(requiredToken)){
      isolationErrors.push(`B5.3 physical GATT harness is missing ${requiredToken}`);
    }
  }
  for(const forbiddenReference of [
    'shared/session',
    'BluetoothGatt',
    'StartDiscovery',
    'LEAdvertisingManager1'
  ]){
    if(harness.includes(forbiddenReference)){
      isolationErrors.push(`B5.3 physical GATT harness must not reference ${forbiddenReference}`);
    }
  }
}
for(const schemaFile of [
  'hello-v1.schema.json',
  'auth-challenge-v1.schema.json',
  'auth-finish-v1.schema.json',
  'auth-response-v1.schema.json',
  'auth-server-proof-v1.schema.json',
  'ack-v1.schema.json',
  'transport-frame-v1.schema.json'
]){
  const schemaPath=path.join(root,'contracts',schemaFile);
  if(!fs.existsSync(schemaPath))continue;
  try{
    const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'));
    if(schema.properties?.sessionId?.pattern!==directSessionPattern){
      isolationErrors.push(`${schemaFile} has a non-canonical B5 sessionId pattern`);
    }
  }catch{
    isolationErrors.push(`${schemaFile} is malformed`);
  }
}
const protocolVectorsPath=path.join(root,'contracts/PROTOCOL_TEST_VECTORS.json');
if(fs.existsSync(protocolVectorsPath)){
  try{
    const vectors=JSON.parse(fs.readFileSync(protocolVectorsPath,'utf8'));
    const sessionId=vectors.directSession?.sessionId;
    if(
      typeof sessionId!=='string'||
      !(new RegExp(directSessionPattern)).test(sessionId)||
      Buffer.from(sessionId,'base64url').byteLength!==16||
      Buffer.from(sessionId,'base64url').toString('base64url')!==sessionId
    ){
      isolationErrors.push('B5 direct-session vector must contain one canonical 128-bit sessionId');
    }
  }catch{
    isolationErrors.push('B5 direct-session protocol vector is malformed');
  }
}
if(fs.existsSync(b4CollectionProgressPath)){
  try{
    const progress=JSON.parse(fs.readFileSync(b4CollectionProgressPath,'utf8'));
    const count=progress.gate?.distinctPhysicalDevices;
    const validCount=Number.isSafeInteger(count)&&count>=0&&count<=10;
    const expectedRemaining=validCount?10-count:null;
    const expectedCollectionStatus=count===10?'READY':'PENDING';
    if(
      progress.verdict!=='PENDING'||
      progress.operation!=='STATUS'||
      progress.gate?.requiredDistinctPhysicalDevices!==10||
      !validCount||
      progress.gate?.remainingPhysicalDevices!==expectedRemaining||
      progress.gate?.collectionStatus!==expectedCollectionStatus||
      progress.gate?.authoritativeB4GateExecuted!==false||
      progress.gate?.b4TenDeviceGate!=='PENDING'
    ){
      isolationErrors.push('B4.4 public collection progress is inconsistent');
    }
    if(
      !Array.isArray(progress.devices)||
      progress.devices.length!==count||
      progress.devices.some((device,index)=>device?.ordinal!==index+1)
    ){
      isolationErrors.push('B4.4 public collection slots are not contiguous');
    }
    if(Object.values(progress.privacy??{}).some(value=>value!==false)){
      isolationErrors.push('B4.4 public collection progress privacy contract is invalid');
    }
    const serialized=JSON.stringify(progress);
    for(const forbidden of ['identityKeyBase64Url','deviceDigest','hardwareSerial','adbTransportSerial']){
      if(serialized.includes(`"${forbidden}"`)){
        isolationErrors.push(`B4.4 public collection progress contains forbidden field ${forbidden}`);
      }
    }
  }catch{
    isolationErrors.push('B4.4 public collection progress is malformed');
  }
}
if(fs.existsSync(b5GattPhysicalReportPath)){
  try{
    const reportBytes=fs.readFileSync(b5GattPhysicalReportPath);
    const reportHash=crypto.createHash('sha256').update(reportBytes).digest('hex');
    const report=JSON.parse(reportBytes.toString('utf8'));
    if(reportHash!=='15228ad4588e6e0a430a0beef942fc2dcde2924ac0d79af7b7e8eac55f5df2d4'){
      isolationErrors.push('B5.3 physical GATT evidence hash changed');
    }
    if(
      report.phase!=='B5.3'||
      report.mode!=='PHYSICAL'||
      report.verdict!=='PASS'||
      report.target?.architecture!=='arm64'||
      report.target?.adapterName!=='hci0'
    ){
      isolationErrors.push('B5.3 physical GATT evidence target or verdict is invalid');
    }
    if(
      report.checks?.bluezPreflight!=='PASS'||
      report.checks?.registerApplication!=='PASS'||
      report.checks?.objectManagerConsumed!=='PASS'||
      report.checks?.preSessionTraffic!=='ZERO'||
      report.checks?.unregisterApplication!=='PASS'||
      report.checks?.resourceCleanup!=='PASS'
    ){
      isolationErrors.push('B5.3 physical GATT evidence checks are incomplete');
    }
    if(
      report.observed?.managedObjectCount!==8||
      !Number.isSafeInteger(report.observed?.managedObjectRequests)||
      report.observed.managedObjectRequests<1||
      report.observed?.characteristicCount!==7||
      report.observed?.discoveryStatePreserved!==true||
      report.observed?.sessionsOpened!==0
    ){
      isolationErrors.push('B5.3 physical GATT measurements are inconsistent');
    }
    if(
      report.gate?.raspberryGattSmoke!=='PASS'||
      report.gate?.androidGattClient!=='NOT_STARTED'||
      report.gate?.b5HundredSessionGate!=='PENDING'||
      report.physicalRadioAccessed!==true||
      report.activeV4Changes!==false
    ){
      isolationErrors.push('B5.3 physical GATT evidence promotes an unsupported gate');
    }
    const serialized=JSON.stringify(report);
    for(const forbidden of [
      'nodeId',
      'storeId',
      'rotatingAlias',
      'bluetoothAddress',
      'identityKey',
      'sessionId',
      'payload'
    ]){
      if(serialized.includes(`"${forbidden}"`)){
        isolationErrors.push(`B5.3 physical GATT evidence contains forbidden field ${forbidden}`);
      }
    }
  }catch{
    isolationErrors.push('B5.3 physical GATT evidence is malformed');
  }
}
if(fs.existsSync(b5AndroidGattPhysicalReportPath)){
  try{
    const reportBytes=fs.readFileSync(b5AndroidGattPhysicalReportPath);
    const reportHash=crypto.createHash('sha256').update(reportBytes).digest('hex');
    const report=JSON.parse(reportBytes.toString('utf8'));
    if(reportHash!=='69f73d23f4908d65e97e2e5907bc5786217dd154461c1f8b94a9de562d7b0454'){
      isolationErrors.push('B5.4 physical Android GATT evidence hash changed');
    }
    if(
      report.phase!=='B5.4'||
      report.mode!=='PHYSICAL'||
      report.verdict!=='PASS'||
      report.target?.role!=='GATT_CLIENT'||
      report.target?.appPackage!==ADVANCED_CERTIFICATION_TARGETS.roles.handheld.packageId||
      report.peer?.role!=='GATT_SERVER'||
      report.peer?.architecture!=='arm64'||
      report.peer?.adapterName!=='hci0'
    ){
      isolationErrors.push('B5.4 physical Android GATT target or verdict is invalid');
    }
    if(
      report.checks?.candidatePolicy!=='PASS'||
      report.checks?.gattConnection!=='PASS'||
      report.checks?.serviceDiscovery!=='PASS'||
      report.checks?.exactProfileValidation!=='PASS'||
      report.checks?.mtuNegotiation!=='PASS'||
      report.checks?.preSessionTraffic!=='ZERO'||
      report.checks?.raspberryCleanup!=='PASS'
    ){
      isolationErrors.push('B5.4 physical Android GATT checks are incomplete');
    }
    if(
      report.observed?.state!=='READY'||
      report.observed?.profileValidated!==true||
      !Number.isSafeInteger(report.observed?.negotiatedMtu)||
      report.observed.negotiatedMtu<23||
      report.observed.negotiatedMtu>517||
      report.observed?.connectionAttempts!==1||
      report.observed?.connectionsEstablished!==1||
      report.observed?.servicesValidated!==1||
      report.observed?.mtuNegotiated!==1||
      report.observed?.disconnects!==0||
      report.observed?.failures!==0||
      report.observed?.sessionsOpened!==0||
      report.observed?.raspberryManagedObjectCount!==8||
      report.observed?.raspberryCharacteristicCount!==7
    ){
      isolationErrors.push('B5.4 physical Android GATT measurements are inconsistent');
    }
    if(
      report.gate?.androidGattClientIncrement!=='PASS_ONE_PHYSICAL_TARGET'||
      report.gate?.helloExchange!=='NOT_STARTED'||
      report.gate?.mutualAuthentication!=='NOT_STARTED'||
      report.gate?.b5HundredSessionGate!=='PENDING'||
      report.physicalRadioAccessed!==true||
      report.activeV4Changes!==false
    ){
      isolationErrors.push('B5.4 physical Android GATT evidence promotes an unsupported gate');
    }
    const serialized=JSON.stringify(report);
    for(const forbidden of [
      'nodeId',
      'storeId',
      'rotatingAlias',
      'bluetoothAddress',
      'identityKey',
      'sessionId',
      'payload',
      'hardwareSerial',
      'adbTransportSerial'
    ]){
      if(serialized.includes(`"${forbidden}"`)){
        isolationErrors.push(`B5.4 physical Android GATT evidence contains forbidden field ${forbidden}`);
      }
    }
  }catch{
    isolationErrors.push('B5.4 physical Android GATT evidence is malformed');
  }
}
if(fs.existsSync(b55AndroidHelloReportPath)){
  try{
    const reportBytes=fs.readFileSync(b55AndroidHelloReportPath);
    const reportHash=crypto.createHash('sha256').update(reportBytes).digest('hex');
    const report=JSON.parse(reportBytes.toString('utf8'));
    if(reportHash!=='9dcd97e0ed3a3ebc121d8e4ca5f0456d67bd021f20a41f138135ed454be9e9c4'){
      isolationErrors.push('B5.5 physical Android HELLO evidence hash changed');
    }
    if(
      report.schemaVersion!==2||
      report.source!=='V5BT_ANDROID_GATT_HELLO_LAB'||
      report.labBuild!==true||
      report.diagnosticsEnabled!==true||
      report.gattClientEnabled!==true||
      report.state!=='HELLO_EXCHANGED'||
      report.profileValidated!==true||
      !Number.isSafeInteger(report.negotiatedMtu)||
      report.negotiatedMtu<54||
      report.negotiatedMtu>517||
      report.lastFailure!=='NONE'||
      report.helloEnabled!==true||
      report.helloExchanged!==true||
      report.helloDeadlineActive!==false||
      report.authenticatedSessionCount!==0
    ){
      isolationErrors.push('B5.5 physical Android HELLO state is invalid');
    }
    for(const [field,expected] of [
      ['connectionAttempts',1],
      ['connectionsEstablished',1],
      ['servicesValidated',1],
      ['mtuNegotiated',1],
      ['helloWritesStarted',1],
      ['helloWritesCompleted',1],
      ['helloReadsCompleted',1],
      ['helloExchanged',1],
      ['disconnects',0],
      ['failures',0],
      ['closes',0]
    ]){
      if(report.metrics?.[field]!==expected){
        isolationErrors.push(`B5.5 physical Android HELLO metric ${field} is invalid`);
      }
    }
    const serialized=JSON.stringify(report);
    for(const forbidden of [
      'nodeId',
      'storeId',
      'rotatingAlias',
      'bluetoothAddress',
      'identityKey',
      'sessionId',
      'nonce',
      'payload',
      'hardwareSerial',
      'adbTransportSerial'
    ]){
      if(serialized.includes(`"${forbidden}"`)){
        isolationErrors.push(`B5.5 physical Android HELLO evidence contains forbidden field ${forbidden}`);
      }
    }
  }catch{
    isolationErrors.push('B5.5 physical Android HELLO evidence is malformed');
  }
}
if(fs.existsSync(b55RaspberryHelloReportPath)){
  try{
    const reportBytes=fs.readFileSync(b55RaspberryHelloReportPath);
    const reportHash=crypto.createHash('sha256').update(reportBytes).digest('hex');
    const report=JSON.parse(reportBytes.toString('utf8'));
    if(reportHash!=='5e7a74d22de58101d61560f97f512cf4eac67e66fb860ffa3ab62319593a862f'){
      isolationErrors.push('B5.5 physical Raspberry HELLO evidence hash changed');
    }
    if(
      report.phase!=='B5.5'||
      report.mode!=='PHYSICAL'||
      report.verdict!=='PASS'||
      report.target?.role!=='GATT_SERVER'||
      report.target?.architecture!=='arm64'||
      report.target?.adapterName!=='hci0'||
      report.physicalRadioAccessed!==true||
      report.activeV4Changes!==false
    ){
      isolationErrors.push('B5.5 physical Raspberry HELLO target or verdict is invalid');
    }
    if(
      report.checks?.bluezPreflight!=='PASS'||
      report.checks?.helloWrite!=='PASS'||
      report.checks?.helloResponseRead!=='PASS'||
      report.checks?.exactSingleExchange!=='PASS'||
      report.checks?.nonHelloCharacteristics!=='FAIL_CLOSED'||
      report.checks?.authenticatedSessions!=='ZERO'||
      report.checks?.unregisterApplication!=='PASS'||
      report.checks?.resourceCleanup!=='PASS'
    ){
      isolationErrors.push('B5.5 physical Raspberry HELLO checks are incomplete');
    }
    if(
      report.observed?.state!=='HELLO_EXCHANGED'||
      !Number.isSafeInteger(report.observed?.durationMs)||
      report.observed.durationMs<20000||
      report.observed?.managedObjectCount!==8||
      report.observed?.characteristicCount!==7||
      report.observed?.writesAccepted!==1||
      report.observed?.readsDelivered!==1||
      report.observed?.helloExchanged!==1||
      report.observed?.failures!==0||
      report.observed?.authenticatedSessions!==0
    ){
      isolationErrors.push('B5.5 physical Raspberry HELLO measurements are inconsistent');
    }
    if(
      report.gate?.helloExchange!=='PASS_ONE_PHYSICAL_TARGET'||
      report.gate?.mutualAuthentication!=='NOT_STARTED'||
      report.gate?.sessionKey!=='NOT_STARTED'||
      report.gate?.heartbeat!=='NOT_STARTED'||
      report.gate?.b5HundredSessionGate!=='PENDING'||
      report.privacy?.stableNodeIdsIncluded!==false||
      report.privacy?.sessionIdsIncluded!==false||
      report.privacy?.bluetoothAddressesIncluded!==false||
      report.privacy?.noncesIncluded!==false||
      report.privacy?.payloadsIncluded!==false
    ){
      isolationErrors.push('B5.5 physical Raspberry HELLO gate or privacy contract is invalid');
    }
    const serialized=JSON.stringify(report);
    for(const forbidden of [
      'nodeId',
      'storeId',
      'rotatingAlias',
      'bluetoothAddress',
      'identityKey',
      'sessionId',
      'nonce',
      'payload',
      'hardwareSerial',
      'adbTransportSerial'
    ]){
      if(serialized.includes(`"${forbidden}"`)){
        isolationErrors.push(`B5.5 physical Raspberry HELLO evidence contains forbidden field ${forbidden}`);
      }
    }
  }catch{
    isolationErrors.push('B5.5 physical Raspberry HELLO evidence is malformed');
  }
}
if(fs.existsSync(raspberryEnvironmentPath)){
  const environment=JSON.parse(fs.readFileSync(raspberryEnvironmentPath,'utf8'));
  if(environment.CASSA_BT_GATT_SERVER_ENABLED!=='0'){
    isolationErrors.push('CASSA_BT_GATT_SERVER_ENABLED must remain disabled in the Raspberry environment example');
  }
  if(environment.CASSA_BT_HELLO_ENABLED!=='0'){
    isolationErrors.push('CASSA_BT_HELLO_ENABLED must remain disabled in the Raspberry environment example');
  }
  if(environment.CASSA_BT_STATE_ROOT!=='/var/lib/cassav5bt-bluetooth'){
    isolationErrors.push('CASSA_BT_STATE_ROOT must use the V5BT state directory');
  }
  if(environment.CASSA_BT_DEVICE_REGISTRY_PATH!=='/var/lib/cassav5bt-bluetooth/devices.json'){
    isolationErrors.push('CASSA_BT_DEVICE_REGISTRY_PATH must use the V5BT registry');
  }
}
if(fs.existsSync(enrollmentEnvironmentExamplePath)){
  const text=fs.readFileSync(enrollmentEnvironmentExamplePath,'utf8');
  const environment=Object.create(null);
  for(const [index,line] of text.split(/\r?\n/).entries()){
    const trimmed=line.trim();
    if(trimmed===''||trimmed.startsWith('#'))continue;
    const separator=trimmed.indexOf('=');
    if(separator<=0){
      isolationErrors.push(`Invalid enrollment EnvironmentFile line ${index+1}`);
      continue;
    }
    const key=trimmed.slice(0,separator);
    if(Object.hasOwn(environment,key)){
      isolationErrors.push(`Duplicate enrollment EnvironmentFile key ${key}`);
      continue;
    }
    environment[key]=trimmed.slice(separator+1);
  }
  const expectedEnvironment={
    CASSA_BT_FEATURE_ENABLED:'0',
    CASSA_BT_ENROLLMENT_RUNTIME_ENABLED:'0',
    CASSA_BT_ENROLLMENT_LISTEN_HOST:'127.0.0.1',
    CASSA_BT_ENROLLMENT_PORT:'9443',
    CASSA_BT_ENROLLMENT_ENDPOINT_ID:'raspberry-lab-v5bt',
    CASSA_BT_ENROLLMENT_TLS_CERT:'/etc/cassav5bt/bluetooth-enrollment.crt',
    CASSA_BT_ENROLLMENT_TLS_KEY:'/etc/cassav5bt/bluetooth-enrollment.key',
    CASSA_BT_STATE_ROOT:'/var/lib/cassav5bt-bluetooth',
    CASSA_BT_DEVICE_REGISTRY:'/var/lib/cassav5bt-bluetooth/devices.json'
  };
  for(const [key,value] of Object.entries(expectedEnvironment)){
    if(environment[key]!==value){
      isolationErrors.push(`${key} must be ${value} in the enrollment EnvironmentFile example`);
    }
  }
  if(/cassav4/i.test(text)){
    isolationErrors.push('V5BT enrollment EnvironmentFile must not reference CASSAv4');
  }
}
if(fs.existsSync(enrollmentUnitPath)){
  const enrollmentUnit=fs.readFileSync(enrollmentUnitPath,'utf8');
  if(/cassav4/i.test(enrollmentUnit)){
    isolationErrors.push('V5BT enrollment unit must not reference CASSAv4');
  }
  if(!enrollmentUnit.includes('EnvironmentFile=-/etc/cassav5bt/cassav5bt-bluetooth-enrollment.env')){
    isolationErrors.push('V5BT enrollment unit must use its isolated EnvironmentFile');
  }
  if(!enrollmentUnit.includes('StateDirectory=cassav5bt-bluetooth')){
    isolationErrors.push('V5BT enrollment unit must create its isolated state directory');
  }
  if(!enrollmentUnit.includes('StateDirectoryMode=0700')){
    isolationErrors.push('V5BT enrollment unit must keep its state directory private');
  }
  if(!enrollmentUnit.includes('ReadWritePaths=/var/lib/cassav5bt-bluetooth')){
    isolationErrors.push('V5BT enrollment unit must use its isolated writable state directory');
  }
}
if(fs.existsSync(bluezNodeUnitPath)){
  const bluezNodeUnit=fs.readFileSync(bluezNodeUnitPath,'utf8');
  if(/cassav4/i.test(bluezNodeUnit)){
    isolationErrors.push('V5BT BlueZ node unit must not reference CASSAv4');
  }
  if(!bluezNodeUnit.includes('User=cassav5bt')){
    isolationErrors.push('V5BT BlueZ node unit must use the isolated service user');
  }
  if(!bluezNodeUnit.includes('WorkingDirectory=/opt/cassav5bt-bluetooth-node/raspberry')){
    isolationErrors.push('V5BT BlueZ node unit must use the isolated working directory');
  }
  if(!bluezNodeUnit.includes('Environment=CASSA_BT_FEATURE_ENABLED=0')){
    isolationErrors.push('V5BT BlueZ node unit must keep the feature disabled by default');
  }
  if(!bluezNodeUnit.includes('Environment=CASSA_BT_GATT_SERVER_ENABLED=0')){
    isolationErrors.push('V5BT BlueZ node unit must keep the GATT server disabled by default');
  }
  if(!bluezNodeUnit.includes('Environment=CASSA_BT_HELLO_ENABLED=0')){
    isolationErrors.push('V5BT BlueZ node unit must keep HELLO disabled by default');
  }
  if(!bluezNodeUnit.includes('Environment=CASSA_BT_DRY_RUN=1')){
    isolationErrors.push('V5BT BlueZ node unit must keep dry-run enabled by default');
  }
  if(!bluezNodeUnit.includes('EnvironmentFile=-/etc/cassav5bt/cassav5bt-bluetooth-node.env')){
    isolationErrors.push('V5BT BlueZ node unit must use its isolated EnvironmentFile');
  }
}
if(fs.existsSync(raspberryPackagePath)){
  const raspberryPackage=JSON.parse(fs.readFileSync(raspberryPackagePath,'utf8'));
  if(raspberryPackage.dependencies?.['@jellybrick/dbus-next']!=='0.11.1'){
    isolationErrors.push('V5BT BlueZ node must pin @jellybrick/dbus-next to 0.11.1');
  }
  if(Object.hasOwn(raspberryPackage.dependencies??{},'dbus-next')){
    isolationErrors.push('V5BT BlueZ node must not depend on the obsolete unscoped dbus-next package');
  }
  if(raspberryPackage.scripts?.['gate:b4-servicedata']!=='node scripts/run-b4-raspberry-servicedata-gate.mjs'){
    isolationErrors.push('V5BT B4 ServiceData gate script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['gate:b4-ten-device']!=='node scripts/run-b4-ten-device-gate.mjs'){
    isolationErrors.push('V5BT B4 ten-device gate script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['gate:b5-gatt-smoke']!=='npm run build && node scripts/run-b5-raspberry-gatt-smoke.mjs'){
    isolationErrors.push('V5BT B5.3 physical GATT smoke script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['gate:b5-hello-smoke']!=='npm run build && node scripts/run-b5-android-hello-smoke.mjs'){
    isolationErrors.push('V5BT B5.5 physical HELLO smoke script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['supervise:b5-campaign']!=='node scripts/run-b5-campaign-supervisor.mjs'){
    isolationErrors.push('V5BT B5 campaign supervisor script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['monitor:b5-raspberry']!=='node ../scripts/run-b5-raspberry-continuity-monitor.mjs'){
    isolationErrors.push('V5BT B5 Raspberry continuity monitor script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['gate:b5-hundred-session']!=='node scripts/run-b5-hundred-session-gate.mjs'){
    isolationErrors.push('V5BT B5 technical hundred-session gate script is missing or has changed');
  }
  if(raspberryPackage.scripts?.['gate:b5-promote']!=='node scripts/run-b5-promotion-gate.mjs'){
    isolationErrors.push('V5BT B5 independent-review promotion script is missing or has changed');
  }
}
if(fs.existsSync(b4PhysicalReportPath)&&fs.existsSync(b4PhysicalLogPath)){
  try{
    const report=JSON.parse(fs.readFileSync(b4PhysicalReportPath,'utf8'));
    const sourceLog=fs.readFileSync(b4PhysicalLogPath);
    const sourceLogSha256=crypto.createHash('sha256').update(sourceLog).digest('hex');
    if(report.verdict!=='PASS'||report.gate?.serviceDataLive!=='PASS'){
      isolationErrors.push('B4.3 physical ServiceData evidence must be PASS');
    }
    if(report.gate?.controlledPhysicalAdvertisers!==1||report.gate?.b4TenNodeGate!=='PENDING'){
      isolationErrors.push('B4.3 evidence must not promote the 10-device B4 gate');
    }
    if(report.measurement?.requiredDurationSeconds!==90||report.measurement?.wallClockDurationMs<90000){
      isolationErrors.push('B4.3 physical evidence must cover the full 90-second run');
    }
    if(typeof report.lifecycle?.durationMs!=='number'||report.lifecycle.durationMs<75000){
      isolationErrors.push('B4.3 physical evidence must include at least 75 seconds of node runtime');
    }
    if(
      !Number.isSafeInteger(report.serviceData?.observationsAccepted)||
      report.serviceData.observationsAccepted<1
    ){
      isolationErrors.push('B4.3 physical evidence must include accepted ServiceData');
    }
    if(
      !Number.isSafeInteger(report.serviceData?.expiredStreamsRemoved)||
      report.serviceData.expiredStreamsRemoved<1||
      !Number.isSafeInteger(report.serviceData?.peersPruned)||
      report.serviceData.peersPruned<1
    ){
      isolationErrors.push('B4.3 physical evidence must exercise real expiry and pruning');
    }
    if(Object.values(report.errors??{}).some(value=>value!==0)){
      isolationErrors.push('B4.3 physical evidence contains runtime errors');
    }
    if(
      report.cleanup?.discovering!==false||
      report.cleanup?.busConnected!==false||
      report.cleanup?.discoverySessionAcquired!==false||
      report.cleanup?.activeMatchRules!==0||
      report.cleanup?.trackedDevices!==0||
      report.cleanup?.retryScheduled!==false
    ){
      isolationErrors.push('B4.3 physical evidence cleanup contract is invalid');
    }
    if(report.sourceLogSha256!==sourceLogSha256){
      isolationErrors.push('B4.3 physical evidence hash does not match its source log');
    }
    if(
      report.privacy?.bluetoothAddressesIncluded!==false||
      report.privacy?.rotatingAliasesIncluded!==false||
      report.privacy?.stableNodeIdsIncluded!==false||
      report.privacy?.rawPayloadsIncluded!==false
    ){
      isolationErrors.push('B4.3 physical report privacy contract is invalid');
    }
  }catch{
    isolationErrors.push('B4.3 physical evidence is malformed');
  }
}
const ok=missing.length===0&&manifestErrors.length===0&&isolationErrors.length===0;
const roadmapPromotionAllowed=isRoadmapPromotionAllowed({
  packageValid:ok,
  externalEvidenceBlockers,
  currentRoadmapStatus
});
console.log(JSON.stringify({
  ok,
  roadmapPromotionAllowed,
  currentRoadmapStatus:currentRoadmapStatus===null?null:{
    statusAsOf:currentRoadmapStatus.statusAsOf,
    officialProgressPercent:currentRoadmapStatus.officialProgressPercent,
    b4:currentRoadmapStatus.b4,
    b5:currentRoadmapStatus.b5,
    b6:currentRoadmapStatus.b6,
    applicationLoad:currentRoadmapStatus.applicationLoad,
    promotion:currentRoadmapStatus.promotion
  },
  missing,
  manifestErrors,
  isolationErrors,
  externalEvidenceBlockers
},null,2));
if(!ok)process.exit(1);
