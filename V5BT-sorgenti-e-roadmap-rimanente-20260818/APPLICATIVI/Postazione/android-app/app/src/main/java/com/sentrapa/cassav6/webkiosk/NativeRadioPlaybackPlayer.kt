package com.sentrapa.cassav6.webkiosk

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Process
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt

class NativeRadioPlaybackPlayer(context: Context) {
    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val queue = ArrayBlockingQueue<ByteArray>(MAX_QUEUED_FRAMES)
    private var job: Job? = null
    private var audioTrack: AudioTrack? = null
    private var focusRequest: AudioFocusRequest? = null

    @Volatile
    private var stopRequested = false

    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    @Synchronized
    fun playFrame(frame: ByteArray) {
        val payload = radioPayload(frame) ?: return
        val pcm = decodeMuLawPayload(payload)
        if (queue.remainingCapacity() <= BACKPRESSURE_TRIM_THRESHOLD_FRAMES) {
            while (queue.size > LIVE_QUEUE_TARGET_FRAMES) queue.poll()
        }
        while (queue.size >= MAX_QUEUED_FRAMES) queue.poll()
        while (!queue.offer(pcm)) queue.poll()
        start()
    }

    @Synchronized
    fun stop() {
        stopRequested = true
        job?.cancel()
        queue.clear()
    }

    fun close() {
        stop()
        scope.cancel()
    }

    @Synchronized
    private fun start() {
        if (job != null) return
        stopRequested = false
        requestAudioFocus()
        job = scope.launch { runLoop() }
    }

    private fun runLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        val track = createTrack()
        if (track == null) {
            abandonAudioFocus()
            synchronized(this) { job = null }
            return
        }
        audioTrack = track
        var missingFrames = 0
        var consecutiveMissingFrames = 0
        var writtenFrames = 0
        try {
            waitForInitialBuffer()
            writtenFrames += prebufferTrack(track)
            track.play()
            while (!stopRequested && scope.coroutineContext.isActive) {
                val next = queue.poll(JITTER_WAIT_MS, TimeUnit.MILLISECONDS)
                if (stopRequested) break
                if (next == null) {
                    missingFrames += 1
                    consecutiveMissingFrames += 1
                    if (consecutiveMissingFrames > MAX_CONSECUTIVE_GAP_FRAMES) break
                } else {
                    consecutiveMissingFrames = 0
                }
                val frame = next ?: SILENCE_FRAME
                val written = track.write(frame, 0, frame.size, AudioTrack.WRITE_BLOCKING)
                if (written < 0) {
                    Log.w(TAG, "Radio AudioTrack write failed: $written")
                    break
                }
                writtenFrames += 1
            }
        } catch (error: RuntimeException) {
            Log.w(TAG, "Native radio playback failed: ${error.message}")
        } finally {
            logPlaybackStats(track, writtenFrames, missingFrames)
            stopTrack()
            abandonAudioFocus()
            synchronized(this) {
                job = null
                stopRequested = false
            }
        }
    }

    private fun prebufferTrack(track: AudioTrack): Int {
        var writtenFrames = 0
        while (
            writtenFrames < START_QUEUE_FRAMES &&
            !stopRequested &&
            scope.coroutineContext.isActive
        ) {
            val next = queue.poll() ?: break
            val written = track.write(next, 0, next.size, AudioTrack.WRITE_BLOCKING)
            if (written < 0) {
                Log.w(TAG, "Radio AudioTrack prebuffer write failed: $written")
                break
            }
            writtenFrames += 1
        }
        return writtenFrames
    }

    private fun waitForInitialBuffer() {
        val startedAt = System.currentTimeMillis()
        while (
            job?.isActive == true &&
            scope.coroutineContext.isActive &&
            queue.size < START_QUEUE_FRAMES &&
            System.currentTimeMillis() - startedAt < START_BUFFER_TIMEOUT_MS
        ) {
            Thread.sleep(START_BUFFER_WAIT_MS)
        }
    }

    private fun createTrack(): AudioTrack? {
        val minBufferSize = AudioTrack.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBufferSize <= 0) return null
        val bufferSize = maxOf(
            minBufferSize,
            SAMPLE_RATE_HZ * AUDIO_TRACK_BUFFER_MS / 1000 * BYTES_PER_SAMPLE
        )
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
            Log.w(TAG, "Unable to create native radio AudioTrack: ${error.message}")
            null
        }
    }

    private fun logPlaybackStats(track: AudioTrack, writtenFrames: Int, missingFrames: Int) {
        if (writtenFrames <= 0 && missingFrames <= 0) return
        val underruns = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { track.underrunCount }.getOrDefault(-1)
        } else {
            -1
        }
        Log.i(TAG, "Radio playback stopped frames=$writtenFrames gaps=$missingFrames underruns=$underruns")
    }

    private fun stopTrack() {
        audioTrack?.let { track ->
            runCatching { track.stop() }
            track.release()
        }
        audioTrack = null
    }

    @Suppress("DEPRECATION")
    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
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
                AudioManager.AUDIOFOCUS_GAIN
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

    private fun radioPayload(frame: ByteArray): ByteArray? {
        if (frame.size <= RADIO_FRAME_HEADER_BYTES) return null
        if (
            frame[0].toInt().toChar() != 'R' ||
            frame[1].toInt().toChar() != 'P' ||
            frame[2].toInt().toChar() != 'T' ||
            frame[3].toInt().toChar() != '1'
        ) {
            return null
        }
        return frame.copyOfRange(RADIO_FRAME_HEADER_BYTES, frame.size)
    }

    private fun decodeMuLawPayload(payload: ByteArray): ByteArray {
        val output = ByteArray(payload.size * BYTES_PER_SAMPLE)
        payload.forEachIndexed { index, byte ->
            val sample = decodeMuLawSample(byte.toInt() and 0xff)
            val offset = index * BYTES_PER_SAMPLE
            val softened = (sample * OUTPUT_GAIN).roundToInt().coerceIn(PCM_16_MIN, PCM_16_MAX)
            output[offset] = (softened and 0xff).toByte()
            output[offset + 1] = ((softened shr 8) and 0xff).toByte()
        }
        return output
    }

    private fun decodeMuLawSample(byte: Int): Int {
        val value = byte.inv() and 0xff
        val sign = if ((value and 0x80) != 0) -1 else 1
        val quantized = value and 0x7f
        val magnitude = (exp((quantized / 127.0) * MU_LAW_MAX_MAGNITUDE) - 1.0) / MU_LAW_MU
        return (sign * magnitude * PCM_16_MAX).roundToInt().coerceIn(PCM_16_MIN, PCM_16_MAX)
    }

    private companion object {
        const val TAG = "NativeRadioPlayback"
        const val SAMPLE_RATE_HZ = 16_000
        const val BYTES_PER_SAMPLE = 2
        const val FRAME_MS = 20
        const val AUDIO_TRACK_BUFFER_MS = 480
        const val RADIO_FRAME_HEADER_BYTES = 16
        const val MAX_QUEUED_FRAMES = 28
        const val LIVE_QUEUE_TARGET_FRAMES = 8
        const val START_QUEUE_FRAMES = 12
        const val BACKPRESSURE_TRIM_THRESHOLD_FRAMES = 2
        const val JITTER_WAIT_MS = 120L
        const val START_BUFFER_WAIT_MS = 8L
        const val START_BUFFER_TIMEOUT_MS = 360L
        const val MAX_CONSECUTIVE_GAP_FRAMES = 12
        const val OUTPUT_GAIN = 0.82
        const val MU_LAW_MU = 255.0
        val MU_LAW_MAX_MAGNITUDE = ln(1.0 + MU_LAW_MU)
        const val PCM_16_MIN = -32768
        const val PCM_16_MAX = 32767
        val SILENCE_FRAME = ByteArray(SAMPLE_RATE_HZ * FRAME_MS / 1000 * BYTES_PER_SAMPLE)
    }
}
