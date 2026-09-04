package com.sentrapa.cassav6.webkiosk.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.CombinedVibration
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.sentrapa.cassav6.webkiosk.AppForegroundState
import com.sentrapa.cassav6.webkiosk.KioskPreferences
import com.sentrapa.cassav6.webkiosk.MainActivity
import com.sentrapa.cassav6.webkiosk.NativeNotificationGroup
import com.sentrapa.cassav6.webkiosk.NativeNotificationSnapshot
import com.sentrapa.cassav6.webkiosk.NotificationTone
import com.sentrapa.cassav6.webkiosk.R
import java.util.concurrent.atomic.AtomicLong

object NotificationHelper {
    private const val CHANNEL_ALERT = "notification_alert_silent_v6"
    private const val PREFS = "webkiosk_notification_prefs"
    private const val KEY_DELIVERED_NOTIFICATION_IDS = "delivered_notification_ids"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        LEGACY_CHANNEL_IDS.forEach { channelId ->
            if (manager.getNotificationChannel(channelId) != null) {
                manager.deleteNotificationChannel(channelId)
            }
        }
        if (manager.getNotificationChannel(CHANNEL_ALERT) != null) return

        val channel = NotificationChannel(
            CHANNEL_ALERT,
            "Notifiche Amalia",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Avvisi Amalia; audio e vibrazione sono coordinati dall'app."
            setSound(null, null)
            enableVibration(false)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    @Synchronized
    fun renderBackgroundSnapshot(
        context: Context,
        snapshot: NativeNotificationSnapshot
    ) {
        val appContext = context.applicationContext
        if (
            AppForegroundState.isForeground ||
            !hasAuthenticatedSession(appContext)
        ) {
            clearDeliveredNotifications(appContext, force = true)
            return
        }

        ensureChannels(appContext)
        val desiredIds = LinkedHashSet<Int>()
        val previouslyDeliveredIds = deliveredNotificationIds(appContext)

        snapshot.callGroups.forEach { group ->
            val notificationId = callNotificationId(group.tone)
            desiredIds.add(notificationId)
            showCallGroup(appContext, notificationId, group)
        }
        snapshot.latestGeneral.forEachIndexed { index, event ->
            val notificationId = GENERAL_NOTIFICATION_IDS[index]
            desiredIds.add(notificationId)
            showGeneral(appContext, notificationId, event.title, event.text, event.createdAt)
        }

        if (!hasAuthenticatedSession(appContext)) {
            clearDeliveredNotifications(appContext, force = true)
            return
        }

        val manager = NotificationManagerCompat.from(appContext)
        previouslyDeliveredIds
            .filterNot(desiredIds::contains)
            .forEach(manager::cancel)
        saveDeliveredNotificationIds(appContext, desiredIds)
        clearAutoGroupSummaries(appContext)
    }

    @Synchronized
    fun vibrateForTone(context: Context, tone: NotificationTone) {
        if (!hasAuthenticatedSession(context)) {
            cancelActiveVibration(context)
            return
        }
        val pattern = when (tone) {
            NotificationTone.WAITER -> longArrayOf(0, 180, 100, 220)
            NotificationTone.BELL -> longArrayOf(0, 120, 80, 120, 80, 180)
            NotificationTone.GENERAL -> longArrayOf(0, 160)
            NotificationTone.HANDHELD_RING -> longArrayOf(0, 220, 120, 220, 120, 360)
        }
        vibrate(context.applicationContext, pattern)
    }

    @Synchronized
    fun cancelActiveVibration(context: Context) {
        val appContext = context.applicationContext
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager =
                    appContext.getSystemService(
                        Context.VIBRATOR_MANAGER_SERVICE
                    ) as VibratorManager
                manager.cancel()
            } else {
                @Suppress("DEPRECATION")
                val vibrator =
                    appContext.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                vibrator.cancel()
            }
        }.onFailure { error ->
            Log.w(
                TAG,
                "Unable to cancel native notification vibration: ${error.message}"
            )
        }
    }

    @Synchronized
    fun clearDeliveredNotifications(context: Context, force: Boolean = false) {
        val appContext = context.applicationContext
        val now = SystemClock.elapsedRealtime()
        val previousClearAt = lastClearAt.getAndSet(now)
        if (
            !force &&
            hasAuthenticatedSession(appContext) &&
            previousClearAt > 0L &&
            now - previousClearAt < CLEAR_DEDUP_WINDOW_MS
        ) return

        val storedIds = deliveredNotificationIds(appContext)
        val ids = (storedIds + ALL_POLICY_NOTIFICATION_IDS).distinct()
        val manager = NotificationManagerCompat.from(appContext)
        ids.forEach { id ->
            runCatching { manager.cancel(id) }
                .onFailure { error ->
                    Log.w(TAG, "Unable to clear notification $id: ${error.message}")
                }
        }
        notificationPrefs(appContext)
            .edit()
            .remove(KEY_DELIVERED_NOTIFICATION_IDS)
            .apply()
        clearAutoGroupSummaries(appContext)
        Handler(Looper.getMainLooper()).postDelayed(
            { clearAutoGroupSummaries(appContext) },
            AUTO_GROUP_CLEAR_DELAY_MS
        )
    }

    private fun deliveredNotificationIds(context: Context): Set<Int> =
        notificationPrefs(context)
            .getStringSet(KEY_DELIVERED_NOTIFICATION_IDS, emptySet())
            .orEmpty()
            .mapNotNullTo(linkedSetOf()) { it.toIntOrNull() }

    private fun showCallGroup(
        context: Context,
        notificationId: Int,
        group: NativeNotificationGroup
    ) {
        val latest = group.latest
        val count = group.events.size
        val title = if (count == 1) latest.title else "${defaultTitle(group.tone)} ($count)"
        val style = NotificationCompat.InboxStyle()
        group.events
            .sortedByDescending { it.createdAt }
            .take(MAX_CALL_LINES)
            .forEach { event -> style.addLine(event.text) }
        if (count > MAX_CALL_LINES) {
            style.setSummaryText("+${count - MAX_CALL_LINES} altre")
        }

        val builder = baseBuilder(context, title, latest.text, latest.createdAt)
            .setStyle(style)
            .setNumber(count)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        notifySafely(context, notificationId, builder)
    }

    private fun showGeneral(
        context: Context,
        notificationId: Int,
        title: String,
        text: String,
        createdAt: Long
    ) {
        val builder = baseBuilder(context, title, text, createdAt)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
        notifySafely(context, notificationId, builder)
    }

    private fun baseBuilder(
        context: Context,
        title: String,
        text: String,
        createdAt: Long
    ): NotificationCompat.Builder {
        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(context, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(createdAt.coerceAtLeast(0L))
            .setShowWhen(createdAt > 0L)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
    }

    private fun notifySafely(
        context: Context,
        notificationId: Int,
        builder: NotificationCompat.Builder
    ) {
        if (!hasAuthenticatedSession(context)) return
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        runCatching {
            if (!hasAuthenticatedSession(context)) return
            NotificationManagerCompat.from(context).notify(notificationId, builder.build())
        }.onFailure { error ->
            Log.e(TAG, "Unable to show native notification: ${error.message}")
        }
    }

    private fun saveDeliveredNotificationIds(context: Context, ids: Set<Int>) {
        notificationPrefs(context)
            .edit()
            .putStringSet(KEY_DELIVERED_NOTIFICATION_IDS, ids.mapTo(linkedSetOf()) { it.toString() })
            .apply()
    }

    private fun notificationPrefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun vibrate(context: Context, pattern: LongArray) {
        if (!hasAuthenticatedSession(context)) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                val vibrator = manager.defaultVibrator
                if (!vibrator.hasVibrator()) return
                val effect = VibrationEffect.createWaveform(pattern, -1)
                if (!hasAuthenticatedSession(context)) return
                manager.vibrate(CombinedVibration.createParallel(effect))
            } else {
                @Suppress("DEPRECATION")
                val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                if (!vibrator.hasVibrator()) return
                if (!hasAuthenticatedSession(context)) return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(pattern, -1)
                }
            }
        }.onFailure { error ->
            Log.w(TAG, "Unable to vibrate for native notification: ${error.message}")
        }
    }

    private fun hasAuthenticatedSession(context: Context): Boolean =
        KioskPreferences.hasAuthenticatedNotificationSession(context)

    private fun callNotificationId(tone: NotificationTone): Int = when (tone) {
        NotificationTone.WAITER -> WAITER_NOTIFICATION_ID
        NotificationTone.BELL -> BELL_NOTIFICATION_ID
        NotificationTone.HANDHELD_RING -> HANDHELD_NOTIFICATION_ID
        NotificationTone.GENERAL -> error("General notifications use rotating slots")
    }

    private fun defaultTitle(tone: NotificationTone): String = when (tone) {
        NotificationTone.WAITER -> "Chiamate cameriere"
        NotificationTone.BELL -> "Comande pronte"
        NotificationTone.HANDHELD_RING -> "Chiamate postazione"
        NotificationTone.GENERAL -> "Notifiche"
    }

    private fun clearAutoGroupSummaries(context: Context) {
        val notificationManager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        automaticGroupSummaryTags(context.packageName).forEach { tag ->
            runCatching { notificationManager.cancel(tag, AUTO_GROUP_SUMMARY_ID) }
        }
    }

    private fun automaticGroupSummaryTags(packageName: String): List<String> =
        listOf(
            "0|$packageName|g:Aggregate_NormalNotificationSection",
            "0|$packageName|g:Aggregate_AlertingNotificationSection",
            "0|$packageName|g:Aggregate_SilentNotificationSection"
        )

    private const val TAG = "NotificationHelper"
    private const val WAITER_NOTIFICATION_ID = 3_101
    private const val BELL_NOTIFICATION_ID = 3_102
    private const val HANDHELD_NOTIFICATION_ID = 3_103
    private val GENERAL_NOTIFICATION_IDS = listOf(3_201, 3_202, 3_203)
    private val ALL_POLICY_NOTIFICATION_IDS =
        listOf(WAITER_NOTIFICATION_ID, BELL_NOTIFICATION_ID, HANDHELD_NOTIFICATION_ID) +
            GENERAL_NOTIFICATION_IDS
    private val LEGACY_CHANNEL_IDS = listOf(
        "notification_alert_audio_v3",
        "notification_alert_silent_v4"
    )
    private const val MAX_CALL_LINES = 5
    private const val AUTO_GROUP_SUMMARY_ID = 0
    private const val AUTO_GROUP_CLEAR_DELAY_MS = 500L
    private const val CLEAR_DEDUP_WINDOW_MS = 500L
    private val lastClearAt = AtomicLong(0L)
}
