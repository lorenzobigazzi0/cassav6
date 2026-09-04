package com.sentrapa.cassav6.webkiosk.notifications

import android.content.Context
import android.webkit.JavascriptInterface
import com.sentrapa.cassav6.webkiosk.AlwaysOnService
import com.sentrapa.cassav6.webkiosk.NativeNotificationEvent
import com.sentrapa.cassav6.webkiosk.NativeSessionContextStore
import com.sentrapa.cassav6.webkiosk.NotificationTone
import com.sentrapa.cassav6.webkiosk.KioskPreferences
import com.sentrapa.cassav6.webkiosk.shouldAcceptNativeNotificationIngress
import org.json.JSONObject

class NativeNotificationBridge(context: Context) {
    private val appContext = context.applicationContext

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun updateSessionContext(payloadJson: String): Boolean =
        NativeSessionContextStore.updateFromJson(appContext, payloadJson)

    @JavascriptInterface
    fun clearSession(): Boolean = NativeSessionContextStore.clear(appContext)

    @JavascriptInterface
    fun showNotification(payloadJson: String): Boolean {
        val payload = runCatching { JSONObject(payloadJson) }.getOrNull() ?: return false
        val meta = payload.optJSONObject("meta")
        val type = firstString(payload, "type", "notificationType", "notification_type")
            ?: firstString(meta, "type")
        val eventType = firstString(payload, "eventType", "event_type")
            ?: firstString(meta, "eventType")
        val tone = NotificationTone.fromPayload(type, eventType)
        val title = firstString(payload, "title") ?: defaultTitleFor(tone)
        val text = firstString(payload, "text", "description", "body", "message") ?: return false
        val createdAt = firstLong(payload, "createdAt", "created_at", "timestamp", "ts")
            ?: return false
        val context = KioskPreferences.getNotificationClientContext(appContext)
        val targetDeviceUuid = firstString(
            payload,
            "targetDeviceUuid",
            "target_device_uuid",
            "deviceUuid",
            "device_uuid"
        ) ?: firstString(meta, "targetDeviceUuid")
        val targetUserId = firstString(payload, "targetUserId", "target_user_id", "userId", "user_id")
            ?: firstString(meta, "targetUserId")
        val targetUsername = firstString(payload, "targetUsername", "target_username", "username")
            ?: firstString(meta, "targetUsername")
        val targetSessionStartedAt = firstLong(
            payload,
            "targetSessionStartedAt",
            "target_session_started_at",
            "sessionStartedAt",
            "session_started_at"
        ) ?: firstLong(meta, "targetSessionStartedAt", "sessionStartedAt")
        if (
            !shouldAcceptNativeNotificationIngress(
                context = context,
                createdAt = createdAt,
                targetDeviceUuid = targetDeviceUuid,
                targetSessionStartedAt = targetSessionStartedAt,
                targetUserId = targetUserId,
                targetUsername = targetUsername
            )
        ) return false
        val id = firstString(payload, "id", "notificationId", "notification_id")
            ?: "web:${listOf(tone.name, title, text, createdAt).joinToString("|").hashCode()}"

        return AlwaysOnService.enqueueNotification(
            appContext,
            NativeNotificationEvent(
                id = id,
                tone = tone,
                title = title,
                text = text,
                createdAt = createdAt,
                sessionBindingKey = context.sessionBindingKey
            )
        )
    }

    private fun firstString(source: JSONObject?, vararg keys: String): String? {
        if (source == null) return null
        return keys.firstNotNullOfOrNull { key ->
            source.optString(key).trim().takeIf { it.isNotEmpty() }
        }
    }

    private fun firstLong(source: JSONObject?, vararg keys: String): Long? {
        if (source == null) return null
        return keys.firstNotNullOfOrNull { key ->
            when (val value = source.opt(key)) {
                is Number -> value.toLong().takeIf { it > 0L }
                is String -> value.trim().toLongOrNull()?.takeIf { it > 0L }
                else -> null
            }
        }
    }

    private fun defaultTitleFor(tone: NotificationTone): String = when (tone) {
        NotificationTone.WAITER -> "Chiamata cameriere"
        NotificationTone.BELL -> "Comanda pronta"
        NotificationTone.HANDHELD_RING -> "Squillo palmare"
        NotificationTone.GENERAL -> "Notifica"
    }
}
