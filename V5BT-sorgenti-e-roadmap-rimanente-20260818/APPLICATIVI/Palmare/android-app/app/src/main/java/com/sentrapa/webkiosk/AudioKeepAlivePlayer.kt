package com.sentrapa.webkiosk

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

class AudioKeepAlivePlayer(context: Context) {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val playbackGeneration = AtomicLong(0)
    private var keepAliveJob: Job? = null
    @Volatile
    private var audioTrack: AudioTrack? = null
    private var focusRequest: AudioFocusRequest? = null
    private val pendingToneSamples = ConcurrentLinkedQueue<IntArray>()
    private var activeToneSamples: IntArray? = null
    private var activeToneIndex = 0
    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    @Synchronized
    fun start() {
        if (!hasAuthenticatedSession()) {
            cancelNotificationTones()
            return
        }
        if (keepAliveJob?.isActive == true) return
        val generation = playbackGeneration.get()
        requestAudioFocus()
        keepAliveJob = scope.launch {
            try {
                runAudioLoop(generation)
            } finally {
                synchronized(this@AudioKeepAlivePlayer) {
                    if (playbackGeneration.get() == generation) {
                        abandonAudioFocus()
                        keepAliveJob = null
                    }
                }
            }
        }
    }

    fun stop() {
        cancelNotificationTones()
        scope.cancel()
    }

    fun cancelNotificationTones() {
        val track = synchronized(this) {
            playbackGeneration.incrementAndGet()
            pendingToneSamples.clear()
            activeToneSamples = null
            activeToneIndex = 0
            keepAliveJob?.cancel()
            keepAliveJob = null
            audioTrack.also { audioTrack = null }
        }
        releaseTrack(track)
        abandonAudioFocus()
    }

    private fun runAudioLoop(generation: Long) {
        if (!hasAuthenticatedSession()) return
        val track = createTrack() ?: return
        val accepted = synchronized(this) {
            if (
                playbackGeneration.get() != generation ||
                !hasAuthenticatedSession()
            ) {
                false
            } else {
                audioTrack = track
                true
            }
        }
        if (!accepted) {
            releaseTrack(track)
            return
        }
        val buffer = ByteArray(BUFFER_SAMPLE_COUNT * BYTES_PER_SAMPLE)
        var idleBufferCount = 0

        try {
            if (!hasAuthenticatedSession()) return
            track.play()
            while (keepAliveJob?.isActive == true && scope.coroutineContext.isActive) {
                if (
                    playbackGeneration.get() != generation ||
                    !hasAuthenticatedSession()
                ) break
                val wroteTone = fillNextBuffer(buffer)
                if (!hasAuthenticatedSession()) break
                val written = track.write(buffer, 0, buffer.size)
                if (written < 0) {
                    Log.e(TAG, "AudioTrack write failed: $written")
                    break
                }
                idleBufferCount = if (wroteTone) 0 else idleBufferCount + 1
                if (idleBufferCount >= IDLE_STOP_SILENT_BUFFERS) break
            }
        } catch (error: RuntimeException) {
            Log.e(TAG, "Audio keep-alive loop failed: ${error.message}")
        } finally {
            stopTrack(track)
        }
    }

    fun playNotificationTone(tone: NotificationTone) {
        if (!hasAuthenticatedSession()) {
            cancelNotificationTones()
            return
        }
        pendingToneSamples.offer(renderTone(tone))
        if (!hasAuthenticatedSession()) {
            cancelNotificationTones()
            return
        }
        start()
    }

    private fun createTrack(): AudioTrack? {
        val minBufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBufferSize <= 0) return null

        val bufferSize = maxOf(minBufferSize, SAMPLE_RATE_HZ / 2)
        return try {
            AudioTrack.Builder()
                .setAudioAttributes(audioAttributes)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (error: RuntimeException) {
            Log.e(TAG, "Unable to create AudioTrack: ${error.message}")
            null
        }
    }

    private fun fillNextBuffer(buffer: ByteArray): Boolean {
        val sampleCount = buffer.size / BYTES_PER_SAMPLE
        var wroteTone = false

        for (sampleIndex in 0 until sampleCount) {
            val next = nextToneSample()
            if (next != null) wroteTone = true
            val value = next ?: 0
            writePcm16(buffer, sampleIndex, value)
        }
        return wroteTone
    }

    @Synchronized
    private fun nextToneSample(): Int? {
        while (activeToneSamples == null || activeToneIndex >= activeToneSamples!!.size) {
            val next = pendingToneSamples.poll() ?: run {
                activeToneSamples = null
                activeToneIndex = 0
                return null
            }
            activeToneSamples = next
            activeToneIndex = 0
        }

        val samples = activeToneSamples ?: return null
        return samples[activeToneIndex++]
    }

    private fun renderTone(tone: NotificationTone): IntArray {
        val samples = when (tone) {
            NotificationTone.WAITER -> renderPattern(
                segments = listOf(
                    ToneSegment(1568, 110),
                    ToneSegment(2093, 130),
                    ToneSegment(1760, 160)
                ),
                wave = Wave.TRIANGLE,
                amplitude = 18_000
            )

            NotificationTone.BELL -> renderPattern(
                segments = listOf(
                    ToneSegment(1318, 100),
                    ToneSegment(1760, 110),
                    ToneSegment(2349, 130),
                    ToneSegment(1760, 130)
                ),
                wave = Wave.TRIANGLE,
                amplitude = 20_000
            )

            NotificationTone.GENERAL -> renderPattern(
                segments = listOf(
                    ToneSegment(1760, 80),
                    ToneSegment(2637, 110)
                ),
                wave = Wave.SINE,
                amplitude = 15_500
            )

            NotificationTone.HANDHELD_RING -> renderHandheldRing()
        }
        return samples + IntArray(msToSamples(INTER_TONE_GAP_MS))
    }

    private fun renderHandheldRing(): IntArray {
        val first = renderPattern(
            segments = listOf(
                ToneSegment(988, 100),
                ToneSegment(1976, 120),
                ToneSegment(988, 100),
                ToneSegment(1976, 120),
                ToneSegment(1318, 160)
            ),
            wave = Wave.SQUARE,
            amplitude = 23_500
        )
        val second = renderPattern(
            segments = listOf(
                ToneSegment(1175, 100),
                ToneSegment(2349, 120),
                ToneSegment(1175, 100),
                ToneSegment(2349, 120),
                ToneSegment(1568, 160)
            ),
            wave = Wave.SQUARE,
            amplitude = 23_500
        )
        val delaySamples = maxOf(0, msToSamples(HANDHELD_SECOND_SEQUENCE_DELAY_MS) - first.size)
        return first + IntArray(delaySamples) + second
    }

    private fun renderPattern(
        segments: List<ToneSegment>,
        wave: Wave,
        amplitude: Int
    ): IntArray {
        val values = ArrayList<Int>()
        segments.forEachIndexed { index, segment ->
            repeat(msToSamples(segment.durationMs)) { sampleIndex ->
                values.add(sampleFor(wave, segment.frequencyHz, sampleIndex, amplitude))
            }
            if (index < segments.lastIndex) {
                repeat(msToSamples(TONE_GAP_MS)) {
                    values.add(0)
                }
            }
        }
        return values.toIntArray()
    }

    private fun sampleFor(wave: Wave, frequencyHz: Int, sampleIndex: Int, amplitude: Int): Int {
        val phase = (sampleIndex.toDouble() * frequencyHz / SAMPLE_RATE_HZ) % 1.0
        val normalized = when (wave) {
            Wave.SINE -> sin(phase * 2.0 * PI)
            Wave.SQUARE -> if (phase < 0.5) 1.0 else -1.0
            Wave.TRIANGLE -> 2.0 * abs(2.0 * phase - 1.0) - 1.0
        }
        return (normalized * amplitude).roundToInt()
    }

    private fun msToSamples(ms: Int): Int =
        SAMPLE_RATE_HZ * ms / 1000

    private fun writePcm16(buffer: ByteArray, sampleIndex: Int, value: Int) {
        val offset = sampleIndex * BYTES_PER_SAMPLE
        buffer[offset] = (value and 0xff).toByte()
        buffer[offset + 1] = ((value shr 8) and 0xff).toByte()
    }

    private fun stopTrack(expectedTrack: AudioTrack) {
        val shouldRelease = synchronized(this) {
            if (audioTrack !== expectedTrack) {
                false
            } else {
                audioTrack = null
                true
            }
        }
        if (shouldRelease) releaseTrack(expectedTrack)
    }

    private fun releaseTrack(track: AudioTrack?) {
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            runCatching { it.stop() }
            runCatching { it.release() }
        }
    }

    private fun hasAuthenticatedSession(): Boolean =
        KioskPreferences.hasAuthenticatedNotificationSession(appContext)

    @Suppress("DEPRECATION")
    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(audioAttributes)
                .setAcceptsDelayedFocusGain(false)
                .setWillPauseWhenDucked(false)
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            audioManager.requestAudioFocus(
                null,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            audioManager.abandonAudioFocus(null)
        }
    }

    companion object {
        private const val TAG = "AudioKeepAlivePlayer"
        private const val SAMPLE_RATE_HZ = 8_000
        private const val BYTES_PER_SAMPLE = 2
        private const val BUFFER_SAMPLE_COUNT = SAMPLE_RATE_HZ / 10
        private const val IDLE_STOP_SILENT_BUFFERS = 3
        private const val TONE_GAP_MS = 60
        private const val INTER_TONE_GAP_MS = 40
        private const val HANDHELD_SECOND_SEQUENCE_DELAY_MS = 880
    }
}

private enum class Wave {
    SINE,
    SQUARE,
    TRIANGLE
}

private data class ToneSegment(
    val frequencyHz: Int,
    val durationMs: Int
)
