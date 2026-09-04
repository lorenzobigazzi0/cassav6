package com.sentrapa.cassav6.webkiosk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.sentrapa.cassav6.webkiosk.bluetooth.BluetoothEnrollmentConfig
import com.sentrapa.cassav6.webkiosk.bluetooth.BluetoothEnrollmentCoordinator
import com.sentrapa.cassav6.webkiosk.bluetooth.BluetoothFailoverService
import com.sentrapa.cassav6.webkiosk.notifications.NotificationHelper

class AlwaysOnService : Service() {
    private lateinit var batteryHeartbeatReporter: BatteryStatusHeartbeatReporter
    private lateinit var audioPlayer: AudioKeepAlivePlayer
    private lateinit var notificationCoordinator: NativeNotificationCoordinator
    private lateinit var notificationPoller: NativeNotificationPoller
    private lateinit var backgroundRadioReceiver: NativeBackgroundRadioReceiver
    private lateinit var foregroundRadioWifiLatencyLock: RadioWifiLatencyLock
    private var bluetoothEnrollmentCoordinator: BluetoothEnrollmentCoordinator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var radioEnabledForSession = false
    private var activeSessionIdentityKey: String? = null
    private val wakeLockHandler = Handler(Looper.getMainLooper())
    private val wakeLockRenewal = object : Runnable {
        override fun run() {
            renewWakeLock()
        }
    }

    private val foregroundListener: (Boolean) -> Unit = { isForeground ->
        if (::notificationPoller.isInitialized) {
            notificationPoller.updateForeground(isForeground)
        }
        if (::backgroundRadioReceiver.isInitialized) {
            backgroundRadioReceiver.updateForeground(isForeground)
        }
        BluetoothFailoverService.refresh(applicationContext)
        syncForegroundRadioWifiLatencyLock()
        if (isForeground && ::notificationCoordinator.isInitialized) {
            notificationCoordinator.reset()
        }
    }

    private val screenStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> AppForegroundState.setDeviceInteractive(false)
                Intent.ACTION_SCREEN_ON,
                Intent.ACTION_USER_PRESENT ->
                    AppForegroundState.setDeviceInteractive(isDeviceInteractive())
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (!hasAuthenticatedSession()) {
            stopSelf()
            return
        }
        activeService = this
        batteryHeartbeatReporter = BatteryStatusHeartbeatReporter(applicationContext)
        audioPlayer = AudioKeepAlivePlayer(applicationContext)
        notificationCoordinator = NativeNotificationCoordinator(applicationContext, audioPlayer)
        activeNotificationCoordinator = notificationCoordinator
        notificationPoller = NativeNotificationPoller(
            applicationContext,
            onSnapshot = { events, alertNew, sessionBindingKey ->
                notificationCoordinator.syncSnapshot(events, alertNew, sessionBindingKey)
            },
            onEvent = { event ->
                notificationCoordinator.submit(event)
            }
        )
        backgroundRadioReceiver = NativeBackgroundRadioReceiver(applicationContext)
        foregroundRadioWifiLatencyLock = RadioWifiLatencyLock(applicationContext)

        NotificationHelper.ensureChannels(applicationContext)
        AppForegroundState.setDeviceInteractive(isDeviceInteractive())
        AppForegroundState.addListener(foregroundListener)
        registerScreenStateReceiver()
        acquireWakeLock()
        startAsForegroundService()
        initializeBluetoothEnrollment()
        BluetoothFailoverService.start(applicationContext)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!hasAuthenticatedSession()) {
            stopForClearedSession()
            return START_NOT_STICKY
        }
        AppForegroundState.setDeviceInteractive(isDeviceInteractive())
        val sessionActive = refreshRuntimeState()
        if (!sessionActive) {
            stopForClearedSession()
            return START_NOT_STICKY
        }
        bluetoothEnrollmentCoordinator?.refresh()
        BluetoothFailoverService.refresh(applicationContext)
        when (intent?.action) {
            ACTION_ENQUEUE_NOTIFICATION ->
                if (sessionActive) {
                    notificationEventFromIntent(intent)?.let(notificationCoordinator::submit)
                }
            ACTION_CLEAR_NATIVE_ALERTS -> notificationCoordinator.reset()
            ACTION_REFRESH_SESSION -> Unit
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        start(applicationContext)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        if (activeService === this) activeService = null
        if (
            ::notificationCoordinator.isInitialized &&
            activeNotificationCoordinator === notificationCoordinator
        ) {
            activeNotificationCoordinator = null
        }
        if (::notificationPoller.isInitialized) notificationPoller.close()
        if (::notificationCoordinator.isInitialized) notificationCoordinator.close()
        if (::backgroundRadioReceiver.isInitialized) backgroundRadioReceiver.close()
        if (::foregroundRadioWifiLatencyLock.isInitialized) foregroundRadioWifiLatencyLock.release()
        bluetoothEnrollmentCoordinator?.close()
        bluetoothEnrollmentCoordinator = null
        if (::audioPlayer.isInitialized) audioPlayer.stop()
        if (::batteryHeartbeatReporter.isInitialized) batteryHeartbeatReporter.close()
        AppForegroundState.removeListener(foregroundListener)
        unregisterScreenStateReceiver()
        wakeLockHandler.removeCallbacks(wakeLockRenewal)
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        super.onDestroy()
    }

    private fun refreshRuntimeState(): Boolean {
        val savedUrl = KioskPreferences.getSavedUrl(this)
        val clientContext = KioskPreferences.getNotificationClientContext(this)
        val sessionActive = clientContext.hasAuthenticatedSession
        val nextIdentityKey = clientContext.identityKey.takeIf { sessionActive }
        if (
            !sessionActive ||
            (activeSessionIdentityKey != null && activeSessionIdentityKey != nextIdentityKey)
        ) {
            notificationCoordinator.reset()
        }
        activeSessionIdentityKey = nextIdentityKey
        radioEnabledForSession = clientContext.canUseRadio
        batteryHeartbeatReporter.updateUrl(savedUrl)
        notificationPoller.update(savedUrl, clientContext)
        backgroundRadioReceiver.update(savedUrl, clientContext)
        syncForegroundRadioWifiLatencyLock()
        return sessionActive
    }

    private fun hasAuthenticatedSession(): Boolean =
        KioskPreferences.hasAuthenticatedNotificationSession(applicationContext)

    private fun stopForClearedSession() {
        activeSessionIdentityKey = null
        radioEnabledForSession = false
        if (::notificationPoller.isInitialized) {
            notificationPoller.stopForSessionClear()
        }
        val savedUrl = KioskPreferences.getSavedUrl(this)
        if (::backgroundRadioReceiver.isInitialized) {
            backgroundRadioReceiver.update(savedUrl, NotificationClientContext())
        }
        if (::foregroundRadioWifiLatencyLock.isInitialized) {
            foregroundRadioWifiLatencyLock.release()
        }
        if (::notificationCoordinator.isInitialized) {
            notificationCoordinator.reset()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun syncForegroundRadioWifiLatencyLock() {
        if (!::foregroundRadioWifiLatencyLock.isInitialized) return
        if (radioEnabledForSession && AppForegroundState.isForeground) {
            foregroundRadioWifiLatencyLock.acquire()
        } else {
            foregroundRadioWifiLatencyLock.release()
        }
    }

    private fun initializeBluetoothEnrollment() {
        if (
            !BuildConfig.BLUETOOTH_LAB_BUILD ||
            !BuildConfig.BLUETOOTH_ENROLLMENT_ENABLED ||
            !BuildConfig.BLUETOOTH_IDENTITY_ENABLED
        ) {
            return
        }
        bluetoothEnrollmentCoordinator = BluetoothEnrollmentCoordinator(
            context = applicationContext,
            config = BluetoothEnrollmentConfig(
                enabled = BuildConfig.BLUETOOTH_ENROLLMENT_ENABLED,
                endpointId = BuildConfig.BLUETOOTH_ENROLLMENT_ENDPOINT_ID,
                url = BuildConfig.BLUETOOTH_ENROLLMENT_URL,
                spkiSha256 = BuildConfig.BLUETOOTH_ENROLLMENT_SPKI_SHA256
            ),
            identityEnabled = BuildConfig.BLUETOOTH_IDENTITY_ENABLED,
            labBuild = BuildConfig.BLUETOOTH_LAB_BUILD,
            onIdentityReady = {
                BluetoothFailoverService.refresh(applicationContext)
            }
        ).also { it.refresh() }
    }

    private fun notificationEventFromIntent(intent: Intent): NativeNotificationEvent? {
        val title = intent.getStringExtra(EXTRA_NOTIFICATION_TITLE)?.trim().orEmpty()
        val text = intent.getStringExtra(EXTRA_NOTIFICATION_TEXT)?.trim().orEmpty()
        if (text.isBlank()) return null
        val tone = NotificationTone.fromWireValue(intent.getStringExtra(EXTRA_NOTIFICATION_TONE))
        val createdAt = intent.getLongExtra(EXTRA_NOTIFICATION_CREATED_AT, 0L)
            .takeIf { it > 0L }
            ?: return null
        val sessionContext = KioskPreferences.getNotificationClientContext(applicationContext)
        val eventSessionStartedAt =
            intent.getLongExtra(EXTRA_NOTIFICATION_SESSION_STARTED_AT, 0L)
        val eventSessionBindingKey =
            intent.getStringExtra(EXTRA_NOTIFICATION_SESSION_BINDING_KEY)?.trim().orEmpty()
        if (
            eventSessionStartedAt != sessionContext.sessionStartedAt ||
            eventSessionBindingKey != sessionContext.sessionBindingKey
        ) {
            return null
        }
        val id = intent.getStringExtra(EXTRA_NOTIFICATION_ID)?.trim().orEmpty()
            .ifBlank { "native:${listOf(tone.name, title, text, createdAt).joinToString("|").hashCode()}" }
        return NativeNotificationEvent(
            id = id,
            tone = tone,
            title = title.ifBlank { defaultTitleFor(tone) },
            text = text,
            createdAt = createdAt,
            sessionBindingKey = eventSessionBindingKey
        ).takeIf { event -> shouldEnqueueNativeNotification(event, sessionContext) }
    }

    private fun registerScreenStateReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        ContextCompat.registerReceiver(
            this,
            screenStateReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun unregisterScreenStateReceiver() {
        runCatching { unregisterReceiver(screenStateReceiver) }
    }

    private fun isDeviceInteractive(): Boolean {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            powerManager.isInteractive
        } else {
            @Suppress("DEPRECATION")
            powerManager.isScreenOn
        }
    }

    private fun acquireWakeLock() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "WebKiosk:AlwaysOnData"
        ).apply {
            setReferenceCounted(false)
        }
        renewWakeLock()
    }

    private fun renewWakeLock() {
        val lock = wakeLock ?: return
        runCatching {
            if (lock.isHeld) lock.release()
            lock.acquire(WAKE_LOCK_TIMEOUT_MS)
        }.onFailure { error ->
            Log.w(TAG, "Unable to renew wake lock: ${error.message}")
        }
        wakeLockHandler.removeCallbacks(wakeLockRenewal)
        wakeLockHandler.postDelayed(wakeLockRenewal, WAKE_LOCK_RENEW_MS)
    }

    private fun startAsForegroundService() {
        ensureServiceNotificationChannel()
        val notification = buildServiceNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val serviceTypes =
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                serviceTypes
            )
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification)
        }
    }

    private fun ensureServiceNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(SERVICE_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            SERVICE_CHANNEL_ID,
            "Amalia Advanced sempre attiva",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Mantiene attivi rete, radio e dati del kiosk."
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildServiceNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Amalia Advanced attiva")
            .setContentText("Radio, notifiche e dati in background attivi.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun defaultTitleFor(tone: NotificationTone): String = when (tone) {
        NotificationTone.WAITER -> "Chiamata cameriere"
        NotificationTone.BELL -> "Comanda pronta"
        NotificationTone.HANDHELD_RING -> "Squillo palmare"
        NotificationTone.GENERAL -> "Notifica"
    }

    companion object {
        @Volatile
        private var activeService: AlwaysOnService? = null

        @Volatile
        private var activeNotificationCoordinator: NativeNotificationCoordinator? = null

        private const val TAG = "AlwaysOnService"
        private const val ACTION_ENQUEUE_NOTIFICATION =
            "com.sentrapa.cassav6.webkiosk.action.ENQUEUE_NOTIFICATION"
        private const val ACTION_CLEAR_NATIVE_ALERTS =
            "com.sentrapa.cassav6.webkiosk.action.CLEAR_NATIVE_ALERTS"
        private const val ACTION_REFRESH_BLUETOOTH =
            "com.sentrapa.cassav6.webkiosk.action.REFRESH_BLUETOOTH"
        private const val ACTION_REFRESH_SESSION =
            "com.sentrapa.cassav6.webkiosk.action.REFRESH_SESSION"
        private const val EXTRA_NOTIFICATION_ID = "notification_id"
        private const val EXTRA_NOTIFICATION_TONE = "notification_tone"
        private const val EXTRA_NOTIFICATION_TITLE = "notification_title"
        private const val EXTRA_NOTIFICATION_TEXT = "notification_text"
        private const val EXTRA_NOTIFICATION_CREATED_AT = "notification_created_at"
        private const val EXTRA_NOTIFICATION_SESSION_STARTED_AT =
            "notification_session_started_at"
        private const val EXTRA_NOTIFICATION_SESSION_BINDING_KEY =
            "notification_session_binding_key"
        private const val SERVICE_CHANNEL_ID = "webkiosk_always_on"
        private const val SERVICE_NOTIFICATION_ID = 2_001
        private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1_000L
        private const val WAKE_LOCK_RENEW_MS = 9 * 60 * 1_000L

        fun start(context: Context) {
            val sessionContext = KioskPreferences.getNotificationClientContext(context)
            if (!shouldStartAuthenticatedRuntime(KioskPreferences.getSavedUrl(context), sessionContext)) return
            BluetoothFailoverService.start(context)
            startServiceIntent(
                context.applicationContext,
                Intent(context.applicationContext, AlwaysOnService::class.java)
            )
        }

        fun refreshBluetooth(context: Context) {
            val appContext = context.applicationContext
            if (!KioskPreferences.hasAuthenticatedNotificationSession(appContext)) return
            BluetoothFailoverService.refresh(appContext)
            if (!BuildConfig.BLUETOOTH_ENROLLMENT_ENABLED) return
            startServiceIntent(
                appContext,
                Intent(appContext, AlwaysOnService::class.java)
                    .setAction(ACTION_REFRESH_BLUETOOTH)
            )
        }

        fun enqueueNotification(context: Context, event: NativeNotificationEvent): Boolean {
            val appContext = context.applicationContext
            val sessionContext = KioskPreferences.getNotificationClientContext(appContext)
            if (!shouldEnqueueNativeNotification(event, sessionContext)) return false
            activeNotificationCoordinator?.let { coordinator ->
                coordinator.submit(event)
                return true
            }
            val intent = Intent(appContext, AlwaysOnService::class.java)
                .setAction(ACTION_ENQUEUE_NOTIFICATION)
                .putExtra(EXTRA_NOTIFICATION_ID, event.id)
                .putExtra(EXTRA_NOTIFICATION_TONE, event.tone.name)
                .putExtra(EXTRA_NOTIFICATION_TITLE, event.title)
                .putExtra(EXTRA_NOTIFICATION_TEXT, event.text)
                .putExtra(EXTRA_NOTIFICATION_CREATED_AT, event.createdAt)
                .putExtra(
                    EXTRA_NOTIFICATION_SESSION_STARTED_AT,
                    sessionContext.sessionStartedAt
                )
                .putExtra(EXTRA_NOTIFICATION_SESSION_BINDING_KEY, event.sessionBindingKey)
            startServiceIntent(appContext, intent)
            return true
        }

        fun refreshSession(context: Context) {
            val appContext = context.applicationContext
            val sessionContext = KioskPreferences.getNotificationClientContext(appContext)
            if (!shouldStartAuthenticatedRuntime(KioskPreferences.getSavedUrl(appContext), sessionContext)) {
                sessionCleared(appContext)
                return
            }
            startServiceIntent(
                appContext,
                Intent(appContext, AlwaysOnService::class.java)
                    .setAction(ACTION_REFRESH_SESSION)
            )
        }

        fun sessionCleared(context: Context) {
            val appContext = context.applicationContext
            stopNativeNotificationPollersForSessionClear()
            activeNotificationCoordinator?.reset()
            NotificationHelper.cancelActiveVibration(appContext)
            NotificationHelper.clearDeliveredNotifications(appContext)
            BluetoothFailoverService.stopForSessionClear(appContext)
            activeService?.stopForClearedSession()
            runCatching {
                appContext.stopService(Intent(appContext, AlwaysOnService::class.java))
            }.onFailure { error ->
                Log.w(TAG, "Unable to stop cleared-session service: ${error.message}")
            }
            val notificationManager =
                appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(SERVICE_NOTIFICATION_ID)
        }

        fun clearNativeAlerts(context: Context) {
            val appContext = context.applicationContext
            activeNotificationCoordinator?.let { coordinator ->
                coordinator.reset()
                return
            }
            NotificationHelper.cancelActiveVibration(appContext)
            NotificationHelper.clearDeliveredNotifications(appContext)
            if (!KioskPreferences.hasAuthenticatedNotificationSession(appContext)) return
            val intent = Intent(appContext, AlwaysOnService::class.java)
                .setAction(ACTION_CLEAR_NATIVE_ALERTS)
            startServiceIntent(appContext, intent)
        }

        private fun startServiceIntent(appContext: Context, intent: Intent) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    appContext.startForegroundService(intent)
                } else {
                    appContext.startService(intent)
                }
            } catch (error: RuntimeException) {
                Log.e(TAG, "Unable to start foreground service: ${error.message}")
            }
        }
    }
}

internal fun shouldStartAuthenticatedRuntime(
    savedUrl: String?,
    sessionContext: NotificationClientContext
): Boolean = !savedUrl.isNullOrBlank() && sessionContext.hasAuthenticatedSession

internal fun shouldEnqueueNativeNotification(
    event: NativeNotificationEvent,
    sessionContext: NotificationClientContext
): Boolean =
    sessionContext.hasAuthenticatedSession &&
        event.sessionBindingKey.isNotBlank() &&
        event.sessionBindingKey == sessionContext.sessionBindingKey &&
        isNativeNotificationFreshForSession(event.createdAt, sessionContext.sessionStartedAt)
