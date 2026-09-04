package com.sentrapa.cassav6.webkiosk.bluetooth

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
        UUID.fromString("34f16f91-8558-595d-ba61-f0b31b2aa7f0")
    val controlRxUuid: UUID =
        UUID.fromString("6c4927da-180d-5e9a-a3c7-c3b7cbccc499")
    val controlTxUuid: UUID =
        UUID.fromString("d9af61c0-289d-583d-877c-ef19a49413c9")
    val dataRxUuid: UUID =
        UUID.fromString("520f34b8-8e37-50a7-ada0-00252a94f11c")
    val dataTxUuid: UUID =
        UUID.fromString("13e8dde6-a0d5-5227-9608-5a71a65de87a")
    val ackTxUuid: UUID =
        UUID.fromString("5ea76dec-cbaa-5aee-9156-6058066a3a7a")
    val metricsUuid: UUID =
        UUID.fromString("544e9ea6-c9a9-56f7-a1ed-41afe8c72078")
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
                controlRxUuid,
                AndroidGattCharacteristicCapability.WRITE,
                AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE
            ),
            contract(
                controlTxUuid,
                AndroidGattCharacteristicCapability.NOTIFY,
                AndroidGattCharacteristicCapability.INDICATE
            ),
            contract(
                dataRxUuid,
                AndroidGattCharacteristicCapability.WRITE,
                AndroidGattCharacteristicCapability.WRITE_WITHOUT_RESPONSE
            ),
            contract(dataTxUuid, AndroidGattCharacteristicCapability.NOTIFY),
            contract(ackTxUuid, AndroidGattCharacteristicCapability.INDICATE),
            contract(
                metricsUuid,
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
        uuid: UUID,
        vararg capabilities: AndroidGattCharacteristicCapability
    ) = AndroidGattCharacteristicContract(
        uuid = uuid,
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
