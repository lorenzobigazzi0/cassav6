package com.sentrapa.cassav6.webkiosk

import android.content.Context

object KioskPreferences {
    private const val PREFS = "cassav6_webkiosk_prefs"
    private const val KEY_URL = "saved_url"
    private const val KEY_BATTERY_DEVICE_IDENTIFIER = "battery_device_identifier"
    private const val KEY_BATTERY_OPTIMIZATION_PROMPTED = "battery_optimization_prompted"
    private const val KEY_NOTIFICATION_TOKEN = "notification_token"
    private const val KEY_NOTIFICATION_USER_ID = "notification_user_id"
    private const val KEY_NOTIFICATION_USERNAME = "notification_username"
    private const val KEY_NOTIFICATION_FULL_NAME = "notification_full_name"
    private const val KEY_NOTIFICATION_DEVICE_UUID = "notification_device_uuid"
    private const val KEY_NOTIFICATION_ROOM_ID = "notification_room_id"
    private const val KEY_NOTIFICATION_ROOM_NAME = "notification_room_name"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun getSavedUrl(context: Context): String? =
        prefs(context).getString(KEY_URL, null)?.trim()?.takeIf { it.isNotEmpty() }

    fun saveSavedUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_URL, url.trim()).apply()
    }

    fun getBatteryDeviceIdentifier(context: Context): String? =
        prefs(context).getString(KEY_BATTERY_DEVICE_IDENTIFIER, null)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

    fun saveBatteryDeviceIdentifier(context: Context, identifier: String?) {
        val normalized = identifier?.trim()?.takeIf { it.isNotEmpty() }
        prefs(context).edit().apply {
            if (normalized == null) remove(KEY_BATTERY_DEVICE_IDENTIFIER)
            else putString(KEY_BATTERY_DEVICE_IDENTIFIER, normalized)
        }.apply()
    }

    fun wasBatteryOptimizationPrompted(context: Context): Boolean =
        prefs(context).getBoolean(KEY_BATTERY_OPTIMIZATION_PROMPTED, false)

    fun markBatteryOptimizationPrompted(context: Context) {
        prefs(context).edit().putBoolean(KEY_BATTERY_OPTIMIZATION_PROMPTED, true).apply()
    }

    fun getNotificationClientContext(context: Context): NotificationClientContext {
        val prefs = prefs(context)
        return NotificationClientContext(
            token = prefs.getString(KEY_NOTIFICATION_TOKEN, null).orEmpty(),
            userId = prefs.getString(KEY_NOTIFICATION_USER_ID, null).orEmpty(),
            username = prefs.getString(KEY_NOTIFICATION_USERNAME, null).orEmpty(),
            fullName = prefs.getString(KEY_NOTIFICATION_FULL_NAME, null).orEmpty(),
            deviceUuid = prefs.getString(KEY_NOTIFICATION_DEVICE_UUID, null).orEmpty(),
            roomId = prefs.getString(KEY_NOTIFICATION_ROOM_ID, null).orEmpty(),
            roomName = prefs.getString(KEY_NOTIFICATION_ROOM_NAME, null).orEmpty()
        )
    }

    fun saveNotificationClientContext(
        context: Context,
        notificationContext: NotificationClientContext
    ): Boolean =
        prefs(context).edit()
            .putString(KEY_NOTIFICATION_TOKEN, notificationContext.token.trim())
            .putString(KEY_NOTIFICATION_USER_ID, notificationContext.userId.trim())
            .putString(KEY_NOTIFICATION_USERNAME, notificationContext.username.trim())
            .putString(KEY_NOTIFICATION_FULL_NAME, notificationContext.fullName.trim())
            .putString(KEY_NOTIFICATION_DEVICE_UUID, notificationContext.deviceUuid.trim())
            .putString(KEY_NOTIFICATION_ROOM_ID, notificationContext.roomId.trim())
            .putString(KEY_NOTIFICATION_ROOM_NAME, notificationContext.roomName.trim())
            .commit()

    fun clearNotificationClientContext(context: Context): Boolean =
        prefs(context).edit()
            .remove(KEY_NOTIFICATION_TOKEN)
            .remove(KEY_NOTIFICATION_USER_ID)
            .remove(KEY_NOTIFICATION_USERNAME)
            .remove(KEY_NOTIFICATION_FULL_NAME)
            .remove(KEY_NOTIFICATION_DEVICE_UUID)
            .remove(KEY_NOTIFICATION_ROOM_ID)
            .remove(KEY_NOTIFICATION_ROOM_NAME)
            .commit()

    fun hasAuthenticatedNotificationSession(context: Context): Boolean =
        getNotificationClientContext(context).hasAuthenticatedSession
}

internal fun resolveConfiguredKioskUrl(savedUrl: String?, defaultUrl: String): String {
    val normalized = savedUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return defaultUrl
    val legacyUrls = setOf(
        "https://192.168.1.79:5280/postazione",
        "https://192.168.1.79:5480/postazione",
        "https://192.168.1.182:5280/postazione",
        "https://192.168.1.182:5480/postazione"
    )
    return if (legacyUrls.any { normalized.trimEnd('/').equals(it, ignoreCase = true) }) {
        defaultUrl
    } else {
        normalized
    }
}
