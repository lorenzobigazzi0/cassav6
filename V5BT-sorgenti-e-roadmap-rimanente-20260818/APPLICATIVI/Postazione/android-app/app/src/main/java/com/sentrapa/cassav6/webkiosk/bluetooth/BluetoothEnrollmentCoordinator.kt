package com.sentrapa.cassav6.webkiosk.bluetooth

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal enum class BluetoothEnrollmentRecoveryDisposition {
    CONSUME,
    RETAIN,
    QUARANTINE
}

internal object BluetoothEnrollmentRecoveryPolicy {
    const val TOKEN_VALIDITY_BUDGET_MILLIS = 10 * 60 * 1000L
    const val SERVER_RECOVERY_WINDOW_MILLIS = 10 * 60 * 1000L
    // A commit may occur at the end of token validity and lose its response.
    const val RECOVERY_WINDOW_MILLIS =
        TOKEN_VALIDITY_BUDGET_MILLIS + SERVER_RECOVERY_WINDOW_MILLIS
    const val PRIVATE_FILE_MODE = 0x180 // 0600

    fun disposition(
        attempt: BluetoothEnrollmentAttempt
    ): BluetoothEnrollmentRecoveryDisposition =
        when (attempt.status) {
            BluetoothEnrollmentAttemptStatus.READY,
            BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED ->
                BluetoothEnrollmentRecoveryDisposition.CONSUME
            BluetoothEnrollmentAttemptStatus.INPUT_INVALID,
            BluetoothEnrollmentAttemptStatus.ENDPOINT_MISMATCH ->
                BluetoothEnrollmentRecoveryDisposition.QUARANTINE
            BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED ->
                if (attempt.identityStatus.isTransientIdentityFailure()) {
                    BluetoothEnrollmentRecoveryDisposition.RETAIN
                } else {
                    BluetoothEnrollmentRecoveryDisposition.QUARANTINE
                }
            BluetoothEnrollmentAttemptStatus.CLIENT_FAILED ->
                if (attempt.httpStatus?.let { it in 400..499 } == true) {
                    BluetoothEnrollmentRecoveryDisposition.QUARANTINE
                } else {
                    BluetoothEnrollmentRecoveryDisposition.RETAIN
                }
            else -> BluetoothEnrollmentRecoveryDisposition.RETAIN
        }

    private fun DeviceIdentityStatus?.isTransientIdentityFailure(): Boolean =
        this == null ||
            this == DeviceIdentityStatus.ANDROID_KEYSTORE_UNAVAILABLE ||
            this == DeviceIdentityStatus.STORAGE_ERROR ||
            this == DeviceIdentityStatus.PROVISIONING_FAILED ||
            this == DeviceIdentityStatus.CRYPTO_OPERATION_FAILED

    fun isWithinRecoveryWindow(
        nowMillis: Long,
        modifiedMillis: Long
    ): Boolean =
        modifiedMillis > 0L &&
            nowMillis >= modifiedMillis &&
            nowMillis - modifiedMillis <= RECOVERY_WINDOW_MILLIS

    fun isSecureFile(
        isRegularFile: Boolean,
        linkCount: Long,
        permissionBits: Int,
        byteCount: Long
    ): Boolean =
        isRegularFile &&
            linkCount == 1L &&
            permissionBits == PRIVATE_FILE_MODE &&
            byteCount in 1L..BluetoothEnrollmentProtocolV1.MAX_QR_BYTES.toLong()
}

internal class BluetoothEnrollmentSingleFlightGate {
    private val active = AtomicBoolean(false)

    fun tryStart(): Boolean = active.compareAndSet(false, true)

    fun finish() {
        active.set(false)
    }
}

internal object BluetoothEnrollmentClaimDurability {
    fun commit(
        syncSource: () -> Boolean,
        rename: () -> Boolean,
        stampTarget: () -> Boolean,
        restrictTarget: () -> Boolean,
        syncTarget: () -> Boolean,
        syncDirectory: () -> Boolean
    ): Boolean = runCatching {
        syncSource() &&
            rename() &&
            stampTarget() &&
            restrictTarget() &&
            syncTarget() &&
            syncDirectory()
    }.getOrDefault(false)
}

enum class BluetoothEnrollmentAttemptStatus {
    IDLE,
    BUSY,
    INPUT_INVALID,
    ENDPOINT_MISMATCH,
    IDENTITY_FAILED,
    CLIENT_FAILED,
    IMPORT_FAILED,
    READY,
    ALREADY_PROVISIONED,
    STORAGE_FAILED,
    INTERRUPTED,
    CLOSED
}

data class BluetoothEnrollmentAttempt(
    val status: BluetoothEnrollmentAttemptStatus,
    val identityStatus: DeviceIdentityStatus? = null,
    val clientStatus: BluetoothEnrollmentClientStatus? = null,
    val parseCode: BluetoothEnrollmentParseCode? = null,
    val httpStatus: Int? = null
) {
    fun toRedactedJson(): String =
        "{\"version\":1," +
            "\"status\":\"${status.name}\"," +
            "\"identityStatus\":${identityStatus.jsonValue()}," +
            "\"clientStatus\":${clientStatus.jsonValue()}," +
            "\"parseCode\":${parseCode.jsonValue()}," +
            "\"httpStatus\":${httpStatus ?: "null"}}"

    private fun Enum<*>?.jsonValue(): String =
        this?.name?.let { "\"$it\"" } ?: "null"
}

internal interface BluetoothEnrollmentIdentityPort {
    fun inspect(): DeviceIdentityReport
    fun createClaim(qr: BluetoothEnrollmentQrV1): BluetoothEnrollmentClaimResult
    fun importResponse(fields: Map<String, Any?>): DeviceIdentityReport
}

internal interface BluetoothEnrollmentNetworkPort {
    fun enroll(
        request: BluetoothEnrollmentRequestV1
    ): BluetoothEnrollmentClientResult
}

internal class BluetoothEnrollmentPipeline(
    private val expectedEndpointId: String,
    private val identity: BluetoothEnrollmentIdentityPort,
    private val network: BluetoothEnrollmentNetworkPort
) {
    fun process(qrBytes: ByteArray): BluetoothEnrollmentAttempt {
        val qr =
            when (val parsed = BluetoothEnrollmentJsonV1.parseQr(qrBytes)) {
                is BluetoothEnrollmentParseResult.Failure ->
                    return BluetoothEnrollmentAttempt(
                        status = BluetoothEnrollmentAttemptStatus.INPUT_INVALID,
                        parseCode = parsed.code
                    )
                is BluetoothEnrollmentParseResult.Ready -> parsed.value
            }
        if (qr.enrollmentEndpointId != expectedEndpointId) {
            return BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ENDPOINT_MISMATCH
            )
        }

        val current =
            runCatching { identity.inspect() }.getOrElse {
                return BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                    identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                )
            }
        if (current.status == DeviceIdentityStatus.READY) {
            return BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED,
                identityStatus = DeviceIdentityStatus.READY
            )
        }

        val claim =
            when (val result = runCatching { identity.createClaim(qr) }.getOrNull()) {
                is BluetoothEnrollmentClaimResult.Ready -> result.request
                is BluetoothEnrollmentClaimResult.Failure -> {
                    if (
                        result.status ==
                        DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
                    ) {
                        return BluetoothEnrollmentAttempt(
                            BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED,
                            identityStatus = DeviceIdentityStatus.READY
                        )
                    }
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                        identityStatus = result.status
                    )
                }
                null ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                        identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                    )
            }

        val response =
            when (val result = runCatching { network.enroll(claim) }.getOrNull()) {
                is BluetoothEnrollmentClientResult.Ready -> result.responseFields
                is BluetoothEnrollmentClientResult.Failure ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                        clientStatus = result.status,
                        parseCode = result.parseCode,
                        httpStatus = result.httpStatus
                    )
                null ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                        clientStatus = BluetoothEnrollmentClientStatus.NETWORK_FAILED
                    )
            }
        val imported =
            runCatching { identity.importResponse(response) }.getOrElse {
                return BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                    identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                )
            }
        return if (
            imported.status == DeviceIdentityStatus.READY ||
            imported.status ==
            DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
        ) {
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.READY,
                identityStatus = DeviceIdentityStatus.READY
            )
        } else {
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                identityStatus = imported.status
            )
        }
    }
}

internal interface BluetoothEnrollmentIdentityPortV2 {
    fun inspect(): DeviceIdentityReport
    fun createClaim(qr: BluetoothEnrollmentQrV2): BluetoothEnrollmentClaimResultV2
    fun importResponse(fields: Map<String, Any?>): DeviceIdentityReport
}

internal interface BluetoothEnrollmentNetworkPortV2 {
    fun enroll(
        request: BluetoothEnrollmentRequestV2
    ): BluetoothEnrollmentClientResult
}

internal class BluetoothEnrollmentPipelineV2(
    private val expectedEndpointId: String,
    private val identity: BluetoothEnrollmentIdentityPortV2,
    private val network: BluetoothEnrollmentNetworkPortV2
) {
    fun process(qrBytes: ByteArray): BluetoothEnrollmentAttempt {
        val qr =
            when (val parsed = BluetoothEnrollmentJsonV2.parseQr(qrBytes)) {
                is BluetoothEnrollmentParseResult.Failure ->
                    return BluetoothEnrollmentAttempt(
                        status = BluetoothEnrollmentAttemptStatus.INPUT_INVALID,
                        parseCode = parsed.code
                    )
                is BluetoothEnrollmentParseResult.Ready -> parsed.value
            }
        if (qr.enrollmentEndpointId != expectedEndpointId) {
            return BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ENDPOINT_MISMATCH
            )
        }
        val current =
            runCatching { identity.inspect() }.getOrElse {
                return BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                    identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                )
            }
        if (current.status == DeviceIdentityStatus.READY) {
            return BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED,
                identityStatus = DeviceIdentityStatus.READY
            )
        }
        val claim =
            when (val result = runCatching { identity.createClaim(qr) }.getOrNull()) {
                is BluetoothEnrollmentClaimResultV2.Ready -> result.request
                is BluetoothEnrollmentClaimResultV2.Failure -> {
                    if (
                        result.status ==
                        DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
                    ) {
                        return BluetoothEnrollmentAttempt(
                            BluetoothEnrollmentAttemptStatus.ALREADY_PROVISIONED,
                            identityStatus = DeviceIdentityStatus.READY
                        )
                    }
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                        identityStatus = result.status
                    )
                }
                null ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.IDENTITY_FAILED,
                        identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                    )
            }
        val response =
            when (val result = runCatching { network.enroll(claim) }.getOrNull()) {
                is BluetoothEnrollmentClientResult.Ready -> result.responseFields
                is BluetoothEnrollmentClientResult.Failure ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                        clientStatus = result.status,
                        parseCode = result.parseCode,
                        httpStatus = result.httpStatus
                    )
                null ->
                    return BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                        clientStatus = BluetoothEnrollmentClientStatus.NETWORK_FAILED
                    )
            }
        val imported =
            runCatching { identity.importResponse(response) }.getOrElse {
                return BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                    identityStatus = DeviceIdentityStatus.PROVISIONING_FAILED
                )
            }
        return if (
            imported.status == DeviceIdentityStatus.READY ||
            imported.status == DeviceIdentityStatus.ALIAS_KEY_ALREADY_PROVISIONED
        ) {
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.READY,
                identityStatus = DeviceIdentityStatus.READY
            )
        } else {
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.IMPORT_FAILED,
                identityStatus = imported.status
            )
        }
    }
}

internal class BluetoothEnrollmentPublicationGate {
    @Volatile
    var isClosed = false
        private set

    @Synchronized
    fun ifOpen(action: () -> Unit): Boolean {
        if (isClosed) return false
        action()
        return true
    }

    @Synchronized
    fun close(action: () -> Unit): Boolean {
        if (isClosed) return false
        isClosed = true
        action()
        return true
    }
}

class BluetoothEnrollmentCoordinator(
    context: Context,
    private val config: BluetoothEnrollmentConfig,
    identityEnabled: Boolean,
    private val labBuild: Boolean,
    private val onIdentityReady: () -> Unit,
    private val clockMillis: () -> Long = System::currentTimeMillis
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "CASSA_V6-BluetoothEnrollment").apply {
            isDaemon = true
        }
    }
    private val publicationGate = BluetoothEnrollmentPublicationGate()
    private val inFlight = BluetoothEnrollmentSingleFlightGate()
    private val identityManager =
        DeviceIdentityManager(appContext, identityEnabled)
    private val client = BluetoothEnrollmentClient(config)
    private val pipeline = BluetoothEnrollmentPipeline(
        expectedEndpointId = config.endpointId,
        identity = object : BluetoothEnrollmentIdentityPort {
            override fun inspect(): DeviceIdentityReport =
                identityManager.provision()

            override fun createClaim(
                qr: BluetoothEnrollmentQrV1
            ): BluetoothEnrollmentClaimResult =
                identityManager.createAuthenticatedEnrollmentClaim(qr)

            override fun importResponse(
                fields: Map<String, Any?>
            ): DeviceIdentityReport =
                identityManager.importAuthenticatedEnrollmentResponse(fields)
        },
        network = object : BluetoothEnrollmentNetworkPort {
            override fun enroll(
                request: BluetoothEnrollmentRequestV1
            ): BluetoothEnrollmentClientResult =
                client.enroll(request)
        }
    )
    private val pipelineV2 = BluetoothEnrollmentPipelineV2(
        expectedEndpointId = config.endpointId,
        identity = object : BluetoothEnrollmentIdentityPortV2 {
            override fun inspect(): DeviceIdentityReport =
                identityManager.provision()

            override fun createClaim(
                qr: BluetoothEnrollmentQrV2
            ): BluetoothEnrollmentClaimResultV2 =
                identityManager.createAuthenticatedEnrollmentClaim(qr)

            override fun importResponse(
                fields: Map<String, Any?>
            ): DeviceIdentityReport =
                identityManager.importAuthenticatedEnrollmentResponse(fields)
        },
        network = object : BluetoothEnrollmentNetworkPortV2 {
            override fun enroll(
                request: BluetoothEnrollmentRequestV2
            ): BluetoothEnrollmentClientResult =
                client.enroll(request)
        }
    )
    private val inputFile =
        File(appContext.noBackupFilesDir, INPUT_FILE_NAME)
    private val processingFile =
        File(appContext.noBackupFilesDir, PROCESSING_FILE_NAME)
    private val rejectedFile =
        File(appContext.noBackupFilesDir, REJECTED_FILE_NAME)
    private val statusFile =
        File(appContext.noBackupFilesDir, STATUS_FILE_NAME)
    private val statusStore = AtomicFile(statusFile)

    @Volatile
    var lastAttempt = BluetoothEnrollmentAttempt(
        BluetoothEnrollmentAttemptStatus.IDLE
    )
        private set

    fun refresh() {
        if (publicationGate.isClosed || !labBuild || !config.enabled) return
        if (
            BluetoothEnrollmentConfigValidator.validate(config) !is
            BluetoothEnrollmentConfigResult.Ready
        ) {
            publish(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.CLIENT_FAILED,
                    clientStatus =
                        BluetoothEnrollmentClientStatus.CONFIGURATION_INVALID
                )
            )
            return
        }
        if (!inFlight.tryStart()) return
        when (val preparation = prepareProcessingFile()) {
            ProcessingPreparation.None -> {
                inFlight.finish()
                return
            }
            is ProcessingPreparation.Failure -> {
                inFlight.finish()
                publish(preparation.attempt)
                return
            }
            ProcessingPreparation.Ready -> Unit
        }
        publish(
            BluetoothEnrollmentAttempt(
                BluetoothEnrollmentAttemptStatus.BUSY
            )
        )
        try {
            executor.execute {
                try {
                    val qrBytes = try {
                        readBounded(processingFile)
                    } catch (_: IllegalArgumentException) {
                        null
                    } catch (_: Exception) {
                        completeProcessing(
                            BluetoothEnrollmentAttempt(
                                BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                            )
                        )
                        return@execute
                    }
                    val result = if (qrBytes == null) {
                        BluetoothEnrollmentAttempt(
                            BluetoothEnrollmentAttemptStatus.INPUT_INVALID
                        )
                    } else {
                        try {
                            processEnrollmentQr(qrBytes)
                        } finally {
                            qrBytes.fill(0)
                        }
                    }
                    completeProcessing(result)
                } finally {
                    inFlight.finish()
                }
            }
        } catch (_: RuntimeException) {
            inFlight.finish()
            publish(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.INTERRUPTED
                )
            )
        }
    }

    private fun processEnrollmentQr(qrBytes: ByteArray): BluetoothEnrollmentAttempt {
        val v1 = BluetoothEnrollmentJsonV1.parseQr(qrBytes)
        if (v1 is BluetoothEnrollmentParseResult.Ready) {
            return pipeline.process(qrBytes)
        }
        val v2 = BluetoothEnrollmentJsonV2.parseQr(qrBytes)
        if (v2 is BluetoothEnrollmentParseResult.Ready) {
            return pipelineV2.process(qrBytes)
        }
        val failure = v2 as BluetoothEnrollmentParseResult.Failure
        return BluetoothEnrollmentAttempt(
            status = BluetoothEnrollmentAttemptStatus.INPUT_INVALID,
            parseCode = failure.code
        )
    }

    private fun prepareProcessingFile(): ProcessingPreparation {
        val now = runCatching(clockMillis).getOrElse {
            return ProcessingPreparation.Failure(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                )
            )
        }
        if (processingFile.exists()) {
            return validateResumableProcessing(now)
        }
        if (!inputFile.exists()) return ProcessingPreparation.None
        if (rejectedFile.exists()) {
            return ProcessingPreparation.Failure(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                )
            )
        }
        if (
            validatePrivateFile(inputFile, repairPermissions = true) ==
            PrivateFileValidation.INSECURE
        ) {
            return ProcessingPreparation.Failure(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                )
            )
        }
        val claimed = BluetoothEnrollmentClaimDurability.commit(
            syncSource = { fsyncSecureRegularFile(inputFile) },
            rename = {
                !processingFile.exists() && inputFile.renameTo(processingFile)
            },
            stampTarget = { processingFile.setLastModified(now) },
            restrictTarget = { setPrivatePermissions(processingFile) },
            syncTarget = { fsyncSecureRegularFile(processingFile) },
            syncDirectory = { fsyncPrivateDirectory() }
        )
        if (!claimed) {
            return ProcessingPreparation.Failure(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                )
            )
        }
        return validateResumableProcessing(now)
    }

    private fun validateResumableProcessing(
        now: Long
    ): ProcessingPreparation =
        when (validatePrivateFile(processingFile, repairPermissions = false)) {
            PrivateFileValidation.READY -> {
                if (
                    BluetoothEnrollmentRecoveryPolicy.isWithinRecoveryWindow(
                        now,
                        processingFile.lastModified()
                    )
                ) {
                    ProcessingPreparation.Ready
                } else {
                    quarantinePreparationFailure(
                        BluetoothEnrollmentAttemptStatus.INPUT_INVALID
                    )
                }
            }
            PrivateFileValidation.CONTENT_INVALID ->
                quarantinePreparationFailure(
                    BluetoothEnrollmentAttemptStatus.INPUT_INVALID
                )
            PrivateFileValidation.INSECURE ->
                ProcessingPreparation.Failure(
                    BluetoothEnrollmentAttempt(
                        BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                    )
                )
        }

    private fun quarantinePreparationFailure(
        status: BluetoothEnrollmentAttemptStatus
    ): ProcessingPreparation =
        if (quarantineProcessingFile()) {
            ProcessingPreparation.Failure(BluetoothEnrollmentAttempt(status))
        } else {
            ProcessingPreparation.Failure(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                )
            )
        }

    private fun completeProcessing(attempt: BluetoothEnrollmentAttempt) {
        publicationGate.ifOpen {
            val finalized = when (
                BluetoothEnrollmentRecoveryPolicy.disposition(attempt)
            ) {
                BluetoothEnrollmentRecoveryDisposition.CONSUME ->
                    if (consumeProcessingFile()) {
                        attempt
                    } else {
                        BluetoothEnrollmentAttempt(
                            BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                        )
                    }
                BluetoothEnrollmentRecoveryDisposition.RETAIN -> attempt
                BluetoothEnrollmentRecoveryDisposition.QUARANTINE ->
                    if (quarantineProcessingFile()) {
                        attempt
                    } else {
                        BluetoothEnrollmentAttempt(
                            BluetoothEnrollmentAttemptStatus.STORAGE_FAILED
                        )
                    }
            }
            writeAttempt(finalized)
            if (finalized.status == BluetoothEnrollmentAttemptStatus.READY) {
                runCatching(onIdentityReady)
            }
        }
    }

    private fun consumeProcessingFile(): Boolean =
        runCatching {
            processingFile.exists() &&
                processingFile.delete() &&
                fsyncPrivateDirectory()
        }.getOrDefault(false)

    private fun quarantineProcessingFile(): Boolean =
        runCatching {
            processingFile.exists() &&
                !rejectedFile.exists() &&
                processingFile.renameTo(rejectedFile) &&
                setPrivatePermissions(rejectedFile) &&
                fsyncPrivateDirectory()
        }.getOrDefault(false)

    private fun validatePrivateFile(
        file: File,
        repairPermissions: Boolean
    ): PrivateFileValidation =
        runCatching {
            val expected = File(
                appContext.noBackupFilesDir.canonicalFile,
                file.name
            )
            if (file.canonicalFile != expected) {
                return@runCatching PrivateFileValidation.INSECURE
            }
            val initial = Os.lstat(file.absolutePath)
            val isRegular =
                (initial.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFREG
            if (!isRegular || initial.st_nlink != 1L) {
                return@runCatching PrivateFileValidation.INSECURE
            }
            if (repairPermissions && !setPrivatePermissions(file)) {
                return@runCatching PrivateFileValidation.INSECURE
            }
            val verified = Os.lstat(file.absolutePath)
            val permissionBits = verified.st_mode and PERMISSION_MASK
            if (
                !BluetoothEnrollmentRecoveryPolicy.isSecureFile(
                    isRegularFile =
                        (verified.st_mode and OsConstants.S_IFMT) ==
                            OsConstants.S_IFREG,
                    linkCount = verified.st_nlink,
                    permissionBits = permissionBits,
                    byteCount = verified.st_size
                )
            ) {
                if (
                    (verified.st_mode and OsConstants.S_IFMT) ==
                        OsConstants.S_IFREG &&
                    verified.st_nlink == 1L &&
                    permissionBits ==
                    BluetoothEnrollmentRecoveryPolicy.PRIVATE_FILE_MODE
                ) {
                    PrivateFileValidation.CONTENT_INVALID
                } else {
                    PrivateFileValidation.INSECURE
                }
            } else {
                PrivateFileValidation.READY
            }
        }.getOrDefault(PrivateFileValidation.INSECURE)

    private fun setPrivatePermissions(file: File): Boolean =
        runCatching {
            Os.chmod(
                file.absolutePath,
                BluetoothEnrollmentRecoveryPolicy.PRIVATE_FILE_MODE
            )
            true
        }.getOrDefault(false)

    private fun fsyncSecureRegularFile(file: File): Boolean =
        runCatching {
            FileInputStream(file).use { input ->
                val verified = Os.fstat(input.fd)
                val permissionBits = verified.st_mode and PERMISSION_MASK
                if (
                    !BluetoothEnrollmentRecoveryPolicy.isSecureFile(
                        isRegularFile =
                            (verified.st_mode and OsConstants.S_IFMT) ==
                                OsConstants.S_IFREG,
                        linkCount = verified.st_nlink,
                        permissionBits = permissionBits,
                        byteCount = verified.st_size
                    )
                ) {
                    return@runCatching false
                }
                input.fd.sync()
            }
            true
        }.getOrDefault(false)

    private fun fsyncPrivateDirectory(): Boolean =
        runCatching {
            val descriptor = Os.open(
                appContext.noBackupFilesDir.absolutePath,
                OsConstants.O_RDONLY,
                0
            )
            try {
                Os.fsync(descriptor)
            } finally {
                Os.close(descriptor)
            }
            true
        }.getOrDefault(false)

    override fun close() {
        val firstClose = publicationGate.close {
            writeAttempt(
                BluetoothEnrollmentAttempt(
                    BluetoothEnrollmentAttemptStatus.CLOSED
                )
            )
        }
        if (!firstClose) return
        client.close()
        executor.shutdownNow()
        inFlight.finish()
    }

    private fun publish(
        attempt: BluetoothEnrollmentAttempt,
        notifyIdentityReady: Boolean = false
    ): Boolean = publicationGate.ifOpen {
        writeAttempt(attempt)
        if (notifyIdentityReady) {
            runCatching(onIdentityReady)
        }
    }

    private fun writeAttempt(attempt: BluetoothEnrollmentAttempt) {
        lastAttempt = attempt
        var output: FileOutputStream? = null
        try {
            statusFile.parentFile?.mkdirs()
            val activeOutput = statusStore.startWrite()
            output = activeOutput
            activeOutput.write(
                "${attempt.toRedactedJson()}\n".toByteArray(Charsets.UTF_8)
            )
            activeOutput.fd.sync()
            statusStore.finishWrite(activeOutput)
            output = null
        } catch (_: Exception) {
            output?.let { failed ->
                runCatching { statusStore.failWrite(failed) }
            }
        }
    }

    private fun readBounded(file: File): ByteArray {
        val working =
            ByteArray(BluetoothEnrollmentProtocolV1.MAX_QR_BYTES + 1)
        try {
            var total = 0
            FileInputStream(file).use { input ->
                while (total < working.size) {
                    val count = input.read(working, total, working.size - total)
                    if (count < 0) break
                    if (count == 0) continue
                    total += count
                }
            }
            if (total == 0) {
                throw IllegalArgumentException("Enrollment QR is empty")
            }
            if (total > BluetoothEnrollmentProtocolV1.MAX_QR_BYTES) {
                throw IllegalArgumentException("Enrollment QR is too large")
            }
            return working.copyOf(total)
        } finally {
            working.fill(0)
        }
    }

    companion object {
        const val INPUT_FILE_NAME = "bluetooth-enrollment-qr-v1.json"
        const val PROCESSING_FILE_NAME =
            "bluetooth-enrollment-qr-v1.processing"
        const val REJECTED_FILE_NAME =
            "bluetooth-enrollment-qr-v1.rejected"
        const val STATUS_FILE_NAME = "bluetooth-enrollment-status-v1.json"
        private const val PERMISSION_MASK = 0x1ff
    }

    private sealed class ProcessingPreparation {
        data object None : ProcessingPreparation()
        data object Ready : ProcessingPreparation()
        data class Failure(
            val attempt: BluetoothEnrollmentAttempt
        ) : ProcessingPreparation()
    }

    private enum class PrivateFileValidation {
        READY,
        CONTENT_INVALID,
        INSECURE
    }
}
