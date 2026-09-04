package com.sentrapa.webkiosk

import android.content.Context
import android.os.SystemClock
import com.sentrapa.webkiosk.notifications.NotificationHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class NativeNotificationCoordinator(
    context: Context,
    private val audioPlayer: AudioKeepAlivePlayer,
    private val isSessionActive: () -> Boolean = {
        KioskPreferences.hasAuthenticatedNotificationSession(context)
    }
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val commands = Channel<Command>(Channel.UNLIMITED)
    private val signals = Channel<Signal>(Channel.UNLIMITED)
    private val queuedSignalTones = ConcurrentHashMap.newKeySet<NotificationTone>()
    private val generation = AtomicLong(0)
    private val alertLifecycleLock = Any()
    private var commandJob: Job
    private var signalJob: Job
    private var repeatJob: Job

    init {
        commandJob = scope.launch { runCommandLoop() }
        signalJob = scope.launch { runSignalLoop() }
        repeatJob = scope.launch {
            while (isActive) {
                delay(CALL_REPEAT_INTERVAL_MS)
                commands.send(Command.RepeatActiveCalls)
            }
        }
    }

    fun submit(event: NativeNotificationEvent) {
        commands.trySend(Command.Submit(event))
    }

    fun syncSnapshot(events: List<NativeNotificationEvent>, alertNewEvents: Boolean) {
        commands.trySend(Command.SyncSnapshot(events, alertNewEvents))
    }

    fun reset() {
        invalidateActiveAlerts()
        commands.trySend(Command.Reset)
    }

    private fun invalidateActiveAlerts() {
        synchronized(alertLifecycleLock) {
            generation.incrementAndGet()
            queuedSignalTones.clear()
            audioPlayer.cancelNotificationTones()
            NotificationHelper.cancelActiveVibration(appContext)
        }
    }

    fun close() {
        reset()
        commands.close()
        signals.close()
        commandJob.cancel()
        signalJob.cancel()
        repeatJob.cancel()
        scope.cancel()
    }

    private suspend fun runCommandLoop() {
        val state = State()
        for (command in commands) {
            when (command) {
                is Command.Submit -> handleSubmit(state, command.event)
                is Command.SyncSnapshot -> handleSnapshot(
                    state,
                    command.events,
                    command.alertNewEvents
                )
                Command.Render -> renderIfReady(state)
                Command.FlushSignals -> flushSignals(state)
                Command.RepeatActiveCalls -> repeatActiveCalls(state)
                Command.Reset -> resetState(state)
            }
        }
    }

    private fun handleSubmit(state: State, event: NativeNotificationEvent) {
        if (!isSessionActive()) {
            invalidateActiveAlerts()
            resetState(state)
            return
        }
        val isNew = rememberEvent(state, event)
        if (AppForegroundState.isForeground) return

        pruneEphemeral(state, event.receivedAt)
        state.ephemeralEvents[event.identity] = event
        scheduleRender(state)
        if (isNew && shouldSignalFingerprint(state, event)) {
            queueSignals(state, listOf(event))
        }
    }

    private fun handleSnapshot(
        state: State,
        events: List<NativeNotificationEvent>,
        alertNewEvents: Boolean
    ) {
        if (!isSessionActive()) {
            invalidateActiveAlerts()
            resetState(state)
            return
        }
        if (AppForegroundState.isForeground) {
            events.forEach { rememberEvent(state, it) }
            return
        }

        val now = System.currentTimeMillis()
        pruneEphemeral(state, now)
        state.snapshotEvents.clear()
        events.forEach { state.snapshotEvents[it.identity] = it }
        events.forEach { event -> state.ephemeralEvents.remove(event.identity) }

        val newEvents = events.filter { event ->
            val isNew = rememberEvent(state, event)
            isNew && shouldSignalFingerprint(state, event)
        }
        scheduleRender(state)
        if (alertNewEvents) queueSignals(state, newEvents)
    }

    private fun renderIfReady(state: State) {
        if (!state.renderScheduled) return
        val now = SystemClock.elapsedRealtime()
        val quietRemaining = RENDER_QUIET_MS - (now - state.lastRenderMutationAt)
        val maxWaitRemaining = RENDER_MAX_WAIT_MS - (now - state.renderWindowStartedAt)
        val remaining = minOf(quietRemaining, maxWaitRemaining)
        if (remaining > 0L) {
            scheduleRenderCheck(remaining)
            return
        }
        render(state)
    }

    private fun render(state: State) {
        state.renderScheduled = false
        if (!isSessionActive()) {
            invalidateActiveAlerts()
            resetState(state)
            return
        }
        val visibleEvents = LinkedHashMap<String, NativeNotificationEvent>()
        visibleEvents.putAll(state.snapshotEvents)
        visibleEvents.putAll(state.ephemeralEvents)
        val snapshot = NativeNotificationPolicy.buildSnapshot(visibleEvents.values)
        val now = System.currentTimeMillis()
        state.lastSignalQueuedAt.keys.retainAll(snapshot.repeatTones)
        snapshot.repeatTones.forEach { tone -> state.lastSignalQueuedAt.putIfAbsent(tone, now) }
        state.repeatTones = snapshot.repeatTones
        val signature = snapshotSignature(snapshot)
        if (signature == state.lastRenderedSignature) return
        state.lastRenderedSignature = signature
        NotificationHelper.renderBackgroundSnapshot(appContext, snapshot)
    }

    private fun scheduleRender(state: State) {
        val now = SystemClock.elapsedRealtime()
        state.lastRenderMutationAt = now
        if (state.renderScheduled) return
        state.renderScheduled = true
        state.renderWindowStartedAt = now
        scheduleRenderCheck(RENDER_QUIET_MS)
    }

    private fun scheduleRenderCheck(delayMs: Long) {
        scope.launch {
            delay(delayMs.coerceAtLeast(1L))
            commands.send(Command.Render)
        }
    }

    private fun queueSignals(state: State, events: Collection<NativeNotificationEvent>) {
        val tones = NativeNotificationPolicy.alertTones(events)
        if (tones.isEmpty()) return
        state.pendingTones.addAll(tones)
        if (state.flushScheduled) return

        state.flushScheduled = true
        scope.launch {
            delay(BURST_COALESCE_MS)
            commands.send(Command.FlushSignals)
        }
    }

    private fun flushSignals(state: State) {
        state.flushScheduled = false
        if (AppForegroundState.isForeground || !isSessionActive()) {
            invalidateActiveAlerts()
            state.pendingTones.clear()
            return
        }
        val signalGeneration = generation.get()
        val now = System.currentTimeMillis()
        state.pendingTones.forEach { tone ->
            if (enqueueSignal(tone, signalGeneration)) state.lastSignalQueuedAt[tone] = now
        }
        state.pendingTones.clear()
    }

    private fun repeatActiveCalls(state: State) {
        if (AppForegroundState.isForeground || !isSessionActive()) {
            invalidateActiveAlerts()
            return
        }
        val signalGeneration = generation.get()
        val now = System.currentTimeMillis()
        state.repeatTones.forEach { tone ->
            val lastQueuedAt = state.lastSignalQueuedAt[tone] ?: 0L
            if (now - lastQueuedAt >= CALL_REPEAT_INTERVAL_MS) {
                if (enqueueSignal(tone, signalGeneration)) state.lastSignalQueuedAt[tone] = now
            }
        }
    }

    private fun enqueueSignal(tone: NotificationTone, signalGeneration: Long): Boolean {
        if (!queuedSignalTones.add(tone)) return false
        if (!signals.trySend(Signal(tone, signalGeneration)).isSuccess) {
            queuedSignalTones.remove(tone)
            return false
        }
        return true
    }

    private suspend fun runSignalLoop() {
        for (signal in signals) {
            try {
                synchronized(alertLifecycleLock) {
                    if (shouldEmitNativeAlert(signal.generation, generation.get())) {
                        NotificationHelper.vibrateForTone(appContext, signal.tone)
                        audioPlayer.playNotificationTone(signal.tone)
                    }
                }
                if (shouldEmitNativeAlert(signal.generation, generation.get())) {
                    delay(signal.tone.playbackDurationMs)
                } else {
                    synchronized(alertLifecycleLock) {
                        audioPlayer.cancelNotificationTones()
                        NotificationHelper.cancelActiveVibration(appContext)
                    }
                }
            } finally {
                queuedSignalTones.remove(signal.tone)
            }
        }
    }

    private fun resetState(state: State) {
        state.snapshotEvents.clear()
        state.ephemeralEvents.clear()
        state.pendingTones.clear()
        state.repeatTones = emptySet()
        state.lastSignalQueuedAt.clear()
        state.flushScheduled = false
        state.renderScheduled = false
        state.lastRenderedSignature = null
        queuedSignalTones.clear()
        NotificationHelper.clearDeliveredNotifications(appContext)
    }

    private fun shouldEmitNativeAlert(
        signalGeneration: Long,
        activeGeneration: Long
    ): Boolean = shouldEmitNativeAlert(
        sessionActive = isSessionActive(),
        appForeground = AppForegroundState.isForeground,
        signalGeneration = signalGeneration,
        activeGeneration = activeGeneration
    )

    private fun snapshotSignature(snapshot: NativeNotificationSnapshot): String = buildString {
        snapshot.callGroups.forEach { group ->
            append(group.tone.name).append(':')
            group.events.forEach { event ->
                append(event.identity).append('@').append(event.createdAt).append(';')
            }
            append('|')
        }
        snapshot.latestGeneral.forEach { event ->
            append(event.identity).append('@').append(event.createdAt).append(';')
        }
    }

    private fun rememberEvent(state: State, event: NativeNotificationEvent): Boolean {
        if (!state.seenIdentities.add(event.identity)) return false
        while (state.seenIdentities.size > MAX_SEEN_IDENTITIES) {
            state.seenIdentities.remove(state.seenIdentities.firstOrNull() ?: break)
        }
        return true
    }

    private fun shouldSignalFingerprint(state: State, event: NativeNotificationEvent): Boolean {
        val previous = state.recentFingerprints[event.fingerprint]
        state.recentFingerprints[event.fingerprint] = event.receivedAt
        if (event.receivedAt - state.lastFingerprintPruneAt >= MAP_PRUNE_INTERVAL_MS) {
            state.recentFingerprints.entries.removeAll { (_, seenAt) ->
                event.receivedAt - seenAt > FINGERPRINT_TTL_MS
            }
            state.lastFingerprintPruneAt = event.receivedAt
        }
        return previous == null || event.receivedAt - previous > CROSS_TRANSPORT_DEDUP_MS
    }

    private fun pruneEphemeral(state: State, now: Long) {
        if (now - state.lastEphemeralPruneAt < MAP_PRUNE_INTERVAL_MS) return
        state.ephemeralEvents.entries.removeAll { (_, event) ->
            now - event.receivedAt > EPHEMERAL_EVENT_TTL_MS
        }
        state.lastEphemeralPruneAt = now
    }

    private class State {
        val snapshotEvents = LinkedHashMap<String, NativeNotificationEvent>()
        val ephemeralEvents = LinkedHashMap<String, NativeNotificationEvent>()
        val seenIdentities = LinkedHashSet<String>()
        val recentFingerprints = LinkedHashMap<String, Long>()
        val pendingTones = LinkedHashSet<NotificationTone>()
        val lastSignalQueuedAt = LinkedHashMap<NotificationTone, Long>()
        var repeatTones: Set<NotificationTone> = emptySet()
        var flushScheduled = false
        var renderScheduled = false
        var lastRenderMutationAt = 0L
        var renderWindowStartedAt = 0L
        var lastRenderedSignature: String? = null
        var lastFingerprintPruneAt = 0L
        var lastEphemeralPruneAt = 0L
    }

    private sealed interface Command {
        data class Submit(val event: NativeNotificationEvent) : Command
        data class SyncSnapshot(
            val events: List<NativeNotificationEvent>,
            val alertNewEvents: Boolean
        ) : Command
        data object Render : Command
        data object FlushSignals : Command
        data object RepeatActiveCalls : Command
        data object Reset : Command
    }

    private data class Signal(
        val tone: NotificationTone,
        val generation: Long
    )

    private companion object {
        const val BURST_COALESCE_MS = 300L
        const val RENDER_QUIET_MS = 250L
        const val RENDER_MAX_WAIT_MS = 1_000L
        const val CALL_REPEAT_INTERVAL_MS = 5_000L
        const val CROSS_TRANSPORT_DEDUP_MS = 3_000L
        const val FINGERPRINT_TTL_MS = 60_000L
        const val EPHEMERAL_EVENT_TTL_MS = 60_000L
        const val MAP_PRUNE_INTERVAL_MS = 5_000L
        const val MAX_SEEN_IDENTITIES = 2_000
    }
}

internal fun shouldEmitNativeAlert(
    sessionActive: Boolean,
    appForeground: Boolean,
    signalGeneration: Long,
    activeGeneration: Long
): Boolean =
    sessionActive &&
        !appForeground &&
        signalGeneration == activeGeneration
