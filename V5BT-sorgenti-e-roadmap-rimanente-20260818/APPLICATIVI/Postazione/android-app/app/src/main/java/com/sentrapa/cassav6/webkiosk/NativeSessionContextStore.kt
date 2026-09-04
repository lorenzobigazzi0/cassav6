package com.sentrapa.cassav6.webkiosk

import android.content.Context
import org.json.JSONObject

internal class NativeSessionEpoch {
    private var value = 0L

    @Synchronized
    fun capture(): Long = value

    @Synchronized
    fun isCurrent(captured: Long): Boolean = captured == value

    @Synchronized
    fun advance(): Long {
        value = if (value == Long.MAX_VALUE) 0L else value + 1L
        return value
    }
}

internal object NativeSessionContextStore {
    private val sessionEpoch = NativeSessionEpoch()

    @Synchronized
    fun updateFromJson(context: Context, payloadJson: String): Boolean {
        return updateFromJsonLocked(context, payloadJson)
    }

    @Synchronized
    fun captureUpdateEpoch(): Long = sessionEpoch.capture()

    @Synchronized
    fun updateFromJsonIfCurrent(
        context: Context,
        payloadJson: String,
        capturedEpoch: Long
    ): Boolean {
        if (!sessionEpoch.isCurrent(capturedEpoch)) return false
        return updateFromJsonLocked(context, payloadJson)
    }

    private fun updateFromJsonLocked(context: Context, payloadJson: String): Boolean {
        val sessionContext = parse(payloadJson)
        if (sessionContext?.hasAuthenticatedSession != true) {
            clearLocked(context)
            return false
        }

        val previousContext = KioskPreferences.getNotificationClientContext(context)
        if (
            previousContext.hasAuthenticatedSession &&
            previousContext.identityKey != sessionContext.identityKey
        ) {
            AlwaysOnService.sessionCleared(context)
        }
        val persisted = KioskPreferences.saveNotificationClientContext(
            context,
            sessionContext
        )
        if (!persisted) {
            clearLocked(context)
            return false
        }
        sessionEpoch.advance()
        AlwaysOnService.refreshSession(context)
        return true
    }

    @Synchronized
    fun clear(context: Context): Boolean {
        return clearLocked(context)
    }

    private fun clearLocked(context: Context): Boolean {
        sessionEpoch.advance()
        val cleared = KioskPreferences.clearNotificationClientContext(context)
        AlwaysOnService.sessionCleared(context)
        return cleared
    }

    internal fun parse(payloadJson: String): NotificationClientContext? {
        val payload = payloadJson.trim().takeIf { it.isNotEmpty() } ?: return null
        val root = runCatching { JSONObject(payload) }.getOrNull() ?: return null
        val source = root.optJSONObject("session") ?: root
        val keys = listOf(
            "token", "pos_token",
            "userId", "user_id", "pos_user_id",
            "username", "user", "pos_user",
            "fullName", "full_name", "pos_full_name",
            "deviceUuid", "device_uuid", "pos_device_uuid",
            "roomId", "room_id", "pos_room_id",
            "roomName", "room_name", "pos_room_name"
        )
        val values = keys.associateWith { key ->
            (source.opt(key) as? String)?.trim().orEmpty()
        }
        return notificationClientContextFromValues(values)
    }
}

internal fun notificationClientContextFromValues(
    values: Map<String, String>
): NotificationClientContext {
    fun first(vararg keys: String): String =
        keys.firstNotNullOfOrNull { key ->
            values[key]?.trim()?.takeIf { it.isNotEmpty() }
        }.orEmpty()

    return NotificationClientContext(
        token = first("token", "pos_token"),
        userId = first("userId", "user_id", "pos_user_id"),
        username = first("username", "user", "pos_user"),
        fullName = first("fullName", "full_name", "pos_full_name"),
        deviceUuid = first("deviceUuid", "device_uuid", "pos_device_uuid"),
        roomId = first("roomId", "room_id", "pos_room_id"),
        roomName = first("roomName", "room_name", "pos_room_name")
    )
}
