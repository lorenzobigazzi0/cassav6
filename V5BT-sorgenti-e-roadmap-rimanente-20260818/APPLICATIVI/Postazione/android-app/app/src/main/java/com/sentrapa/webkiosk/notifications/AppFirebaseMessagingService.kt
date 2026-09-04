package com.sentrapa.webkiosk.notifications

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sentrapa.webkiosk.AlwaysOnService
import com.sentrapa.webkiosk.NativeNotificationEvent
import com.sentrapa.webkiosk.NotificationTone
import org.json.JSONObject

class AppFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val text = firstDataValue(data, "text", "description", "body", "message")
            ?: message.notification?.body
            ?: return
        val title = firstDataValue(data, "title")
            ?: message.notification?.title
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
            ?: System.currentTimeMillis()
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
                createdAt = createdAt
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

    private companion object {
        const val TAG = "AppFirebaseMessaging"
    }
}
