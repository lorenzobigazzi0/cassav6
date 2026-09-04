# Archivio portatile Cassa V5BT

Data preparazione: 2026-07-20

Questo archivio e destinato al trasferimento del workspace V5BT su un altro PC.
Contiene i sorgenti, le copie del server, i database, le configurazioni, la
roadmap Bluetooth, gli script, i test e la documentazione.

## Elementi conservati

- sorgenti di Palmare Advanced e Postazione Advanced;
- sorgenti e copia del server;
- runtime Node x64 locale e ARM64 del server, necessari agli script di avvio
  e non prodotti dai sorgenti V5BT;
- database, dump SQL e snapshot SQLite;
- configurazioni e materiale riservato gia presente nel workspace;
- roadmap Bluetooth e relative evidenze;
- frontend `cassa`, `monitor`, `reservation` e `settings` compilati, perche
  nel workspace non sono presenti i rispettivi sorgenti completi per
  rigenerarli;
- le copie dei frontend non ricostruibili presenti nei rispettivi contesti
  server, anche quando risultano byte-identiche.

## Elementi esclusi

- `node_modules` e cache dei package manager;
- stato locale di esecuzione `.runtime/cassav5bt`;
- cache Gradle e directory Android `build`;
- directory `dist` quando sono presenti sorgenti e lockfile per rigenerarle;
- asset web copiati nelle app Android dal task Gradle `preBuild`;
- directory duplicata `WEBAPP_COMPILATA`, che non contiene file unici;
- APK, AAB, DEX, classi e altri output compilati;
- `local.properties`, `*.tsbuildinfo`, PID e lock locali.

I manifest `package.json`, i `package-lock.json`, Gradle Wrapper, i file
`build.gradle.kts` e tutti i sorgenti necessari alla ricompilazione restano
inclusi.

## Ripristino sul nuovo PC

1. Installare Node.js, JDK 17 e Android SDK 34.
2. Nei progetti Node eseguire `npm ci`.
3. Eseguire `npm run build` nei frontend interessati.
4. Per le app Android usare `APPLICATIVI/Palmare/build-palmare.ps1` e
   `APPLICATIVI/Postazione/build-postazione.ps1`, oppure i rispettivi Gradle
   Wrapper dopo la build web.
5. Configurare `ANDROID_HOME` oppure rigenerare `local.properties` per il
   percorso Android SDK del nuovo PC.

L'archivio contiene configurazioni e materiale TLS riservato: trasferirlo e
conservarlo come dato sensibile.
