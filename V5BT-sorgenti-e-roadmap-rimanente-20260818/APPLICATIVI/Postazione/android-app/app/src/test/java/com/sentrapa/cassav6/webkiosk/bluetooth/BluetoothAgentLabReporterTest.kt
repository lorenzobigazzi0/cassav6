package com.sentrapa.cassav6.webkiosk.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BluetoothAgentLabReporterTest {
    @Test
    fun `status schema is exact redacted and keeps B3 resources dormant`() {
        val status = BluetoothAgentLabStatusV1(
            sampleSequence = 7L,
            sampledAtEpochMs = 20L,
            reporterStartedAtEpochMs = 10L,
            state = BluetoothConnectivityState.DISCOVERING,
            metrics = BluetoothConnectivityMetricsSnapshot(
                starts = 1L,
                stops = 0L,
                backoffs = 2L,
                transitions = 5L,
                duplicates = 3L,
                invalid = 0L
            ),
            resources = BluetoothAgentResourceSnapshot(
                scannerActive = true,
                advertiserActive = true
            )
        )

        val json = status.toRedactedJson()

        assertEquals(
            "{\"schemaVersion\":1,\"source\":\"CASSA_V6_ANDROID_CONNECTIVITY_AGENT\"," +
                "\"labBuild\":true,\"diagnosticsEnabled\":true,\"agentEnabled\":true," +
                "\"sampleSequence\":7,\"sampledAtEpochMs\":20," +
                "\"reporterStartedAtEpochMs\":10,\"state\":\"DISCOVERING\"," +
                "\"metrics\":{\"startCount\":1,\"stopCount\":0,\"backoffCount\":2," +
                "\"transitionCount\":5,\"duplicateEventCount\":3," +
                "\"invalidTransitionCount\":0},\"resources\":{\"scannerActive\":true," +
                "\"advertiserActive\":true,\"gattServerActive\":false," +
                "\"gattClientActive\":false,\"sessionCount\":0," +
                "\"reliableClientActive\":false," +
                "\"reliableServerActive\":false," +
                "\"reliableArbitrationRejected\":0}}",
            json
        )
        assertFalse(json.contains("serial", ignoreCase = true))
        assertFalse(json.contains("alias", ignoreCase = true))
    }
}
