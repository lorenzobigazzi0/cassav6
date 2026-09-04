package com.sentrapa.webkiosk.bluetooth

import java.util.UUID

enum class AndroidGattCharacteristicCapability {
    READ,
    WRITE,
    WRITE_WITHOUT_RESPONSE,
    NOTIFY,
    INDICATE
}

data class AndroidGattCharacteristicContract(
    val uuid: UUID,
    val capabilities: Set<AndroidGattCharacteristicCapability>
)

object AndroidGattProfileV1 {
    const val MINIMUM_MTU = 23
    const val PREFERRED_MTU = 247
    const val MAXIMUM_MTU = 517

    val serviceUuid: UUID =
        UUID.fromString(BluetoothAdvertisementCodecV1.SERVICE_UUID)
    val helloUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410002")
    val controlRxUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410003")
    val controlTxUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410004")
    val dataRxUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410005")
    val dataTxUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410006")
    val ackTxUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410007")
    val metricsUuid: UUID =
        UUID.fromString("b1c4a500-7d1f-4f32-9a64-4f4b6c410008")
    val clientConfigurationDescriptorUuid: UUID =
        UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    val characteristics: Map<UUID, Set<AndroidGattCharacteristicCapability>> =
        listOf(
            AndroidGattCharacteristicContract(
                helloUuid,
                setOf(
                    AndroidGattCharacteristicCapability.READ,
                    AndroidGattCharacteristicCapability.WRITE
                )
            ),
            contract(
                3,
                AndroidGattCharacteristicCapability.WRITE,
                AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE
            ),
            contract(
                4,
                AndroidGattCharacteristicCapability.NOTIFY,
                AndroidGattCharacteristicCapability.INDICATE
            ),
            contract(
                5,
                AndroidGattCharacteristicCapability.WRITE,
                AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE
            ),
            contract(6, AndroidGattCharacteristicCapability.NOTIFY),
            contract(7, AndroidGattCharacteristicCapability.INDICATE),
            contract(
                8,
                AndroidGattCharacteristicCapability.READ,
                AndroidGattCharacteristicCapability.NOTIFY
            )
        ).associate { it.uuid to it.capabilities }

    val characteristicUuids: Set<UUID> = characteristics.keys

    fun isComplete(
        discoveredServiceUuid: UUID,
        discoveredCharacteristics:
            Map<UUID, Set<AndroidGattCharacteristicCapability>>
    ): Boolean =
        discoveredServiceUuid == serviceUuid &&
            discoveredCharacteristics == characteristics

    fun isComplete(
        discoveredServiceUuid: UUID,
        discoveredCharacteristicUuids: Set<UUID>
    ): Boolean =
        discoveredServiceUuid == serviceUuid &&
            discoveredCharacteristicUuids == characteristicUuids

    fun isValidMtu(mtu: Int): Boolean = mtu in MINIMUM_MTU..MAXIMUM_MTU

    private fun contract(
        suffix: Int,
        vararg capabilities: AndroidGattCharacteristicCapability
    ) = AndroidGattCharacteristicContract(
        uuid =
            UUID.fromString(
                "b1c4a500-7d1f-4f32-9a64-4f4b6c4100${suffix.toString().padStart(2, '0')}"
            ),
        capabilities = capabilities.toSet()
    )
}

object BluetoothGattCandidatePolicy {
    fun isEligible(advertisement: BluetoothAdvertisementV1): Boolean {
        return runCatching {
            val value = BluetoothAdvertisementCodecV1.validate(advertisement)
            value.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY &&
                value.serverReachable &&
                value.capabilities and BluetoothCapabilityBitsV1.GATT_SERVER != 0
        }.getOrDefault(false)
    }

    fun shouldConnect(
        observation: BluetoothPeerObservationResult,
        advertisement: BluetoothAdvertisementV1
    ): Boolean =
        observation in setOf(
            BluetoothPeerObservationResult.ADDED,
            BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED
        ) && isEligible(advertisement)

    fun shouldConnect(
        observation: BluetoothPeerObservationResult,
        remoteAdvertisement: BluetoothAdvertisementV1,
        localAdvertisement: BluetoothAdvertisementV1,
        androidPeerAuthEnabled: Boolean,
        aliasEpoch: Long
    ): Boolean {
        if (
            observation !in setOf(
                BluetoothPeerObservationResult.ADDED,
                BluetoothPeerObservationResult.CAPACITY_EVICTED_ADDED
            )
        ) return false
        val remote = runCatching {
            BluetoothAdvertisementCodecV1.validate(remoteAdvertisement)
        }.getOrNull() ?: return false
        if (remote.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY) {
            return isEligible(remote)
        }
        if (!androidPeerAuthEnabled) return false
        val local = runCatching {
            BluetoothAdvertisementCodecV1.validate(localAdvertisement)
        }.getOrNull() ?: return false
        if (
            local.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY ||
            remote.nodeKind == BluetoothAdvertisementNodeKind.RASPBERRY ||
            local.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE !=
                BluetoothCapabilityBitsV1.B2_FULL_NODE ||
            remote.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE !=
                BluetoothCapabilityBitsV1.B2_FULL_NODE
        ) return false
        val decision = AndroidAndroidRoleElectionV1.elect(
            roleCandidate(local, aliasEpoch),
            roleCandidate(remote, aliasEpoch)
        )
        return decision.role == AndroidAndroidGattRoleV1.CLIENT
    }

    private fun roleCandidate(
        advertisement: BluetoothAdvertisementV1,
        aliasEpoch: Long
    ) = AndroidAndroidRoleCandidateV1(
        nodeKind = advertisement.nodeKind,
        nodeClass =
            if (
                advertisement.capabilities and BluetoothCapabilityBitsV1.B2_FULL_NODE ==
                    BluetoothCapabilityBitsV1.B2_FULL_NODE
            ) {
                BluetoothNodeClass.FULL_NODE
            } else if (
                advertisement.capabilities and
                    (BluetoothCapabilityBitsV1.SCAN or
                        BluetoothCapabilityBitsV1.GATT_CLIENT) ==
                    (BluetoothCapabilityBitsV1.SCAN or
                        BluetoothCapabilityBitsV1.GATT_CLIENT)
            ) {
                BluetoothNodeClass.CLIENT_ONLY
            } else {
                BluetoothNodeClass.UNSUPPORTED
            },
        rotatingAlias = advertisement.rotatingAlias,
        aliasEpoch = aliasEpoch
    )
}
