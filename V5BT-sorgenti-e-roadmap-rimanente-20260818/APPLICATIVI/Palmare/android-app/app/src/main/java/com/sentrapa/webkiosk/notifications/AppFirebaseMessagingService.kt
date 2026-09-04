package com.sentrapa.webkiosk.notifications

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sentrapa.webkiosk.AlwaysOnService
import com.sentrapa.webkiosk.KioskPreferences
import com.sentrapa.webkiosk.NativeNotificationEvent
import com.sentrapa.webkiosk.NotificationTone
import com.sentrapa.webkiosk.shouldAcceptNativeNotificationIngress
import org.json.JSONObject

class AppFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // Notification payloads can be rendered by Android before application policy runs.
        if (message.notification != null) return
        val data = message.data
        val text = firstDataValue(data, "text", "description", "body", "message")
            ?: return
        val title = firstDataValue(data, "title")
            ?: "Notifica"
        val tone = NotificationTone.fromPayload(
            type = firstDataValue(data, "type", "notificationType", "notification_type")
                ?: metaDataValue(data, "type"),
            eventType = firstDataValue(data, "eventType", "event_type", "meta.eventType")
                ?: metaDataValue(data, "eventType")
        )
        val createdAt = firstDataValue(data, "createdAt", "created_at", "timestamp", "ts")
            ?.toLongOrNull()
            ?.takeIf { it > 0L }
            ?: message.sentTime.takeIf { it > 0L }
            ?: return
        val context = KioskPreferences.getNotificationClientContext(this)
        val targetDeviceUuid = firstDataValue(
            data,
            "targetDeviceUuid",
            "target_device_uuid",
            "deviceUuid",
            "device_uuid"
        ) ?: metaDataValue(data, "targetDeviceUuid")
        val targetUserId = firstDataValue(data, "targetUserId", "target_user_id", "userId", "user_id")
            ?: metaDataValue(data, "targetUserId")
        val targetUsername = firstDataValue(data, "targetUsername", "target_username", "username")
            ?: metaDataValue(data, "targetUsername")
        val targetSessionStartedAt = firstDataValue(
            data,
            "targetSessionStartedAt",
            "target_session_started_at",
            "sessionStartedAt",
            "session_started_at"
        )?.toLongOrNull()?.takeIf { it > 0L }
            ?: metaLongValue(data, "targetSessionStartedAt", "sessionStartedAt")
        if (
            !shouldAcceptNativeNotificationIngress(
                context = context,
                createdAt = createdAt,
                targetDeviceUuid = targetDeviceUuid,
                targetSessionStartedAt = targetSessionStartedAt,
                targetUserId = targetUserId,
                targetUsername = targetUsername
            )
        ) return
        val id = firstDataValue(data, "id", "notificationId", "notification_id")
            ?: message.messageId
            ?: "fcm:${listOf(tone.name, title, text, createdAt).joinToString("|").hashCode()}"

        AlwaysOnService.enqueueNotification(
            this,
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

    override fun onNewToken(token: String) {
        Log.i(TAG, "FCM token refreshed (${token.length} chars)")
    }

    private fun firstDataValue(data: Map<String, String>, vararg keys: String): String? =
        keys.firstNotNullOfOrNull { key ->
            data[key]?.trim()?.takeIf { it.isNotEmpty() }
        }

    private fun metaDataValue(data: Map<String, String>, key: String): String? {
        val meta = firstDataValue(data, "meta", "metadata") ?: return null
        return runCatching {
            JSONObject(meta).optString(key).trim().takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    private fun metaLongValue(data: Map<String, String>, vararg keys: String): Long? {
        val meta = firstDataValue(data, "meta", "metadata") ?: return null
        val json = runCatching { JSONObject(meta) }.getOrNull() ?: return null
        return keys.firstNotNullOfOrNull { key ->
            when (val value = json.opt(key)) {
                is Number -> value.toLong().takeIf { it > 0L }
                is String -> value.trim().toLongOrNull()?.takeIf { it > 0L }
                else -> null
            }
        }
    }

    private companion object {
        const val TAG = "AppFirebaseMessaging"
    }
}
