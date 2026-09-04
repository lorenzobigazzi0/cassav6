package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Process
import android.system.Os
import android.system.OsConstants
import java.io.File

class AndroidBluetoothTransportStoreV1(
    context: Context,
    databaseName: String = BLUETOOTH_TRANSPORT_STORE_DATABASE_NAME
) : ReliableChannelStoreV1, AutoCloseable {
    private val appContext = context.applicationContext
    private val canonicalDatabaseName =
        BluetoothTransportStoreContractV1.validateDatabaseName(databaseName)
    private val databaseFile = appContext.getDatabasePath(canonicalDatabaseName)
    private val helper = StoreHelper(appContext, canonicalDatabaseName)
    private val database: SQLiteDatabase
    private var closed = false

    init {
        helper.setWriteAheadLoggingEnabled(false)
        val opened = try {
            helper.writableDatabase
        } catch (error: Throwable) {
            helper.close()
            bluetoothTransportStoreFailure(
                "STORE_INITIALIZATION_FAILED",
                "Bluetooth transport store could not be opened",
                error
            )
        }
        try {
            hardenAndValidateDatabaseFile(databaseFile)
            validateRuntimeDatabase(opened)
        } catch (error: Throwable) {
            helper.close()
            if (error is BluetoothTransportStoreException) throw error
            bluetoothTransportStoreFailure(
                "STORE_INITIALIZATION_FAILED",
                "Bluetooth transport store validation failed",
                error
            )
        }
        database = opened
    }

    @Synchronized
    override fun reserveOutboundSequence(): Long = transaction(
        "SEQUENCE_COMMIT_FAILED",
        "outbound sequence could not be committed"
    ) { db ->
        val current = readMetaLong(db, "outbound_sequence")
        val next = BluetoothTransportStoreContractV1.nextSequence(current)
        val changed = db.update(
            BluetoothTransportStoreContractV1.META_TABLE_NAME,
            ContentValues().apply { put("value", next) },
            "key=? AND value=?",
            arrayOf("outbound_sequence", current.toString())
        )
        if (changed != 1) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "outbound sequence high-watermark changed unexpectedly"
            )
        }
        next
    }

    @Synchronized
    fun reserveRouteAdvertisementSequence(): Long = transaction(
        "ROUTE_SEQUENCE_COMMIT_FAILED",
        "route advertisement sequence could not be committed"
    ) { db ->
        val current = readMetaLong(db, "route_outbound_sequence")
        val next = BluetoothTransportStoreContractV1.nextSequence(current)
        val changed = db.update(
            BluetoothTransportStoreContractV1.META_TABLE_NAME,
            ContentValues().apply { put("value", next) },
            "key=? AND value=?",
            arrayOf("route_outbound_sequence", current.toString())
        )
        if (changed != 1) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "route sequence high-watermark changed unexpectedly"
            )
        }
        next
    }

    @Synchronized
    fun routeAdvertisementSequenceHighWatermark(): Long {
        assertOpen()
        return BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
            readMetaLong(database, "route_outbound_sequence")
        )
    }

    @Synchronized
    override fun enqueueOutbox(record: ReliableOutboxRecordV1) {
        BluetoothTransportStoreContractV1.validateOutboxRecord(record)
        val payload = record.payload.copyOf()
        try {
            transaction(
                "OUTBOX_COMMIT_FAILED",
                "durable outbox record could not be committed"
            ) { db ->
                advanceClockLocked(db, record.createdAtEpochMs)
                if (
                    DatabaseUtils.longForQuery(
                        db,
                        "SELECT COUNT(*) FROM bluetooth_outbox " +
                            "WHERE peer_trust_id=? AND message_id=?",
                        arrayOf(record.peerTrustId, record.messageId)
                    ) == 1L
                ) {
                    bluetoothTransportStoreFailure(
                        "OUTBOX_CONFLICT",
                        "messageId already exists in the durable outbox"
                    )
                }
                enforceCapacity(
                    db,
                    "bluetooth_outbox",
                    BluetoothTransportStoreContractV1.MAX_OUTBOX_RECORDS
                )
                db.insertOrThrow(
                    "bluetooth_outbox",
                    null,
                    ContentValues().apply {
                        put("peer_trust_id", record.peerTrustId)
                        put("message_id", record.messageId)
                        put("message_type", record.type.wireValue)
                        put("flags", record.flags)
                        put("payload", payload)
                        put("created_at_ms", record.createdAtEpochMs)
                        put("expires_at_ms", record.expiresAtEpochMs)
                    }
                )
            }
        } finally {
            payload.fill(0)
        }
    }

    @Synchronized
    override fun completeOutbox(peerTrustId: String, messageId: String) {
        val normalizedPeerTrustId =
            BluetoothTransportStoreContractV1.validatePeerTrustId(peerTrustId)
        val normalizedMessageId =
            BluetoothTransportStoreContractV1.validateMessageId(messageId)
        transaction(
            "OUTBOX_COMMIT_FAILED",
            "durable outbox completion could not be committed"
        ) { db ->
            db.delete(
                "bluetooth_outbox",
                "peer_trust_id=? AND message_id=?",
                arrayOf(normalizedPeerTrustId, normalizedMessageId)
            )
        }
    }

    @Synchronized
    override fun listOutbox(
        peerTrustId: String,
        nowEpochMs: Long
    ): List<ReliableOutboxRecordV1> {
        val normalizedPeerTrustId =
            BluetoothTransportStoreContractV1.validatePeerTrustId(peerTrustId)
        return transaction(
            "OUTBOX_RECOVERY_FAILED",
            "durable outbox could not be recovered"
        ) { db ->
            advanceClockLocked(db, nowEpochMs)
            val records = mutableListOf<ReliableOutboxRecordV1>()
            db.query(
                "bluetooth_outbox",
                arrayOf(
                    "peer_trust_id",
                    "message_id",
                    "message_type",
                    "flags",
                    "payload",
                    "created_at_ms",
                    "expires_at_ms"
                ),
                "peer_trust_id=? AND expires_at_ms>?",
                arrayOf(normalizedPeerTrustId, nowEpochMs.toString()),
                null,
                null,
                "created_at_ms ASC, message_id ASC",
                BluetoothTransportStoreContractV1.MAX_OUTBOX_RECORDS.toString()
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val typeValue = cursor.getInt(2)
                    val type = ReliableFrameTypeV1.entries.firstOrNull {
                        it.wireValue == typeValue
                    } ?: bluetoothTransportStoreFailure(
                        "CORRUPT_STORE",
                        "stored outbox message type is not assigned"
                    )
                    val payload = cursor.getBlob(4)
                    try {
                        val record = ReliableOutboxRecordV1(
                            cursor.getString(0),
                            cursor.getString(1),
                            type,
                            cursor.getInt(3),
                            payload,
                            cursor.getLong(5),
                            cursor.getLong(6)
                        )
                        BluetoothTransportStoreContractV1.validateOutboxRecord(record)
                        records += record
                    } finally {
                        payload.fill(0)
                    }
                }
            }
            records
        }
    }

    @Synchronized
    override fun hasInbox(
        peerTrustId: String,
        messageId: String,
        nowEpochMs: Long
    ): Boolean =
        transaction(
            "INBOX_READ_FAILED",
            "durable inbox dedup state could not be read"
        ) { db ->
            advanceClockLocked(db, nowEpochMs)
            DatabaseUtils.longForQuery(
                db,
                "SELECT COUNT(*) FROM bluetooth_inbox_dedup " +
                    "WHERE peer_trust_id=? AND message_id=? AND expires_at_ms>?",
                arrayOf(
                    BluetoothTransportStoreContractV1.validatePeerTrustId(peerTrustId),
                    BluetoothTransportStoreContractV1.validateMessageId(messageId),
                    nowEpochMs.toString()
                )
            ) == 1L
        }

    @Synchronized
    override fun rememberInbox(
        peerTrustId: String,
        messageId: String,
        expiresAtEpochMs: Long
    ) {
        val normalizedPeerTrustId =
            BluetoothTransportStoreContractV1.validatePeerTrustId(peerTrustId)
        val normalizedMessageId =
            BluetoothTransportStoreContractV1.validateMessageId(messageId)
        BluetoothTransportStoreContractV1.validateClock(
            expiresAtEpochMs,
            "expiresAtEpochMs"
        )
        if (expiresAtEpochMs == 0L) {
            bluetoothTransportStoreFailure(
                "INVALID_STORE_VALUE",
                "inbox expiry must be positive"
            )
        }
        transaction(
            "INBOX_COMMIT_FAILED",
            "durable inbox dedup state could not be committed"
        ) { db ->
            val existing = nullableLongForQuery(
                db,
                "SELECT expires_at_ms FROM bluetooth_inbox_dedup " +
                    "WHERE peer_trust_id=? AND message_id=?",
                arrayOf(normalizedPeerTrustId, normalizedMessageId)
            )
            if (existing == null) {
                enforceCapacity(
                    db,
                    "bluetooth_inbox_dedup",
                    BluetoothTransportStoreContractV1.MAX_INBOX_RECORDS
                )
                db.insertOrThrow(
                    "bluetooth_inbox_dedup",
                    null,
                    ContentValues().apply {
                        put("peer_trust_id", normalizedPeerTrustId)
                        put("message_id", normalizedMessageId)
                        put("expires_at_ms", expiresAtEpochMs)
                    }
                )
            } else if (expiresAtEpochMs > existing) {
                db.update(
                    "bluetooth_inbox_dedup",
                    ContentValues().apply { put("expires_at_ms", expiresAtEpochMs) },
                    "peer_trust_id=? AND message_id=?",
                    arrayOf(normalizedPeerTrustId, normalizedMessageId)
                )
            }
            Unit
        }
    }

    @Synchronized
    override fun forgetInbox(peerTrustId: String, messageId: String) {
        val normalizedPeerTrustId =
            BluetoothTransportStoreContractV1.validatePeerTrustId(peerTrustId)
        val normalizedMessageId =
            BluetoothTransportStoreContractV1.validateMessageId(messageId)
        transaction(
            "INBOX_COMMIT_FAILED",
            "durable inbox dedup rollback could not be committed"
        ) { db ->
            db.delete(
                "bluetooth_inbox_dedup",
                "peer_trust_id=? AND message_id=?",
                arrayOf(normalizedPeerTrustId, normalizedMessageId)
            )
        }
    }

    @Synchronized
    override fun prune(nowEpochMs: Long): ReliableStorePruneResultV1 =
        transaction(
            "STORE_PRUNE_FAILED",
            "expired Bluetooth transport records could not be pruned"
        ) { db ->
            advanceClockLocked(db, nowEpochMs)
            ReliableStorePruneResultV1(
                expiredOutbox = db.delete(
                    "bluetooth_outbox",
                    "expires_at_ms<=?",
                    arrayOf(nowEpochMs.toString())
                ),
                expiredInbox = db.delete(
                    "bluetooth_inbox_dedup",
                    "expires_at_ms<=?",
                    arrayOf(nowEpochMs.toString())
                )
            )
        }

    @Synchronized
    override fun snapshot(): ReliableStoreSnapshotV1 {
        val value = snapshotTransportStore()
        return ReliableStoreSnapshotV1(value.outboxDepth, value.inboxDedupDepth)
    }

    @Synchronized
    fun upsertKnownPeer(input: BluetoothKnownPeerInputV1) {
        BluetoothTransportStoreContractV1.validateKnownPeer(input)
        transaction(
            "PEER_COMMIT_FAILED",
            "known peer could not be committed"
        ) { db ->
            advanceClockLocked(db, input.lastSeenAtEpochMs)
            val existing = nullableLongForQuery(
                db,
                "SELECT last_seen_at_ms FROM known_peers WHERE node_id=?",
                arrayOf(input.nodeId)
            )
            if (existing != null && input.lastSeenAtEpochMs < existing) {
                bluetoothTransportStoreFailure(
                    "STORE_CLOCK_REGRESSION",
                    "known peer timestamp regressed"
                )
            }
            if (existing == null) {
                enforceCapacity(
                    db,
                    "known_peers",
                    BluetoothTransportStoreContractV1.MAX_KNOWN_PEERS
                )
                db.insertOrThrow(
                    "known_peers",
                    null,
                    ContentValues().apply {
                        put("node_id", input.nodeId)
                        put("capabilities", input.capabilities)
                        put("last_seen_at_ms", input.lastSeenAtEpochMs)
                        put("server_reachable", if (input.serverReachable) 1 else 0)
                    }
                )
            } else {
                db.update(
                    "known_peers",
                    ContentValues().apply {
                        put("capabilities", input.capabilities)
                        put("last_seen_at_ms", input.lastSeenAtEpochMs)
                        put("server_reachable", if (input.serverReachable) 1 else 0)
                    },
                    "node_id=?",
                    arrayOf(input.nodeId)
                )
            }
        }
    }

    @Synchronized
    fun openSession(input: BluetoothSessionOpenInputV1) {
        BluetoothTransportStoreContractV1.validateSessionOpen(input)
        transaction(
            "SESSION_COMMIT_FAILED",
            "session open could not be committed"
        ) { db ->
            advanceClockLocked(db, input.openedAtEpochMs)
            if (rowExists(db, "session_history", "session_id", input.sessionId)) {
                bluetoothTransportStoreFailure(
                    "SESSION_CONFLICT",
                    "session identifier already exists"
                )
            }
            enforceCapacity(
                db,
                "session_history",
                BluetoothTransportStoreContractV1.MAX_SESSION_HISTORY
            )
            db.insertOrThrow(
                "session_history",
                null,
                ContentValues().apply {
                    put("session_id", input.sessionId)
                    put("peer_id", input.peerId)
                    put("opened_at_ms", input.openedAtEpochMs)
                }
            )
        }
    }

    @Synchronized
    fun closeSession(input: BluetoothSessionCloseInputV1) {
        BluetoothTransportStoreContractV1.validateSessionClose(input)
        transaction(
            "SESSION_COMMIT_FAILED",
            "session close could not be committed"
        ) { db ->
            advanceClockLocked(db, input.closedAtEpochMs)
            val changed = db.update(
                "session_history",
                ContentValues().apply {
                    put("closed_at_ms", input.closedAtEpochMs)
                    put("close_reason", input.closeReason)
                },
                "session_id=? AND closed_at_ms IS NULL AND opened_at_ms<=?",
                arrayOf(input.sessionId, input.closedAtEpochMs.toString())
            )
            if (changed != 1) {
                bluetoothTransportStoreFailure(
                    "SESSION_CLOSE_CONFLICT",
                    "session is missing, closed or clock-invalid"
                )
            }
        }
    }

    @Synchronized
    fun storeLastServerAdvertisement(value: BluetoothStoredRouteAdvertisementV1) {
        BluetoothTransportStoreContractV1.validateAdvertisement(value)
        transaction(
            "ADVERTISEMENT_COMMIT_FAILED",
            "last server advertisement could not be committed"
        ) { db ->
            advanceClockLocked(db, value.observedAtEpochMs)
            val existing = nullableLongForQuery(
                db,
                "SELECT observed_at_ms FROM last_server_advertisement " +
                    "WHERE singleton_id=1"
            )
            val existingSequence = nullableLongForQuery(
                db,
                "SELECT sequence FROM last_server_advertisement WHERE singleton_id=1"
            )
            if (existing != null && value.observedAtEpochMs < existing) {
                bluetoothTransportStoreFailure(
                    "STORE_CLOCK_REGRESSION",
                    "server advertisement timestamp regressed"
                )
            }
            if (existingSequence != null && value.sequence <= existingSequence) {
                bluetoothTransportStoreFailure(
                    "ROUTE_SEQUENCE_REPLAY",
                    "server route sequence did not advance"
                )
            }
            val content = ContentValues().apply {
                put("singleton_id", 1)
                put("can_reach_server", if (value.canReachServer) 1 else 0)
                put("route_kind", value.routeKind.name)
                put("server_rtt_bucket", value.serverRttBucket)
                put("route_age_seconds", value.routeAgeSeconds)
                put("queue_depth_bucket", value.queueDepthBucket)
                put("battery_bucket", value.batteryBucket)
                put("sequence", value.sequence)
                put("observed_at_ms", value.observedAtEpochMs)
            }
            if (existing == null) {
                db.insertOrThrow("last_server_advertisement", null, content)
            } else {
                db.update(
                    "last_server_advertisement",
                    content,
                    "singleton_id=1",
                    null
                )
            }
        }
    }

    @Synchronized
    fun lastServerAdvertisement(): BluetoothStoredRouteAdvertisementV1? {
        assertOpen()
        return database.query(
            "last_server_advertisement",
            arrayOf(
                "can_reach_server",
                "route_kind",
                "server_rtt_bucket",
                "route_age_seconds",
                "queue_depth_bucket",
                "battery_bucket",
                "sequence",
                "observed_at_ms"
            ),
            "singleton_id=1",
            null,
            null,
            null,
            null,
            "1"
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            val value = BluetoothStoredRouteAdvertisementV1(
                canReachServer = cursor.getInt(0) == 1,
                routeKind = runCatching {
                    BluetoothRouteKindV1.valueOf(cursor.getString(1))
                }.getOrElse {
                    bluetoothTransportStoreFailure(
                        "CORRUPT_STORE",
                        "stored route kind is invalid"
                    )
                },
                serverRttBucket = cursor.getInt(2),
                routeAgeSeconds = cursor.getInt(3),
                queueDepthBucket = cursor.getInt(4),
                batteryBucket = cursor.getInt(5),
                sequence = cursor.getLong(6),
                observedAtEpochMs = cursor.getLong(7)
            )
            BluetoothTransportStoreContractV1.validateAdvertisement(value)
            value
        }
    }

    @Synchronized
    fun snapshotTransportStore(): BluetoothTransportStoreSnapshotV1 =
        transaction(
            "STORE_SNAPSHOT_FAILED",
            "Bluetooth transport store snapshot could not be read"
        ) { db -> snapshotLocked(db) }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        helper.close()
    }

    private fun <T> transaction(
        code: String,
        message: String,
        operation: (SQLiteDatabase) -> T
    ): T {
        assertOpen()
        try {
            database.beginTransaction()
        } catch (error: Throwable) {
            bluetoothTransportStoreFailure(code, message, error)
        }
        var primary: Throwable? = null
        try {
            val result = operation(database)
            database.setTransactionSuccessful()
            return result
        } catch (error: Throwable) {
            val mapped = if (error is BluetoothTransportStoreException) {
                error
            } else {
                BluetoothTransportStoreException(code, message, error)
            }
            primary = mapped
            throw mapped
        } finally {
            try {
                database.endTransaction()
            } catch (error: Throwable) {
                if (primary != null) {
                    primary.addSuppressed(error)
                } else {
                    bluetoothTransportStoreFailure(code, message, error)
                }
            }
        }
    }

    private fun assertOpen() {
        if (closed || !database.isOpen) {
            bluetoothTransportStoreFailure(
                "STORE_CLOSED",
                "Bluetooth transport store is closed"
            )
        }
    }

    private class StoreHelper(context: Context, name: String) :
        SQLiteOpenHelper(
            context,
            name,
            null,
            BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION
        ) {
        override fun onConfigure(db: SQLiteDatabase) {
            super.onConfigure(db)
            db.disableWriteAheadLogging()
            db.setForeignKeyConstraintsEnabled(true)
            db.execSQL("PRAGMA synchronous=FULL")
            db.execSQL("PRAGMA secure_delete=ON")
            db.execSQL("PRAGMA fullfsync=ON")
            db.execSQL("PRAGMA temp_store=MEMORY")
            db.rawQuery("PRAGMA journal_mode=DELETE", null).use { cursor ->
                if (!cursor.moveToFirst() || cursor.getString(0) != "delete") {
                    bluetoothTransportStoreFailure(
                        "STORE_DURABILITY_UNAVAILABLE",
                        "SQLite DELETE journal mode is unavailable"
                    )
                }
            }
        }

        override fun onCreate(db: SQLiteDatabase) {
            BluetoothTransportStoreContractV1.CREATE_STATEMENTS.forEach(db::execSQL)
            BluetoothTransportStoreContractV1.INDEX_STATEMENTS.forEach(db::execSQL)
            db.execSQL(
                "INSERT INTO bluetooth_transport_meta(key,value) VALUES(?,?)",
                arrayOf("schema_version", BLUETOOTH_TRANSPORT_STORE_SCHEMA_VERSION)
            )
            db.execSQL(
                "INSERT INTO bluetooth_transport_meta(key,value) VALUES(?,?)",
                arrayOf("outbound_sequence", 0L)
            )
            db.execSQL(
                "INSERT INTO bluetooth_transport_meta(key,value) VALUES(?,?)",
                arrayOf("last_clock_ms", 0L)
            )
            db.execSQL(
                "INSERT INTO bluetooth_transport_meta(key,value) VALUES(?,?)",
                arrayOf("route_outbound_sequence", 0L)
            )
        }

        override fun onUpgrade(
            db: SQLiteDatabase,
            oldVersion: Int,
            newVersion: Int
        ) {
            var migratedVersion = oldVersion
            if (migratedVersion == 1 && newVersion >= 2) {
                db.execSQL(
                    "ALTER TABLE last_server_advertisement ADD COLUMN " +
                        "sequence INTEGER NOT NULL DEFAULT 0 " +
                        "CHECK(sequence BETWEEN 0 AND 4294967295)"
                )
                db.execSQL(
                    "ALTER TABLE bluetooth_transport_meta " +
                        "RENAME TO bluetooth_transport_meta_v1"
                )
                db.execSQL(
                    """
                    CREATE TABLE bluetooth_transport_meta(
                        key TEXT PRIMARY KEY NOT NULL
                            CHECK(key IN (
                                'schema_version','outbound_sequence','last_clock_ms',
                                'route_outbound_sequence'
                            )),
                        value INTEGER NOT NULL CHECK(value >= 0)
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    "INSERT INTO bluetooth_transport_meta(key,value) " +
                        "SELECT key,value FROM bluetooth_transport_meta_v1"
                )
                db.execSQL(
                    "INSERT INTO bluetooth_transport_meta(key,value) VALUES(?,?)",
                    arrayOf("route_outbound_sequence", 0L)
                )
                db.execSQL("DROP TABLE bluetooth_transport_meta_v1")
                db.execSQL(
                    "UPDATE bluetooth_transport_meta SET value=? WHERE key=?",
                    arrayOf(2L, "schema_version")
                )
                migratedVersion = 2
            }
            if (migratedVersion == 2 && newVersion >= 3) {
                val outboxDepth = DatabaseUtils.longForQuery(
                    db,
                    "SELECT COUNT(*) FROM bluetooth_outbox",
                    null
                )
                val inboxDepth = DatabaseUtils.longForQuery(
                    db,
                    "SELECT COUNT(*) FROM bluetooth_inbox_dedup",
                    null
                )
                if (outboxDepth != 0L || inboxDepth != 0L) {
                    bluetoothTransportStoreFailure(
                        "UNBOUND_LEGACY_RECORDS",
                        "schema v2 reliable records cannot be assigned to a peer trust context"
                    )
                }
                db.execSQL("DROP INDEX IF EXISTS bluetooth_outbox_expiry_idx")
                db.execSQL("DROP INDEX IF EXISTS bluetooth_inbox_expiry_idx")
                db.execSQL("DROP TABLE bluetooth_outbox")
                db.execSQL("DROP TABLE bluetooth_inbox_dedup")
                db.execSQL(BluetoothTransportStoreContractV1.OUTBOX_CREATE_STATEMENT)
                db.execSQL(BluetoothTransportStoreContractV1.INBOX_CREATE_STATEMENT)
                db.execSQL(
                    "CREATE INDEX bluetooth_outbox_expiry_idx " +
                        "ON bluetooth_outbox(expires_at_ms)"
                )
                db.execSQL(
                    "CREATE INDEX bluetooth_inbox_expiry_idx " +
                        "ON bluetooth_inbox_dedup(expires_at_ms)"
                )
                db.execSQL(
                    "UPDATE bluetooth_transport_meta SET value=? WHERE key=?",
                    arrayOf(3L, "schema_version")
                )
                migratedVersion = 3
            }
            if (migratedVersion == newVersion) {
                return
            }
            bluetoothTransportStoreFailure(
                "UNSUPPORTED_SCHEMA",
                "Bluetooth transport store migration path is unsupported"
            )
        }

        override fun onDowngrade(
            db: SQLiteDatabase,
            oldVersion: Int,
            newVersion: Int
        ) {
            bluetoothTransportStoreFailure(
                "UNSUPPORTED_SCHEMA",
                "Bluetooth transport store downgrade is forbidden"
            )
        }
    }

    private fun validateRuntimeDatabase(db: SQLiteDatabase) {
        val quickCheck = db.rawQuery("PRAGMA quick_check(1)", null).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        if (quickCheck != "ok") {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "SQLite quick_check did not pass"
            )
        }
        if (
            pragmaLong(db, "foreign_keys") != 1L ||
            pragmaLong(db, "secure_delete") != 1L ||
            pragmaLong(db, "synchronous") < 2L
        ) {
            bluetoothTransportStoreFailure(
                "STORE_DURABILITY_UNAVAILABLE",
                "required SQLite durability pragmas are inactive"
            )
        }
        val journalMode = db.rawQuery("PRAGMA journal_mode", null).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        if (journalMode != "delete") {
            bluetoothTransportStoreFailure(
                "STORE_DURABILITY_UNAVAILABLE",
                "SQLite journal mode changed unexpectedly"
            )
        }
        val tableNames = sqliteObjectNames(db, "table")
        val requiredTables =
            BluetoothTransportStoreContractV1.DATA_TABLE_NAMES.toSet() +
                BluetoothTransportStoreContractV1.META_TABLE_NAME
        if (!tableNames.containsAll(requiredTables)) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "Bluetooth transport schema is incomplete"
            )
        }
        val indexNames = sqliteObjectNames(db, "index")
        if (!indexNames.containsAll(BluetoothTransportStoreContractV1.INDEX_NAMES)) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "Bluetooth transport indexes are incomplete"
            )
        }
        BluetoothTransportStoreContractV1.validateSchemaVersion(
            readMetaLong(db, "schema_version")
        )
        BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
            readMetaLong(db, "outbound_sequence")
        )
        BluetoothTransportStoreContractV1.validateSequenceHighWatermark(
            readMetaLong(db, "route_outbound_sequence")
        )
        BluetoothTransportStoreContractV1.validateClock(
            readMetaLong(db, "last_clock_ms"),
            "last_clock_ms"
        )
        val metaCount = scalar(db, "SELECT COUNT(*) FROM bluetooth_transport_meta")
        if (metaCount != 4L) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "Bluetooth transport metadata inventory is invalid"
            )
        }
        snapshotLocked(db)
        validateStoredIdentifiers(db)
    }

    private fun validateStoredIdentifiers(db: SQLiteDatabase) {
        val validators: List<Triple<String, String, (String) -> String>> = listOf(
            Triple(
                "bluetooth_outbox",
                "peer_trust_id",
                BluetoothTransportStoreContractV1::validatePeerTrustId
            ),
            Triple(
                "bluetooth_outbox",
                "message_id",
                BluetoothTransportStoreContractV1::validateMessageId
            ),
            Triple(
                "bluetooth_inbox_dedup",
                "peer_trust_id",
                BluetoothTransportStoreContractV1::validatePeerTrustId
            ),
            Triple(
                "bluetooth_inbox_dedup",
                "message_id",
                BluetoothTransportStoreContractV1::validateMessageId
            ),
            Triple(
                "known_peers",
                "node_id",
                { value: String ->
                BluetoothTransportStoreContractV1.validateIdentifier(value, "nodeId")
                }
            ),
            Triple(
                "session_history",
                "session_id",
                BluetoothTransportStoreContractV1::validateSessionId
            ),
            Triple(
                "session_history",
                "peer_id",
                { value: String ->
                BluetoothTransportStoreContractV1.validateIdentifier(value, "peerId")
                }
            )
        )
        for ((table, field, validator) in validators) {
            db.query(table, arrayOf(field), null, null, null, null, null).use { cursor ->
                while (cursor.moveToNext()) validator(cursor.getString(0))
            }
        }
    }

    private fun snapshotLocked(db: SQLiteDatabase): BluetoothTransportStoreSnapshotV1 =
        BluetoothTransportStoreSnapshotV1(
            outboxDepth = scalar(db, "SELECT COUNT(*) FROM bluetooth_outbox").toInt(),
            inboxDedupDepth =
                scalar(db, "SELECT COUNT(*) FROM bluetooth_inbox_dedup").toInt(),
            knownPeerCount = scalar(db, "SELECT COUNT(*) FROM known_peers").toInt(),
            sessionHistoryCount =
                scalar(db, "SELECT COUNT(*) FROM session_history").toInt(),
            openSessionCount = scalar(
                db,
                "SELECT COUNT(*) FROM session_history WHERE closed_at_ms IS NULL"
            ).toInt(),
            hasServerAdvertisement =
                scalar(db, "SELECT COUNT(*) FROM last_server_advertisement") == 1L
        )

    private fun advanceClockLocked(db: SQLiteDatabase, candidate: Long) {
        val last = readMetaLong(db, "last_clock_ms")
        val next = BluetoothTransportStoreContractV1.advanceClock(last, candidate)
        if (next == last) return
        val changed = db.update(
            BluetoothTransportStoreContractV1.META_TABLE_NAME,
            ContentValues().apply { put("value", next) },
            "key=? AND value=?",
            arrayOf("last_clock_ms", last.toString())
        )
        if (changed != 1) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "persisted clock high-watermark changed unexpectedly"
            )
        }
    }

    private fun enforceCapacity(db: SQLiteDatabase, table: String, maximum: Int) {
        if (scalar(db, "SELECT COUNT(*) FROM $table") >= maximum.toLong()) {
            bluetoothTransportStoreFailure(
                "STORE_LIMIT_EXCEEDED",
                "Bluetooth transport store table reached its fixed limit"
            )
        }
    }

    private fun rowExists(
        db: SQLiteDatabase,
        table: String,
        field: String,
        value: String
    ): Boolean = DatabaseUtils.longForQuery(
        db,
        "SELECT COUNT(*) FROM $table WHERE $field=?",
        arrayOf(value)
    ) == 1L

    private fun readMetaLong(db: SQLiteDatabase, key: String): Long =
        nullableLongForQuery(
            db,
            "SELECT value FROM bluetooth_transport_meta WHERE key=?",
            arrayOf(key)
        ) ?: bluetoothTransportStoreFailure(
            "CORRUPT_STORE",
            "required Bluetooth transport metadata is missing"
        )

    private fun nullableLongForQuery(
        db: SQLiteDatabase,
        sql: String,
        arguments: Array<String> = emptyArray()
    ): Long? = db.rawQuery(sql, arguments).use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        if (cursor.isNull(0)) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "stored integer is unexpectedly null"
            )
        }
        val value = cursor.getLong(0)
        if (cursor.moveToNext()) {
            bluetoothTransportStoreFailure(
                "CORRUPT_STORE",
                "stored scalar is not unique"
            )
        }
        value
    }

    private fun scalar(db: SQLiteDatabase, sql: String): Long =
        DatabaseUtils.longForQuery(db, sql, null)

    private fun pragmaLong(db: SQLiteDatabase, name: String): Long =
        db.rawQuery("PRAGMA $name", null).use { cursor ->
            if (!cursor.moveToFirst()) {
                bluetoothTransportStoreFailure(
                    "STORE_DURABILITY_UNAVAILABLE",
                    "required SQLite pragma is unavailable"
                )
            }
            cursor.getLong(0)
        }

    private fun sqliteObjectNames(db: SQLiteDatabase, type: String): Set<String> =
        db.rawQuery(
            "SELECT name FROM sqlite_master WHERE type=?",
            arrayOf(type)
        ).use { cursor ->
            buildSet {
                while (cursor.moveToNext()) add(cursor.getString(0))
            }
        }

    private fun hardenAndValidateDatabaseFile(file: File) {
        val dataRoot = appContext.dataDir.canonicalFile
        val canonical = file.canonicalFile
        if (
            canonical != file.absoluteFile ||
            !canonical.path.startsWith(dataRoot.path + File.separator)
        ) {
            bluetoothTransportStoreFailure(
                "UNSAFE_STORE_FILE",
                "Bluetooth transport database escaped app-private storage"
            )
        }
        if (
            !file.setReadable(false, false) ||
            !file.setWritable(false, false) ||
            !file.setExecutable(false, false) ||
            !file.setReadable(true, true) ||
            !file.setWritable(true, true)
        ) {
            bluetoothTransportStoreFailure(
                "UNSAFE_STORE_MODE",
                "Bluetooth transport database permissions could not be hardened"
            )
        }
        val status = try {
            Os.lstat(file.absolutePath)
        } catch (error: Throwable) {
            bluetoothTransportStoreFailure(
                "UNSAFE_STORE_FILE",
                "Bluetooth transport database could not be inspected",
                error
            )
        }
        if (
            !OsConstants.S_ISREG(status.st_mode) ||
            status.st_nlink != 1L ||
            status.st_uid != Process.myUid() ||
            status.st_mode and 0x3f != 0
        ) {
            bluetoothTransportStoreFailure(
                "UNSAFE_STORE_FILE",
                "Bluetooth transport database is linked, shared or not app-owned"
            )
        }
    }
}
