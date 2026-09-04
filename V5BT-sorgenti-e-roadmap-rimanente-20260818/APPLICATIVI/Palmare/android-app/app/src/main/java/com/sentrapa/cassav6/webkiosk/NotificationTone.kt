package com.sentrapa.cassav6.webkiosk

enum class NotificationTone {
    WAITER,
    BELL,
    GENERAL,
    HANDHELD_RING;

    val playbackDurationMs: Long
        get() = when (this) {
            WAITER -> 560L
            BELL -> 690L
            GENERAL -> 290L
            HANDHELD_RING -> 1_760L
        }

    companion object {
        fun fromPayload(type: String?, eventType: String?): NotificationTone {
            val normalizedEvent = normalize(eventType)
            if (normalizedEvent == "handheld-ring") return HANDHELD_RING

            return when (normalize(type)) {
                "waiter" -> WAITER
                "bell" -> BELL
                "handheld-ring", "ring" -> HANDHELD_RING
                else -> GENERAL
            }
        }

        fun fromWireValue(value: String?): NotificationTone =
            entries.firstOrNull { it.name == value } ?: GENERAL

        private fun normalize(value: String?): String =
            value.orEmpty()
                .trim()
                .lowercase()
                .replace('_', '-')
    }
}
