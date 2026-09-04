package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProtection
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.ProviderException
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.SecretKeySpec

enum class DeviceIdentityStatus {
    READY,
    FEATURE_DISABLED,
    ANDROID_KEYSTORE_UNAVAILABLE,
    ED25519_UNSUPPORTED,
    ED25519_KEY_INVALID,
    P256_UNSUPPORTED,
    P256_KEY_INVALID,
    ALIAS_KEY_UNPROVISIONED,
    ALIAS_KEY_ALREADY_PROVISIONED,
    ALIAS_KEY_INVALID,
    ALIAS_KEY_IMPORT_FAILED,
    ENROLLMENT_PENDING,
    ENROLLMENT_RESPONSE_INVALID,
    ENROLLMENT_BINDING_MISMATCH,
    ENROLLMENT_STATE_INVALID,
    NODE_ID_INVALID,
    STORAGE_ERROR,
    INVALID_INPUT,
    CRYPTO_OPERATION_FAILED,
    PROVISIONING_FAILED
}

internal enum class DeviceSigningProfile(
    val protocolVersion: Int,
    val publicKeyAlgorithm: String,
    val publicKeyEncoding: String,
    val signatureAlgorithm: String,
    val keyAlias: String
) {
    ED25519(
        protocolVersion = BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION,
        publicKeyAlgorithm = Ed25519SpkiV1.PUBLIC_KEY_ALGORITHM,
        publicKeyEncoding = Ed25519SpkiV1.ENCODING,
        signatureAlgorithm = "Ed25519",
        keyAlias = "cassav6.bluetooth.identity.ed25519.v1"
    ),
    P256(
        protocolVersion = BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION,
        publicKeyAlgorithm = P256SpkiV2.PUBLIC_KEY_ALGORITHM,
        publicKeyEncoding = P256SpkiV2.ENCODING,
        signatureAlgorithm = P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM,
        keyAlias = "cassav6.bluetooth.identity.ec-p256.v2"
    );

    fun isCanonicalSpki(spki: ByteArray): Boolean =
        when (this) {
            ED25519 -> Ed25519SpkiV1.isCanonicalEd25519Spki(spki)
            P256 -> P256SpkiV2.isCanonicalP256Spki(spki)
        }

    fun fingerprint(spki: ByteArray): String =
        when (this) {
            ED25519 -> Ed25519SpkiV1.sha256Fingerprint(spki)
            P256 -> P256SpkiV2.sha256Fingerprint(spki)
        }

    fun unsupportedStatus(): DeviceIdentityStatus =
        when (this) {
            ED25519 -> DeviceIdentityStatus.ED25519_UNSUPPORTED
            P256 -> DeviceIdentityStatus.P256_UNSUPPORTED
        }

    fun invalidKeyStatus(): DeviceIdentityStatus =
        when (this) {
            ED25519 -> DeviceIdentityStatus.ED25519_KEY_INVALID
            P256 -> DeviceIdentityStatus.P256_KEY_INVALID
        }

    companion object {
        fun fromProtocolVersion(version: Int): DeviceSigningProfile? =
            entries.firstOrNull { it.protocolVersion == version }

        fun fromPublicKeyAlgorithm(algorithm: String): DeviceSigningProfile? =
            entries.firstOrNull { it.publicKeyAlgorithm == algorithm }
    }
}

internal object DeviceSigningProfilePolicy {
    fun select(
        androidApi: Int,
        existingProfiles: Set<DeviceSigningProfile>
    ): DeviceSigningProfile? =
        when {
            existingProfiles.size > 1 -> null
            existingProfiles.size == 1 ->
                existingProfiles.single().takeUnless {
                    androidApi < Build.VERSION_CODES.TIRAMISU &&
                        it == DeviceSigningProfile.ED25519
                }
            androidApi >= Build.VERSION_CODES.TIRAMISU ->
                DeviceSigningProfile.ED25519
            else -> DeviceSigningProfile.P256
        }
}

internal object DeviceEnrollmentClaimPolicy {
    fun rejectionStatus(
        provisioningStatus: DeviceIdentityStatus
    ): DeviceIdentityStatus? =
        when (provisioningStatus) {
            DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED,
            DeviceIdentityStatus.ENROLLMENT_PENDING -> null
            DeviceIdentityStatus.READY ->
                DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
            else -> provisioningStatus
        }
}

internal object Ed25519KeyInfoFactoryPolicy {
    private const val STANDARD_ALGORITHM = "Ed25519"
    private const val LEGACY_ANDROID_KEYSTORE_ALGORITHM = "EC"

    fun candidates(reportedAlgorithm: String): List<String> =
        linkedSetOf(
            reportedAlgorithm.trim(),
            STANDARD_ALGORITHM,
            LEGACY_ANDROID_KEYSTORE_ALGORITHM
        ).filter(String::isNotEmpty)
}

data class DeviceIdentityReport(
    val enabled: Boolean,
    val status: DeviceIdentityStatus,
    val protocolVersion: Int? = null,
    val nodeId: String? = null,
    val certificateId: String? = null,
    val signingPublicKeyBase64: String? = null,
    val signingPublicKeySha256: String? = null,
    val signingKeySecurityLevel: String? = null,
    val aliasKeyBytes: Int? = null,
    val aliasKeySecurityLevel: String? = null,
    val enrollmentState: String? = null,
    val enrolledAt: String? = null,
    val validationError: String? = null,
    val signingAlgorithm: String? = null,
    val signingPublicKeyEncoding: String? = null
) {
    fun toJson(): String =
        JSONObject()
            .put("enabled", enabled)
            .put("status", status.name)
            .put("protocolVersion", protocolVersion ?: JSONObject.NULL)
            .put("nodeId", nodeId ?: JSONObject.NULL)
            .put("certificateId", certificateId ?: JSONObject.NULL)
            .put("signingAlgorithm", signingAlgorithm ?: JSONObject.NULL)
            .put(
                "signingPublicKeyEncoding",
                signingPublicKeyEncoding ?: JSONObject.NULL
            )
            .put("signingPublicKeyBase64", signingPublicKeyBase64 ?: JSONObject.NULL)
            .put("signingPublicKeySha256", signingPublicKeySha256 ?: JSONObject.NULL)
            .put("signingKeySecurityLevel", signingKeySecurityLevel ?: JSONObject.NULL)
            .put("aliasKeyAlgorithm", AliasKeyEnrollmentCodecV1.ALGORITHM)
            .put("aliasKeyEncoding", AliasKeyEnrollmentCodecV1.ENCODING)
            .put("aliasKeyBytes", aliasKeyBytes ?: JSONObject.NULL)
            .put("aliasKeySecurityLevel", aliasKeySecurityLevel ?: JSONObject.NULL)
            .put("aliasKeyProvisioned", aliasKeyBytes == RotatingAliasV1.ALIAS_KEY_BYTES)
            .put("enrollmentState", enrollmentState ?: JSONObject.NULL)
            .put("enrolledAt", enrolledAt ?: JSONObject.NULL)
            .put("validationError", validationError ?: JSONObject.NULL)
            .put("privateKeyExportable", false)
            .put("aliasKeyExportable", false)
            .put("advertisementIncludesNodeId", false)
            .toString()
}

data class RotatingAliasResult(
    val status: DeviceIdentityStatus,
    val alias: String? = null,
    val epoch: Long? = null
)

data class DeviceSignatureResult(
    val status: DeviceIdentityStatus,
    val signature: ByteArray? = null
)

data class DeviceAuthenticationMacResult(
    val status: DeviceIdentityStatus,
    val proof: ByteArray? = null
)

data class DeviceAuthenticationMacVerificationResult(
    val status: DeviceIdentityStatus,
    val verified: Boolean = false
)

class DeviceIdentityManager(
    context: Context,
    private val enabled: Boolean
) : BluetoothMutualAuthIdentityPort {
    private val appContext = context.applicationContext

    fun provision(): DeviceIdentityReport {
        if (!enabled) return disabledReport()
        return synchronized(identityLock) {
            when (val coreResult = safeLoadOrCreateCoreIdentity()) {
                is LoadResult.Failure -> failureReport(coreResult.status)
                is LoadResult.Ready -> inspectProvisioningState(coreResult.value)
            }
        }
    }

    internal fun inspectExistingIdentity(): DeviceIdentityReport {
        if (!enabled) return disabledReport()
        return synchronized(identityLock) {
            when (val result = safeLoadExistingReadyMaterial()) {
                is LoadResult.Failure -> failureReport(result.status)
                is LoadResult.Ready -> result.value.core.toReport(
                    DeviceIdentityStatus.READY,
                    result.value.binding,
                    result.value.aliasKey
                )
            }
        }
    }

    /**
     * Entry point reserved to a future authenticated native enrollment transport. The caller must
     * provide the complete response as an already strictly parsed object whose parser rejected
     * duplicate JSON keys. It is intentionally not exposed to WebView JavaScript, and B1 never
     * overwrites an existing alias key.
     */
    internal fun importAuthenticatedEnrollmentResponse(
        responseFields: Map<String, Any?>
    ): DeviceIdentityReport {
        if (!enabled) return disabledReport()

        return synchronized(identityLock) {
            val core =
                when (val coreResult = safeLoadOrCreateCoreIdentity()) {
                    is LoadResult.Failure -> return@synchronized failureReport(coreResult.status)
                    is LoadResult.Ready -> coreResult.value
                }
            when (core.signingProfile) {
                DeviceSigningProfile.ED25519 ->
                    when (
                        val validation = EnrollmentResponseValidatorV1.validate(
                            fields = responseFields,
                            localIdentity = core.toLocalEnrollmentIdentityV1()
                        )
                    ) {
                        is EnrollmentResponseValidationResult.Failure ->
                            core.toReport(
                                status = DeviceIdentityStatus.ENROLLMENT_RESPONSE_INVALID,
                                validationError = validation.code.name
                            )
                        is EnrollmentResponseValidationResult.Ready -> {
                            try {
                                completeEnrollment(
                                    core,
                                    validation.response.toMaterial()
                                )
                            } finally {
                                validation.response.aliasKey.fill(0)
                            }
                        }
                    }
                DeviceSigningProfile.P256 ->
                    when (
                        val validation = EnrollmentResponseValidatorV2.validate(
                            fields = responseFields,
                            localIdentity = core.toLocalEnrollmentIdentityV2()
                        )
                    ) {
                        is EnrollmentResponseValidationResultV2.Failure ->
                            core.toReport(
                                status = DeviceIdentityStatus.ENROLLMENT_RESPONSE_INVALID,
                                validationError = validation.code.name
                            )
                        is EnrollmentResponseValidationResultV2.Ready -> {
                            try {
                                completeEnrollment(
                                    core,
                                    validation.response.toMaterial()
                                )
                            } finally {
                                validation.response.aliasKey.fill(0)
                            }
                        }
                    }
            }
        }
    }

    /**
     * Creates a proof-of-possession claim for the native TLS enrollment client.
     * The private key remains in Android Keystore and only the signature leaves
     * this manager.
     */
    internal fun createAuthenticatedEnrollmentClaim(
        qr: BluetoothEnrollmentQrV1
    ): BluetoothEnrollmentClaimResult {
        if (!enabled) {
            return BluetoothEnrollmentClaimResult.Failure(
                DeviceIdentityStatus.FEATURE_DISABLED
            )
        }
        if (
            qr.version != BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION ||
            !BluetoothEnrollmentProtocolV1.isCanonicalEndpointId(
                qr.enrollmentEndpointId
            ) ||
            !BluetoothEnrollmentProtocolV1.isCanonicalToken(qr.token)
        ) {
            return BluetoothEnrollmentClaimResult.Failure(
                DeviceIdentityStatus.INVALID_INPUT
            )
        }

        return synchronized(identityLock) {
            val core =
                when (val coreResult = safeLoadOrCreateCoreIdentity()) {
                    is LoadResult.Failure ->
                        return@synchronized BluetoothEnrollmentClaimResult.Failure(
                            coreResult.status
                        )
                    is LoadResult.Ready -> coreResult.value
                }
            val provisioningStatus = inspectProvisioningState(core).status
            if (core.signingProfile != DeviceSigningProfile.ED25519) {
                return@synchronized BluetoothEnrollmentClaimResult.Failure(
                    DeviceIdentityStatus.INVALID_INPUT
                )
            }
            val rejectionStatus =
                DeviceEnrollmentClaimPolicy.rejectionStatus(provisioningStatus)
            if (rejectionStatus != null) {
                return@synchronized BluetoothEnrollmentClaimResult.Failure(
                    rejectionStatus
                )
            }

            val proof = BluetoothEnrollmentProtocolV1.proofBytes(
                protocolVersion = BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION,
                enrollmentEndpointId = qr.enrollmentEndpointId,
                token = qr.token,
                nodeId = core.nodeId,
                publicKeySpkiDerBase64 = core.publicKeySpkiDerBase64
            )
            try {
                val signer = Signature.getInstance(ED25519_SIGNATURE)
                signer.initSign(core.privateKey)
                signer.update(proof)
                val signature = signer.sign()
                try {
                    if (signature.size != SIGNATURE_BYTES) {
                        return@synchronized BluetoothEnrollmentClaimResult.Failure(
                            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                        )
                    }
                    val signatureBase64 =
                        Base64.encodeToString(signature, Base64.NO_WRAP)
                    if (
                        !BluetoothEnrollmentProtocolV1.isCanonicalSignature(
                            signatureBase64
                        )
                    ) {
                        return@synchronized BluetoothEnrollmentClaimResult.Failure(
                            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                        )
                    }
                    BluetoothEnrollmentClaimResult.Ready(
                        BluetoothEnrollmentRequestV1(
                            protocolVersion =
                                BluetoothEnrollmentProtocolV1.PROTOCOL_VERSION,
                            enrollmentEndpointId = qr.enrollmentEndpointId,
                            token = qr.token,
                            nodeId = core.nodeId,
                            publicKeySpkiDerBase64 =
                                core.publicKeySpkiDerBase64,
                            proofSignatureBase64 = signatureBase64
                        )
                    )
                } finally {
                    signature.fill(0)
                }
            } catch (_: Exception) {
                BluetoothEnrollmentClaimResult.Failure(
                    DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                )
            } finally {
                proof.fill(0)
            }
        }
    }

    internal fun createAuthenticatedEnrollmentClaim(
        qr: BluetoothEnrollmentQrV2
    ): BluetoothEnrollmentClaimResultV2 {
        if (!enabled) {
            return BluetoothEnrollmentClaimResultV2.Failure(
                DeviceIdentityStatus.FEATURE_DISABLED
            )
        }
        if (
            qr.version != BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION ||
            !BluetoothEnrollmentProtocolV2.isCanonicalEndpointId(
                qr.enrollmentEndpointId
            ) ||
            !BluetoothEnrollmentProtocolV2.isCanonicalToken(qr.token)
        ) {
            return BluetoothEnrollmentClaimResultV2.Failure(
                DeviceIdentityStatus.INVALID_INPUT
            )
        }

        return synchronized(identityLock) {
            val core =
                when (val coreResult = safeLoadOrCreateCoreIdentity()) {
                    is LoadResult.Failure ->
                        return@synchronized BluetoothEnrollmentClaimResultV2.Failure(
                            coreResult.status
                        )
                    is LoadResult.Ready -> coreResult.value
                }
            if (core.signingProfile != DeviceSigningProfile.P256) {
                return@synchronized BluetoothEnrollmentClaimResultV2.Failure(
                    DeviceIdentityStatus.INVALID_INPUT
                )
            }
            val provisioningStatus = inspectProvisioningState(core).status
            val rejectionStatus =
                DeviceEnrollmentClaimPolicy.rejectionStatus(provisioningStatus)
            if (rejectionStatus != null) {
                return@synchronized BluetoothEnrollmentClaimResultV2.Failure(
                    rejectionStatus
                )
            }

            val proof = BluetoothEnrollmentProtocolV2.proofBytes(
                protocolVersion = BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION,
                enrollmentEndpointId = qr.enrollmentEndpointId,
                token = qr.token,
                nodeId = core.nodeId,
                publicKeyAlgorithm =
                    BluetoothEnrollmentProtocolV2.PUBLIC_KEY_ALGORITHM,
                proofAlgorithm =
                    BluetoothEnrollmentProtocolV2.PROOF_ALGORITHM,
                publicKeySpkiDerBase64 = core.publicKeySpkiDerBase64
            )
            try {
                val signature = signP256(core.privateKey, proof)
                    ?: return@synchronized BluetoothEnrollmentClaimResultV2.Failure(
                        DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                    )
                try {
                    val signatureBase64 =
                        Base64.encodeToString(signature, Base64.NO_WRAP)
                    if (
                        !BluetoothEnrollmentProtocolV2.isCanonicalSignature(
                            signatureBase64
                        )
                    ) {
                        return@synchronized BluetoothEnrollmentClaimResultV2.Failure(
                            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                        )
                    }
                    BluetoothEnrollmentClaimResultV2.Ready(
                        BluetoothEnrollmentRequestV2(
                            protocolVersion =
                                BluetoothEnrollmentProtocolV2.PROTOCOL_VERSION,
                            enrollmentEndpointId = qr.enrollmentEndpointId,
                            token = qr.token,
                            nodeId = core.nodeId,
                            publicKeySpkiDerBase64 =
                                core.publicKeySpkiDerBase64,
                            proofSignatureBase64 = signatureBase64,
                            publicKeyAlgorithm =
                                BluetoothEnrollmentProtocolV2.PUBLIC_KEY_ALGORITHM,
                            proofAlgorithm =
                                BluetoothEnrollmentProtocolV2.PROOF_ALGORITHM
                        )
                    )
                } finally {
                    signature.fill(0)
                }
            } catch (_: Exception) {
                BluetoothEnrollmentClaimResultV2.Failure(
                    DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                )
            } finally {
                proof.fill(0)
            }
        }
    }

    fun deriveRotatingAlias(
        timestampSeconds: Long,
        epochSeconds: Long = RotatingAliasV1.DEFAULT_EPOCH_SECONDS
    ): RotatingAliasResult {
        if (!enabled) {
            return RotatingAliasResult(DeviceIdentityStatus.FEATURE_DISABLED)
        }
        return synchronized(identityLock) {
            when (val result = safeLoadReadyMaterial()) {
                is LoadResult.Failure -> RotatingAliasResult(result.status)
                is LoadResult.Ready ->
                    try {
                        RotatingAliasResult(
                            status = DeviceIdentityStatus.READY,
                            alias = RotatingAliasV1.deriveHex(
                                aliasKey = result.value.aliasKey.key,
                                nodeId = result.value.core.nodeId,
                                timestampSeconds = timestampSeconds,
                                epochSeconds = epochSeconds
                            ),
                            epoch = RotatingAliasV1.epoch(timestampSeconds, epochSeconds)
                        )
                    } catch (_: IllegalArgumentException) {
                        RotatingAliasResult(DeviceIdentityStatus.INVALID_INPUT)
                    } catch (_: Exception) {
                        RotatingAliasResult(DeviceIdentityStatus.CRYPTO_OPERATION_FAILED)
                    }
            }
        }
    }

    internal fun deriveExistingRotatingAlias(
        timestampSeconds: Long,
        epochSeconds: Long = RotatingAliasV1.DEFAULT_EPOCH_SECONDS
    ): RotatingAliasResult {
        if (!enabled) {
            return RotatingAliasResult(DeviceIdentityStatus.FEATURE_DISABLED)
        }
        return synchronized(identityLock) {
            when (val result = safeLoadExistingReadyMaterial()) {
                is LoadResult.Failure -> RotatingAliasResult(result.status)
                is LoadResult.Ready ->
                    try {
                        RotatingAliasResult(
                            status = DeviceIdentityStatus.READY,
                            alias = RotatingAliasV1.deriveHex(
                                aliasKey = result.value.aliasKey.key,
                                nodeId = result.value.core.nodeId,
                                timestampSeconds = timestampSeconds,
                                epochSeconds = epochSeconds
                            ),
                            epoch = RotatingAliasV1.epoch(timestampSeconds, epochSeconds)
                        )
                    } catch (_: IllegalArgumentException) {
                        RotatingAliasResult(DeviceIdentityStatus.INVALID_INPUT)
                    } catch (_: Exception) {
                        RotatingAliasResult(DeviceIdentityStatus.CRYPTO_OPERATION_FAILED)
                    }
            }
        }
    }

    override fun sign(message: ByteArray): DeviceSignatureResult {
        if (!enabled) {
            return DeviceSignatureResult(DeviceIdentityStatus.FEATURE_DISABLED)
        }
        return synchronized(identityLock) {
            when (val result = safeLoadReadyMaterial()) {
                is LoadResult.Failure -> DeviceSignatureResult(result.status)
                is LoadResult.Ready ->
                    try {
                        val core = result.value.core
                        val signature = when (core.signingProfile) {
                            DeviceSigningProfile.ED25519 -> {
                                val signer = Signature.getInstance(ED25519_SIGNATURE)
                                signer.initSign(core.privateKey)
                                signer.update(message)
                                signer.sign()
                            }
                            DeviceSigningProfile.P256 ->
                                signP256(core.privateKey, message)
                                    ?: return@synchronized DeviceSignatureResult(
                                        DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                                    )
                        }
                        DeviceSignatureResult(
                            status = DeviceIdentityStatus.READY,
                            signature = signature
                        )
                    } catch (_: Exception) {
                        DeviceSignatureResult(DeviceIdentityStatus.CRYPTO_OPERATION_FAILED)
                    }
            }
        }
    }

    internal fun signWithExistingIdentity(message: ByteArray): DeviceSignatureResult {
        if (!enabled) {
            return DeviceSignatureResult(DeviceIdentityStatus.FEATURE_DISABLED)
        }
        return synchronized(identityLock) {
            when (val result = safeLoadExistingReadyMaterial()) {
                is LoadResult.Failure -> DeviceSignatureResult(result.status)
                is LoadResult.Ready -> signWithCore(result.value.core, message)
            }
        }
    }

    private fun signWithCore(
        core: CoreIdentity,
        message: ByteArray
    ): DeviceSignatureResult {
        return try {
            val signature = when (core.signingProfile) {
                DeviceSigningProfile.ED25519 -> {
                    val signer = Signature.getInstance(ED25519_SIGNATURE)
                    signer.initSign(core.privateKey)
                    signer.update(message)
                    signer.sign()
                }
                DeviceSigningProfile.P256 ->
                    signP256(core.privateKey, message)
                        ?: return DeviceSignatureResult(
                            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                        )
            }
            DeviceSignatureResult(
                status = DeviceIdentityStatus.READY,
                signature = signature
            )
        } catch (_: Exception) {
            DeviceSignatureResult(DeviceIdentityStatus.CRYPTO_OPERATION_FAILED)
        }
    }

    private fun signP256(
        privateKey: PrivateKey,
        message: ByteArray
    ): ByteArray? =
        runCatching {
            val signer = Signature.getInstance(
                P256EcdsaSignatureV2.JCA_SIGNATURE_ALGORITHM
            )
            signer.initSign(privateKey)
            signer.update(message)
            val der = signer.sign()
            try {
                P256EcdsaSignatureV2.derToCanonicalP1363(der)
            } finally {
                der.fill(0)
            }
        }.getOrNull()

    override fun createAuthenticationMac(
        message: ByteArray
    ): DeviceAuthenticationMacResult {
        if (!enabled) {
            return DeviceAuthenticationMacResult(
                DeviceIdentityStatus.FEATURE_DISABLED
            )
        }
        if (message.isEmpty()) {
            return DeviceAuthenticationMacResult(DeviceIdentityStatus.INVALID_INPUT)
        }
        return synchronized(identityLock) {
            when (val result = safeLoadReadyMaterial()) {
                is LoadResult.Failure ->
                    DeviceAuthenticationMacResult(result.status)
                is LoadResult.Ready ->
                    try {
                        val mac = Mac.getInstance(RotatingAliasV1.HMAC_ALGORITHM)
                        mac.init(result.value.aliasKey.key)
                        val proof = mac.doFinal(message)
                        if (proof.size != AUTHENTICATION_MAC_BYTES) {
                            proof.fill(0)
                            DeviceAuthenticationMacResult(
                                DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                            )
                        } else {
                            DeviceAuthenticationMacResult(
                                status = DeviceIdentityStatus.READY,
                                proof = proof
                            )
                        }
                    } catch (_: Exception) {
                        DeviceAuthenticationMacResult(
                            DeviceIdentityStatus.CRYPTO_OPERATION_FAILED
                        )
                    }
            }
        }
    }

    override fun verifyAuthenticationMac(
        message: ByteArray,
        proof: ByteArray
    ): DeviceAuthenticationMacVerificationResult {
        if (proof.size != AUTHENTICATION_MAC_BYTES || message.isEmpty()) {
            return DeviceAuthenticationMacVerificationResult(
                DeviceIdentityStatus.INVALID_INPUT
            )
        }
        val expected = createAuthenticationMac(message)
        val expectedProof = expected.proof
            ?: return DeviceAuthenticationMacVerificationResult(expected.status)
        return try {
            DeviceAuthenticationMacVerificationResult(
                status = DeviceIdentityStatus.READY,
                verified = MessageDigest.isEqual(expectedProof, proof)
            )
        } finally {
            expectedProof.fill(0)
        }
    }

    private fun inspectProvisioningState(core: CoreIdentity): DeviceIdentityReport {
        val binding =
            when (val result = readEnrollmentBinding()) {
                is LoadResult.Failure -> return core.toReport(result.status)
                is LoadResult.Ready -> result.value
            }
        val keyStore =
            when (val result = openAndroidKeyStore()) {
                is LoadResult.Failure -> return core.toReport(result.status, binding)
                is LoadResult.Ready -> result.value
            }
        return when (val aliasResult = loadAliasKey(keyStore)) {
            is LoadResult.Failure -> {
                if (aliasResult.status != DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED) {
                    core.toReport(aliasResult.status, binding)
                } else {
                    when (binding?.state) {
                        null ->
                            core.toReport(DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED)
                        StoredEnrollmentState.PENDING ->
                            if (binding.matchesCore(core)) {
                                core.toReport(
                                    DeviceIdentityStatus.ENROLLMENT_PENDING,
                                    binding
                                )
                            } else {
                                core.toReport(
                                    DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                                    binding
                                )
                            }
                        StoredEnrollmentState.READY ->
                            core.toReport(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID, binding)
                    }
                }
            }
            is LoadResult.Ready -> {
                when {
                    binding == null ->
                        core.toReport(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID,
                            aliasKey = aliasResult.value
                        )
                    !binding.matchesCore(core) ->
                        core.toReport(
                            DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                            binding,
                            aliasResult.value
                        )
                    !aliasKeyMatchesBinding(aliasResult.value.key, binding) ->
                        core.toReport(
                            DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                            binding,
                            aliasResult.value
                        )
                    binding.state == StoredEnrollmentState.PENDING ->
                        if (
                            writeEnrollmentBinding(
                                binding.copy(state = StoredEnrollmentState.READY)
                            )
                        ) {
                            core.toReport(
                                DeviceIdentityStatus.READY,
                                binding.copy(state = StoredEnrollmentState.READY),
                                aliasResult.value
                            )
                        } else {
                            core.toReport(
                                DeviceIdentityStatus.ENROLLMENT_PENDING,
                                binding,
                                aliasResult.value
                            )
                        }
                    else ->
                        core.toReport(
                            DeviceIdentityStatus.READY,
                            binding,
                            aliasResult.value
                        )
                }
            }
        }
    }

    private fun completeEnrollment(
        core: CoreIdentity,
        response: ValidatedEnrollmentResponseMaterial
    ): DeviceIdentityReport {
        val keyStore =
            when (val result = openAndroidKeyStore()) {
                is LoadResult.Failure -> return core.toReport(result.status)
                is LoadResult.Ready -> result.value
            }
        val storedBinding =
            when (val result = readEnrollmentBinding()) {
                is LoadResult.Failure -> return core.toReport(result.status)
                is LoadResult.Ready -> result.value
            }
        val responseAliasVerifier =
            aliasKeyVerifier(
                aliasKeyBytes = response.aliasKey,
                nodeId = response.nodeId,
                certificateId = response.certificateId
            )
        val requestedBinding =
            EnrollmentBinding.from(response, responseAliasVerifier)
        val aliasExists =
            try {
                keyStore.containsAlias(ALIAS_KEY_ALIAS)
            } catch (_: Exception) {
                return core.toReport(DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE)
            }

        if (storedBinding?.state == StoredEnrollmentState.READY) {
            val existingAlias =
                when (val result = loadAliasKey(keyStore)) {
                    is LoadResult.Failure ->
                        return core.toReport(
                            status =
                                if (
                                    result.status ==
                                    DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED
                                ) {
                                    DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                                } else {
                                    result.status
                                },
                            binding = storedBinding
                        )
                    is LoadResult.Ready -> result.value
                }
            if (!aliasKeyMatchesBinding(existingAlias.key, storedBinding)) {
                return core.toReport(
                    DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                    storedBinding,
                    existingAlias
                )
            }
            return core.toReport(
                status =
                    if (
                        storedBinding.matchesResponse(
                            response,
                            responseAliasVerifier
                        )
                    ) {
                        DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
                    } else {
                        DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH
                },
                binding = storedBinding,
                aliasKey = existingAlias
            )
        }
        if (
            storedBinding?.state == StoredEnrollmentState.PENDING &&
            !storedBinding.matchesResponse(response, responseAliasVerifier)
        ) {
            return core.toReport(
                DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                storedBinding
            )
        }
        if (storedBinding == null && aliasExists) {
            return core.toReport(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
        }

        val pendingBinding =
            storedBinding ?: requestedBinding.copy(state = StoredEnrollmentState.PENDING)
        if (storedBinding == null && !writeEnrollmentBinding(pendingBinding)) {
            return core.toReport(DeviceIdentityStatus.STORAGE_ERROR)
        }

        val aliasKey =
            if (aliasExists) {
                when (val result = loadAliasKey(keyStore)) {
                    is LoadResult.Failure -> return core.toReport(result.status, pendingBinding)
                    is LoadResult.Ready -> result.value
                }
            } else {
                if (
                    AliasKeyProvisioningPolicy.decide(false) !=
                    AliasKeyImportDecision.IMPORT_NEW
                ) {
                    return core.toReport(
                        DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED,
                        pendingBinding
                    )
                }
                val workingCopy = response.aliasKey.copyOf()
                try {
                    when (val result = importAliasKey(keyStore, workingCopy)) {
                        is LoadResult.Failure ->
                            return core.toReport(result.status, pendingBinding)
                        is LoadResult.Ready -> result.value
                    }
                } finally {
                    workingCopy.fill(0)
                }
            }

        if (!aliasKeyMatchesBinding(aliasKey.key, pendingBinding)) {
            return core.toReport(
                DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH,
                pendingBinding,
                aliasKey
            )
        }
        val readyBinding = pendingBinding.copy(state = StoredEnrollmentState.READY)
        if (!writeEnrollmentBinding(readyBinding)) {
            return core.toReport(
                DeviceIdentityStatus.ENROLLMENT_PENDING,
                pendingBinding,
                aliasKey
            )
        }
        return core.toReport(DeviceIdentityStatus.READY, readyBinding, aliasKey)
    }

    private fun loadReadyMaterial(): LoadResult<IdentityMaterial> {
        val core =
            when (val result = loadOrCreateCoreIdentity()) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        val binding =
            when (val result = readEnrollmentBinding()) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            } ?: return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED)
        if (binding.state != StoredEnrollmentState.READY) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_PENDING)
        }
        if (!binding.matchesCore(core)) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH)
        }
        val keyStore =
            when (val result = openAndroidKeyStore()) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        val aliasKey =
            when (val result = loadAliasKey(keyStore)) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        if (!aliasKeyMatchesBinding(aliasKey.key, binding)) {
            return LoadResult.Failure(
                DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH
            )
        }
        return LoadResult.Ready(IdentityMaterial(core, aliasKey, binding))
    }

    private fun loadExistingReadyMaterial(): LoadResult<IdentityMaterial> {
        val core = when (val result = loadExistingCoreIdentity()) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        val binding = when (val result = readEnrollmentBinding()) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        } ?: return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED)
        if (binding.state != StoredEnrollmentState.READY) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_PENDING)
        }
        if (!binding.matchesCore(core)) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH)
        }
        val keyStore = when (val result = openAndroidKeyStore()) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        val aliasKey = when (val result = loadAliasKey(keyStore)) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        if (!aliasKeyMatchesBinding(aliasKey.key, binding)) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_BINDING_MISMATCH)
        }
        return LoadResult.Ready(IdentityMaterial(core, aliasKey, binding))
    }

    private fun loadExistingCoreIdentity(): LoadResult<CoreIdentity> {
        val keyStore = when (val result = openAndroidKeyStore()) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        val existingProfiles = try {
            DeviceSigningProfile.entries.filter { keyStore.containsAlias(it.keyAlias) }
        } catch (_: Exception) {
            return LoadResult.Failure(DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE)
        }
        if (existingProfiles.size != 1) {
            return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
        }
        val profile = DeviceSigningProfilePolicy.select(
            Build.VERSION.SDK_INT,
            existingProfiles.toSet()
        ) ?: return LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
        val signing = when (val result = loadSigningKey(keyStore, profile)) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        val nodeId = when (val result = loadExistingNodeId()) {
            is LoadResult.Failure -> return result
            is LoadResult.Ready -> result.value
        }
        val publicKeySpki = signing.publicKey.encoded
            ?: return LoadResult.Failure(signing.profile.invalidKeyStatus())
        if (!signing.profile.isCanonicalSpki(publicKeySpki)) {
            return LoadResult.Failure(signing.profile.invalidKeyStatus())
        }
        return LoadResult.Ready(
            CoreIdentity(
                nodeId = nodeId,
                privateKey = signing.privateKey,
                publicKey = signing.publicKey,
                publicKeySpkiDerBase64 =
                    Base64.encodeToString(publicKeySpki, Base64.NO_WRAP),
                publicKeySha256 = signing.profile.fingerprint(publicKeySpki),
                securityLevel = signing.securityLevel,
                signingProfile = signing.profile
            )
        )
    }

    private fun loadOrCreateCoreIdentity(): LoadResult<CoreIdentity> {
        val keyStore =
            when (val result = openAndroidKeyStore()) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        val signing =
            when (val result = ensureSigningKey(keyStore)) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        val nodeId =
            when (val result = loadOrCreateNodeId()) {
                is LoadResult.Failure -> return result
                is LoadResult.Ready -> result.value
            }
        val publicKeySpki =
            signing.publicKey.encoded
                ?: return LoadResult.Failure(
                    signing.profile.invalidKeyStatus()
                )
        if (!signing.profile.isCanonicalSpki(publicKeySpki)) {
            return LoadResult.Failure(signing.profile.invalidKeyStatus())
        }
        return LoadResult.Ready(
            CoreIdentity(
                nodeId = nodeId,
                privateKey = signing.privateKey,
                publicKey = signing.publicKey,
                publicKeySpkiDerBase64 =
                    Base64.encodeToString(publicKeySpki, Base64.NO_WRAP),
                publicKeySha256 = signing.profile.fingerprint(publicKeySpki),
                securityLevel = signing.securityLevel,
                signingProfile = signing.profile
            )
        )
    }

    private fun safeLoadOrCreateCoreIdentity(): LoadResult<CoreIdentity> =
        try {
            loadOrCreateCoreIdentity()
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.PROVISIONING_FAILED)
        }

    private fun safeLoadReadyMaterial(): LoadResult<IdentityMaterial> =
        try {
            loadReadyMaterial()
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.PROVISIONING_FAILED)
        }

    private fun safeLoadExistingReadyMaterial(): LoadResult<IdentityMaterial> =
        try {
            loadExistingReadyMaterial()
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.PROVISIONING_FAILED)
        }

    private fun openAndroidKeyStore(): LoadResult<KeyStore> =
        try {
            LoadResult.Ready(
                KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            )
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE)
        }

    private fun ensureSigningKey(keyStore: KeyStore): LoadResult<SigningMaterial> {
        val existingProfiles =
            try {
                DeviceSigningProfile.entries.filter {
                    keyStore.containsAlias(it.keyAlias)
                }
            } catch (_: Exception) {
                return LoadResult.Failure(
                    DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE
                )
            }
        if (existingProfiles.size > 1) {
            return LoadResult.Failure(
                DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
            )
        }
        val profile = DeviceSigningProfilePolicy.select(
            Build.VERSION.SDK_INT,
            existingProfiles.toSet()
        ) ?: return LoadResult.Failure(
            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
        )
        if (existingProfiles.isEmpty()) {
            val generator =
                try {
                    KeyPairGenerator.getInstance(
                        KeyProperties.KEY_ALGORITHM_EC,
                        ANDROID_KEYSTORE
                    )
                } catch (_: Exception) {
                    return LoadResult.Failure(profile.unsupportedStatus())
                }
            try {
                val builder = KeyGenParameterSpec.Builder(
                    profile.keyAlias,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                when (profile) {
                    DeviceSigningProfile.ED25519 ->
                        builder
                            .setAlgorithmParameterSpec(ECGenParameterSpec("ed25519"))
                            .setDigests(KeyProperties.DIGEST_NONE)
                    DeviceSigningProfile.P256 ->
                        builder
                            .setAlgorithmParameterSpec(
                                ECGenParameterSpec(P256SpkiV2.CURVE_NAME)
                            )
                            .setDigests(KeyProperties.DIGEST_SHA256)
                }
                generator.initialize(builder.build())
                generator.generateKeyPair()
            } catch (_: ProviderException) {
                return LoadResult.Failure(profile.unsupportedStatus())
            } catch (_: Exception) {
                return LoadResult.Failure(profile.unsupportedStatus())
            }
        }
        return loadSigningKey(keyStore, profile)
    }

    private fun loadSigningKey(
        keyStore: KeyStore,
        profile: DeviceSigningProfile
    ): LoadResult<SigningMaterial> {
        return try {
            /*
             * Some Android Keystore providers expose Ed25519 and EdDSA as
             * equivalent but different algorithm names. KeyStore.getEntry()
             * constructs PrivateKeyEntry, which rejects that harmless naming
             * mismatch before this code can validate the actual key material.
             */
            val privateKey =
                keyStore.getKey(profile.keyAlias, null) as? PrivateKey
                    ?: return invalidSigningKey(profile, "PRIVATE_KEY_TYPE")
            val publicKey =
                keyStore.getCertificate(profile.keyAlias)?.publicKey
                    ?: return invalidSigningKey(profile, "PUBLIC_CERTIFICATE")
            val publicSpki =
                publicKey.encoded
                    ?: return invalidSigningKey(profile, "PUBLIC_KEY_NOT_ENCODED")
            val expectedPurposes =
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            if (
                profile == DeviceSigningProfile.ED25519 &&
                (!isEd25519(privateKey.algorithm) || !isEd25519(publicKey.algorithm))
            ) {
                return invalidSigningKey(profile, "KEY_ALGORITHM")
            }
            if (
                profile == DeviceSigningProfile.P256 &&
                (
                    !privateKey.algorithm.equals("EC", ignoreCase = true) ||
                    !publicKey.algorithm.equals("EC", ignoreCase = true)
                )
            ) {
                return invalidSigningKey(profile, "KEY_ALGORITHM")
            }
            if (privateKey.encoded != null) {
                return invalidSigningKey(profile, "PRIVATE_KEY_EXPORTABLE")
            }
            if (privateKey.format != null) {
                return invalidSigningKey(profile, "PRIVATE_KEY_FORMAT")
            }
            if (!profile.isCanonicalSpki(publicSpki)) {
                return invalidSigningKey(profile, "PUBLIC_SPKI")
            }
            val keyInfo =
                loadSigningKeyInfo(privateKey, profile)
                    ?: return invalidSigningKey(profile, "KEY_INFO_UNAVAILABLE")
            if (keyInfo.origin != KeyProperties.ORIGIN_GENERATED) {
                return invalidSigningKey(
                    profile,
                    "KEY_INFO_ORIGIN_${keyInfo.origin}"
                )
            }
            if (keyInfo.keySize != SIGNING_KEY_BITS) {
                return invalidSigningKey(profile, "KEY_INFO_SIZE_${keyInfo.keySize}")
            }
            if (keyInfo.purposes != expectedPurposes) {
                return invalidSigningKey(
                    profile,
                    "KEY_INFO_PURPOSES_${keyInfo.purposes}"
                )
            }
            val digests =
                runCatching { keyInfo.digests.toSet() }.getOrElse {
                    return invalidSigningKey(
                        profile,
                        "KEY_INFO_DIGESTS_UNAVAILABLE"
                    )
                }
            val expectedDigests = when (profile) {
                DeviceSigningProfile.ED25519 -> setOf(KeyProperties.DIGEST_NONE)
                DeviceSigningProfile.P256 -> setOf(KeyProperties.DIGEST_SHA256)
            }
            if (digests != expectedDigests) {
                return invalidSigningKey(
                    profile,
                    "KEY_INFO_DIGESTS_${digests.sorted().joinToString("_")}"
                )
            }
            if (!signingOperationSelfTest(privateKey, profile)) {
                return invalidSigningKey(profile, "SIGNATURE_SELF_TEST")
            }
            LoadResult.Ready(
                SigningMaterial(
                    privateKey = privateKey,
                    publicKey = publicKey,
                    securityLevel = describeSecurityLevel(keyInfo),
                    profile = profile
                )
            )
        } catch (error: Exception) {
            invalidSigningKey(
                profile,
                "EXCEPTION_${error.javaClass.simpleName}"
            )
        }
    }

    private fun invalidSigningKey(
        profile: DeviceSigningProfile,
        reason: String
    ): LoadResult.Failure {
        val qualifiedReason = "${profile.name}_$reason"
        val shouldLog =
            synchronized(loggedSigningKeyRejections) {
                loggedSigningKeyRejections.add(qualifiedReason)
            }
        if (shouldLog) {
            Log.w(LOG_TAG, "${profile.publicKeyAlgorithm} signing key rejected: $reason")
        }
        return LoadResult.Failure(profile.invalidKeyStatus())
    }

    private fun loadSigningKeyInfo(
        privateKey: PrivateKey,
        profile: DeviceSigningProfile
    ): KeyInfo? {
        val algorithms = when (profile) {
            DeviceSigningProfile.ED25519 ->
                Ed25519KeyInfoFactoryPolicy.candidates(privateKey.algorithm)
            DeviceSigningProfile.P256 -> listOf(KeyProperties.KEY_ALGORITHM_EC)
        }
        for (algorithm in algorithms) {
            val keyInfo =
                runCatching {
                    KeyFactory
                        .getInstance(algorithm, ANDROID_KEYSTORE)
                        .getKeySpec(privateKey, KeyInfo::class.java) as KeyInfo
                }.getOrNull()
            if (keyInfo != null) return keyInfo
        }
        return null
    }

    /*
     * Android 13/14 can sign Ed25519 through AndroidKeyStore but AOSP does not
     * ship a matching public-key verifier. The exact SPKI/OID is checked above;
     * this operation test verifies deterministic 64-byte Keystore signatures.
     */
    private fun signingOperationSelfTest(
        privateKey: PrivateKey,
        profile: DeviceSigningProfile
    ): Boolean =
        runCatching {
            val challenge = when (profile) {
                DeviceSigningProfile.ED25519 -> SIGNING_SELF_TEST_CONTEXT
                DeviceSigningProfile.P256 -> P256_SIGNING_SELF_TEST_CONTEXT
            }.toByteArray(Charsets.UTF_8)
            when (profile) {
                DeviceSigningProfile.ED25519 -> {
                    fun signOnce(): ByteArray {
                        val signer = Signature.getInstance(ED25519_SIGNATURE)
                        signer.initSign(privateKey)
                        signer.update(challenge)
                        return signer.sign()
                    }
                    val first = signOnce()
                    val second = signOnce()
                    first.size == SIGNATURE_BYTES &&
                        second.size == SIGNATURE_BYTES &&
                        MessageDigest.isEqual(first, second)
                }
                DeviceSigningProfile.P256 -> {
                    val signature = signP256(privateKey, challenge)
                    signature != null &&
                        P256EcdsaSignatureV2.isCanonicalP1363(signature)
                }
            }
        }.getOrDefault(false)

    private fun loadAliasKey(keyStore: KeyStore): LoadResult<AliasKeyMaterial> {
        return try {
            if (!keyStore.containsAlias(ALIAS_KEY_ALIAS)) {
                return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_UNPROVISIONED)
            }
            val key = keyStore.getKey(ALIAS_KEY_ALIAS, null)
            if (
                key !is SecretKey ||
                !key.algorithm.equals(RotatingAliasV1.HMAC_ALGORITHM, ignoreCase = true) ||
                key.encoded != null ||
                key.format != null
            ) {
                return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_INVALID)
            }
            val keyInfo = SecretKeyFactory
                .getInstance(key.algorithm, ANDROID_KEYSTORE)
                .getKeySpec(key, KeyInfo::class.java) as? KeyInfo
                ?: return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_INVALID)
            val importedOrigin =
                keyInfo.origin == KeyProperties.ORIGIN_IMPORTED ||
                    (
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                            keyInfo.origin == KeyProperties.ORIGIN_SECURELY_IMPORTED
                        )
            val expectedPurposes =
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            if (
                keyInfo.keySize != RotatingAliasV1.ALIAS_KEY_BYTES * Byte.SIZE_BITS ||
                !importedOrigin ||
                keyInfo.purposes != expectedPurposes ||
                keyInfo.digests.toSet() != setOf(KeyProperties.DIGEST_SHA256)
            ) {
                return LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_INVALID)
            }
            LoadResult.Ready(
                AliasKeyMaterial(
                    key = key,
                    securityLevel = describeSecurityLevel(keyInfo)
                )
            )
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_INVALID)
        }
    }

    private fun importAliasKey(
        keyStore: KeyStore,
        aliasKeyBytes: ByteArray
    ): LoadResult<AliasKeyMaterial> {
        if (aliasKeyBytes.size != RotatingAliasV1.ALIAS_KEY_BYTES) {
            return LoadResult.Failure(DeviceIdentityStatus.INVALID_INPUT)
        }
        return try {
            if (keyStore.containsAlias(ALIAS_KEY_ALIAS)) {
                return LoadResult.Failure(
                    DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
                )
            }
            val importedKey = SecretKeySpec(
                aliasKeyBytes,
                RotatingAliasV1.HMAC_ALGORITHM
            )
            val protection = KeyProtection.Builder(
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
            try {
                keyStore.setEntry(
                    ALIAS_KEY_ALIAS,
                    KeyStore.SecretKeyEntry(importedKey),
                    protection
                )
                loadAliasKey(keyStore)
            } finally {
                runCatching { importedKey.destroy() }
            }
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.ALIAS_KEY_IMPORT_FAILED)
        }
    }

    private fun aliasKeyVerifier(
        aliasKeyBytes: ByteArray,
        nodeId: String,
        certificateId: String
    ): String {
        val key = SecretKeySpec(aliasKeyBytes, RotatingAliasV1.HMAC_ALGORITHM)
        return try {
            aliasKeyVerifier(key, nodeId, certificateId)
        } finally {
            runCatching { key.destroy() }
        }
    }

    private fun aliasKeyVerifier(
        aliasKey: SecretKey,
        nodeId: String,
        certificateId: String
    ): String {
        val verifier = Mac.getInstance(RotatingAliasV1.HMAC_ALGORITHM)
        verifier.init(aliasKey)
        val context =
            "$ALIAS_KEY_VERIFIER_CONTEXT\u0000$nodeId\u0000$certificateId"
        return verifier
            .doFinal(context.toByteArray(Charsets.UTF_8))
            .toHex()
    }

    private fun aliasKeyMatchesBinding(
        aliasKey: SecretKey,
        binding: EnrollmentBinding
    ): Boolean =
        runCatching {
            MessageDigest.isEqual(
                aliasKeyVerifier(
                    aliasKey,
                    binding.nodeId,
                    binding.certificateId
                ).toByteArray(Charsets.US_ASCII),
                binding.aliasKeyVerifier.toByteArray(Charsets.US_ASCII)
            )
        }.getOrDefault(false)

    private fun loadOrCreateNodeId(): LoadResult<String> {
        val preferences =
            try {
                identityPreferences()
            } catch (_: Exception) {
                return LoadResult.Failure(DeviceIdentityStatus.STORAGE_ERROR)
            }
        val existing =
            try {
                preferences.getString(NODE_ID_PREFERENCE, null)
            } catch (_: Exception) {
                return LoadResult.Failure(DeviceIdentityStatus.NODE_ID_INVALID)
            }
        if (existing != null) {
            if (!RotatingAliasV1.isCanonicalNodeId(existing)) {
                return LoadResult.Failure(DeviceIdentityStatus.NODE_ID_INVALID)
            }
            return LoadResult.Ready(existing)
        }

        val generated = UUID.randomUUID().toString().lowercase(Locale.ROOT)
        val stored =
            try {
                preferences.edit().putString(NODE_ID_PREFERENCE, generated).commit()
            } catch (_: Exception) {
                false
            }
        return if (stored) {
            LoadResult.Ready(generated)
        } else {
            LoadResult.Failure(DeviceIdentityStatus.STORAGE_ERROR)
        }
    }

    private fun loadExistingNodeId(): LoadResult<String> {
        val preferences = try {
            identityPreferences()
        } catch (_: Exception) {
            return LoadResult.Failure(DeviceIdentityStatus.STORAGE_ERROR)
        }
        val existing = try {
            preferences.getString(NODE_ID_PREFERENCE, null)
        } catch (_: Exception) {
            return LoadResult.Failure(DeviceIdentityStatus.NODE_ID_INVALID)
        } ?: return LoadResult.Failure(DeviceIdentityStatus.NODE_ID_INVALID)
        return if (RotatingAliasV1.isCanonicalNodeId(existing)) {
            LoadResult.Ready(existing)
        } else {
            LoadResult.Failure(DeviceIdentityStatus.NODE_ID_INVALID)
        }
    }

    private fun readEnrollmentBinding(): LoadResult<EnrollmentBinding?> {
        val preferences =
            try {
                identityPreferences()
            } catch (_: Exception) {
                return LoadResult.Failure(DeviceIdentityStatus.STORAGE_ERROR)
            }
        return try {
            val stateText = preferences.getString(ENROLLMENT_STATE_PREFERENCE, null)
            if (stateText == null) {
                val orphanedField = enrollmentPreferenceKeys.any(preferences::contains)
                return if (orphanedField) {
                    LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
                } else {
                    LoadResult.Ready(null)
                }
            }
            val binding = EnrollmentBinding(
                state = StoredEnrollmentState.valueOf(stateText),
                protocolVersion =
                    preferences.getInt(ENROLLMENT_PROTOCOL_PREFERENCE, -1),
                nodeId =
                    preferences.getString(ENROLLMENT_NODE_ID_PREFERENCE, null)
                        ?: return LoadResult.Failure(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                        ),
                certificateId =
                    preferences.getString(ENROLLMENT_CERTIFICATE_ID_PREFERENCE, null)
                        ?: return LoadResult.Failure(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                        ),
                publicKeySha256 =
                    preferences.getString(ENROLLMENT_PUBLIC_KEY_HASH_PREFERENCE, null)
                        ?: return LoadResult.Failure(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                        ),
                publicKeyAlgorithm =
                    preferences.getString(
                        ENROLLMENT_PUBLIC_KEY_ALGORITHM_PREFERENCE,
                        null
                    ) ?: return LoadResult.Failure(
                        DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                    ),
                publicKeySpkiDerBase64 =
                    preferences.getString(
                        ENROLLMENT_PUBLIC_KEY_SPKI_PREFERENCE,
                        null
                    ) ?: return LoadResult.Failure(
                        DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                    ),
                enrolledAt =
                    preferences.getString(ENROLLMENT_DATE_PREFERENCE, null)
                        ?: return LoadResult.Failure(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                        ),
                aliasKeyAlias =
                    preferences.getString(ENROLLMENT_ALIAS_PREFERENCE, null)
                        ?: return LoadResult.Failure(
                            DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                        ),
                aliasKeyVersion =
                    preferences.getInt(ENROLLMENT_ALIAS_VERSION_PREFERENCE, -1),
                aliasKeyAlgorithm =
                    preferences.getString(
                        ENROLLMENT_ALIAS_ALGORITHM_PREFERENCE,
                        null
                    ) ?: return LoadResult.Failure(
                        DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                    ),
                aliasKeyEncoding =
                    preferences.getString(
                        ENROLLMENT_ALIAS_ENCODING_PREFERENCE,
                        null
                    ) ?: return LoadResult.Failure(
                        DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                    ),
                aliasKeyVerifier =
                    preferences.getString(
                        ENROLLMENT_ALIAS_VERIFIER_PREFERENCE,
                        null
                    ) ?: return LoadResult.Failure(
                        DeviceIdentityStatus.ENROLLMENT_STATE_INVALID
                    )
            )
            if (!binding.isCanonical()) {
                LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
            } else {
                LoadResult.Ready(binding)
            }
        } catch (_: Exception) {
            LoadResult.Failure(DeviceIdentityStatus.ENROLLMENT_STATE_INVALID)
        }
    }

    private fun writeEnrollmentBinding(binding: EnrollmentBinding): Boolean =
        try {
            identityPreferences()
                .edit()
                .putString(ENROLLMENT_STATE_PREFERENCE, binding.state.name)
                .putInt(ENROLLMENT_PROTOCOL_PREFERENCE, binding.protocolVersion)
                .putString(ENROLLMENT_NODE_ID_PREFERENCE, binding.nodeId)
                .putString(
                    ENROLLMENT_CERTIFICATE_ID_PREFERENCE,
                    binding.certificateId
                )
                .putString(
                    ENROLLMENT_PUBLIC_KEY_HASH_PREFERENCE,
                    binding.publicKeySha256
                )
                .putString(
                    ENROLLMENT_PUBLIC_KEY_ALGORITHM_PREFERENCE,
                    binding.publicKeyAlgorithm
                )
                .putString(
                    ENROLLMENT_PUBLIC_KEY_SPKI_PREFERENCE,
                    binding.publicKeySpkiDerBase64
                )
                .putString(ENROLLMENT_DATE_PREFERENCE, binding.enrolledAt)
                .putString(ENROLLMENT_ALIAS_PREFERENCE, binding.aliasKeyAlias)
                .putInt(
                    ENROLLMENT_ALIAS_VERSION_PREFERENCE,
                    binding.aliasKeyVersion
                )
                .putString(
                    ENROLLMENT_ALIAS_ALGORITHM_PREFERENCE,
                    binding.aliasKeyAlgorithm
                )
                .putString(
                    ENROLLMENT_ALIAS_ENCODING_PREFERENCE,
                    binding.aliasKeyEncoding
                )
                .putString(
                    ENROLLMENT_ALIAS_VERIFIER_PREFERENCE,
                    binding.aliasKeyVerifier
                )
                .commit()
        } catch (_: Exception) {
            false
        }

    private fun identityPreferences() =
        appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Suppress("DEPRECATION")
    private fun describeSecurityLevel(keyInfo: KeyInfo): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (keyInfo.securityLevel) {
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ->
                    "TRUSTED_ENVIRONMENT"
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "UNKNOWN_SECURE"
                KeyProperties.SECURITY_LEVEL_UNKNOWN -> "UNKNOWN"
                else -> "UNKNOWN"
            }
        } else if (keyInfo.isInsideSecureHardware) {
            "HARDWARE_BACKED_LEGACY"
        } else {
            "SOFTWARE"
        }

    private fun CoreIdentity.toLocalEnrollmentIdentityV1(): LocalEnrollmentIdentityV1 =
        LocalEnrollmentIdentityV1(
            protocolVersion = EnrollmentResponseValidatorV1.PROTOCOL_VERSION,
            nodeId = nodeId,
            publicKeySpkiDerBase64 = publicKeySpkiDerBase64,
            publicKeySha256 = publicKeySha256
        )

    private fun CoreIdentity.toLocalEnrollmentIdentityV2(): LocalEnrollmentIdentityV2 =
        LocalEnrollmentIdentityV2(
            protocolVersion = EnrollmentResponseValidatorV2.PROTOCOL_VERSION,
            nodeId = nodeId,
            publicKeySpkiDerBase64 = publicKeySpkiDerBase64,
            publicKeySha256 = publicKeySha256
        )

    private fun ValidatedEnrollmentResponseV1.toMaterial() =
        ValidatedEnrollmentResponseMaterial(
            protocolVersion = protocolVersion,
            nodeId = nodeId,
            certificateId = certificateId,
            publicKeyAlgorithm = Ed25519SpkiV1.PUBLIC_KEY_ALGORITHM,
            publicKeySpkiDerBase64 = publicKeySpkiDerBase64,
            publicKeySha256 = publicKeySha256,
            aliasKey = aliasKey,
            enrolledAt = enrolledAt
        )

    private fun ValidatedEnrollmentResponseV2.toMaterial() =
        ValidatedEnrollmentResponseMaterial(
            protocolVersion = protocolVersion,
            nodeId = nodeId,
            certificateId = certificateId,
            publicKeyAlgorithm = P256SpkiV2.PUBLIC_KEY_ALGORITHM,
            publicKeySpkiDerBase64 = publicKeySpkiDerBase64,
            publicKeySha256 = publicKeySha256,
            aliasKey = aliasKey,
            enrolledAt = enrolledAt
        )

    private fun CoreIdentity.toReport(
        status: DeviceIdentityStatus,
        binding: EnrollmentBinding? = null,
        aliasKey: AliasKeyMaterial? = null,
        validationError: String? = null
    ): DeviceIdentityReport =
        DeviceIdentityReport(
            enabled = true,
            status = status,
            protocolVersion = signingProfile.protocolVersion,
            nodeId = nodeId,
            certificateId = binding?.certificateId,
            signingPublicKeyBase64 = publicKeySpkiDerBase64,
            signingPublicKeySha256 = publicKeySha256,
            signingKeySecurityLevel = securityLevel,
            aliasKeyBytes =
                if (aliasKey == null) null else RotatingAliasV1.ALIAS_KEY_BYTES,
            aliasKeySecurityLevel = aliasKey?.securityLevel,
            enrollmentState = binding?.state?.name ?: "UNPROVISIONED",
            enrolledAt = binding?.enrolledAt,
            validationError = validationError,
            signingAlgorithm = signingProfile.publicKeyAlgorithm,
            signingPublicKeyEncoding = signingProfile.publicKeyEncoding
        )

    private fun disabledReport(): DeviceIdentityReport =
        DeviceIdentityReport(
            enabled = false,
            status = DeviceIdentityStatus.FEATURE_DISABLED
        )

    private fun failureReport(status: DeviceIdentityStatus): DeviceIdentityReport =
        DeviceIdentityReport(enabled = true, status = status)

    private fun isEd25519(algorithm: String): Boolean =
        algorithm.equals(ED25519_SIGNATURE, ignoreCase = true) ||
            algorithm.equals("EdDSA", ignoreCase = true) ||
            algorithm == ED25519_OID

    private sealed class LoadResult<out T> {
        data class Ready<T>(val value: T) : LoadResult<T>()
        data class Failure(val status: DeviceIdentityStatus) : LoadResult<Nothing>()
    }

    private data class SigningMaterial(
        val privateKey: PrivateKey,
        val publicKey: PublicKey,
        val securityLevel: String,
        val profile: DeviceSigningProfile
    )

    private data class CoreIdentity(
        val nodeId: String,
        val privateKey: PrivateKey,
        val publicKey: PublicKey,
        val publicKeySpkiDerBase64: String,
        val publicKeySha256: String,
        val securityLevel: String,
        val signingProfile: DeviceSigningProfile
    )

    private data class AliasKeyMaterial(
        val key: SecretKey,
        val securityLevel: String
    )

    private data class IdentityMaterial(
        val core: CoreIdentity,
        val aliasKey: AliasKeyMaterial,
        val binding: EnrollmentBinding
    )

    private data class ValidatedEnrollmentResponseMaterial(
        val protocolVersion: Int,
        val nodeId: String,
        val certificateId: String,
        val publicKeyAlgorithm: String,
        val publicKeySpkiDerBase64: String,
        val publicKeySha256: String,
        val aliasKey: ByteArray,
        val enrolledAt: String
    )

    private enum class StoredEnrollmentState {
        PENDING,
        READY
    }

    private data class EnrollmentBinding(
        val state: StoredEnrollmentState,
        val protocolVersion: Int,
        val nodeId: String,
        val certificateId: String,
        val publicKeySha256: String,
        val publicKeyAlgorithm: String,
        val publicKeySpkiDerBase64: String,
        val enrolledAt: String,
        val aliasKeyAlias: String,
        val aliasKeyVersion: Int,
        val aliasKeyAlgorithm: String,
        val aliasKeyEncoding: String,
        val aliasKeyVerifier: String
    ) {
        fun isCanonical(): Boolean {
            val profile = DeviceSigningProfile.fromProtocolVersion(protocolVersion)
                ?: return false
            if (profile.publicKeyAlgorithm != publicKeyAlgorithm) return false
            return RotatingAliasV1.isCanonicalNodeId(nodeId) &&
                RotatingAliasV1.isCanonicalNodeId(certificateId) &&
                publicKeySha256.matches(Regex("^[0-9a-f]{64}$")) &&
                canonicalPublicKeyMatchesFingerprint(profile) &&
                EnrollmentResponseValidatorV1.isCanonicalUtcDate(enrolledAt) &&
                aliasKeyAlias == ALIAS_KEY_ALIAS &&
                aliasKeyVersion == ALIAS_KEY_VERSION &&
                aliasKeyAlgorithm == AliasKeyEnrollmentCodecV1.ALGORITHM &&
                aliasKeyEncoding == AliasKeyEnrollmentCodecV1.ENCODING &&
                aliasKeyVerifier.matches(Regex("^[0-9a-f]{64}$"))
        }

        fun matchesCore(core: CoreIdentity): Boolean =
            isCanonical() &&
                nodeId == core.nodeId &&
                protocolVersion == core.signingProfile.protocolVersion &&
                publicKeyAlgorithm == core.signingProfile.publicKeyAlgorithm &&
                publicKeySha256 == core.publicKeySha256 &&
                publicKeySpkiDerBase64 == core.publicKeySpkiDerBase64

        fun matchesResponse(
            response: ValidatedEnrollmentResponseMaterial,
            responseAliasVerifier: String
        ): Boolean =
            isCanonical() &&
                protocolVersion == response.protocolVersion &&
                nodeId == response.nodeId &&
                certificateId == response.certificateId &&
                publicKeyAlgorithm == response.publicKeyAlgorithm &&
                publicKeySpkiDerBase64 == response.publicKeySpkiDerBase64 &&
                publicKeySha256 == response.publicKeySha256 &&
                enrolledAt == response.enrolledAt &&
                aliasKeyAlgorithm == AliasKeyEnrollmentCodecV1.ALGORITHM &&
                aliasKeyEncoding == AliasKeyEnrollmentCodecV1.ENCODING &&
                aliasKeyVerifier == responseAliasVerifier

        private fun canonicalPublicKeyMatchesFingerprint(
            profile: DeviceSigningProfile
        ): Boolean =
            runCatching {
                val publicKey = when (profile) {
                    DeviceSigningProfile.ED25519 ->
                        Ed25519SpkiV1.decodeCanonicalBase64(
                            publicKeySpkiDerBase64
                        )
                    DeviceSigningProfile.P256 ->
                        P256SpkiV2.decodeCanonicalBase64(
                            publicKeySpkiDerBase64
                        )
                }
                profile.isCanonicalSpki(publicKey) &&
                    profile.fingerprint(publicKey) == publicKeySha256
            }.getOrDefault(false)

        companion object {
            fun from(
                response: ValidatedEnrollmentResponseMaterial,
                aliasKeyVerifier: String
            ): EnrollmentBinding =
                EnrollmentBinding(
                    state = StoredEnrollmentState.PENDING,
                    protocolVersion = response.protocolVersion,
                    nodeId = response.nodeId,
                    certificateId = response.certificateId,
                    publicKeySha256 = response.publicKeySha256,
                    publicKeyAlgorithm = response.publicKeyAlgorithm,
                    publicKeySpkiDerBase64 =
                        response.publicKeySpkiDerBase64,
                    enrolledAt = response.enrolledAt,
                    aliasKeyAlias = ALIAS_KEY_ALIAS,
                    aliasKeyVersion = ALIAS_KEY_VERSION,
                    aliasKeyAlgorithm =
                        AliasKeyEnrollmentCodecV1.ALGORITHM,
                    aliasKeyEncoding =
                        AliasKeyEnrollmentCodecV1.ENCODING,
                    aliasKeyVerifier = aliasKeyVerifier
                )
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ED25519_SIGNATURE = "Ed25519"
        private const val ED25519_OID = "1.3.101.112"
        private const val LOG_TAG = "CASSA_V6Identity"
        private const val SIGNING_KEY_BITS = 256
        private const val SIGNATURE_BYTES = 64
        private const val AUTHENTICATION_MAC_BYTES = 32
        private const val SIGNING_SELF_TEST_CONTEXT =
            "CASSA_V6-BT-ED25519-SELF-TEST-V1"
        private const val P256_SIGNING_SELF_TEST_CONTEXT =
            "CASSA_V6-BT-ECDSA-P256-SELF-TEST-V2"
        private const val SIGNING_KEY_ALIAS =
            "cassav6.bluetooth.identity.ed25519.v1"
        private const val P256_SIGNING_KEY_ALIAS =
            "cassav6.bluetooth.identity.ec-p256.v2"
        private const val ALIAS_KEY_ALIAS =
            "cassav6.bluetooth.identity.alias-hmac.v1"
        private const val ALIAS_KEY_VERSION = 1
        private const val ALIAS_KEY_VERIFIER_CONTEXT =
            "CASSA_V6-BT-ALIAS-BINDING-V1"
        private const val PREFERENCES_NAME =
            "cassav6_bluetooth_identity_v1"
        private val loggedSigningKeyRejections = mutableSetOf<String>()
        private const val NODE_ID_PREFERENCE = "node_id"
        private const val ENROLLMENT_STATE_PREFERENCE = "enrollment_state"
        private const val ENROLLMENT_PROTOCOL_PREFERENCE = "enrollment_protocol"
        private const val ENROLLMENT_NODE_ID_PREFERENCE = "enrollment_node_id"
        private const val ENROLLMENT_CERTIFICATE_ID_PREFERENCE =
            "enrollment_certificate_id"
        private const val ENROLLMENT_PUBLIC_KEY_HASH_PREFERENCE =
            "enrollment_public_key_sha256"
        private const val ENROLLMENT_PUBLIC_KEY_ALGORITHM_PREFERENCE =
            "enrollment_public_key_algorithm"
        private const val ENROLLMENT_PUBLIC_KEY_SPKI_PREFERENCE =
            "enrollment_public_key_spki"
        private const val ENROLLMENT_DATE_PREFERENCE = "enrollment_date"
        private const val ENROLLMENT_ALIAS_PREFERENCE = "enrollment_alias"
        private const val ENROLLMENT_ALIAS_VERSION_PREFERENCE =
            "enrollment_alias_version"
        private const val ENROLLMENT_ALIAS_ALGORITHM_PREFERENCE =
            "enrollment_alias_algorithm"
        private const val ENROLLMENT_ALIAS_ENCODING_PREFERENCE =
            "enrollment_alias_encoding"
        private const val ENROLLMENT_ALIAS_VERIFIER_PREFERENCE =
            "enrollment_alias_verifier"
        private val enrollmentPreferenceKeys = listOf(
            ENROLLMENT_PROTOCOL_PREFERENCE,
            ENROLLMENT_NODE_ID_PREFERENCE,
            ENROLLMENT_CERTIFICATE_ID_PREFERENCE,
            ENROLLMENT_PUBLIC_KEY_HASH_PREFERENCE,
            ENROLLMENT_PUBLIC_KEY_ALGORITHM_PREFERENCE,
            ENROLLMENT_PUBLIC_KEY_SPKI_PREFERENCE,
            ENROLLMENT_DATE_PREFERENCE,
            ENROLLMENT_ALIAS_PREFERENCE,
            ENROLLMENT_ALIAS_VERSION_PREFERENCE,
            ENROLLMENT_ALIAS_ALGORITHM_PREFERENCE,
            ENROLLMENT_ALIAS_ENCODING_PREFERENCE,
            ENROLLMENT_ALIAS_VERIFIER_PREFERENCE
        )
        private val identityLock = Any()
    }
}
