package com.sentrapa.webkiosk

data class NativeNotificationEvent(
    val id: String,
    val tone: NotificationTone,
    val title: String,
    val text: String,
    val createdAt: Long,
    val receivedAt: Long = System.currentTimeMillis()
) {
    val identity: String
        get() = id.trim().ifBlank { "fallback:${fingerprint.hashCode()}" }

    val fingerprint: String
        get() = listOf(tone.name, title.trim(), text.trim()).joinToString("|")
}

data class NativeNotificationGroup(
    val tone: NotificationTone,
    val events: List<NativeNotificationEvent>
) {
    val latest: NativeNotificationEvent
        get() = events.maxBy { it.createdAt }
}

data class NativeNotificationSnapshot(
    val callGroups: List<NativeNotificationGroup>,
    val latestGeneral: List<NativeNotificationEvent>,
    val repeatTones: Set<NotificationTone>
)

object NativeNotificationPolicy {
    private val callTones = listOf(
        NotificationTone.WAITER,
        NotificationTone.BELL,
        NotificationTone.HANDHELD_RING
    )

    fun buildSnapshot(events: Collection<NativeNotificationEvent>): NativeNotificationSnapshot {
        val deduplicated = events
            .associateBy { it.identity }
            .values
            .sortedBy { it.createdAt }
        val callGroups = callTones.mapNotNull { tone ->
            deduplicated
                .filter { it.tone == tone }
                .takeIf { it.isNotEmpty() }
                ?.let { NativeNotificationGroup(tone, it) }
        }
        val latestGeneral = deduplicated
            .asSequence()
            .filter { it.tone == NotificationTone.GENERAL }
            .sortedByDescending { it.createdAt }
            .take(MAX_VISIBLE_GENERAL_NOTIFICATIONS)
            .toList()
        val repeatTones = callGroups
            .map { it.tone }
            .filterTo(linkedSetOf()) {
                it == NotificationTone.WAITER || it == NotificationTone.BELL
            }

        return NativeNotificationSnapshot(callGroups, latestGeneral, repeatTones)
    }

    fun alertTones(events: Collection<NativeNotificationEvent>): List<NotificationTone> =
        events
            .sortedBy { it.createdAt }
            .map { it.tone }
            .distinct()

    const val MAX_VISIBLE_GENERAL_NOTIFICATIONS = 3
}
