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

val palmareApplicationId =
    providers.gradleProperty("cassaApplicationId")
        .getOrElse("com.sentrapa.palmare.advanced")
val palmareAppLabel =
    providers.gradleProperty("cassaAppLabel")
        .getOrElse("Palmare Advanced")
// Falso costruisce la variante WebView: nessun frontend dentro l'APK, la UI
// viene letta dal server configurato. Vero incorpora il bundle come sempre.
val bundledWebAppEnabled =
    providers.gradleProperty("cassaBundledWebApp")
        .map(String::toBooleanStrict)
        .getOrElse(true)
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
val bundledWebAssetsDir = layout.projectDirectory.dir("src/main/assets/mobile")
val webSourceRoots = listOf("src", "public", "legacy-mobile-assets")
    .map { webFrontendDir.dir(it).asFile }
val webSourceFiles = listOf(
    "index.html",
    "vite.config.ts",
    "vitest.config.ts",
    "tsconfig.json",
    "package.json"
).map { webFrontendDir.file(it).asFile }

android {
    namespace = "com.sentrapa.webkiosk"
    compileSdk = 34

    defaultConfig {
        applicationId = palmareApplicationId
        minSdk = 24
        targetSdk = 34
        versionCode = 40
        versionName = "1.0.39"
        manifestPlaceholders["appLabel"] = palmareAppLabel

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
        buildConfigField("String", "BLUETOOTH_NODE_KIND", "\"handheld\"")
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

val googleServicesFile = layout.projectDirectory.file("google-services.json").asFile
if (
    googleServicesFile.isFile &&
    googleServicesFile.readText().contains("\"package_name\": \"$palmareApplicationId\"")
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
                "Frontend Palmare non compilato. Esegui 'npm run build' in ../web-frontend."
            )
        }
        val newestSource = (
            webSourceRoots.asSequence().flatMap { root ->
                if (root.isDirectory) root.walkTopDown().filter { it.isFile } else emptySequence()
            } + webSourceFiles.asSequence().filter { it.isFile }
        ).maxByOrNull { it.lastModified() }
        if (newestSource != null && newestSource.lastModified() > distIndex.lastModified()) {
            throw GradleException(
                "Frontend Palmare piu recente del bundle dist. Esegui 'npm run build' in ../web-frontend."
            )
        }
    }
}

val clearBundledWebApp by tasks.registering(Delete::class) {
    delete(bundledWebAssetsDir)
}

tasks.named("preBuild").configure {
    // Un Sync senza sorgenti verrebbe saltato come NO-SOURCE lasciando dentro
    // l'APK il bundle della build precedente: la variante WebView cancella.
    dependsOn(if (bundledWebAppEnabled) syncBundledWebApp else clearBundledWebApp)
}

// V6.0.0.5 consegna una seconda copia dell'intera app sotto
// com.sentrapa.cassav6.webkiosk che non compila: usa BuildConfig e R di quel
// package, mentre il namespace del modulo resta com.sentrapa.webkiosk. Non e'
// referenziata dall'AndroidManifest, che risolve i nomi relativi sul namespace,
// e non compare in V6_BOOTSTRAP_MANIFEST.tsv. Resta esclusa dalla compilazione
// finche' la migrazione di identita' V6 non viene completata.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude("com/sentrapa/cassav6/**")
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
