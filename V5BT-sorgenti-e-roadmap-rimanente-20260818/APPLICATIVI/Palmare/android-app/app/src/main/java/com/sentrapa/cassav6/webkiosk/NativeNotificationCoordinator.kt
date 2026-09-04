package com.sentrapa.cassav6.webkiosk

import android.content.Context
import android.os.SystemClock
import com.sentrapa.cassav6.webkiosk.notifications.NotificationHelper
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
    private val currentSessionBindingKey: () -> String = {
        KioskPreferences.getNotificationClientContext(context).sessionBindingKey
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
                synchronized(alertLifecycleLock) {
                    val bindingKey = currentSessionBindingKey().trim()
                    if (bindingKey.isNotEmpty()) {
                        commands.trySend(
                            Command.RepeatActiveCalls(generation.get(), bindingKey)
                        )
                    }
                }
            }
        }
    }

    fun submit(event: NativeNotificationEvent) {
        synchronized(alertLifecycleLock) {
            commands.trySend(
                Command.Submit(event, generation.get(), event.sessionBindingKey)
            )
        }
    }

    fun syncSnapshot(
        events: List<NativeNotificationEvent>,
        alertNewEvents: Boolean,
        sessionBindingKey: String
    ) {
        synchronized(alertLifecycleLock) {
            commands.trySend(
                Command.SyncSnapshot(
                    events,
                    alertNewEvents,
                    generation.get(),
                    sessionBindingKey
                )
            )
        }
    }

    fun reset() {
        val resetGeneration: Long
        synchronized(alertLifecycleLock) {
            resetGeneration = generation.incrementAndGet()
            queuedSignalTones.clear()
            audioPlayer.cancelNotificationTones()
            NotificationHelper.cancelActiveVibration(appContext)
            commands.trySend(Command.Reset(resetGeneration))
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
            if (command is Command.Reset) {
                if (command.generation == generation.get()) resetState(state)
                continue
            }
            if (
                !shouldProcessNativeNotificationCommand(
                    commandGeneration = command.generation,
                    activeGeneration = generation.get(),
                    commandSessionBindingKey = command.sessionBindingKey,
                    activeSessionBindingKey = currentSessionBindingKey()
                )
            ) {
                continue
            }
            prepareStateForBinding(state, command.sessionBindingKey)
            when (command) {
                is Command.Submit -> handleSubmit(
                    state,
                    command.event,
                    command.generation,
                    command.sessionBindingKey
                )
                is Command.SyncSnapshot -> handleSnapshot(
                    state,
                    command.events,
                    command.alertNewEvents,
                    command.generation,
                    command.sessionBindingKey
                )
                is Command.Render -> renderIfReady(
                    state,
                    command.generation,
                    command.sessionBindingKey
                )
                is Command.FlushSignals -> flushSignals(
                    state,
                    command.generation,
                    command.sessionBindingKey
                )
                is Command.RepeatActiveCalls -> repeatActiveCalls(
                    state,
                    command.generation,
                    command.sessionBindingKey
                )
                is Command.Reset -> Unit
            }
        }
    }

    private fun handleSubmit(
        state: State,
        event: NativeNotificationEvent,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        val isNew = rememberEvent(state, event)
        if (AppForegroundState.isForeground) return

        pruneEphemeral(state, event.receivedAt)
        state.ephemeralEvents[event.identity] = event
        scheduleRender(state, commandGeneration, sessionBindingKey)
        if (isNew && shouldSignalFingerprint(state, event)) {
            queueSignals(state, listOf(event), commandGeneration, sessionBindingKey)
        }
    }

    private fun handleSnapshot(
        state: State,
        events: List<NativeNotificationEvent>,
        alertNewEvents: Boolean,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        val boundEvents = events.filter { event ->
            event.sessionBindingKey == sessionBindingKey
        }
        if (AppForegroundState.isForeground) {
            boundEvents.forEach { rememberEvent(state, it) }
            return
        }

        val now = System.currentTimeMillis()
        pruneEphemeral(state, now)
        state.snapshotEvents.clear()
        boundEvents.forEach { state.snapshotEvents[it.identity] = it }
        boundEvents.forEach { event -> state.ephemeralEvents.remove(event.identity) }

        val newEvents = boundEvents.filter { event ->
            val isNew = rememberEvent(state, event)
            isNew && shouldSignalFingerprint(state, event)
        }
        scheduleRender(state, commandGeneration, sessionBindingKey)
        if (alertNewEvents) {
            queueSignals(state, newEvents, commandGeneration, sessionBindingKey)
        }
    }

    private fun renderIfReady(
        state: State,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        if (!state.renderScheduled) return
        val now = SystemClock.elapsedRealtime()
        val quietRemaining = RENDER_QUIET_MS - (now - state.lastRenderMutationAt)
        val maxWaitRemaining = RENDER_MAX_WAIT_MS - (now - state.renderWindowStartedAt)
        val remaining = minOf(quietRemaining, maxWaitRemaining)
        if (remaining > 0L) {
            scheduleRenderCheck(remaining, commandGeneration, sessionBindingKey)
            return
        }
        render(state, sessionBindingKey)
    }

    private fun render(state: State, sessionBindingKey: String) {
        state.renderScheduled = false
        if (currentSessionBindingKey() != sessionBindingKey) {
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

    private fun scheduleRender(
        state: State,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        val now = SystemClock.elapsedRealtime()
        state.lastRenderMutationAt = now
        if (state.renderScheduled) return
        state.renderScheduled = true
        state.renderWindowStartedAt = now
        scheduleRenderCheck(RENDER_QUIET_MS, commandGeneration, sessionBindingKey)
    }

    private fun scheduleRenderCheck(
        delayMs: Long,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        scope.launch {
            delay(delayMs.coerceAtLeast(1L))
            commands.trySend(Command.Render(commandGeneration, sessionBindingKey))
        }
    }

    private fun queueSignals(
        state: State,
        events: Collection<NativeNotificationEvent>,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        val tones = NativeNotificationPolicy.alertTones(events)
        if (tones.isEmpty()) return
        state.pendingTones.addAll(tones)
        if (state.flushScheduled) return

        state.flushScheduled = true
        scope.launch {
            delay(BURST_COALESCE_MS)
            commands.trySend(Command.FlushSignals(commandGeneration, sessionBindingKey))
        }
    }

    private fun flushSignals(
        state: State,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        state.flushScheduled = false
        if (
            AppForegroundState.isForeground ||
            currentSessionBindingKey() != sessionBindingKey
        ) {
            state.pendingTones.clear()
            return
        }
        val now = System.currentTimeMillis()
        state.pendingTones.forEach { tone ->
            if (enqueueSignal(tone, commandGeneration, sessionBindingKey)) {
                state.lastSignalQueuedAt[tone] = now
            }
        }
        state.pendingTones.clear()
    }

    private fun repeatActiveCalls(
        state: State,
        commandGeneration: Long,
        sessionBindingKey: String
    ) {
        if (
            AppForegroundState.isForeground ||
            currentSessionBindingKey() != sessionBindingKey
        ) return
        val now = System.currentTimeMillis()
        state.repeatTones.forEach { tone ->
            val lastQueuedAt = state.lastSignalQueuedAt[tone] ?: 0L
            if (now - lastQueuedAt >= CALL_REPEAT_INTERVAL_MS) {
                if (enqueueSignal(tone, commandGeneration, sessionBindingKey)) {
                    state.lastSignalQueuedAt[tone] = now
                }
            }
        }
    }

    private fun enqueueSignal(
        tone: NotificationTone,
        signalGeneration: Long,
        sessionBindingKey: String
    ): Boolean {
        if (!queuedSignalTones.add(tone)) return false
        if (!signals.trySend(Signal(tone, signalGeneration, sessionBindingKey)).isSuccess) {
            queuedSignalTones.remove(tone)
            return false
        }
        return true
    }

    private suspend fun runSignalLoop() {
        for (signal in signals) {
            try {
                synchronized(alertLifecycleLock) {
                    if (
                        signal.generation == generation.get() &&
                        signal.sessionBindingKey == currentSessionBindingKey() &&
                        !AppForegroundState.isForeground &&
                        signal.sessionBindingKey.isNotBlank()
                    ) {
                        NotificationHelper.vibrateForTone(appContext, signal.tone)
                        audioPlayer.playNotificationTone(signal.tone)
                    }
                }
                if (
                    signal.generation == generation.get() &&
                    signal.sessionBindingKey == currentSessionBindingKey() &&
                    !AppForegroundState.isForeground &&
                    signal.sessionBindingKey.isNotBlank()
                ) {
                    delay(signal.tone.playbackDurationMs)
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
        state.seenIdentities.clear()
        state.recentFingerprints.clear()
        state.lastFingerprintPruneAt = 0L
        state.lastEphemeralPruneAt = 0L
        state.sessionBindingKey = ""
        queuedSignalTones.clear()
        NotificationHelper.clearDeliveredNotifications(appContext)
    }

    private fun prepareStateForBinding(state: State, sessionBindingKey: String) {
        if (state.sessionBindingKey == sessionBindingKey) return
        resetState(state)
        state.sessionBindingKey = sessionBindingKey
    }

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
        var sessionBindingKey = ""
    }

    private sealed interface Command {
        val generation: Long
        val sessionBindingKey: String

        data class Submit(
            val event: NativeNotificationEvent,
            override val generation: Long,
            override val sessionBindingKey: String
        ) : Command
        data class SyncSnapshot(
            val events: List<NativeNotificationEvent>,
            val alertNewEvents: Boolean,
            override val generation: Long,
            override val sessionBindingKey: String
        ) : Command
        data class Render(
            override val generation: Long,
            override val sessionBindingKey: String
        ) : Command
        data class FlushSignals(
            override val generation: Long,
            override val sessionBindingKey: String
        ) : Command
        data class RepeatActiveCalls(
            override val generation: Long,
            override val sessionBindingKey: String
        ) : Command
        data class Reset(override val generation: Long) : Command {
            override val sessionBindingKey: String = ""
        }
    }

    private data class Signal(
        val tone: NotificationTone,
        val generation: Long,
        val sessionBindingKey: String
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

internal fun shouldProcessNativeNotificationCommand(
    commandGeneration: Long,
    activeGeneration: Long,
    commandSessionBindingKey: String,
    activeSessionBindingKey: String
): Boolean =
    commandGeneration == activeGeneration &&
        commandSessionBindingKey.isNotBlank() &&
        commandSessionBindingKey == activeSessionBindingKey
