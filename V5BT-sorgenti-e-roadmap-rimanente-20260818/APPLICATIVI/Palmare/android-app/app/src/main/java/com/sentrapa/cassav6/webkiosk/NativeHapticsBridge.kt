package com.sentrapa.cassav6.webkiosk

import android.content.Context
import android.os.Build
import android.os.CombinedVibration
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.annotation.RequiresApi

class NativeHapticsBridge(context: Context) {
    private val appContext = context.applicationContext

    @JavascriptInterface
    fun isAvailable(): Boolean = resolveDefaultVibrator().hasVibrator()

    @JavascriptInterface
    fun pulse(durationMs: Int): Boolean =
        vibrateOneShot(durationMs.coerceIn(MIN_PULSE_MS, MAX_PULSE_MS).toLong())

    @JavascriptInterface
    fun pattern(patternCsv: String?): Boolean {
        val pattern = patternCsv
            ?.split(",")
            ?.mapNotNull { part -> part.trim().toLongOrNull() }
            ?.map { value -> value.coerceIn(0L, MAX_PATTERN_SEGMENT_MS) }
            ?.take(MAX_PATTERN_SEGMENTS)
            ?.takeIf { it.isNotEmpty() }
            ?.toLongArray()
            ?: return false
        return vibratePattern(pattern)
    }

    private fun vibrateOneShot(durationMs: Long): Boolean = runCatching {
        val vibrator = resolveDefaultVibrator()
        if (!vibrator.hasVibrator()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrateEffect(
                VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
            )
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(durationMs)
        }
        true
    }.getOrElse { error ->
        Log.w(TAG, "Unable to run native haptic pulse: ${error.message}")
        false
    }

    private fun vibratePattern(pattern: LongArray): Boolean = runCatching {
        val vibrator = resolveDefaultVibrator()
        if (!vibrator.hasVibrator()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrateEffect(VibrationEffect.createWaveform(pattern, amplitudesFor(pattern), -1))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(longArrayOf(0L) + pattern, -1)
        }
        true
    }.getOrElse { error ->
        Log.w(TAG, "Unable to run native haptic feedback: ${error.message}")
        false
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun vibrateEffect(effect: VibrationEffect) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            resolveVibratorManager().vibrate(CombinedVibration.createParallel(effect))
        } else {
            resolveDefaultVibrator().vibrate(effect)
        }
    }

    private fun resolveDefaultVibrator(): Vibrator =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            resolveVibratorManager().defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            appContext.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun resolveVibratorManager(): VibratorManager =
        appContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager

    @RequiresApi(Build.VERSION_CODES.O)
    private fun amplitudesFor(pattern: LongArray): IntArray =
        pattern.mapIndexed { index, duration ->
            if (duration <= 0L || index % 2 != 0) 0 else VibrationEffect.DEFAULT_AMPLITUDE
        }.toIntArray()

    private companion object {
        const val TAG = "NativeHapticsBridge"
        const val MIN_PULSE_MS = 16
        const val MAX_PULSE_MS = 250
        const val MAX_PATTERN_SEGMENT_MS = 1_500L
        const val MAX_PATTERN_SEGMENTS = 24
    }
}
