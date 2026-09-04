package com.sentrapa.webkiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeNotificationPolicyTest {
    @Test
    fun `keeps only the latest three general notifications`() {
        val events = (1..1_000).map { index -> event("general-$index", NotificationTone.GENERAL, index) }

        val snapshot = NativeNotificationPolicy.buildSnapshot(events)

        assertEquals(listOf("general-1000", "general-999", "general-998"), snapshot.latestGeneral.map { it.id })
        assertTrue(snapshot.callGroups.isEmpty())
    }

    @Test
    fun `groups calls by type and repeats only waiter and bell`() {
        val events = buildList {
            repeat(10) { add(event("waiter-$it", NotificationTone.WAITER, it)) }
            repeat(5) { add(event("bell-$it", NotificationTone.BELL, 100 + it)) }
            repeat(2) { add(event("ring-$it", NotificationTone.HANDHELD_RING, 200 + it)) }
        }

        val snapshot = NativeNotificationPolicy.buildSnapshot(events)

        assertEquals(
            mapOf(
                NotificationTone.WAITER to 10,
                NotificationTone.BELL to 5,
                NotificationTone.HANDHELD_RING to 2
            ),
            snapshot.callGroups.associate { it.tone to it.events.size }
        )
        assertEquals(setOf(NotificationTone.WAITER, NotificationTone.BELL), snapshot.repeatTones)
    }

    @Test
    fun `coalesces a burst to one alert per tone in arrival order`() {
        val events = listOf(
            event("w1", NotificationTone.WAITER, 1),
            event("w2", NotificationTone.WAITER, 2),
            event("g1", NotificationTone.GENERAL, 3),
            event("b1", NotificationTone.BELL, 4),
            event("g2", NotificationTone.GENERAL, 5)
        )

        assertEquals(
            listOf(NotificationTone.WAITER, NotificationTone.GENERAL, NotificationTone.BELL),
            NativeNotificationPolicy.alertTones(events)
        )
    }

    private fun event(id: String, tone: NotificationTone, order: Int) =
        NativeNotificationEvent(
            id = id,
            tone = tone,
            title = id,
            text = "text-$id",
            createdAt = order.toLong(),
            receivedAt = order.toLong()
        )
}
