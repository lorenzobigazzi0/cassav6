package com.sentrapa.webkiosk

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.sentrapa.webkiosk.bluetooth.BluetoothAgentStateSubscription
import com.sentrapa.webkiosk.bluetooth.BluetoothFailoverService
import com.sentrapa.webkiosk.bluetooth.BluetoothFailoverUiBridge
import com.sentrapa.webkiosk.bluetooth.NativeBluetoothCapabilityBridge
import com.sentrapa.webkiosk.bluetooth.shouldAllowGattServerCapabilityProbe
import com.sentrapa.webkiosk.notifications.NativeNotificationBridge
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val REQUEST_CODE_APP_PERMISSIONS = 1001
private const val REQUEST_CODE_WEB_PERMISSION = 1002
private const val REQUEST_CODE_WEB_GEOLOCATION = 1003
private const val REQUEST_CODE_FILE_CHOOSER = 1004
private const val NATIVE_NOTIFICATION_BRIDGE_NAME = "AmaliaNativeNotifications"
private const val NATIVE_HAPTICS_BRIDGE_NAME = "AmaliaNativeHaptics"
private const val URL_SETUP_UNLOCK_WINDOW_MS = 10_000L
private const val URL_SETUP_LONG_PRESS_MS = 5_000L
private const val URL_SETUP_PIN_LENGTH = 4
private const val NATIVE_RADIO_PTT_LONG_PRESS_MS = 650L
internal const val DEFAULT_SERVER_URL = "https://192.168.0.67:5380/mobile/"
private const val SPLASH_DURATION_MS = 2_000L
internal const val NOTIFICATION_CONTEXT_STORAGE_JS =
    "(function(){try{var keys=['pos_token','pos_user_id','pos_user','pos_full_name','pos_device_uuid','pos_auth_session_started_at','pos_room_id','pos_room_name'];var out={};keys.forEach(function(k){out[k]=window.localStorage.getItem(k)||window.sessionStorage.getItem(k)||'';});return JSON.stringify(out);}catch(e){return '';}})();"
private const val MICROPHONE_CAPABILITY_JS =
    "(function(){try{return JSON.stringify({secure:!!window.isSecureContext,media:!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)});}catch(e){return '';}})();"

private data class PendingGeolocationPrompt(
    val origin: String,
    val callback: GeolocationPermissions.Callback
)

class MainActivity : ComponentActivity() {
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingGeolocationPrompt: PendingGeolocationPrompt? = null
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraImageUri: Uri? = null
    private var activeWebView: WebView? = null
    private var bluetoothStateSubscription: BluetoothAgentStateSubscription? = null
    private val bluetoothFailoverUiBridge by lazy {
        BluetoothFailoverUiBridge { BluetoothFailoverService.stateSnapshot() }
    }
    private val nfcController by lazy {
        NativeNfcController(this, ::dispatchNfcPayloadToWebView)
    }
    private val batteryController by lazy {
        NativeBatteryController(applicationContext, ::dispatchBatteryPayloadToWebView)
    }
    private val urlSetupRequestCounter = mutableStateOf(0)
    private val urlSetupGestureHandler = Handler(Looper.getMainLooper())
    private val nativeRadioPttHandler = Handler(Looper.getMainLooper())
    private var urlSetupWindowStartedAt = 0L
    private var urlSetupTouchStartedAt = 0L
    private var urlSetupTouchTriggered = false
    private var volumeUpPttStartedAt = 0L
    private var volumeUpPttPending = false
    private var volumeUpPttActive = false
    private var volumeUpPttStartRunnable: Runnable? = null
    private var startupServicesReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        urlSetupWindowStartedAt = SystemClock.elapsedRealtime()
        batteryController.start()

        AppForegroundState.markForeground()
        AlwaysOnService.clearNativeAlerts(this)
// 1. Forza il layout a estendersi dietro il notch (fotocamera)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 2. Rendi la finestra "Edge-to-Edge" (senza limiti di sistema)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContent {
            // Nascondi le barre non appena l'interfaccia è pronta
            SideEffect {
                hideSystemBars()
                // Assicura che lo sfondo della finestra sia pulito
                window.statusBarColor = android.graphics.Color.TRANSPARENT
                window.navigationBarColor = android.graphics.Color.TRANSPARENT
            }

            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    PalmareRoot(urlSetupRequestSignal = urlSetupRequestCounter.value)
                }
            }
        }
    }

    fun onPalmareUiReady() {
        if (startupServicesReady) return
        startupServicesReady = true
        requestAppPermissions()
        requestBatteryOptimizationExemption()
        AlwaysOnService.start(this)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        handleUrlSetupGesture(ev)
        return super.dispatchTouchEvent(ev)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            event.startTracking()
            handleVolumeUpRadioPttDown(event)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            startVolumeUpRadioPtt()
            return true
        }
        return super.onKeyLongPress(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            handleVolumeUpRadioPttUp()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        AlwaysOnService.clearNativeAlerts(this)
        nfcController.handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        AppForegroundState.markForeground()
    }

    override fun onResume() {
        super.onResume()
        AppForegroundState.markForeground()
        AlwaysOnService.refreshBluetooth(this)
        nfcController.onResume()
    }

    override fun onPause() {
        nfcController.onPause()
        cancelVolumeUpRadioPtt()
        super.onPause()
    }

    override fun onStop() {
        AppForegroundState.markBackground()
        super.onStop()
    }

    override fun onDestroy() {
        urlSetupGestureHandler.removeCallbacksAndMessages(null)
        cancelVolumeUpRadioPtt()
        nativeRadioPttHandler.removeCallbacksAndMessages(null)
        nfcController.close()
        batteryController.close()
        pendingWebPermissionRequest?.deny()
        pendingWebPermissionRequest = null
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = null
        pendingCameraImageUri = null
        pendingGeolocationPrompt?.let { prompt ->
            prompt.callback.invoke(prompt.origin, false, false)
        }
        pendingGeolocationPrompt = null
        bluetoothStateSubscription?.close()
        bluetoothStateSubscription = null
        activeWebView?.let { webView ->
            runCatching {
                webView.stopLoading()
                webView.removeJavascriptInterface(NATIVE_NOTIFICATION_BRIDGE_NAME)
                webView.removeJavascriptInterface(NATIVE_HAPTICS_BRIDGE_NAME)
                webView.removeJavascriptInterface(NativeNfcController.BRIDGE_NAME)
                webView.removeJavascriptInterface(NativeBatteryController.BRIDGE_NAME)
                webView.removeJavascriptInterface(NativeBluetoothCapabilityBridge.BRIDGE_NAME)
                webView.removeJavascriptInterface(BluetoothFailoverUiBridge.BRIDGE_NAME)
                webView.destroy()
            }
        }
        activeWebView = null
        super.onDestroy()
    }

    private fun handleUrlSetupGesture(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val now = SystemClock.elapsedRealtime()
                if (now - urlSetupWindowStartedAt > URL_SETUP_UNLOCK_WINDOW_MS) return

                urlSetupTouchStartedAt = now
                urlSetupTouchTriggered = false
                urlSetupGestureHandler.postDelayed({
                    val current = SystemClock.elapsedRealtime()
                    val heldLongEnough =
                        urlSetupTouchStartedAt > 0L &&
                            current - urlSetupTouchStartedAt >= URL_SETUP_LONG_PRESS_MS
                    val insideLaunchWindow =
                        current - urlSetupWindowStartedAt <= URL_SETUP_UNLOCK_WINDOW_MS
                    if (heldLongEnough && insideLaunchWindow && !urlSetupTouchTriggered) {
                        urlSetupTouchTriggered = true
                        urlSetupRequestCounter.value += 1
                    }
                }, URL_SETUP_LONG_PRESS_MS)
            }

            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> {
                urlSetupTouchStartedAt = 0L
                urlSetupGestureHandler.removeCallbacksAndMessages(null)
            }
        }
    }

    private fun handleVolumeUpRadioPttDown(event: KeyEvent) {
        if (volumeUpPttActive) return
        if (event.repeatCount > 0) {
            startVolumeUpRadioPtt()
            return
        }
        if (volumeUpPttPending) return

        volumeUpPttStartedAt = SystemClock.elapsedRealtime()
        volumeUpPttPending = true
        val startRunnable = Runnable {
            val heldLongEnough =
                volumeUpPttPending &&
                    SystemClock.elapsedRealtime() - volumeUpPttStartedAt >=
                    NATIVE_RADIO_PTT_LONG_PRESS_MS
            if (heldLongEnough && !volumeUpPttActive) startVolumeUpRadioPtt()
        }
        volumeUpPttStartRunnable = startRunnable
        nativeRadioPttHandler.postDelayed(startRunnable, NATIVE_RADIO_PTT_LONG_PRESS_MS)
    }

    private fun handleVolumeUpRadioPttUp() {
        clearPendingVolumeUpRadioPttStart()
        if (volumeUpPttActive) {
            volumeUpPttActive = false
            dispatchNativeRadioPtt("up")
        } else {
            raiseMediaVolumeOnce()
        }
    }

    private fun startVolumeUpRadioPtt() {
        if (volumeUpPttActive) return
        clearPendingVolumeUpRadioPttStart()
        volumeUpPttActive = true
        dispatchNativeRadioPtt("down")
    }

    private fun clearPendingVolumeUpRadioPttStart() {
        volumeUpPttPending = false
        volumeUpPttStartRunnable?.let(nativeRadioPttHandler::removeCallbacks)
        volumeUpPttStartRunnable = null
    }

    private fun cancelVolumeUpRadioPtt() {
        clearPendingVolumeUpRadioPttStart()
        if (volumeUpPttActive) {
            volumeUpPttActive = false
            dispatchNativeRadioPtt("cancel")
        }
    }

    private fun raiseMediaVolumeOnce() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0)
    }

    private fun dispatchNativeRadioPtt(phase: String) {
        val webView = activeWebView ?: return
        if (!isTrustedKioskPage(webView)) return
        val payload = JSONObject()
            .put("phase", phase)
            .put("key", "volume-up")
            .put("source", "android")
            .put("ts", System.currentTimeMillis())
        val script = """
            (function(){
              try {
                var detail = $payload;
                window.__amaliaLastNativeRadioPtt = detail;
                window.dispatchEvent(new CustomEvent('amalia:native-radio-ptt', { detail: detail }));
              } catch (error) {
                console.warn('amalia:native-radio-ptt dispatch failed', error);
              }
            })();
        """.trimIndent()
        webView.post {
            runCatching { webView.evaluateJavascript(script, null) }
                .onFailure { error ->
                    Log.w("WebKioskRadio", "Radio PTT non inviato alla WebView", error)
                }
        }
    }

    @Deprecated("Deprecated by Android; WebView file chooser still returns through this callback.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_CODE_FILE_CHOOSER) {
            val callback = pendingFileChooserCallback ?: return
            pendingFileChooserCallback = null

            val result = if (resultCode == Activity.RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                    ?.takeIf { it.isNotEmpty() }
                    ?: pendingCameraImageUri?.let { arrayOf(it) }
            } else {
                null
            }
            pendingCameraImageUri = null
            callback.onReceiveValue(result)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQUEST_CODE_WEB_PERMISSION -> resolvePendingWebPermissionRequest()
            REQUEST_CODE_WEB_GEOLOCATION -> resolvePendingGeolocationPrompt()
            REQUEST_CODE_APP_PERMISSIONS -> AlwaysOnService.refreshBluetooth(this)
        }
    }

    fun handleFileChooser(
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: WebChromeClient.FileChooserParams
    ): Boolean {
        val webView = activeWebView
        if (webView == null || !isTrustedKioskPage(webView)) {
            Log.w("WebKioskWebView", "File chooser rifiutato fuori dall'origine kiosk")
            filePathCallback.onReceiveValue(null)
            return true
        }
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = filePathCallback
        pendingCameraImageUri = null

        val cameraIntent = createImageCaptureIntent(fileChooserParams)
        val pickerIntent = createPickerIntent(fileChooserParams)

        val launchIntent = if (fileChooserParams.isCaptureEnabled && cameraIntent != null) {
            cameraIntent
        } else {
            Intent(Intent.ACTION_CHOOSER).apply {
                putExtra(Intent.EXTRA_INTENT, pickerIntent)
                putExtra(Intent.EXTRA_TITLE, "Seleziona QR")
                if (cameraIntent != null) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
                }
            }
        }

        return runCatching {
            startActivityForResult(launchIntent, REQUEST_CODE_FILE_CHOOSER)
            true
        }.getOrElse { error ->
            Log.w("WebKioskWebView", "File chooser/camera non avviabile: ${error.message}")
            pendingFileChooserCallback = null
            pendingCameraImageUri = null
            filePathCallback.onReceiveValue(null)
            false
        }
    }

    private fun hideSystemBars() {
        val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
        windowInsetsController.let { controller ->
            // Nasconde completamente le barre di sistema
            controller.hide(WindowInsetsCompat.Type.systemBars())
            // Comportamento Immersivo: le barre appaiono solo con swipe e svaniscono subito
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    fun updateNotificationClientContext(payloadJson: String?) {
        NativeSessionContextStore.updateFromJson(this, payloadJson.orEmpty())
    }

    fun attachWebView(webView: WebView) {
        activeWebView = webView
        if (BuildConfig.BLUETOOTH_DIAGNOSTIC_BADGE) {
            bluetoothStateSubscription?.close()
            bluetoothStateSubscription =
                BluetoothFailoverService.addStateListener { snapshot ->
                    dispatchBluetoothAgentStateToWebView(
                        snapshot.toRedactedWebViewJson()
                    )
                }
        }
    }

    fun nativeNfcBridge(): NativeNfcBridge = nfcController.bridge

    fun nativeBatteryBridge(): NativeBatteryBridge = batteryController.bridge

    fun bluetoothFailoverStateBridge(): BluetoothFailoverUiBridge =
        bluetoothFailoverUiBridge

    fun onWebPageNavigationStarted() {
        nfcController.onPageNavigationStarted()
    }

    fun installNativePageHooks(webView: WebView) {
        if (!isTrustedKioskPage(webView)) return
        nfcController.installWebLifecycleHook(webView)
        batteryController.publishCurrent()
        if (BuildConfig.BLUETOOTH_DIAGNOSTIC_BADGE) {
            dispatchBluetoothAgentStateToWebView(
                BluetoothFailoverService.stateSnapshot().toRedactedWebViewJson()
            )
        }
    }

    private fun dispatchBluetoothAgentStateToWebView(payloadJson: String) {
        val script = """
            (function(){
              try {
                var detail = $payloadJson;
                window.dispatchEvent(new CustomEvent('${BluetoothFailoverUiBridge.EVENT_NAME}', { detail: detail }));
              } catch (error) {
                console.warn('native bluetooth state dispatch failed', error);
              }
            })();
        """.trimIndent()
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            val webView = activeWebView ?: return@runOnUiThread
            if (!isTrustedKioskPage(webView)) return@runOnUiThread
            runCatching { webView.evaluateJavascript(script, null) }
                .onFailure { error ->
                    Log.w("WebKioskBluetooth", "Stato Bluetooth non inviato alla WebView", error)
                }
        }
    }

    private fun dispatchBatteryPayloadToWebView(payloadJson: String) {
        val webView = activeWebView ?: return
        if (!isTrustedKioskPage(webView)) return
        val script = """
            (function(){
              try {
                var detail = $payloadJson;
                window.dispatchEvent(new CustomEvent('${NativeBatteryController.EVENT_NAME}', { detail: detail }));
              } catch (error) {
                console.warn('native battery dispatch failed', error);
              }
            })();
        """.trimIndent()
        webView.post {
            runCatching { webView.evaluateJavascript(script, null) }
                .onFailure { error -> Log.w("WebKioskBattery", "Batteria non inviata alla WebView", error) }
        }
    }

    private fun dispatchNfcPayloadToWebView(payloadJson: String) {
        val webView = activeWebView ?: return
        if (!isTrustedKioskPage(webView)) {
            Log.w("WebKioskNfc", "Lettura NFC scartata fuori dall'origine kiosk")
            return
        }
        val script = """
            (function(){
              try {
                var detail = $payloadJson;
                window.__amaliaLastNfcTag = detail;
                window.dispatchEvent(new CustomEvent('native:nfc', { detail: detail }));
                window.dispatchEvent(new CustomEvent('amalia:nfc', { detail: detail }));
                if (window.AmaliaNativeBridge && typeof window.AmaliaNativeBridge.onNfcTag === 'function') {
                  window.AmaliaNativeBridge.onNfcTag(detail);
                }
                if (window.CassaNativeBridge && typeof window.CassaNativeBridge.onNfcTag === 'function') {
                  window.CassaNativeBridge.onNfcTag(detail);
                }
              } catch (error) {
                console.warn('native:nfc dispatch failed', error);
              }
            })();
        """.trimIndent()
        webView.post {
            runCatching { webView.evaluateJavascript(script, null) }
                .onFailure { error -> Log.w("WebKioskNfc", "NFC non inviato alla WebView", error) }
        }
    }

    private fun isTrustedKioskPage(webView: WebView): Boolean =
        isSameOrigin(webView.url, KioskPreferences.getSavedUrl(this))

    fun handleWebPermissionRequest(request: PermissionRequest) {
        if (!isTrustedWebPermissionRequest(request)) {
            Log.w(
                "WebKioskWebView",
                "Permesso WebView rifiutato per origine o risorsa non autorizzata"
            )
            request.deny()
            return
        }
        val missingPermissions = missingAndroidPermissionsForWebResources(request.resources)
        if (missingPermissions.isEmpty()) {
            request.grant(request.resources)
            return
        }

        pendingWebPermissionRequest?.deny()
        pendingWebPermissionRequest = request
        requestPermissions(missingPermissions.toTypedArray(), REQUEST_CODE_WEB_PERMISSION)
    }

    fun handleWebPermissionRequestCanceled(request: PermissionRequest) {
        if (pendingWebPermissionRequest === request) {
            pendingWebPermissionRequest = null
        }
    }

    fun handleGeolocationPermissionPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback
    ) {
        if (!isTrustedKioskOrigin(origin)) {
            Log.w("WebKioskWebView", "Geolocalizzazione rifiutata fuori dall'origine kiosk")
            callback.invoke(origin, false, false)
            return
        }
        if (hasLocationPermission()) {
            callback.invoke(origin, true, false)
            return
        }

        pendingGeolocationPrompt?.let { prompt ->
            prompt.callback.invoke(prompt.origin, false, false)
        }
        pendingGeolocationPrompt = PendingGeolocationPrompt(origin, callback)
        requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ),
            REQUEST_CODE_WEB_GEOLOCATION
        )
    }

    private fun requestAppPermissions() {
        val missingPermissions = appRuntimePermissions().filterNot(::hasPermission)
        if (missingPermissions.isNotEmpty()) {
            requestPermissions(missingPermissions.toTypedArray(), REQUEST_CODE_APP_PERMISSIONS)
        }
    }

    private fun appRuntimePermissions(): List<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        add(Manifest.permission.CAMERA)
        add(Manifest.permission.RECORD_AUDIO)
        if (
            (
                BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED ||
                    (
                        BuildConfig.BLUETOOTH_DISCOVERY_ENABLED &&
                            BuildConfig.BLUETOOTH_IDENTITY_ENABLED
                        )
                ) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        ) {
            add(Manifest.permission.BLUETOOTH_SCAN)
            add(Manifest.permission.BLUETOOTH_ADVERTISE)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
    }

    private fun resolvePendingWebPermissionRequest() {
        val request = pendingWebPermissionRequest ?: return
        pendingWebPermissionRequest = null

        if (
            isTrustedWebPermissionRequest(request) &&
            missingAndroidPermissionsForWebResources(request.resources).isEmpty()
        ) {
            request.grant(request.resources)
        } else {
            request.deny()
        }
    }

    private fun resolvePendingGeolocationPrompt() {
        val prompt = pendingGeolocationPrompt ?: return
        pendingGeolocationPrompt = null
        prompt.callback.invoke(
            prompt.origin,
            isTrustedKioskOrigin(prompt.origin) && hasLocationPermission(),
            false
        )
    }

    private fun isTrustedWebPermissionRequest(request: PermissionRequest): Boolean {
        val resources = request.resources.toSet()
        return isTrustedKioskOrigin(request.origin?.toString()) &&
            resources.isNotEmpty() &&
            resources.all(ALLOWED_WEB_PERMISSION_RESOURCES::contains) &&
            activeWebView?.let(::isTrustedKioskPage) == true
    }

    private fun isTrustedKioskOrigin(origin: String?): Boolean =
        isSameOrigin(origin, KioskPreferences.getSavedUrl(this))

    private fun missingAndroidPermissionsForWebResources(resources: Array<String>): List<String> {
        val requiredPermissions = buildSet {
            resources.forEach { resource ->
                when (resource) {
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> add(Manifest.permission.RECORD_AUDIO)
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> add(Manifest.permission.CAMERA)
                }
            }
        }
        return requiredPermissions.filterNot(::hasPermission)
    }

    private companion object {
        val ALLOWED_WEB_PERMISSION_RESOURCES = setOf(
            PermissionRequest.RESOURCE_AUDIO_CAPTURE,
            PermissionRequest.RESOURCE_VIDEO_CAPTURE
        )
    }

    private fun hasLocationPermission(): Boolean =
        hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun hasPermission(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun createPickerIntent(
        fileChooserParams: WebChromeClient.FileChooserParams
    ): Intent =
        runCatching { fileChooserParams.createIntent() }.getOrElse {
            Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
            }
        }.apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            if (type.isNullOrBlank()) type = "image/*"
        }

    private fun createImageCaptureIntent(
        fileChooserParams: WebChromeClient.FileChooserParams
    ): Intent? {
        if (!fileChooserAcceptsImages(fileChooserParams.acceptTypes)) return null
        if (!hasPermission(Manifest.permission.CAMERA)) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CODE_APP_PERMISSIONS)
            return null
        }

        val imageUri = createCameraImageUri() ?: return null
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, imageUri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        if (intent.resolveActivity(packageManager) == null) return null

        pendingCameraImageUri = imageUri
        return intent
    }

    private fun createCameraImageUri(): Uri? =
        runCatching {
            val capturesDir = File(cacheDir, "camera-captures").apply { mkdirs() }
            val imageFile = File.createTempFile("qr-capture-", ".jpg", capturesDir)
            FileProvider.getUriForFile(this, "$packageName.fileprovider", imageFile)
        }.getOrElse { error ->
            Log.w("WebKioskWebView", "URI foto QR non creabile: ${error.message}")
            null
        }

    private fun fileChooserAcceptsImages(acceptTypes: Array<String>): Boolean =
        acceptTypes.isEmpty() ||
            acceptTypes.any { acceptType ->
                val normalized = acceptType.trim().lowercase(Locale.ROOT)
                normalized.isBlank() ||
                    normalized == "*/*" ||
                    normalized.startsWith("image/") ||
                    normalized.contains("image")
            }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (KioskPreferences.wasBatteryOptimizationPrompted(this)) return

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return

        KioskPreferences.markBatteryOptimizationPrompted(this)
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        runCatching { startActivity(intent) }
            .onFailure {
                runCatching {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
    }
}

@Composable
private fun PalmareRoot(urlSetupRequestSignal: Int) {
    val activity = LocalContext.current as? MainActivity
    var splashVisible by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        delay(SPLASH_DURATION_MS)
        splashVisible = false
        delay(100)
        activity?.onPalmareUiReady()
    }

    if (splashVisible) {
        PalmareSplash()
    } else {
        WebKioskScreen(urlSetupRequestSignal = urlSetupRequestSignal)
    }
}

@Composable
private fun PalmareSplash() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF2F7FC)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Image(
                painter = painterResource(id = R.drawable.amalia_logo),
                contentDescription = "Palmare",
                modifier = Modifier.size(124.dp)
            )
            Text(
                text = "PALMARE",
                color = Color(0xFF172436),
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 22.dp)
            )
            Text(
                text = "Versione ${BuildConfig.VERSION_NAME}",
                color = Color(0xFF4E6278),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp)
            )
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun WebKioskScreen(urlSetupRequestSignal: Int) {
    val context = LocalContext.current

    var savedUrl by remember { mutableStateOf(resolveInitialKioskUrl(context)) }
    
    var showPinDialog by remember { mutableStateOf(savedUrl.isNullOrBlank()) }
    var showUrlDialog by remember { mutableStateOf(false) }
    var webViewInstance: WebView? by remember { mutableStateOf(null) }

    LaunchedEffect(urlSetupRequestSignal) {
        if (
            urlSetupRequestSignal > 0 &&
            !showPinDialog &&
            !showUrlDialog &&
            !savedUrl.isNullOrBlank()
        ) {
            showPinDialog = true
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val bundledWebApp = PalmareWebAppAssets(ctx)
                WebView(ctx).apply {
                    webViewInstance = this
                    (ctx as? MainActivity)?.attachWebView(this)
                    // Configurazione layout per occupare ogni pixel
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    isHapticFeedbackEnabled = false
                    isLongClickable = false
                    setOnLongClickListener { true }

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        cacheMode = WebSettings.LOAD_DEFAULT
                        mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                        mediaPlaybackRequiresUserGesture = false
                        setGeolocationEnabled(true)

                        // Fondamentale: forza la pagina web a scalare correttamente
                        useWideViewPort = true
                        loadWithOverviewMode = true

                        setSupportZoom(false)
                        builtInZoomControls = false
                        displayZoomControls = false
                    }
                    addJavascriptInterface(
                        NativeNotificationBridge(ctx.applicationContext),
                        NATIVE_NOTIFICATION_BRIDGE_NAME
                    )
                    addJavascriptInterface(
                        NativeHapticsBridge(ctx.applicationContext),
                        NATIVE_HAPTICS_BRIDGE_NAME
                    )
                    addJavascriptInterface(
                        (ctx as MainActivity).nativeNfcBridge(),
                        NativeNfcController.BRIDGE_NAME
                    )
                    addJavascriptInterface(
                        (ctx as MainActivity).nativeBatteryBridge(),
                        NativeBatteryController.BRIDGE_NAME
                    )
                    if (BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED) {
                        addJavascriptInterface(
                            NativeBluetoothCapabilityBridge(
                                context = ctx.applicationContext,
                                allowGattServerProbe =
                                    shouldAllowGattServerCapabilityProbe(
                                        diagnosticsEnabled =
                                            BuildConfig.BLUETOOTH_DIAGNOSTICS_ENABLED,
                                        labBuild = BuildConfig.BLUETOOTH_LAB_BUILD
                                    )
                            ),
                            NativeBluetoothCapabilityBridge.BRIDGE_NAME
                        )
                    }
                    if (BuildConfig.BLUETOOTH_DIAGNOSTIC_BADGE) {
                        addJavascriptInterface(
                            (ctx as MainActivity).bluetoothFailoverStateBridge(),
                            BluetoothFailoverUiBridge.BRIDGE_NAME
                        )
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) {
                            (ctx as? MainActivity)?.handleWebPermissionRequest(request) ?: request.deny()
                        }

                        override fun onPermissionRequestCanceled(request: PermissionRequest) {
                            (ctx as? MainActivity)?.handleWebPermissionRequestCanceled(request)
                        }

                        override fun onGeolocationPermissionsShowPrompt(
                            origin: String,
                            callback: GeolocationPermissions.Callback
                        ) {
                            (ctx as? MainActivity)?.handleGeolocationPermissionPrompt(origin, callback)
                                ?: callback.invoke(origin, false, false)
                        }

                        override fun onShowFileChooser(
                            webView: WebView,
                            filePathCallback: ValueCallback<Array<Uri>>,
                            fileChooserParams: FileChooserParams
                        ): Boolean =
                            (ctx as? MainActivity)?.handleFileChooser(
                                filePathCallback,
                                fileChooserParams
                            ) ?: false
                    }
                    webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(
                            view: WebView,
                            request: WebResourceRequest
                        ): WebResourceResponse? =
                            bundledWebApp.shouldIntercept(request.url, savedUrl)
                                ?: super.shouldInterceptRequest(view, request)

                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            if (!request.isForMainFrame) return false
                            val target = request.url.toString()
                            if (isSameOrigin(target, savedUrl)) return false
                            runCatching {
                                context.startActivity(
                                    Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                )
                            }.onFailure { error ->
                                Log.w("WebKioskWebView", "Navigazione esterna bloccata: $target", error)
                            }
                            return true
                        }

                        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            (context as? MainActivity)?.onWebPageNavigationStarted()
                        }

                        override fun onReceivedSslError(
                            view: WebView,
                            handler: SslErrorHandler,
                            error: SslError
                        ) {
                            if (LocalHttpsTrust.shouldAllowCertificateError(error.url, savedUrl)) {
                                Log.w("WebKioskWebView", "Certificato HTTPS locale accettato per ${error.url}")
                                handler.proceed()
                                return
                            }

                            Log.w("WebKioskWebView", "Certificato HTTPS rifiutato per ${error.url}")
                            handler.cancel()
                        }

                        override fun onPageFinished(view: WebView, url: String?) {
                            super.onPageFinished(view, url)
                            if (!url.isNullOrBlank() && url != "about:blank") {
                                val notificationContextEpoch =
                                    NativeSessionContextStore.captureUpdateEpoch()
                                view.evaluateJavascript(NOTIFICATION_CONTEXT_STORAGE_JS) { value ->
                                    (context as? MainActivity)?.let { activity ->
                                        NativeSessionContextStore.updateFromJsonIfCurrent(
                                            activity,
                                            decodeJavaScriptStringResult(value).orEmpty(),
                                            notificationContextEpoch
                                        )
                                    }
                                }
                                view.evaluateJavascript(MICROPHONE_CAPABILITY_JS) { value ->
                                    Log.i(
                                        "WebKioskMic",
                                        "capability=${decodeJavaScriptStringResult(value).orEmpty()} url=$url"
                                    )
                                }
                                (context as? MainActivity)?.installNativePageHooks(view)
                            }
                        }

                        override fun onReceivedError(
                            view: WebView,
                            request: WebResourceRequest,
                            error: WebResourceError
                        ) {
                            super.onReceivedError(view, request, error)
                            if (request.isForMainFrame) {
                                Log.w(
                                    "WebKioskWebView",
                                    "Errore main frame ${error.errorCode}: ${error.description} url=${request.url}"
                                )
                            }
                        }

                        override fun onReceivedHttpError(
                            view: WebView,
                            request: WebResourceRequest,
                            errorResponse: WebResourceResponse
                        ) {
                            super.onReceivedHttpError(view, request, errorResponse)
                            if (request.isForMainFrame && errorResponse.statusCode >= 500) {
                                Log.w(
                                    "WebKioskWebView",
                                    "Errore HTTP main frame ${errorResponse.statusCode} url=${request.url}"
                                )
                            }
                        }
                    }

                    loadUrl(savedUrl)
                }
            },
            update = { }
        )

        if (showPinDialog) {
            UrlSetupPinDialog(
                canDismiss = !savedUrl.isNullOrBlank(),
                onCancel = { showPinDialog = false },
                onUnlocked = {
                    showPinDialog = false
                    showUrlDialog = true
                }
            )
        }

        if (showUrlDialog) {
            UrlSetupDialog(
                initial = savedUrl.orEmpty(),
                canDismiss = !savedUrl.isNullOrBlank(),
                onCancel = { showUrlDialog = false },
                onSave = { url ->
                    val normalized = normalizeUrl(url)
                    KioskPreferences.saveSavedUrl(context, normalized)
                    savedUrl = normalized
                    showUrlDialog = false
                    webViewInstance?.loadUrl(normalized)
                }
            )
        }
    }
}

@Composable
private fun UrlSetupPinDialog(
    canDismiss: Boolean,
    onCancel: () -> Unit,
    onUnlocked: () -> Unit
) {
    var value by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (canDismiss) onCancel() },
        title = { Text("Accesso configurazione") },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = value,
                    onValueChange = { input ->
                        value = input.filter { it.isDigit() }.take(URL_SETUP_PIN_LENGTH)
                        error = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    isError = error != null,
                    label = { Text("PIN") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword)
                )
                if (error != null) {
                    Text(
                        text = error!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                if (value == currentUrlSetupPin()) {
                    value = ""
                    onUnlocked()
                } else {
                    error = "PIN non valido."
                }
            }) {
                Text("Sblocca")
            }
        },
        dismissButton = if (canDismiss) {
            {
                TextButton(onClick = onCancel) {
                    Text("Annulla")
                }
            }
        } else {
            null
        }
    )
}

@Composable
private fun UrlSetupDialog(
    initial: String,
    canDismiss: Boolean,
    onCancel: () -> Unit,
    onSave: (String) -> Unit
) {
    var value by remember { mutableStateOf(TextFieldValue(initial)) }
    var error by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (canDismiss) onCancel() },
        title = { Text("Configurazione Kiosk") },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "Inserisci l'indirizzo del portale LiquidWait.",
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                OutlinedTextField(
                    value = value,
                    onValueChange = {
                        value = it
                        error = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    isError = error != null,
                    label = { Text("Indirizzo URL") }
                )
                if (error != null) {
                    Text(
                        text = error!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val txt = value.text.trim()
                if (txt.isBlank()) {
                    error = "L'URL non può essere vuoto."
                    return@Button
                }
                val normalized = normalizeUrl(txt)
                if (!isProbablyUrl(normalized)) {
                    error = "URL non valido (es: google.it o 192.168.1.1)"
                    return@Button
                }
                onSave(normalized)
            }) {
                Text("Avvia Kiosk")
            }
        },
        dismissButton = if (canDismiss) {
            {
                TextButton(onClick = onCancel) {
                    Text("Annulla")
                }
            }
        } else {
            null
        }
    )
}

private fun normalizeUrl(input: String): String {
    val t = input.trim()
    val withScheme = when {
        t.startsWith("http://", ignoreCase = true) || t.startsWith("https://", ignoreCase = true) -> t
        else -> "https://$t"
    }
    return runCatching {
        val uri = URI(withScheme)
        val scheme = uri.scheme ?: return@runCatching withScheme
        val authority = uri.rawAuthority ?: return@runCatching withScheme
        val path = uri.rawPath.orEmpty()
        if (path.isBlank() || path == "/") {
            "$scheme://$authority/mobile/"
        } else {
            withScheme
        }
    }.getOrDefault(withScheme)
}

private fun isSameOrigin(candidateUrl: String?, configuredUrl: String?): Boolean {
    if (candidateUrl.isNullOrBlank() || configuredUrl.isNullOrBlank()) return false
    return runCatching {
        val candidate = URI(candidateUrl)
        val configured = URI(configuredUrl)
        val candidateScheme = candidate.scheme?.lowercase(Locale.ROOT)
        val configuredScheme = configured.scheme?.lowercase(Locale.ROOT)
        if (candidateScheme !in setOf("http", "https") || configuredScheme != candidateScheme) {
            return@runCatching false
        }
        candidate.host.equals(configured.host, ignoreCase = true) &&
            effectivePort(candidate) == effectivePort(configured)
    }.getOrDefault(false)
}

private fun effectivePort(uri: URI): Int = when {
    uri.port > 0 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    uri.scheme.equals("http", ignoreCase = true) -> 80
    else -> -1
}

private fun isProbablyUrl(url: String): Boolean {
    val lower = url.lowercase()
    val rest = lower.removePrefix("http://").removePrefix("https://")
    return rest.contains(".") || rest.startsWith("localhost") || rest.any { it.isDigit() }
}

private fun currentUrlSetupPin(): String =
    SimpleDateFormat("HHmm", Locale.getDefault()).format(Date())

private fun decodeJavaScriptStringResult(result: String?): String? {
    val raw = result?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (raw == "null" || raw == "undefined") return null
    return runCatching { JSONArray("[$raw]").optString(0) }
        .getOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
}

private fun resolveInitialKioskUrl(context: Context): String {
    val savedUrl = KioskPreferences.getSavedUrl(context)
    val resolvedUrl = resolveConfiguredKioskUrl(savedUrl, DEFAULT_SERVER_URL)
    if (savedUrl != resolvedUrl) {
        KioskPreferences.saveSavedUrl(context, resolvedUrl)
    }
    return resolvedUrl
}
