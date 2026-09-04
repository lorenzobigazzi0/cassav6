package com.sentrapa.cassav6.webkiosk

import java.security.MessageDigest

data class NotificationClientContext(
    val token: String = "",
    val userId: String = "",
    val username: String = "",
    val fullName: String = "",
    val deviceUuid: String = "",
    val roomId: String = "",
    val roomName: String = ""
) {
    val hasAuthenticatedSession: Boolean
        get() =
            token.isNotBlank() &&
                deviceUuid.isNotBlank() &&
                (userId.isNotBlank() || username.isNotBlank())

    val canPullNotifications: Boolean
        get() = hasAuthenticatedSession

    val canUseRadio: Boolean
        get() = hasAuthenticatedSession && userId.isNotBlank()

    val identityKey: String
        get() = listOf(token, userId, username, deviceUuid, roomId).joinToString("|")

    val sessionBindingKey: String
        get() = if (hasAuthenticatedSession) sha256SessionBindingKey(identityKey) else ""
}

private fun sha256SessionBindingKey(value: String): String {
    val bytes = value.toByteArray(Charsets.UTF_8)
    val digest = try {
        MessageDigest.getInstance("SHA-256").digest(bytes)
    } finally {
        bytes.fill(0)
    }
    return try {
        digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    } finally {
        digest.fill(0)
    }
}
