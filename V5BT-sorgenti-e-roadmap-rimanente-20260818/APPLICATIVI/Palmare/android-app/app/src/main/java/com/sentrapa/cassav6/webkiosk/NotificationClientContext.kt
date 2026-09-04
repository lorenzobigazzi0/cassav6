package com.sentrapa.cassav6.webkiosk

import java.security.MessageDigest

data class NotificationClientContext(
    val token: String = "",
    val userId: String = "",
    val username: String = "",
    val fullName: String = "",
    val deviceUuid: String = "",
    val sessionStartedAt: Long = 0L,
    val roomId: String = "",
    val roomName: String = ""
) {
    val hasAuthenticatedSession: Boolean
        get() =
            token.isNotBlank() &&
                deviceUuid.isNotBlank() &&
                sessionStartedAt > 0L &&
                (userId.isNotBlank() || username.isNotBlank())

    val canPullNotifications: Boolean
        get() = hasAuthenticatedSession

    val canUseRadio: Boolean
        get() = hasAuthenticatedSession && userId.isNotBlank()

    val identityKey: String
        get() = listOf(token, userId, username, deviceUuid, sessionStartedAt, roomId).joinToString("|")

    val sessionBindingKey: String
        get() = if (hasAuthenticatedSession) sha256Hex(identityKey) else ""
}

private fun sha256Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    val hex = CharArray(digest.size * 2)
    digest.forEachIndexed { index, byte ->
        val valueByte = byte.toInt() and 0xff
        hex[index * 2] = HEX_DIGITS[valueByte ushr 4]
        hex[index * 2 + 1] = HEX_DIGITS[valueByte and 0x0f]
    }
    return String(hex)
}

private const val HEX_DIGITS = "0123456789abcdef"

internal fun isNativeNotificationFreshForSession(
    createdAt: Long,
    sessionStartedAt: Long
): Boolean = createdAt > 0L && sessionStartedAt > 0L && createdAt >= sessionStartedAt

internal fun shouldAcceptNativeNotificationIngress(
    context: NotificationClientContext,
    createdAt: Long,
    targetDeviceUuid: String?,
    targetSessionStartedAt: Long?,
    targetUserId: String?,
    targetUsername: String?
): Boolean {
    if (!context.hasAuthenticatedSession) return false
    if (!isNativeNotificationFreshForSession(createdAt, context.sessionStartedAt)) return false
    if (targetDeviceUuid?.trim() != context.deviceUuid) return false
    if (targetSessionStartedAt != context.sessionStartedAt) return false

    val userIdMatches =
        context.userId.isNotBlank() && targetUserId?.trim() == context.userId
    val usernameMatches =
        context.username.isNotBlank() && targetUsername?.trim() == context.username
    return userIdMatches || usernameMatches
}
