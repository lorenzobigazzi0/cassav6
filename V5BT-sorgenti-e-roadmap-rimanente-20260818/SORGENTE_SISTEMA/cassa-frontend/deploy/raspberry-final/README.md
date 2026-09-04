# Raspberry final target deploy

Target rilevato:

- Host: `192.168.1.79`
- Architettura: `aarch64`
- Kernel: PREEMPT_RT
- CPU online: `0-3`
- CPU disponibili allo scheduler: `0-3`, senza core isolati

Regola deploy: servizi CASSAv4, MariaDB, Redis, Mosquitto e processi di sistema
possono usare tutti i core `0 1 2 3`.

Layout:

```text
/opt/cassav4/releases/<release>   codice release
/opt/cassav4/current              symlink release attiva
/etc/cassav4/cassav4.env          configurazione e segreti runtime
/etc/cassav4/tls/                 certificato HTTPS LAN
/var/lib/cassav4/                 stato runtime non versionato, inclusi DB relazionale e app-state split
```

Servizi:

```text
cassav4-backend.service          backend owner su 127.0.0.1:5281
cassav4-realtime.service         gateway realtime/SSE su 127.0.0.1:5282
cassav4-api-worker@5283.service  api-worker 1 su 127.0.0.1:5283
cassav4-api-worker@5284.service  api-worker 2 su 127.0.0.1:5284
cassav4-table-lock-worker.service worker lock tavoli su 127.0.0.1:5285
cassav4-frontend.service         HTTPS/proxy su 0.0.0.0:5280
cassav4-battery.service          battery service su 127.0.0.1:8765
cassav4-hardware-telemetry.service diagnostica persistente Raspberry ogni 5s
cassav4-fiscal-simulator.service simulatore fiscale locale su 127.0.0.1:9290
cassav4-automatic-cash-simulator.service simulatore cassa automatica locale su 127.0.0.1:9190
```

Sul Raspberry finale il kernel PREEMPT_RT resta attivo, ma non vengono usati
`isolcpus`, `nohz_full` o `rcu_nocbs`: tutti i quattro core partecipano allo
scheduling generale. Il frontend bilancia le route `api-worker` in round-robin su:

```env
BACKEND_API_WORKER_ORIGIN=http://127.0.0.1:5283,http://127.0.0.1:5284
BACKEND_TABLE_LOCK_WORKER_ORIGIN=http://127.0.0.1:5285
```

I fuse e l'allowlist del worker lock sono distribuiti senza segreti in
`/etc/cassav4/cassav4-table-lock-worker.env`, caricato dopo il profilo runtime
principale da owner, realtime, API worker, worker lock e frontend.

URL principale:

```text
https://192.168.1.79:5280/mobile/
```

Installazione diagnostica hardware:

```bash
sudo install -m 0755 deploy/raspberry-final/cassav4-hardware-telemetry.sh \
  /usr/local/libexec/cassav4-hardware-telemetry
sudo install -m 0644 deploy/raspberry-final/cassav4-hardware-telemetry.service \
  /etc/systemd/system/cassav4-hardware-telemetry.service
sudo systemctl daemon-reload
sudo systemctl enable --now cassav4-hardware-telemetry.service
```

Il servizio conserva campioni ruotati in
`/var/log/cassav4/hardware-telemetry.log*` e, una sola volta per boot, salva
`boot-diagnostics-*.log` con journal kernel e warning del boot precedente. Usa
priorita' CPU/I/O minima, massimo 64 MB di memoria e non esegue azioni di
recovery automatiche.

Raccolta forense dopo un crash P4:

```bash
sudo install -m 0755 deploy/raspberry-final/cassav4-p4-crash-forensics.sh \
  /usr/local/sbin/cassav4-p4-crash-forensics
sudo /usr/local/sbin/cassav4-p4-crash-forensics \
  p4_paced100_autoprint_postfix_20260710_1915
```

Il comando non ferma e non riavvia servizi. Produce un archivio con manifest e
SHA256 in `/var/log/cassav4/forensics/`, includendo journal del boot precedente,
segnali OOM/watchdog/panic, telemetria hardware, configurazione systemd e gli
artefatti del run indicato. Impostare `P4_FORENSICS_INCLUDE_DATABASES=0` per
omettere i database SQLite sintetici.

Deploy transazionale degli strumenti P4:

```bash
P4_OBSERVABILITY_DRY_RUN=1 sudo -E \
  deploy/raspberry-final/install-p4-observability.sh
sudo deploy/raspberry-final/install-p4-observability.sh
```

L'installer crea un backup sotto `/opt/cassav4/backups`, installa e avvia solo
la telemetria, esegue test statici e preflight-only, quindi controlla le health
gia' attive. Non riavvia frontend, backend o worker. Ogni errore ripristina file
e stato precedente della telemetria.

MQTT resta fanout eventi. I comandi MQTT sono spenti:

```env
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
```

Profilo hardware simulato, senza richieste verso dispositivi LAN reali:

```bash
sudo install -m 0644 deploy/raspberry-final/cassav4-fiscal-simulator.service /etc/systemd/system/
sudo install -m 0644 deploy/raspberry-final/cassav4-automatic-cash-simulator.service /etc/systemd/system/
sudo cp deploy/raspberry-final/cassav4.simulated-hardware.env /etc/cassav4/cassav4.simulated-hardware.env
sudo install -D -m 0644 deploy/raspberry-final/systemd-overrides/cassav4-backend.service.d/70-simulated-hardware.conf /etc/systemd/system/cassav4-backend.service.d/70-simulated-hardware.conf
sudo systemctl daemon-reload
sudo systemctl enable --now cassav4-fiscal-simulator cassav4-automatic-cash-simulator
sudo systemctl restart cassav4-backend
```

Rollback release:

```bash
sudo ln -sfn /opt/cassav4/releases/<release-precedente> /opt/cassav4/current
sudo systemctl restart cassav4-backend cassav4-realtime cassav4-api-worker@5283 cassav4-api-worker@5284 cassav4-table-lock-worker cassav4-battery cassav4-frontend
```
