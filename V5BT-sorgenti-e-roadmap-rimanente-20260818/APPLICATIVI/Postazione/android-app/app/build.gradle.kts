import java.net.URI
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val postazioneApplicationId = "com.sentrapa.postazione.advanced"
val partialDefaultServerUrl = run {
    val candidate =
        providers.gradleProperty("cassaPartialDefaultServerUrl")
            .getOrElse("https://192.168.1.79:5380/postazione/")
            .trim()
    val uri = runCatching { URI(candidate) }.getOrNull()
    if (
        uri?.scheme != "https" ||
        uri.host.isNullOrBlank() ||
        uri.userInfo != null ||
        uri.query != null ||
        uri.fragment != null ||
        uri.path.trimEnd('/') != "/postazione"
    ) {
        throw GradleException(
            "cassaPartialDefaultServerUrl deve essere un URL HTTPS senza credenziali, query o fragment e con path /postazione/."
        )
    }
    candidate.trimEnd('/') + "/"
}
val api31CompatEnrollmentEndpointId =
    providers.gradleProperty("cassaApi31CompatEnrollmentEndpointId")
        .orNull
        ?.trim()
        .orEmpty()
val api31CompatEnrollmentUrl =
    providers.gradleProperty("cassaApi31CompatEnrollmentUrl")
        .orNull
        ?.trim()
        .orEmpty()
val api31CompatEnrollmentSpkiSha256 =
    providers.gradleProperty("cassaApi31CompatEnrollmentSpkiSha256")
        .orNull
        ?.trim()
        .orEmpty()
val api31CompatConfigurationError = run {
    val endpointPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    val pinPattern = Regex("^sha256/[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")
    val enrollmentUri = runCatching { URI(api31CompatEnrollmentUrl) }.getOrNull()
    val pinBytes = runCatching {
        Base64.getDecoder().decode(
            api31CompatEnrollmentSpkiSha256.removePrefix("sha256/")
        )
    }.getOrNull()
    when {
        !endpointPattern.matches(api31CompatEnrollmentEndpointId) ->
            "cassaApi31CompatEnrollmentEndpointId non e canonico."
        enrollmentUri?.scheme != "https" ||
            enrollmentUri.host.isNullOrBlank() ||
            enrollmentUri.userInfo != null ||
            enrollmentUri.query != null ||
            enrollmentUri.fragment != null ||
            enrollmentUri.path != "/v2/enroll" ->
            "cassaApi31CompatEnrollmentUrl deve essere un URL HTTPS /v2/enroll senza credenziali, query o fragment."
        !pinPattern.matches(api31CompatEnrollmentSpkiSha256) ||
            pinBytes?.size != 32 ||
            pinBytes.all { it == 0.toByte() } ||
            Base64.getEncoder().encodeToString(pinBytes) !=
                api31CompatEnrollmentSpkiSha256.removePrefix("sha256/") ->
            "cassaApi31CompatEnrollmentSpkiSha256 deve essere un pin SPKI sha256/ canonico e nonzero."
        else -> null
    }
}
val bluetoothDiagnosticsEnabled =
    providers.gradleProperty("cassaBluetoothDiagnostics")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothIdentityEnabled =
    providers.gradleProperty("cassaBluetoothIdentity")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothDiscoveryEnabled =
    providers.gradleProperty("cassaBluetoothDiscovery")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothFailoverRequested =
    providers.gradleProperty("cassaBluetoothFailover")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothLabBuild =
    providers.gradleProperty("cassaBluetoothLab")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothDirectServerRequested =
    providers.gradleProperty("cassaBluetoothDirectServer")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothPeerLinkRequested =
    providers.gradleProperty("cassaBluetoothPeerLink")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothAndroidPeerAuthRequested =
    providers.gradleProperty("cassaBluetoothAndroidPeerAuthV2")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothPeerTrustDirectoryUrl =
    providers.gradleProperty("cassaBluetoothPeerTrustDirectoryUrl")
        .getOrElse("")
        .trim()
val bluetoothPeerTrustTlsSpkiSha256 =
    providers.gradleProperty("cassaBluetoothPeerTrustTlsSpkiSha256")
        .getOrElse("")
        .trim()
val bluetoothPeerTrustAuthoritySpkiDerBase64 =
    providers.gradleProperty("cassaBluetoothPeerTrustAuthoritySpkiDerBase64")
        .getOrElse("")
        .trim()
val bluetoothPeerTrustConfigurationError = run {
    val pinPattern = Regex("^sha256/[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")
    val directoryUri = runCatching { URI(bluetoothPeerTrustDirectoryUrl) }.getOrNull()
    val tlsPin = runCatching {
        Base64.getDecoder().decode(
            bluetoothPeerTrustTlsSpkiSha256.removePrefix("sha256/")
        )
    }.getOrNull()
    val authority = runCatching {
        Base64.getDecoder().decode(bluetoothPeerTrustAuthoritySpkiDerBase64)
    }.getOrNull()
    val authorityKey = authority?.let { encoded ->
        runCatching {
            KeyFactory.getInstance("EC")
                .generatePublic(X509EncodedKeySpec(encoded)) as? ECPublicKey
        }.getOrNull()
    }
    val authorityPin = authority?.let {
        MessageDigest.getInstance("SHA-256").digest(it)
    }
    when {
        directoryUri?.scheme != "https" ||
            directoryUri.host.isNullOrBlank() ||
            directoryUri.userInfo != null ||
            directoryUri.query != null ||
            directoryUri.fragment != null ||
            directoryUri.path != "/v1/peer-trust-directory" ->
            "cassaBluetoothPeerTrustDirectoryUrl deve essere un URL HTTPS /v1/peer-trust-directory senza credenziali, query o fragment."
        !pinPattern.matches(bluetoothPeerTrustTlsSpkiSha256) ||
            tlsPin?.size != 32 ||
            tlsPin.all { it == 0.toByte() } ||
            Base64.getEncoder().encodeToString(tlsPin) !=
                bluetoothPeerTrustTlsSpkiSha256.removePrefix("sha256/") ->
            "cassaBluetoothPeerTrustTlsSpkiSha256 deve essere un pin TLS SPKI sha256/ canonico e nonzero."
        authority == null ||
            authority.isEmpty() ||
            authorityKey == null ||
            authorityKey.params.curve.field.fieldSize != 256 ||
            !authorityKey.encoded.contentEquals(authority) ||
            Base64.getEncoder().encodeToString(authority) !=
                bluetoothPeerTrustAuthoritySpkiDerBase64 ->
            "cassaBluetoothPeerTrustAuthoritySpkiDerBase64 deve essere uno SPKI EC P-256 X.509 canonico."
        authorityPin == null || MessageDigest.isEqual(authorityPin, tlsPin) ->
            "L'autorita peer trust deve usare una chiave distinta dall'endpoint TLS."
        else -> null
    }
}
if (bluetoothAndroidPeerAuthRequested && bluetoothPeerTrustConfigurationError != null) {
    throw GradleException(bluetoothPeerTrustConfigurationError)
}
val bluetoothGattClientRequested =
    providers.gradleProperty("cassaBluetoothGattClient")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothHelloExchangeRequested =
    providers.gradleProperty("cassaBluetoothHelloExchange")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothMutualAuthRequested =
    providers.gradleProperty("cassaBluetoothMutualAuth")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothSessionKeyRequested =
    providers.gradleProperty("cassaBluetoothSessionKey")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothHeartbeatRequested =
    providers.gradleProperty("cassaBluetoothHeartbeat")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothRouteAdvertisementRequested =
    providers.gradleProperty("cassaBluetoothRouteAdvertisement")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothCommandBusShadowRequested =
    providers.gradleProperty("cassaBluetoothCommandBusShadow")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothDiagnosticBadgeRequested =
    providers.gradleProperty("cassaBluetoothDiagnosticBadge")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothEnrollmentRequested =
    providers.gradleProperty("cassaBluetoothEnrollment")
        .map(String::toBooleanStrict)
        .getOrElse(false)
val bluetoothEnrollmentEnabled =
    bluetoothLabBuild && bluetoothEnrollmentRequested
val bluetoothFailoverEnabled =
    bluetoothLabBuild &&
        bluetoothFailoverRequested &&
        bluetoothIdentityEnabled &&
        bluetoothDiscoveryEnabled
val bluetoothDirectServerEnabled =
    bluetoothFailoverEnabled && bluetoothDirectServerRequested
val bluetoothGattClientEnabled =
    bluetoothFailoverEnabled && bluetoothGattClientRequested
val bluetoothHelloExchangeEnabled =
    (bluetoothGattClientEnabled || bluetoothDirectServerEnabled) &&
        bluetoothHelloExchangeRequested
val bluetoothAndroidPeerAuthEnabled =
    bluetoothFailoverEnabled &&
        bluetoothDirectServerEnabled &&
        bluetoothGattClientEnabled &&
        bluetoothHelloExchangeEnabled &&
        bluetoothPeerLinkRequested &&
        bluetoothAndroidPeerAuthRequested &&
        bluetoothPeerTrustConfigurationError == null
val bluetoothPeerLinkEnabled = bluetoothAndroidPeerAuthEnabled
val api31CompatAndroidPeerAuthEnabled =
    bluetoothPeerLinkRequested &&
        bluetoothAndroidPeerAuthRequested &&
        bluetoothPeerTrustConfigurationError == null
val bluetoothMutualAuthEnabled =
    bluetoothGattClientEnabled &&
        bluetoothHelloExchangeEnabled &&
        bluetoothMutualAuthRequested
val bluetoothSessionKeyEnabled =
    bluetoothMutualAuthEnabled && bluetoothSessionKeyRequested
val bluetoothHeartbeatEnabled =
    bluetoothSessionKeyEnabled && bluetoothHeartbeatRequested
val bluetoothRouteAdvertisementEnabled =
    bluetoothHeartbeatEnabled && bluetoothRouteAdvertisementRequested
val bluetoothCommandBusShadowEnabled =
    bluetoothRouteAdvertisementEnabled && bluetoothCommandBusShadowRequested
val bluetoothDiagnosticBadgeEnabled =
    bluetoothFailoverEnabled &&
        bluetoothDiagnosticsEnabled &&
        bluetoothDiagnosticBadgeRequested
val bluetoothEnrollmentEndpointId =
    providers.gradleProperty("cassaBluetoothEnrollmentEndpointId")
        .getOrElse("")
val bluetoothEnrollmentUrl =
    providers.gradleProperty("cassaBluetoothEnrollmentUrl")
        .getOrElse("")
val bluetoothEnrollmentSpkiSha256 =
    providers.gradleProperty("cassaBluetoothEnrollmentSpkiSha256")
        .getOrElse("")
val webFrontendDir = rootProject.layout.projectDirectory.dir("../web-frontend")
val webDistDir = webFrontendDir.dir("dist")
val bundledWebAssetsDir = layout.projectDirectory.dir("src/main/assets/postazione")
val webSourceRoots = listOf("src", "public", "css", "js", "partials")
    .map { webFrontendDir.dir(it).asFile }
val webSourceFiles = listOf("index.html", "styles.css", "vite.config.js", "package.json")
    .map { webFrontendDir.file(it).asFile }

android {
    namespace = "com.sentrapa.webkiosk"
    compileSdk = 34

    defaultConfig {
        applicationId = postazioneApplicationId
        minSdk = 24
        targetSdk = 34
        versionCode = 25
        versionName = "2.0.23"

        manifestPlaceholders["appLabel"] = "Postazione Advanced"
        manifestPlaceholders["partialNonGateBuild"] = "false"
        manifestPlaceholders["api31CompatNonGateBuild"] = "false"
        manifestPlaceholders["bluetoothFailoverServiceEnabled"] =
            bluetoothFailoverEnabled.toString()

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "boolean",
            "PARTIAL_NON_GATE_BUILD",
            "false"
        )
        buildConfigField(
            "boolean",
            "API31_COMPAT_NON_GATE_BUILD",
            "false"
        )
        buildConfigField(
            "int",
            "BLUETOOTH_DISCOVERY_MIN_ANDROID_API",
            "33"
        )
        buildConfigField(
            "String",
            "DEFAULT_SERVER_URL",
            "\"https://192.168.0.67:5380/postazione/\""
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_DIAGNOSTICS_ENABLED",
            bluetoothDiagnosticsEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_IDENTITY_ENABLED",
            bluetoothIdentityEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_DISCOVERY_ENABLED",
            bluetoothDiscoveryEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_FAILOVER_ENABLED",
            bluetoothFailoverEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_DIRECT_SERVER_ENABLED",
            bluetoothDirectServerEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_PEER_LINK_ENABLED",
            bluetoothPeerLinkEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_ANDROID_PEER_AUTH_V2_ENABLED",
            bluetoothAndroidPeerAuthEnabled.toString()
        )
        buildConfigField(
            "String",
            "BLUETOOTH_PEER_TRUST_DIRECTORY_URL",
            groovy.json.JsonOutput.toJson(bluetoothPeerTrustDirectoryUrl)
        )
        buildConfigField(
            "String",
            "BLUETOOTH_PEER_TRUST_TLS_SPKI_SHA256",
            groovy.json.JsonOutput.toJson(bluetoothPeerTrustTlsSpkiSha256)
        )
        buildConfigField(
            "String",
            "BLUETOOTH_PEER_TRUST_AUTHORITY_SPKI_DER_BASE64",
            groovy.json.JsonOutput.toJson(bluetoothPeerTrustAuthoritySpkiDerBase64)
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_GATT_CLIENT_ENABLED",
            bluetoothGattClientEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_HELLO_EXCHANGE_ENABLED",
            bluetoothHelloExchangeEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_MUTUAL_AUTH_ENABLED",
            bluetoothMutualAuthEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_SESSION_KEY_ENABLED",
            bluetoothSessionKeyEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_HEARTBEAT_ENABLED",
            bluetoothHeartbeatEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_ROUTE_ADVERTISEMENT_ENABLED",
            bluetoothRouteAdvertisementEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_COMMAND_BUS_SHADOW",
            bluetoothCommandBusShadowEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_DIAGNOSTIC_BADGE",
            bluetoothDiagnosticBadgeEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_ENROLLMENT_ENABLED",
            bluetoothEnrollmentEnabled.toString()
        )
        buildConfigField(
            "boolean",
            "BLUETOOTH_LAB_BUILD",
            bluetoothLabBuild.toString()
        )
        buildConfigField(
            "String",
            "BLUETOOTH_ENROLLMENT_ENDPOINT_ID",
            groovy.json.JsonOutput.toJson(bluetoothEnrollmentEndpointId)
        )
        buildConfigField(
            "String",
            "BLUETOOTH_ENROLLMENT_URL",
            groovy.json.JsonOutput.toJson(bluetoothEnrollmentUrl)
        )
        buildConfigField(
            "String",
            "BLUETOOTH_ENROLLMENT_SPKI_SHA256",
            groovy.json.JsonOutput.toJson(bluetoothEnrollmentSpkiSha256)
        )
        buildConfigField("String", "BLUETOOTH_NODE_KIND", "\"station\"")
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        create("partial") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".partial"
            versionNameSuffix = "-partial"
            matchingFallbacks += listOf("debug")

            manifestPlaceholders["appLabel"] = "Postazione Advanced V5BT Partial"
            manifestPlaceholders["partialNonGateBuild"] = "true"
            manifestPlaceholders["api31CompatNonGateBuild"] = "false"
            manifestPlaceholders["bluetoothFailoverServiceEnabled"] = "false"

            buildConfigField("boolean", "PARTIAL_NON_GATE_BUILD", "true")
            buildConfigField(
                "String",
                "DEFAULT_SERVER_URL",
                groovy.json.JsonOutput.toJson(partialDefaultServerUrl)
            )
            listOf(
                "BLUETOOTH_DIAGNOSTICS_ENABLED",
                "BLUETOOTH_IDENTITY_ENABLED",
                "BLUETOOTH_DISCOVERY_ENABLED",
                "BLUETOOTH_FAILOVER_ENABLED",
                "BLUETOOTH_DIRECT_SERVER_ENABLED",
                "BLUETOOTH_PEER_LINK_ENABLED",
                "BLUETOOTH_ANDROID_PEER_AUTH_V2_ENABLED",
                "BLUETOOTH_GATT_CLIENT_ENABLED",
                "BLUETOOTH_HELLO_EXCHANGE_ENABLED",
                "BLUETOOTH_MUTUAL_AUTH_ENABLED",
                "BLUETOOTH_SESSION_KEY_ENABLED",
                "BLUETOOTH_HEARTBEAT_ENABLED",
                "BLUETOOTH_DIAGNOSTIC_BADGE",
                "BLUETOOTH_ENROLLMENT_ENABLED",
                "BLUETOOTH_LAB_BUILD"
            ).forEach { field ->
                buildConfigField("boolean", field, "false")
            }
            listOf(
                "BLUETOOTH_PEER_TRUST_DIRECTORY_URL",
                "BLUETOOTH_PEER_TRUST_TLS_SPKI_SHA256",
                "BLUETOOTH_PEER_TRUST_AUTHORITY_SPKI_DER_BASE64"
            ).forEach { field ->
                buildConfigField("String", field, "\"\"")
            }
        }
        create("api31Compat") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".partial"
            versionNameSuffix = "-api31compat"
            matchingFallbacks += listOf("debug")

            manifestPlaceholders["appLabel"] =
                "Postazione Advanced V5BT API31 Compat"
            manifestPlaceholders["partialNonGateBuild"] = "true"
            manifestPlaceholders["api31CompatNonGateBuild"] = "true"
            manifestPlaceholders["bluetoothFailoverServiceEnabled"] = "true"

            buildConfigField("boolean", "PARTIAL_NON_GATE_BUILD", "true")
            buildConfigField("boolean", "API31_COMPAT_NON_GATE_BUILD", "true")
            buildConfigField("int", "BLUETOOTH_DISCOVERY_MIN_ANDROID_API", "31")
            buildConfigField(
                "String",
                "DEFAULT_SERVER_URL",
                groovy.json.JsonOutput.toJson(partialDefaultServerUrl)
            )
            listOf(
                "BLUETOOTH_DIAGNOSTICS_ENABLED",
                "BLUETOOTH_IDENTITY_ENABLED",
                "BLUETOOTH_DISCOVERY_ENABLED",
                "BLUETOOTH_FAILOVER_ENABLED",
                "BLUETOOTH_DIRECT_SERVER_ENABLED",
                "BLUETOOTH_GATT_CLIENT_ENABLED",
                "BLUETOOTH_HELLO_EXCHANGE_ENABLED",
                "BLUETOOTH_MUTUAL_AUTH_ENABLED",
                "BLUETOOTH_SESSION_KEY_ENABLED",
                "BLUETOOTH_HEARTBEAT_ENABLED",
                "BLUETOOTH_DIAGNOSTIC_BADGE",
                "BLUETOOTH_ENROLLMENT_ENABLED",
                "BLUETOOTH_LAB_BUILD"
            ).forEach { field ->
                buildConfigField("boolean", field, "true")
            }
            buildConfigField(
                "boolean",
                "BLUETOOTH_PEER_LINK_ENABLED",
                api31CompatAndroidPeerAuthEnabled.toString()
            )
            buildConfigField(
                "boolean",
                "BLUETOOTH_ANDROID_PEER_AUTH_V2_ENABLED",
                api31CompatAndroidPeerAuthEnabled.toString()
            )
            buildConfigField(
                "String",
                "BLUETOOTH_PEER_TRUST_DIRECTORY_URL",
                groovy.json.JsonOutput.toJson(bluetoothPeerTrustDirectoryUrl)
            )
            buildConfigField(
                "String",
                "BLUETOOTH_PEER_TRUST_TLS_SPKI_SHA256",
                groovy.json.JsonOutput.toJson(bluetoothPeerTrustTlsSpkiSha256)
            )
            buildConfigField(
                "String",
                "BLUETOOTH_PEER_TRUST_AUTHORITY_SPKI_DER_BASE64",
                groovy.json.JsonOutput.toJson(
                    bluetoothPeerTrustAuthoritySpkiDerBase64
                )
            )
            buildConfigField(
                "String",
                "BLUETOOTH_ENROLLMENT_ENDPOINT_ID",
                groovy.json.JsonOutput.toJson(api31CompatEnrollmentEndpointId)
            )
            buildConfigField(
                "String",
                "BLUETOOTH_ENROLLMENT_URL",
                groovy.json.JsonOutput.toJson(api31CompatEnrollmentUrl)
            )
            buildConfigField(
                "String",
                "BLUETOOTH_ENROLLMENT_SPKI_SHA256",
                groovy.json.JsonOutput.toJson(api31CompatEnrollmentSpkiSha256)
            )
        }
    }

    // Fondamentale: allinea Java e Kotlin sulla stessa versione (17)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("test").resources.srcDir(
            rootProject.layout.projectDirectory.dir(
                "../../../ROADMAP_BLUETOOTH/" +
                    "CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/" +
                    "contracts/golden-vectors"
            )
        )
    }

    composeOptions {
        // Questa versione deve essere compatibile con la tua versione di Kotlin
        kotlinCompilerExtensionVersion = "1.5.10"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

val validateApi31CompatConfiguration by tasks.registering {
    group = "verification"
    description = "Valida la configurazione pubblica TLS della build API31 compat."
    doLast {
        api31CompatConfigurationError?.let { throw GradleException(it) }
    }
}

tasks.configureEach {
    if (name == "preApi31CompatBuild") {
        dependsOn(validateApi31CompatConfiguration)
    }
}

val googleServicesFile = layout.projectDirectory.file("google-services.json").asFile
if (
    googleServicesFile.isFile &&
    googleServicesFile.readText().contains("\"package_name\": \"$postazioneApplicationId\"")
) {
    apply(plugin = "com.google.gms.google-services")
}

val syncBundledWebApp by tasks.registering(Sync::class) {
    from(webDistDir)
    into(bundledWebAssetsDir)
    doFirst {
        val distIndex = webDistDir.file("index.html").asFile
        if (!distIndex.isFile) {
            throw GradleException(
                "Frontend Postazione non compilato. Esegui 'npm run build' in ../web-frontend."
            )
        }
        val newestSource = (
            webSourceRoots.asSequence().flatMap { root ->
                if (root.isDirectory) root.walkTopDown().filter { it.isFile } else emptySequence()
            } + webSourceFiles.asSequence().filter { it.isFile }
        ).maxByOrNull { it.lastModified() }
        if (newestSource != null && newestSource.lastModified() > distIndex.lastModified()) {
            throw GradleException(
                "Frontend Postazione piu recente del bundle dist. Esegui 'npm run build' in ../web-frontend."
            )
        }
    }
}

tasks.named("preBuild").configure {
    dependsOn(syncBundledWebApp)
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(platform("com.google.firebase:firebase-bom:33.2.0"))
    implementation("com.google.firebase:firebase-messaging")
    // Core e Lifecycle
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

    // Jetpack Compose
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation(platform("androidx.compose:compose-bom:2023.10.01")) // Consigliato per gestire le versioni
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    // Material Components (Necessario per risolvere l'errore del Tema XML)
    implementation("com.google.android.material:material:1.11.0")

    // Tooling di debug
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// Come nel progetto Palmare: sotto `com.sentrapa.cassav6` c'e' una seconda copia
// dell'app che **non compila**, perche' usa `BuildConfig` e `R` di quel package
// mentre il namespace del modulo resta `com.sentrapa.webkiosk`. Non e'
// referenziata dall'AndroidManifest, che risolve i nomi relativi sul namespace.
// Senza questa esclusione il progetto non si costruisce affatto: resta fuori
// dalla compilazione finche' la migrazione di identita' V6 non viene completata.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude("com/sentrapa/cassav6/**")
}
