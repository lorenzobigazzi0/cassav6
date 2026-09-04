package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.system.Os
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

internal const val PEER_TRUST_DIRECTORY_VERSION_V1 = 1
internal const val PEER_TRUST_DIRECTORY_KIND_V1 =
    "cassav6.bluetooth.peer-trust-directory"
internal const val PEER_TRUST_DIRECTORY_SIGNATURE_V1 =
    "ECDSA-P256-SHA256-P1363"
internal const val PEER_TRUST_DIRECTORY_MAX_BYTES_V1 = 262_144
internal const val PEER_TRUST_DIRECTORY_MAX_LIFETIME_MS_V1 = 86_400_000L
internal const val PEER_TRUST_DIRECTORY_FUTURE_SKEW_MS_V1 = 300_000L
internal val BLUETOOTH_PEER_TRUST_ID_PATTERN_V1 = Regex("^[0-9a-f]{64}$")

internal fun deriveBluetoothPeerTrustIdV1(
    nodeId: String,
    certificateId: String,
    publicKeyAlgorithm: String,
    publicKeySpkiDer: ByteArray
): String {
    val canonicalNode = runCatching { UUID.fromString(nodeId).toString() }.getOrNull()
    val canonicalCertificate = runCatching {
        UUID.fromString(certificateId).toString()
    }.getOrNull()
    require(canonicalNode == nodeId && canonicalCertificate == certificateId) {
        "peer trust identity UUIDs must be canonical lowercase"
    }
    require(
        when (publicKeyAlgorithm) {
            "EC-P256" -> P256SpkiV2.isCanonicalP256Spki(publicKeySpkiDer)
            "Ed25519" -> Ed25519SpkiV1.isCanonicalEd25519Spki(publicKeySpkiDer)
            else -> false
        }
    ) { "peer trust public key does not match its algorithm" }
    val context = "CASSA_V6-BT-PEER-TRUST-ID-V1\u0000".encodeToByteArray()
    val algorithm = "$publicKeyAlgorithm\u0000".encodeToByteArray()
    val node = UUID.fromString(nodeId).toBytes()
    val certificate = UUID.fromString(certificateId).toBytes()
    return try {
        MessageDigest.getInstance("SHA-256").run {
            update(context)
            update(node)
            update(certificate)
            update(algorithm)
            digest(publicKeySpkiDer).joinToString("") {
                "%02x".format(it.toInt() and 0xff)
            }
        }
    } finally {
        context.fill(0)
        algorithm.fill(0)
        node.fill(0)
        certificate.fill(0)
    }
}

private fun UUID.toBytes(): ByteArray = ByteBuffer.allocate(16)
    .putLong(mostSignificantBits)
    .putLong(leastSignificantBits)
    .array()

internal enum class AndroidPeerTrustStatusV1 { ACTIVE, REVOKED }

internal data class AndroidPeerTrustEntryV1(
    val nodeId: String,
    val certificateId: String,
    val publicKeyAlgorithm: String,
    val publicKeySpkiDerBase64: String,
    val status: AndroidPeerTrustStatusV1,
    val currentAlias: String?,
    val nextAlias: String?
)

internal data class AndroidPeerTrustDirectoryV1(
    val issuerId: String,
    val revision: Long,
    val issuedAt: String,
    val expiresAt: String,
    val aliasEpoch: Long,
    val authorityKeyId: String,
    val devices: List<AndroidPeerTrustEntryV1>,
    val signatureBase64: String
)

internal data class AndroidResolvedPeerTrustV1(
    val entry: AndroidPeerTrustEntryV1,
    val directoryRevision: Long,
    val directoryExpiresAtEpochMs: Long,
    val observedEpoch: Long,
    val observedAlias: String,
    val peerTrustId: String
)

internal class AndroidPeerTrustExceptionV1(
    val code: String,
    message: String,
    cause: Throwable? = null
) : IllegalArgumentException(message, cause)

private fun trustFailure(
    code: String,
    message: String,
    cause: Throwable? = null
): Nothing = throw AndroidPeerTrustExceptionV1(code, message, cause)

private val peerTrustDatePattern = Regex(
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
)

private fun parseCanonicalPeerTrustDateEpochMs(value: String, field: String): Long {
    if (!peerTrustDatePattern.matches(value)) {
        trustFailure("INVALID_DATE", "$field invalid")
    }
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        isLenient = false
        timeZone = TimeZone.getTimeZone("UTC")
    }
    val position = ParsePosition(0)
    val parsed = formatter.parse(value, position)
    if (
        parsed == null ||
        position.errorIndex >= 0 ||
        position.index != value.length ||
        formatter.format(parsed) != value
    ) {
        trustFailure("INVALID_DATE", "$field is not canonical")
    }
    return parsed.time
}

internal object AndroidPeerTrustDirectoryCodecV1 {
    private const val CONTEXT = "CASSA_V6-BT-PEER-TRUST-DIRECTORY-V1\u0000"
    private val uuidPattern = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-" +
            "[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    private val issuerPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private val aliasPattern = Regex("^[0-9a-f]{12}$")
    private val keyIdPattern = Regex("^[0-9a-f]{64}$")
    private val rootKeys = setOf(
        "schemaVersion", "kind", "issuerId", "revision", "issuedAt",
        "expiresAt", "aliasEpoch", "authorityKeyId", "signatureAlgorithm",
        "devices", "signatureBase64"
    )
    private val deviceKeys = setOf(
        "nodeId", "certificateId", "publicKeyAlgorithm",
        "publicKeySpkiDerBase64", "status", "currentAlias", "nextAlias"
    )

    fun verify(
        wire: ByteArray,
        pinnedAuthoritySpki: ByteArray,
        nowEpochMs: Long,
        minimumRevision: Long = 0
    ): AndroidPeerTrustDirectoryV1 = verifyWithTemporalPolicy(
        wire,
        pinnedAuthoritySpki,
        nowEpochMs,
        minimumRevision
    )

    fun verifyStoredForImport(
        wire: ByteArray,
        pinnedAuthoritySpki: ByteArray
    ): AndroidPeerTrustDirectoryV1 = verifyWithTemporalPolicy(
        wire,
        pinnedAuthoritySpki,
        nowEpochMs = null,
        minimumRevision = 0
    )

    private fun verifyWithTemporalPolicy(
        wire: ByteArray,
        pinnedAuthoritySpki: ByteArray,
        nowEpochMs: Long?,
        minimumRevision: Long
    ): AndroidPeerTrustDirectoryV1 {
        if (wire.isEmpty() || wire.size > PEER_TRUST_DIRECTORY_MAX_BYTES_V1) {
            trustFailure("INVALID_WIRE", "peer trust directory size is invalid")
        }
        if ((nowEpochMs != null && nowEpochMs < 0) || minimumRevision < 0) {
            trustFailure("INVALID_CLOCK", "clock or minimum revision is invalid")
        }
        val parsed = try {
            JSONObject(wire.toString(Charsets.UTF_8))
        } catch (error: Exception) {
            trustFailure("INVALID_JSON", "peer trust directory JSON is invalid", error)
        }
        exactKeys(parsed, rootKeys, "directory")
        if (
            parsed.optInt("schemaVersion", -1) != PEER_TRUST_DIRECTORY_VERSION_V1 ||
            parsed.optString("kind") != PEER_TRUST_DIRECTORY_KIND_V1 ||
            parsed.optString("signatureAlgorithm") !=
            PEER_TRUST_DIRECTORY_SIGNATURE_V1
        ) {
            trustFailure("PROTOCOL_MISMATCH", "peer trust protocol mismatch")
        }
        val issuerId = parsed.requiredString("issuerId")
        if (!issuerPattern.matches(issuerId)) {
            trustFailure("INVALID_ISSUER", "issuerId is invalid")
        }
        val revision = parsed.requiredLong("revision", 1, Long.MAX_VALUE)
        val aliasEpoch = parsed.requiredLong("aliasEpoch", 0, Long.MAX_VALUE - 1)
        val issuedAt = canonicalDate(parsed.requiredString("issuedAt"), "issuedAt")
        val expiresAt = canonicalDate(parsed.requiredString("expiresAt"), "expiresAt")
        val issuedMs = parseCanonicalPeerTrustDateEpochMs(issuedAt, "issuedAt")
        val expiresMs = parseCanonicalPeerTrustDateEpochMs(expiresAt, "expiresAt")
        if (
            expiresMs <= issuedMs ||
            expiresMs - issuedMs > PEER_TRUST_DIRECTORY_MAX_LIFETIME_MS_V1
        ) {
            trustFailure("INVALID_LIFETIME", "directory lifetime is invalid")
        }
        if (nowEpochMs != null) {
            if (issuedMs > nowEpochMs + PEER_TRUST_DIRECTORY_FUTURE_SKEW_MS_V1) {
                trustFailure(
                    "DIRECTORY_NOT_YET_VALID",
                    "directory issue time is in the future"
                )
            }
            if (expiresMs <= nowEpochMs) {
                trustFailure("DIRECTORY_EXPIRED", "directory has expired")
            }
        }
        if (revision < minimumRevision) {
            trustFailure("REVISION_ROLLBACK", "directory revision regressed")
        }
        val authorityKeyId = parsed.requiredString("authorityKeyId")
        if (!keyIdPattern.matches(authorityKeyId)) {
            trustFailure("INVALID_AUTHORITY_KEY_ID", "authority key id is invalid")
        }
        val authority = decodePublicKey("EC-P256", pinnedAuthoritySpki)
        val expectedAuthorityId = sha256Hex(pinnedAuthoritySpki)
        if (authorityKeyId != expectedAuthorityId) {
            trustFailure("AUTHORITY_KEY_MISMATCH", "directory authority pin mismatch")
        }
        val array = parsed.optJSONArray("devices")
            ?: trustFailure("INVALID_STRUCTURE", "devices must be an array")
        if (array.length() > 256) {
            trustFailure("INVALID_DEVICE_LIST", "too many peer trust entries")
        }
        val devices = ArrayList<AndroidPeerTrustEntryV1>(array.length())
        val certificates = hashSetOf<String>()
        val publicKeys = hashSetOf<String>()
        var previousNodeId = ""
        repeat(array.length()) { index ->
            val entry = array.optJSONObject(index)
                ?: trustFailure("INVALID_STRUCTURE", "device entry is invalid")
            exactKeys(entry, deviceKeys, "devices[$index]")
            val nodeId = canonicalUuid(entry.requiredString("nodeId"), "nodeId")
            val certificateId = canonicalUuid(
                entry.requiredString("certificateId"),
                "certificateId"
            )
            if (nodeId <= previousNodeId) {
                trustFailure("NON_CANONICAL_ORDER", "devices are not sorted")
            }
            previousNodeId = nodeId
            val algorithm = entry.requiredString("publicKeyAlgorithm")
            val spkiBase64 = entry.requiredString("publicKeySpkiDerBase64")
            val spki = decodeCanonicalBase64(spkiBase64)
            try {
                decodePublicKey(algorithm, spki)
            } finally {
                spki.fill(0)
            }
            val status = try {
                AndroidPeerTrustStatusV1.valueOf(entry.requiredString("status"))
            } catch (error: Exception) {
                trustFailure("INVALID_STATUS", "peer status is invalid", error)
            }
            val currentAlias = entry.nullableString("currentAlias")
            val nextAlias = entry.nullableString("nextAlias")
            if (
                (status == AndroidPeerTrustStatusV1.ACTIVE &&
                    (currentAlias == null || nextAlias == null ||
                        !aliasPattern.matches(currentAlias) ||
                        !aliasPattern.matches(nextAlias) ||
                        currentAlias == nextAlias)) ||
                (status == AndroidPeerTrustStatusV1.REVOKED &&
                    (currentAlias != null || nextAlias != null))
            ) {
                trustFailure("INVALID_ALIAS", "peer alias window is invalid")
            }
            if (!certificates.add(certificateId) || !publicKeys.add(spkiBase64)) {
                trustFailure("DUPLICATE_DEVICE", "peer identity is duplicated")
            }
            devices += AndroidPeerTrustEntryV1(
                nodeId, certificateId, algorithm, spkiBase64, status,
                currentAlias, nextAlias
            )
        }
        val signatureBase64 = parsed.requiredString("signatureBase64")
        val signature = decodeCanonicalBase64(signatureBase64)
        if (!P256EcdsaSignatureV2.isCanonicalP1363(signature)) {
            signature.fill(0)
            trustFailure("NON_CANONICAL_SIGNATURE", "signature is not low-S P1363")
        }
        val directory = AndroidPeerTrustDirectoryV1(
            issuerId, revision, issuedAt, expiresAt, aliasEpoch,
            authorityKeyId, devices.toList(), signatureBase64
        )
        val canonical = encode(directory)
        if (!MessageDigest.isEqual(canonical, wire)) {
            canonical.fill(0)
            signature.fill(0)
            trustFailure("NON_CANONICAL_WIRE", "directory JSON is not canonical")
        }
        canonical.fill(0)
        val message = signingMessage(directory)
        try {
            val verifier = Signature.getInstance(
                P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM
            )
            verifier.initVerify(authority)
            verifier.update(message)
            if (!verifier.verify(P256EcdsaSignatureV2.canonicalP1363ToDer(signature))) {
                trustFailure("SIGNATURE_INVALID", "directory signature is invalid")
            }
        } catch (error: AndroidPeerTrustExceptionV1) {
            throw error
        } catch (error: Exception) {
            trustFailure("SIGNATURE_INVALID", "directory signature failed", error)
        } finally {
            message.fill(0)
            signature.fill(0)
        }
        return directory
    }

    fun encode(directory: AndroidPeerTrustDirectoryV1): ByteArray =
        (unsignedJson(directory) +
            ",\"signatureBase64\":\"${directory.signatureBase64}\"}")
            .encodeToByteArray()

    fun signingMessage(directory: AndroidPeerTrustDirectoryV1): ByteArray =
        CONTEXT.encodeToByteArray() + (unsignedJson(directory) + "}").encodeToByteArray()

    fun verifyPeerSignature(
        peer: AndroidPeerTrustEntryV1,
        message: ByteArray,
        signature: ByteArray
    ): Boolean {
        if (peer.status != AndroidPeerTrustStatusV1.ACTIVE || signature.size != 64) {
            return false
        }
        val spki = decodeCanonicalBase64(peer.publicKeySpkiDerBase64)
        return try {
            val publicKey = decodePublicKey(peer.publicKeyAlgorithm, spki)
            when (peer.publicKeyAlgorithm) {
                "EC-P256" -> {
                    if (!P256EcdsaSignatureV2.isCanonicalP1363(signature)) return false
                    Signature.getInstance(P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM)
                        .run {
                            initVerify(publicKey)
                            update(message)
                            verify(P256EcdsaSignatureV2.canonicalP1363ToDer(signature))
                        }
                }
                "Ed25519" -> Signature.getInstance("Ed25519").run {
                    initVerify(publicKey)
                    update(message)
                    verify(signature)
                }
                else -> false
            }
        } catch (_: Exception) {
            false
        } finally {
            spki.fill(0)
        }
    }

    private fun unsignedJson(directory: AndroidPeerTrustDirectoryV1): String =
        buildString {
            append("{\"schemaVersion\":1")
            append(",\"kind\":\"$PEER_TRUST_DIRECTORY_KIND_V1\"")
            append(",\"issuerId\":\"${directory.issuerId}\"")
            append(",\"revision\":${directory.revision}")
            append(",\"issuedAt\":\"${directory.issuedAt}\"")
            append(",\"expiresAt\":\"${directory.expiresAt}\"")
            append(",\"aliasEpoch\":${directory.aliasEpoch}")
            append(",\"authorityKeyId\":\"${directory.authorityKeyId}\"")
            append(",\"signatureAlgorithm\":\"$PEER_TRUST_DIRECTORY_SIGNATURE_V1\"")
            append(",\"devices\":[")
            directory.devices.forEachIndexed { index, peer ->
                if (index > 0) append(',')
                append("{\"nodeId\":\"${peer.nodeId}\"")
                append(",\"certificateId\":\"${peer.certificateId}\"")
                append(",\"publicKeyAlgorithm\":\"${peer.publicKeyAlgorithm}\"")
                append(",\"publicKeySpkiDerBase64\":\"${peer.publicKeySpkiDerBase64}\"")
                append(",\"status\":\"${peer.status.name}\"")
                append(",\"currentAlias\":")
                append(peer.currentAlias?.let { "\"$it\"" } ?: "null")
                append(",\"nextAlias\":")
                append(peer.nextAlias?.let { "\"$it\"" } ?: "null")
                append('}')
            }
            append(']')
        }

    private fun decodePublicKey(algorithm: String, spki: ByteArray): PublicKey {
        val canonical = when (algorithm) {
            "EC-P256" -> P256SpkiV2.isCanonicalP256Spki(spki)
            "Ed25519" -> Ed25519SpkiV1.isCanonicalEd25519Spki(spki)
            else -> false
        }
        if (!canonical) trustFailure("INVALID_PUBLIC_KEY", "peer public key is invalid")
        return try {
            KeyFactory.getInstance(if (algorithm == "EC-P256") "EC" else "Ed25519")
                .generatePublic(X509EncodedKeySpec(spki))
        } catch (error: Exception) {
            trustFailure("INVALID_PUBLIC_KEY", "peer public key cannot be loaded", error)
        }
    }

    private fun exactKeys(value: JSONObject, expected: Set<String>, field: String) {
        val actual = value.keys().asSequence().toSet()
        if (actual != expected) {
            trustFailure("INVALID_STRUCTURE", "$field has missing or unexpected fields")
        }
    }

    private fun JSONObject.requiredString(name: String): String =
        if (has(name) && !isNull(name) && opt(name) is String) getString(name)
        else trustFailure("INVALID_STRUCTURE", "$name must be a string")

    private fun JSONObject.nullableString(name: String): String? = when {
        !has(name) -> trustFailure("INVALID_STRUCTURE", "$name is missing")
        isNull(name) -> null
        opt(name) is String -> getString(name)
        else -> trustFailure("INVALID_STRUCTURE", "$name must be string or null")
    }

    private fun JSONObject.requiredLong(name: String, min: Long, max: Long): Long {
        if (!has(name) || isNull(name)) trustFailure("INVALID_STRUCTURE", "$name missing")
        val raw = opt(name)
        if (raw !is Number || raw.toDouble() != raw.toLong().toDouble()) {
            trustFailure("INVALID_INTEGER", "$name must be an integer")
        }
        return raw.toLong().also {
            if (it !in min..max) trustFailure("INVALID_INTEGER", "$name is out of range")
        }
    }

    private fun canonicalUuid(value: String, field: String): String =
        value.takeIf(uuidPattern::matches)
            ?: trustFailure("INVALID_UUID", "$field must be a canonical UUID")

    private fun canonicalDate(value: String, field: String): String {
        parseCanonicalPeerTrustDateEpochMs(value, field)
        return value
    }

    private fun decodeCanonicalBase64(value: String): ByteArray = try {
        (value.decodeBase64()?.toByteArray()
            ?: trustFailure("INVALID_BASE64", "base64 field is invalid")).also { decoded ->
            if (decoded.toByteString().base64() != value) {
                decoded.fill(0)
                trustFailure("INVALID_BASE64", "base64 field is not canonical")
            }
        }
    } catch (error: AndroidPeerTrustExceptionV1) {
        throw error
    } catch (error: Exception) {
        trustFailure("INVALID_BASE64", "base64 field is invalid", error)
    }

    private fun sha256Hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(value).joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        }
}

internal interface AndroidPeerTrustStoreV1 {
    fun read(): ByteArray?
    fun writeAtomically(value: ByteArray)
}

internal class AndroidAtomicPeerTrustStoreV1(context: Context) :
    AndroidPeerTrustStoreV1 {
    private val base = File(context.noBackupFilesDir, "bluetooth-peer-trust-v1.json")
    private val atomic = AtomicFile(base)

    @Synchronized
    override fun read(): ByteArray? {
        if (!base.exists()) return null
        assertPrivateRegularFile()
        return atomic.openRead().use { input ->
            val bytes = input.readBytes()
            if (bytes.size > PEER_TRUST_DIRECTORY_MAX_BYTES_V1) {
                bytes.fill(0)
                trustFailure("CACHE_INVALID", "peer trust cache is oversized")
            }
            bytes
        }
    }

    @Synchronized
    override fun writeAtomically(value: ByteArray) {
        require(value.isNotEmpty() && value.size <= PEER_TRUST_DIRECTORY_MAX_BYTES_V1)
        var output: FileOutputStream? = null
        try {
            output = atomic.startWrite()
            output.write(value)
            output.fd.sync()
            atomic.finishWrite(output)
            output = null
            Os.chmod(base.absolutePath, 0x180) // 0600
            assertPrivateRegularFile()
        } catch (error: Exception) {
            output?.let(atomic::failWrite)
            trustFailure("CACHE_WRITE_FAILED", "peer trust cache write failed", error)
        }
    }

    private fun assertPrivateRegularFile() {
        if (!base.isFile || base.canonicalFile != base.absoluteFile ||
            (Os.stat(base.absolutePath).st_mode and 0x1ff) != 0x180) {
            trustFailure("CACHE_INVALID", "peer trust cache must be regular mode 0600")
        }
    }
}

internal class AndroidPeerTrustCacheV1(
    private val store: AndroidPeerTrustStoreV1,
    pinnedAuthoritySpki: ByteArray
) : AutoCloseable {
    private val authoritySpki = pinnedAuthoritySpki.copyOf()

    @Synchronized
    fun importSignedDirectory(wire: ByteArray, nowEpochMs: Long): Long {
        val existingWire = store.read()
        try {
            val existing = existingWire?.let {
                AndroidPeerTrustDirectoryCodecV1.verifyStoredForImport(
                    it,
                    authoritySpki
                )
            }
            val candidate = AndroidPeerTrustDirectoryCodecV1.verify(
                wire,
                authoritySpki,
                nowEpochMs,
                minimumRevision = existing?.revision ?: 0
            )
            if (existing != null && candidate.revision == existing.revision) {
                if (!MessageDigest.isEqual(existingWire, wire)) {
                    trustFailure(
                        "REVISION_CONFLICT",
                        "revision already identifies other bytes"
                    )
                }
                return candidate.revision
            }
            store.writeAtomically(wire)
            val committed = store.read()
                ?: trustFailure("CACHE_WRITE_FAILED", "peer trust cache disappeared")
            try {
                if (!MessageDigest.isEqual(committed, wire)) {
                    trustFailure("CACHE_WRITE_FAILED", "peer trust cache commit mismatch")
                }
                return AndroidPeerTrustDirectoryCodecV1.verify(
                    committed,
                    authoritySpki,
                    nowEpochMs,
                    minimumRevision = candidate.revision
                ).revision
            } finally {
                committed.fill(0)
            }
        } finally {
            existingWire?.fill(0)
        }
    }

    @Synchronized
    fun resolveActivePeer(
        nodeId: String,
        certificateId: String,
        observedAlias: String,
        observedEpoch: Long,
        nowEpochMs: Long
    ): AndroidResolvedPeerTrustV1? {
        val wire = store.read() ?: return null
        return try {
            val directory = AndroidPeerTrustDirectoryCodecV1.verify(
                wire,
                authoritySpki,
                nowEpochMs
            )
            resolveFromDirectory(
                directory,
                nodeId,
                certificateId,
                observedAlias,
                observedEpoch
            )
        } finally {
            wire.fill(0)
        }
    }

    @Synchronized
    fun resolveActivePeerByAlias(
        nodeId: String,
        observedAlias: String,
        observedEpoch: Long,
        nowEpochMs: Long
    ): AndroidResolvedPeerTrustV1? {
        val wire = store.read() ?: return null
        return try {
            val directory = AndroidPeerTrustDirectoryCodecV1.verify(
                wire,
                authoritySpki,
                nowEpochMs
            )
            resolveFromDirectory(
                directory,
                nodeId,
                certificateId = null,
                observedAlias,
                observedEpoch
            )
        } finally {
            wire.fill(0)
        }
    }

    @Synchronized
    fun validateActiveLocalIdentity(
        report: DeviceIdentityReport,
        observedAlias: String,
        observedEpoch: Long,
        nowEpochMs: Long
    ): Boolean {
        if (
            report.status != DeviceIdentityStatus.READY ||
            report.nodeId == null ||
            report.certificateId == null ||
            report.signingAlgorithm == null ||
            report.signingPublicKeyBase64 == null
        ) return false
        val resolved = resolveActivePeer(
            report.nodeId,
            report.certificateId,
            observedAlias,
            observedEpoch,
            nowEpochMs
        ) ?: return false
        if (resolved.entry.publicKeyAlgorithm != report.signingAlgorithm) return false
        val localSpki = try {
            report.signingPublicKeyBase64.decodeBase64()?.toByteArray() ?: return false
        } catch (_: RuntimeException) {
            return false
        }
        val directorySpki = try {
            resolved.entry.publicKeySpkiDerBase64.decodeBase64()?.toByteArray()
                ?: return false.also { localSpki.fill(0) }
        } catch (_: RuntimeException) {
            localSpki.fill(0)
            return false
        }
        return try {
            MessageDigest.isEqual(localSpki, directorySpki)
        } finally {
            localSpki.fill(0)
            directorySpki.fill(0)
        }
    }

    @Synchronized
    fun validateActivePeerLease(
        lease: AndroidResolvedPeerTrustV1,
        nowEpochMs: Long
    ): Boolean {
        if (nowEpochMs < 0L || lease.directoryExpiresAtEpochMs <= nowEpochMs) {
            return false
        }
        val wire = store.read() ?: return false
        return try {
            val directory = AndroidPeerTrustDirectoryCodecV1.verify(
                wire,
                authoritySpki,
                nowEpochMs,
                minimumRevision = lease.directoryRevision
            )
            directory.devices.singleOrNull { peer ->
                peer.status == AndroidPeerTrustStatusV1.ACTIVE &&
                    peer.nodeId == lease.entry.nodeId &&
                    peer.certificateId == lease.entry.certificateId
            }?.let { peer ->
                val spki = peer.publicKeySpkiDerBase64.decodeBase64()?.toByteArray()
                    ?: return false
                try {
                    deriveBluetoothPeerTrustIdV1(
                        peer.nodeId,
                        peer.certificateId,
                        peer.publicKeyAlgorithm,
                        spki
                    ) == lease.peerTrustId
                } finally {
                    spki.fill(0)
                }
            } == true
        } catch (_: Throwable) {
            false
        } finally {
            wire.fill(0)
        }
    }

    @Synchronized
    fun activeDirectoryExpiryEpochMs(nowEpochMs: Long): Long? {
        if (nowEpochMs < 0L) return null
        val wire = store.read() ?: return null
        return try {
            val directory = AndroidPeerTrustDirectoryCodecV1.verify(
                wire,
                authoritySpki,
                nowEpochMs
            )
            parseCanonicalPeerTrustDateEpochMs(directory.expiresAt, "expiresAt")
        } catch (_: Throwable) {
            null
        } finally {
            wire.fill(0)
        }
    }

    private fun resolveFromDirectory(
        directory: AndroidPeerTrustDirectoryV1,
        nodeId: String,
        certificateId: String?,
        observedAlias: String,
        observedEpoch: Long
    ): AndroidResolvedPeerTrustV1? =
        directory.devices.singleOrNull { peer ->
                peer.status == AndroidPeerTrustStatusV1.ACTIVE &&
                    peer.nodeId == nodeId &&
                    (certificateId == null || peer.certificateId == certificateId) &&
                    (
                        (observedEpoch == directory.aliasEpoch &&
                            observedAlias == peer.currentAlias) ||
                        (observedEpoch == directory.aliasEpoch + 1 &&
                            observedAlias == peer.nextAlias)
                    )
            }?.let { peer ->
                val spki = peer.publicKeySpkiDerBase64.decodeBase64()?.toByteArray()
                    ?: return@let null
                try {
                    AndroidResolvedPeerTrustV1(
                        entry = peer,
                        directoryRevision = directory.revision,
                        directoryExpiresAtEpochMs =
                            parseCanonicalPeerTrustDateEpochMs(directory.expiresAt, "expiresAt"),
                        observedEpoch = observedEpoch,
                        observedAlias = observedAlias,
                        peerTrustId = deriveBluetoothPeerTrustIdV1(
                            peer.nodeId,
                            peer.certificateId,
                            peer.publicKeyAlgorithm,
                            spki
                        )
                    )
                } finally {
                    spki.fill(0)
                }
            }

    @Synchronized
    override fun close() {
        authoritySpki.fill(0)
    }

    override fun toString(): String =
        "AndroidPeerTrustCacheV1(authoritySpki=<redacted>)"
}
