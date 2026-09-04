package com.sentrapa.webkiosk

import android.app.Activity
import android.content.Intent
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

class NativeNfcController(
    private val activity: Activity,
    private val dispatchPayload: (String) -> Unit
) {
    private val adapter: NfcAdapter? by lazy { NfcAdapter.getDefaultAdapter(activity) }
    private val requestedSessions = LinkedHashSet<String>()
    private val readSequence = AtomicLong(0)
    private var activityResumed = false
    private var readerEnabled = false
    private var closed = false
    private var lastFingerprint = ""
    private var lastReadElapsedAt = 0L

    val bridge = NativeNfcBridge(this)

    fun isAvailable(): Boolean = adapter != null

    fun isHardwareEnabled(): Boolean = adapter?.isEnabled == true

    @Synchronized
    fun startSession(sessionId: String?): Boolean {
        if (closed || adapter == null) return false
        requestedSessions.add(normalizeSessionId(sessionId))
        scheduleReaderStateSync()
        return true
    }

    @Synchronized
    fun stopSession(sessionId: String?): Boolean {
        requestedSessions.remove(normalizeSessionId(sessionId))
        scheduleReaderStateSync()
        return true
    }

    @Synchronized
    fun onPageNavigationStarted() {
        requestedSessions.clear()
        scheduleReaderStateSync()
    }

    @Synchronized
    fun onResume() {
        activityResumed = true
        scheduleReaderStateSync()
    }

    @Synchronized
    fun onPause() {
        activityResumed = false
        scheduleReaderStateSync()
    }

    fun handleIntent(intent: Intent?) {
        val tag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(NfcAdapter.EXTRA_TAG)
        }
        if (tag != null) handleTag(tag)
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        activityResumed = false
        requestedSessions.clear()
        scheduleReaderStateSync()
    }

    fun installWebLifecycleHook(webView: WebView) {
        webView.evaluateJavascript(WEB_SESSION_HOOK_JS, null)
    }

    @Synchronized
    private fun scheduleReaderStateSync() {
        activity.runOnUiThread { applyReaderState() }
    }

    @Synchronized
    private fun applyReaderState() {
        val nfcAdapter = adapter
        val shouldEnable =
            !closed && activityResumed && requestedSessions.isNotEmpty() && nfcAdapter?.isEnabled == true
        if (shouldEnable == readerEnabled) return

        if (shouldEnable && nfcAdapter != null) {
            val flags =
                NfcAdapter.FLAG_READER_NFC_A or
                    NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_NFC_F or
                    NfcAdapter.FLAG_READER_NFC_V or
                    NfcAdapter.FLAG_READER_NFC_BARCODE
            runCatching {
                nfcAdapter.enableReaderMode(activity, ::handleTag, flags, null)
                readerEnabled = true
            }.onFailure { error ->
                readerEnabled = false
                Log.w(TAG, "NFC reader mode non attivabile", error)
            }
            return
        }

        if (nfcAdapter != null && readerEnabled) {
            runCatching { nfcAdapter.disableReaderMode(activity) }
                .onFailure { error -> Log.w(TAG, "NFC reader mode non disattivabile", error) }
        }
        readerEnabled = false
    }

    private fun handleTag(tag: Tag) {
        if (!isReadAllowed()) return
        val tagId = tag.id?.toHexString().orEmpty()
        val records = readNfcRecords(tag)
        val token = records.firstOrNull { it.isNotBlank() } ?: tagId
        if (token.isBlank()) return

        val nowElapsed = SystemClock.elapsedRealtime()
        val fingerprint = "$tagId|$token"
        synchronized(this) {
            if (
                fingerprint == lastFingerprint &&
                nowElapsed - lastReadElapsedAt < SAME_TAG_DEBOUNCE_MS
            ) {
                return
            }
            lastFingerprint = fingerprint
            lastReadElapsedAt = nowElapsed
        }

        val readAt = System.currentTimeMillis()
        val devicePart = KioskPreferences.getNotificationClientContext(activity)
            .deviceUuid
            .ifBlank { "device" }
        val readId = "$devicePart:$readAt:${readSequence.incrementAndGet()}"
        val payload = JSONObject()
            .put("source", "android-nfc")
            .put("readId", readId)
            .put("token", token)
            .put("id", tagId)
            .put("raw", JSONArray(records))
            .put("at", readAt)
            .toString()
        dispatchPayload(payload)
    }

    @Synchronized
    private fun isReadAllowed(): Boolean =
        !closed && activityResumed && readerEnabled && requestedSessions.isNotEmpty()

    private fun readNfcRecords(tag: Tag): List<String> {
        val ndef = Ndef.get(tag) ?: return emptyList()
        return try {
            ndef.connect()
            val message = ndef.ndefMessage ?: ndef.cachedNdefMessage
            message?.records
                ?.mapNotNull(::decodeNdefRecord)
                ?.map(::sanitizeRecord)
                ?.filter(String::isNotBlank)
                .orEmpty()
        } catch (error: Exception) {
            Log.w(TAG, "Tag NFC letto senza payload NDEF utilizzabile", error)
            emptyList()
        } finally {
            runCatching { ndef.close() }
        }
    }

    private fun decodeNdefRecord(record: NdefRecord): String? {
        if (record.payload.isEmpty()) return null
        return when {
            record.tnf == NdefRecord.TNF_WELL_KNOWN &&
                record.type.contentEquals(NdefRecord.RTD_TEXT) -> decodeTextRecord(record.payload)
            record.tnf == NdefRecord.TNF_WELL_KNOWN &&
                record.type.contentEquals(NdefRecord.RTD_URI) -> decodeUriRecord(record.payload)
            else -> record.payload.toString(Charsets.UTF_8)
        }
    }

    private fun decodeTextRecord(payload: ByteArray): String? {
        if (payload.isEmpty()) return null
        val status = payload[0].toInt() and 0xff
        val languageLength = status and 0x3f
        val textStart = 1 + languageLength
        if (textStart >= payload.size) return null
        val charset = if ((status and 0x80) == 0) Charsets.UTF_8 else Charsets.UTF_16
        return String(payload, textStart, payload.size - textStart, charset)
    }

    private fun decodeUriRecord(payload: ByteArray): String? {
        if (payload.isEmpty()) return null
        val prefixIndex = payload[0].toInt() and 0xff
        val prefix = URI_PREFIXES.getOrElse(prefixIndex) { "" }
        return prefix + String(payload, 1, payload.size - 1, Charsets.UTF_8)
    }

    private fun sanitizeRecord(value: String): String =
        value.replace("\u0000", "").trim().take(MAX_TOKEN_LENGTH)

    private fun normalizeSessionId(sessionId: String?): String =
        sessionId.orEmpty().trim().take(MAX_SESSION_ID_LENGTH).ifBlank { "web" }

    companion object {
        private const val TAG = "WebKioskNfc"
        private const val SAME_TAG_DEBOUNCE_MS = 1_500L
        private const val MAX_TOKEN_LENGTH = 2_048
        private const val MAX_SESSION_ID_LENGTH = 120

        const val BRIDGE_NAME = "AmaliaNativeNfc"

        private val URI_PREFIXES = arrayOf(
            "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
            "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://",
            "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://",
            "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
            "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:",
            "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"
        )

        private val WEB_SESSION_HOOK_JS = """
            (function(){
              try {
                if (window.__amaliaNativeNfcSessionHook === 1) return;
                var bridge = window.AmaliaNativeNfc;
                if (!bridge || typeof bridge.startSession !== 'function') return;
                var sessionId = 'web_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
                var listeners = new Set();
                var originalAdd = window.addEventListener;
                var originalRemove = window.removeEventListener;
                function sync(){
                  if (listeners.size > 0) bridge.startSession(sessionId);
                  else bridge.stopSession(sessionId);
                }
                window.addEventListener = function(type, listener, options){
                  var result = originalAdd.call(this, type, listener, options);
                  if (this === window && type === 'native:nfc' && listener) {
                    listeners.add(listener);
                    sync();
                  }
                  return result;
                };
                window.removeEventListener = function(type, listener, options){
                  var result = originalRemove.call(this, type, listener, options);
                  if (this === window && type === 'native:nfc' && listener) {
                    listeners.delete(listener);
                    sync();
                  }
                  return result;
                };
                originalAdd.call(window, 'pagehide', function(){
                  listeners.clear();
                  bridge.stopSession(sessionId);
                }, { once: true });
                window.__amaliaNativeNfcSessionHook = 1;
              } catch (error) {
                console.warn('Amalia NFC lifecycle hook failed', error);
              }
            })();
        """.trimIndent()
    }
}

class NativeNfcBridge(private val controller: NativeNfcController) {
    @JavascriptInterface
    fun isAvailable(): Boolean = controller.isAvailable()

    @JavascriptInterface
    fun isEnabled(): Boolean = controller.isHardwareEnabled()

    @JavascriptInterface
    fun startSession(sessionId: String?): Boolean = controller.startSession(sessionId)

    @JavascriptInterface
    fun stopSession(sessionId: String?): Boolean = controller.stopSession(sessionId)
}

private fun ByteArray.toHexString(): String =
    joinToString(separator = "") { byte -> "%02X".format(byte) }
