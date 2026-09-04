package com.sentrapa.webkiosk.bluetooth

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothTransportStoreContractTest {
    @Test
    fun `schema exposes exactly five bounded domain tables`() {
        assertEquals(
            listOf(
                "bluetooth_outbox",
                "bluetooth_inbox_dedup",
                "known_peers",
                "session_history",
                "last_server_advertisement"
            ),
            BluetoothTransportStoreContractV1.DATA_TABLE_NAMES
        )
        assertEquals(5, BluetoothTransportStoreContractV1.DATA_TABLE_NAMES.size)
        assertEquals(
            "bluetooth_transport_meta",
            BluetoothTransportStoreContractV1.META_TABLE_NAME
        )
        assertEquals(6, BluetoothTransportStoreContractV1.CREATE_STATEMENTS.size)
        assertEquals(4, BluetoothTransportStoreContractV1.INDEX_STATEMENTS.size)

        val sql = (
            BluetoothTransportStoreContractV1.CREATE_STATEMENTS +
                BluetoothTransportStoreContractV1.INDEX_STATEMENTS
            ).joinToString("\n")
        BluetoothTransportStoreContractV1.DATA_TABLE_NAMES.forEach {
            assertTrue(sql.contains("CREATE TABLE IF NOT EXISTS $it"))
        }
        assertTrue(sql.contains("CHECK(length(payload) <= 16384)"))
        assertTrue(sql.contains("PRIMARY KEY(peer_trust_id, message_id)"))
        assertTrue(sql.contains("CHECK(singleton_id=1)"))
        assertTrue(sql.contains("CHECK(capabilities BETWEEN 0 AND 127)"))
        assertTrue(sql.contains("CHECK(closed_at_ms IS NULL OR closed_at_ms >= opened_at_ms)"))
        assertFalse(sql.contains("DROP ", ignoreCase = true))
    }

    @Test
    fun `migration is explicit and unsupported versions fail closed`() {
        assertEquals(
            BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION,
            BluetoothTransportStoreContractV1.validateSchemaVersion(3L)
        )
        assertStoreError("UNSUPPORTED_SCHEMA") {
            BluetoothTransportStoreContractV1.validateSchemaVersion(0L)
        }
        assertStoreError("UNSUPPORTED_SCHEMA") {
            BluetoothTransportStoreContractV1.validateSchemaVersion(2L)
        }
        assertStoreError("UNSUPPORTED_SCHEMA") {
            BluetoothTransportStoreContractV1.validateSchemaVersion(1L)
        }

        val source = androidStoreSource()
        assertTrue(source.contains("override fun onUpgrade("))
        assertTrue(source.contains("override fun onDowngrade("))
        assertTrue(source.contains("UNSUPPORTED_SCHEMA"))
        assertTrue(source.contains("UNBOUND_LEGACY_RECORDS"))
        assertTrue(source.contains("migratedVersion == 1"))
        assertTrue(source.contains("migratedVersion == 2"))
        assertTrue(source.contains("DROP TABLE bluetooth_outbox"))
        assertTrue(source.contains("DROP TABLE bluetooth_inbox_dedup"))
    }

    @Test
    fun `committed high watermark and outbox survive simulated crash reopen`() {
        val persisted = PersistedMetadata()
        val durableOutbox = mutableListOf<ReliableOutboxRecordV1>()

        val firstSequence = BluetoothTransportStoreContractV1.nextSequence(
            persisted.outboundSequence
        )
        persisted.outboundSequence = firstSequence
        val record = validOutboxRecord()
        BluetoothTransportStoreContractV1.validateOutboxRecord(record)
        durableOutbox += record

        reopen(persisted, durableOutbox)
        assertEquals(1L, persisted.outboundSequence)
        assertEquals(MESSAGE_ID, durableOutbox.single().messageId)
        assertEquals(
            2L,
            BluetoothTransportStoreContractV1.nextSequence(persisted.outboundSequence)
        )
    }

    @Test
    fun `uncommitted crash window does not advance durable metadata`() {
        val persisted = PersistedMetadata()
        val stagedSequence = BluetoothTransportStoreContractV1.nextSequence(
            persisted.outboundSequence
        )
        val stagedRecord = validOutboxRecord()
        BluetoothTransportStoreContractV1.validateOutboxRecord(stagedRecord)

        reopen(persisted, emptyList())
        assertEquals(1L, stagedSequence)
        assertEquals(0L, persisted.outboundSequence)
        assertEquals(
            1L,
            BluetoothTransportStoreContractV1.nextSequence(persisted.outboundSequence)
        )
    }

    @Test
    fun `sequence high watermark accepts exhausted reopen but forbids reuse`() {
        assertEquals(
            BluetoothTransportStoreContractV1.MAX_OUTBOUND_SEQUENCE,
            BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
                BluetoothTransportStoreContractV1.MAX_OUTBOUND_SEQUENCE
            )
        )
        assertStoreError("SEQUENCE_EXHAUSTED") {
            BluetoothTransportStoreContractV1.nextSequence(
                BluetoothTransportStoreContractV1.MAX_OUTBOUND_SEQUENCE
            )
        }
        assertStoreError("CORRUPT_STORE") {
            BluetoothTransportStoreContractV1.validateSequenceHighWatermark(-1L)
        }
        assertStoreError("CORRUPT_STORE") {
            BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
                BluetoothTransportStoreContractV1.MAX_OUTBOUND_SEQUENCE + 1L
            )
        }
    }

    @Test
    fun `clock high watermark survives reopen and regression fails closed`() {
        val persisted = PersistedMetadata(lastClockMs = 10_000L)
        reopen(persisted, emptyList())
        persisted.lastClockMs = BluetoothTransportStoreContractV1.advanceClock(
            persisted.lastClockMs,
            10_001L
        )
        reopen(persisted, emptyList())
        assertEquals(10_001L, persisted.lastClockMs)
        assertEquals(
            10_001L,
            BluetoothTransportStoreContractV1.advanceClock(10_001L, 10_001L)
        )
        assertStoreError("STORE_CLOCK_REGRESSION") {
            BluetoothTransportStoreContractV1.advanceClock(10_001L, 10_000L)
        }
        assertStoreError("INVALID_STORE_CLOCK") {
            BluetoothTransportStoreContractV1.advanceClock(
                0L,
                ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK + 1L
            )
        }
    }

    @Test
    fun `durable outbox rejects acknowledgements flags payload and expiry violations`() {
        BluetoothTransportStoreContractV1.validateOutboxRecord(validOutboxRecord())
        assertStoreError("INVALID_STORE_VALUE") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(type = ReliableFrameTypeV1.ACK)
            )
        }
        assertStoreError("INVALID_STORE_VALUE") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(flags = 0)
            )
        }
        assertStoreError("STORE_LIMIT_EXCEEDED") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(
                    payload = ByteArray(ReliableFrameCodecV1.MAX_PAYLOAD_BYTES + 1)
                )
            )
        }
        assertStoreError("INVALID_STORE_VALUE") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(createdAtMs = 1_000L, expiresAtMs = 1_000L)
            )
        }
        assertStoreError("INVALID_MESSAGE_ID") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(messageId = MESSAGE_ID.uppercase())
            )
        }
        assertStoreError("INVALID_PEER_TRUST_ID") {
            BluetoothTransportStoreContractV1.validateOutboxRecord(
                validOutboxRecord(peerTrustId = PEER_TRUST_ID.uppercase())
            )
        }
    }

    @Test
    fun `peer session and route records enforce canonical bounds`() {
        BluetoothTransportStoreContractV1.validateKnownPeer(
            BluetoothKnownPeerInputV1("peer.api31", 0x7f, 1_000L, true)
        )
        BluetoothTransportStoreContractV1.validateSessionOpen(
            BluetoothSessionOpenInputV1(SESSION_ID, "peer.api31", 1_000L)
        )
        BluetoothTransportStoreContractV1.validateSessionClose(
            BluetoothSessionCloseInputV1(SESSION_ID, 2_000L, "normal_close")
        )
        BluetoothTransportStoreContractV1.validateAdvertisement(
            BluetoothStoredRouteAdvertisementV1(
                canReachServer = true,
                routeKind = BluetoothRouteKindV1.BLE_DIRECT,
                serverRttBucket = 15,
                routeAgeSeconds = 65_535,
                queueDepthBucket = 15,
                batteryBucket = 15,
                sequence = 0xffff_ffffL,
                observedAtEpochMs = 2_000L
            )
        )

        assertStoreError("INVALID_STORE_VALUE") {
            BluetoothTransportStoreContractV1.validateKnownPeer(
                BluetoothKnownPeerInputV1("peer", 0x80, 1_000L, false)
            )
        }
        assertStoreError("INVALID_SESSION_ID") {
            BluetoothTransportStoreContractV1.validateSessionOpen(
                BluetoothSessionOpenInputV1("short", "peer", 1_000L)
            )
        }
        assertStoreError("INVALID_ROUTE") {
            BluetoothTransportStoreContractV1.validateAdvertisement(
                BluetoothStoredRouteAdvertisementV1(
                    false,
                    BluetoothRouteKindV1.NONE,
                    16,
                    0,
                    0,
                    0,
                    1,
                    1_000L
                )
            )
        }
    }

    @Test
    fun `snapshot is bounded and redacts every persistent identifier`() {
        val snapshot = BluetoothTransportStoreSnapshotV1(
            outboxDepth = 1,
            inboxDedupDepth = 2,
            knownPeerCount = 3,
            sessionHistoryCount = 4,
            openSessionCount = 1,
            hasServerAdvertisement = true
        )
        val json = snapshot.toRedactedJson()
        assertEquals(
            "{\"schemaVersion\":3,\"outboxDepth\":1," +
                "\"inboxDedupDepth\":2,\"knownPeerCount\":3," +
                "\"sessionHistoryCount\":4,\"openSessionCount\":1," +
                "\"hasServerAdvertisement\":true}",
            json
        )
        listOf("messageId", "nodeId", "peerId", "sessionId", "payload", "path").forEach {
            assertFalse(json.contains(it, ignoreCase = true))
        }
        assertStoreError("CORRUPT_STORE") {
            BluetoothTransportStoreSnapshotV1(
                BluetoothTransportStoreContractV1.MAX_OUTBOX_RECORDS + 1,
                0,
                0,
                0,
                0,
                false
            )
        }
    }

    @Test
    fun `database name cannot escape app private storage`() {
        assertEquals(
            BLUETOOTH_TRANSPORT_STORE_DATABASE_NAME,
            BluetoothTransportStoreContractV1.validateDatabaseName(
                BLUETOOTH_TRANSPORT_STORE_DATABASE_NAME
            )
        )
        listOf("../store.db", "/tmp/store.db", "store", ".hidden.db", "x/y.db").forEach {
            assertStoreError("INVALID_STORE_NAME") {
                BluetoothTransportStoreContractV1.validateDatabaseName(it)
            }
        }
    }

    @Test
    fun `android helper declares atomic durable reopen and file hardening controls`() {
        val source = androidStoreSource()
        listOf(
            "SQLiteOpenHelper",
            "PRAGMA synchronous=FULL",
            "PRAGMA secure_delete=ON",
            "PRAGMA fullfsync=ON",
            "PRAGMA journal_mode=DELETE",
            "PRAGMA quick_check(1)",
            "database.beginTransaction()",
            "database.setTransactionSuccessful()",
            "database.endTransaction()",
            "Os.lstat",
            "status.st_nlink != 1L",
            "status.st_uid != Process.myUid()",
            "validateStoredIdentifiers(db)",
            "override fun listOutbox("
        ).forEach { assertTrue("missing $it", source.contains(it)) }
        assertTrue(
            source.indexOf("database.beginTransaction()") <
                source.indexOf("database.setTransactionSuccessful()")
        )
        assertTrue(
            source.indexOf("database.setTransactionSuccessful()") <
                source.indexOf("database.endTransaction()")
        )
    }

    private fun reopen(
        metadata: PersistedMetadata,
        outbox: List<ReliableOutboxRecordV1>
    ) {
        BluetoothTransportStoreContractV1.validateSchemaVersion(metadata.schemaVersion)
        BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
            metadata.outboundSequence
        )
        BluetoothTransportStoreContractV1.validateClock(
            metadata.lastClockMs,
            "last_clock_ms"
        )
        outbox.forEach(BluetoothTransportStoreContractV1::validateOutboxRecord)
    }

    private fun validOutboxRecord(
        peerTrustId: String = PEER_TRUST_ID,
        messageId: String = MESSAGE_ID,
        type: ReliableFrameTypeV1 = ReliableFrameTypeV1.DATA,
        flags: Int = ReliableFrameFlagsV1.DURABLE,
        payload: ByteArray = byteArrayOf(1, 2, 3),
        createdAtMs: Long = 1_000L,
        expiresAtMs: Long = 2_000L
    ): ReliableOutboxRecordV1 = ReliableOutboxRecordV1(
        peerTrustId,
        messageId,
        type,
        flags,
        payload,
        createdAtMs,
        expiresAtMs
    )

    private fun assertStoreError(code: String, operation: () -> Unit) {
        val error = assertThrows(BluetoothTransportStoreException::class.java) {
            operation()
        }
        assertEquals(code, error.code)
    }

    private fun androidStoreSource(): String {
        val relative =
            "com/sentrapa/webkiosk/bluetooth/AndroidBluetoothTransportStore.kt"
        val source = listOf(
            File("app/src/main/java/$relative"),
            File("src/main/java/$relative")
        ).firstOrNull(File::isFile)
        assertTrue("Android store source is missing", source != null)
        return source!!.readText()
    }

    private data class PersistedMetadata(
        val schemaVersion: Long = BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION.toLong(),
        var outboundSequence: Long = 0L,
        var lastClockMs: Long = 0L
    )

    companion object {
        private const val MESSAGE_ID = "00112233445566778899aabbccddeeff"
        private const val PEER_TRUST_ID =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        private const val SESSION_ID = "session_0011223344"
    }
}
