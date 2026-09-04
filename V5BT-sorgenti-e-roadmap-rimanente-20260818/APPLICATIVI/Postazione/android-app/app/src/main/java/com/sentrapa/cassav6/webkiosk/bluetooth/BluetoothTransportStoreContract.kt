package com.sentrapa.cassav6.webkiosk.bluetooth

const val BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION = 3
const val BLUETOOTH_TRANSPORT_STORE_DATABASE_NAME =
    "cassav6_bluetooth_transport.db"

enum class BluetoothRouteKindV1 {
    WIFI,
    LAN,
    BLE_DIRECT,
    NONE
}

data class BluetoothKnownPeerInputV1(
    val nodeId: String,
    val capabilities: Int,
    val lastSeenAtEpochMs: Long,
    val serverReachable: Boolean
)

data class BluetoothSessionOpenInputV1(
    val sessionId: String,
    val peerId: String,
    val openedAtEpochMs: Long
)

data class BluetoothSessionCloseInputV1(
    val sessionId: String,
    val closedAtEpochMs: Long,
    val closeReason: String
)

data class BluetoothStoredRouteAdvertisementV1(
    val canReachServer: Boolean,
    val routeKind: BluetoothRouteKindV1,
    val serverRttBucket: Int,
    val routeAgeSeconds: Int,
    val queueDepthBucket: Int,
    val batteryBucket: Int,
    val sequence: Long,
    val observedAtEpochMs: Long
)

data class BluetoothTransportStoreSnapshotV1(
    val outboxDepth: Int,
    val inboxDedupDepth: Int,
    val knownPeerCount: Int,
    val sessionHistoryCount: Int,
    val openSessionCount: Int,
    val hasServerAdvertisement: Boolean,
    val schemaVersion: Int = BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION
) {
    init {
        BluetoothTransportStoreContractV1.validateSnapshot(this)
    }

    fun toRedactedJson(): String =
        "{\"schemaVersion\":$schemaVersion," +
            "\"outboxDepth\":$outboxDepth," +
            "\"inboxDedupDepth\":$inboxDedupDepth," +
            "\"knownPeerCount\":$knownPeerCount," +
            "\"sessionHistoryCount\":$sessionHistoryCount," +
            "\"openSessionCount\":$openSessionCount," +
            "\"hasServerAdvertisement\":$hasServerAdvertisement}"
}

class BluetoothTransportStoreException(
    val code: String,
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

internal fun bluetoothTransportStoreFailure(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw BluetoothTransportStoreException(code, message, cause)

internal object BluetoothTransportStoreContractV1 {
    const val MAX_OUTBOX_RECORDS = 4_096
    const val MAX_INBOX_RECORDS = 8_192
    const val MAX_KNOWN_PEERS = 2_048
    const val MAX_SESSION_HISTORY = 4_096
    const val MAX_OUTBOUND_SEQUENCE = 0xffff_ffffL

    val DATA_TABLE_NAMES = listOf(
        "bluetooth_outbox",
        "bluetooth_inbox_dedup",
        "known_peers",
        "session_history",
        "last_server_advertisement"
    )
    const val META_TABLE_NAME = "bluetooth_transport_meta"
    val INDEX_NAMES = listOf(
        "bluetooth_outbox_expiry_idx",
        "bluetooth_inbox_expiry_idx",
        "known_peers_seen_idx",
        "session_history_open_idx"
    )

    val OUTBOX_CREATE_STATEMENT =
        """
        CREATE TABLE IF NOT EXISTS bluetooth_outbox(
            peer_trust_id TEXT NOT NULL
                CHECK(length(peer_trust_id)=64)
                CHECK(peer_trust_id NOT GLOB '*[^0-9a-f]*'),
            message_id TEXT NOT NULL
                CHECK(length(message_id)=32)
                CHECK(message_id NOT GLOB '*[^0-9a-f]*'),
            message_type INTEGER NOT NULL CHECK(message_type BETWEEN 1 AND 255),
            flags INTEGER NOT NULL CHECK(flags BETWEEN 0 AND 255),
            payload BLOB NOT NULL CHECK(length(payload) <= 16384),
            created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
            expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
            PRIMARY KEY(peer_trust_id, message_id)
        )
        """.trimIndent()

    val INBOX_CREATE_STATEMENT =
        """
        CREATE TABLE IF NOT EXISTS bluetooth_inbox_dedup(
            peer_trust_id TEXT NOT NULL
                CHECK(length(peer_trust_id)=64)
                CHECK(peer_trust_id NOT GLOB '*[^0-9a-f]*'),
            message_id TEXT NOT NULL
                CHECK(length(message_id)=32)
                CHECK(message_id NOT GLOB '*[^0-9a-f]*'),
            expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > 0),
            PRIMARY KEY(peer_trust_id, message_id)
        )
        """.trimIndent()

    val CREATE_STATEMENTS = listOf(
        """
        CREATE TABLE IF NOT EXISTS bluetooth_transport_meta(
            key TEXT PRIMARY KEY NOT NULL
                CHECK(key IN (
                    'schema_version','outbound_sequence','last_clock_ms',
                    'route_outbound_sequence'
                )),
            value INTEGER NOT NULL CHECK(value >= 0)
        )
        """.trimIndent(),
        OUTBOX_CREATE_STATEMENT,
        INBOX_CREATE_STATEMENT,
        """
        CREATE TABLE IF NOT EXISTS known_peers(
            node_id TEXT PRIMARY KEY NOT NULL
                CHECK(length(node_id) BETWEEN 1 AND 128)
                CHECK(substr(node_id,1,1) GLOB '[A-Za-z0-9]')
                CHECK(node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
            capabilities INTEGER NOT NULL CHECK(capabilities BETWEEN 0 AND 127),
            last_seen_at_ms INTEGER NOT NULL CHECK(last_seen_at_ms >= 0),
            server_reachable INTEGER NOT NULL CHECK(server_reachable IN (0,1))
        )
        """.trimIndent(),
        """
        CREATE TABLE IF NOT EXISTS session_history(
            session_id TEXT PRIMARY KEY NOT NULL
                CHECK(length(session_id) BETWEEN 16 AND 128)
                CHECK(session_id NOT GLOB '*[^A-Za-z0-9_-]*'),
            peer_id TEXT NOT NULL
                CHECK(length(peer_id) BETWEEN 1 AND 128)
                CHECK(substr(peer_id,1,1) GLOB '[A-Za-z0-9]')
                CHECK(peer_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
            opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms >= 0),
            closed_at_ms INTEGER,
            close_reason TEXT,
            CHECK(closed_at_ms IS NULL OR closed_at_ms >= opened_at_ms),
            CHECK((closed_at_ms IS NULL) = (close_reason IS NULL)),
            CHECK(close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 128),
            CHECK(close_reason IS NULL OR close_reason NOT GLOB '*[^A-Za-z0-9._:-]*')
        )
        """.trimIndent(),
        """
        CREATE TABLE IF NOT EXISTS last_server_advertisement(
            singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id=1),
            can_reach_server INTEGER NOT NULL CHECK(can_reach_server IN (0,1)),
            route_kind TEXT NOT NULL
                CHECK(route_kind IN ('WIFI','LAN','BLE_DIRECT','NONE')),
            server_rtt_bucket INTEGER NOT NULL CHECK(server_rtt_bucket BETWEEN 0 AND 15),
            route_age_seconds INTEGER NOT NULL CHECK(route_age_seconds BETWEEN 0 AND 65535),
            queue_depth_bucket INTEGER NOT NULL CHECK(queue_depth_bucket BETWEEN 0 AND 15),
            battery_bucket INTEGER NOT NULL CHECK(battery_bucket BETWEEN 0 AND 15),
            sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 4294967295),
            observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0)
        )
        """.trimIndent()
    )

    val INDEX_STATEMENTS = listOf(
        "CREATE INDEX IF NOT EXISTS bluetooth_outbox_expiry_idx " +
            "ON bluetooth_outbox(expires_at_ms)",
        "CREATE INDEX IF NOT EXISTS bluetooth_inbox_expiry_idx " +
            "ON bluetooth_inbox_dedup(expires_at_ms)",
        "CREATE INDEX IF NOT EXISTS known_peers_seen_idx " +
            "ON known_peers(last_seen_at_ms)",
        "CREATE INDEX IF NOT EXISTS session_history_open_idx " +
            "ON session_history(closed_at_ms)"
    )

    private val databaseNamePattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\\.db$")
    private val messageIdPattern = Regex("^[0-9a-f]{32}$")
    private val peerTrustIdPattern = Regex("^[0-9a-f]{64}$")
    private val identifierPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private val sessionIdPattern = Regex("^[A-Za-z0-9_-]{16,128}$")

    fun validateDatabaseName(value: String): String {
        if (!databaseNamePattern.matches(value)) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_NAME",
                "Bluetooth transport database name is not canonical"
            )
        }
        return value
    }

    fun validateMessageId(value: String): String {
        if (!messageIdPattern.matches(value)) {
            bluetoothTransportStoreFailure(
                "INVALID_MESSAGE_ID",
                "messageId must be canonical lowercase hex"
            )
        }
        return value
    }

    fun validatePeerTrustId(value: String): String {
        if (!peerTrustIdPattern.matches(value)) {
            bluetoothTransportStoreFailure(
                "INVALID_PEER_TRUST_ID",
                "peerTrustId must be a canonical V1 trust commitment"
            )
        }
        return value
    }

    fun validateIdentifier(value: String, field: String): String {
        if (!identifierPattern.matches(value)) {
            bluetoothTransportStoreFailure(
                "INVALID_IDENTIFIER",
                "$field is not canonical"
            )
        }
        return value
    }

    fun validateSessionId(value: String): String {
        if (!sessionIdPattern.matches(value)) {
            bluetoothTransportStoreFailure(
                "INVALID_SESSION_ID",
                "sessionId is not canonical"
            )
        }
        return value
    }

    fun validateClock(value: Long, field: String = "clock"): Long {
        if (value !in 0L..ReliableFrameCodecV1.MAXIMUM_SAFE_CLOCK) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_CLOCK",
                "$field is outside its canonical range"
            )
        }
        return value
    }

    fun advanceClock(lastClockEpochMs: Long, candidateEpochMs: Long): Long {
        validateClock(lastClockEpochMs, "lastClockEpochMs")
        validateClock(candidateEpochMs, "candidateEpochMs")
        if (candidateEpochMs < lastClockEpochMs) {
            bluetoothTransportStoreFailure(
                "STORE_CLOCK_REGRESSION",
                "Bluetooth transport store clock regressed"
            )
        }
        return candidateEpochMs
    }

    fun validateSchemaVersion(value: Long): Int {
        if (value != BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION.toLong()) {
            bluetoothTransportStoreFailure(
                "UNSUPPORTED_SCHEMA",
                "Bluetooth transport store requires an explicit migration"
            )
        }
        return value.toInt()
    }

    fun validateSequenceHighWatermark(value: Long): Long {
        if (value !in 0L..MAX_OUTBOUND_SEQUENCE) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "outbound sequence high-watermark is invalid"
            )
        }
        return value
    }

    fun nextSequence(current: Long): Long {
        validateSequenceHighWatermark(current)
        if (current == MAX_OUTBOUND_SEQUENCE) {
            bluetoothTransportStoreFailure(
                "SEQUENCE_EXHAUSTED",
                "outbound sequence space is exhausted"
            )
        }
        return current + 1L
    }

    fun validateOutboxRecord(record: ReliableOutboxRecordV1) {
        validatePeerTrustId(record.peerTrustId)
        validateMessageId(record.messageId)
        if (record.type == ReliableFrameTypeV1.ACK) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_VALUE",
                "ACK frames cannot be persisted in the outbox"
            )
        }
        if (record.flags != ReliableFrameFlagsV1.DURABLE) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_VALUE",
                "outbox record must be durable and use only assigned flags"
            )
        }
        validateClock(record.createdAtEpochMs, "createdAtEpochMs")
        validateClock(record.expiresAtEpochMs, "expiresAtEpochMs")
        if (record.expiresAtEpochMs <= record.createdAtEpochMs) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_VALUE",
                "outbox expiry must follow creation time"
            )
        }
        if (record.payload.size > ReliableFrameCodecV1.MAX_PAYLOAD_BYTES) {
            bluetoothTransportStoreFailure(
                "STORE_LIMIT_EXCEEDED",
                "outbox payload exceeds the protocol limit"
            )
        }
    }

    fun validateKnownPeer(input: BluetoothKnownPeerInputV1) {
        validateIdentifier(input.nodeId, "nodeId")
        if (input.capabilities !in 0..0x7f) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_VALUE",
                "capabilities are outside the assigned range"
            )
        }
        validateClock(input.lastSeenAtEpochMs, "lastSeenAtEpochMs")
    }

    fun validateSessionOpen(input: BluetoothSessionOpenInputV1) {
        validateSessionId(input.sessionId)
        validateIdentifier(input.peerId, "peerId")
        validateClock(input.openedAtEpochMs, "openedAtEpochMs")
    }

    fun validateSessionClose(input: BluetoothSessionCloseInputV1) {
        validateSessionId(input.sessionId)
        validateIdentifier(input.closeReason, "closeReason")
        validateClock(input.closedAtEpochMs, "closedAtEpochMs")
    }

    fun validateAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
        if (
            value.serverRttBucket !in 0..15 ||
            value.routeAgeSeconds !in 0..65_535 ||
            value.queueDepthBucket !in 0..15 ||
            value.batteryBucket !in 0..15 ||
            value.sequence !in 0..MAX_OUTBOUND_SEQUENCE
        ) {
            bluetoothTransportStoreFailure(
                "INVALID_ROUTE",
                "server advertisement bucket is outside its assigned range"
            )
        }
        validateClock(value.observedAtEpochMs, "observedAtEpochMs")
    }

    fun validateSnapshot(value: BluetoothTransportStoreSnapshotV1) {
        if (
            value.schemaVersion != BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION ||
            value.outboxDepth !in 0..MAX_OUTBOX_RECORDS ||
            value.inboxDedupDepth !in 0..MAX_INBOX_RECORDS ||
            value.knownPeerCount !in 0..MAX_KNOWN_PEERS ||
            value.sessionHistoryCount !in 0..MAX_SESSION_HISTORY ||
            value.openSessionCount !in 0..value.sessionHistoryCount
        ) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "Bluetooth transport store counters are inconsistent"
            )
        }
    }
}
