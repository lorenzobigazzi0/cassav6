# HTTPS LAN locale per microfono

## Avvio rapido

1. Assicurati che il server abbia IP LAN fisso `192.168.0.28`.
2. Installa `mkcert` sulla macchina che esegue Vite.
3. Genera certificati:

   ```bash
   npm run cert:lan
   ```

4. Per sviluppo frontend puro, avvia Vite in HTTPS LAN:

   ```bash
   npm run dev:lan:https
   ```

5. Per il sistema completo V3, avvia lo stack corrente dalla root progetto:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\start-cassav2-current.ps1
   ```

   Lo static server `serve-frontends.mjs` legge gli stessi certificati e serve `/mobile/`, `/postazione/`,
   `/impostazioni/` e `/api` in HTTPS sulla porta `5280`.

6. Apri:

   ```txt
   https://192.168.0.28:5280
   ```

7. Test microfono:

   ```txt
   https://192.168.0.28:5280/mic-test.html
   ```

## Dispositivi client

Se apri la webapp da un altro PC, telefono Android o iPhone, quel dispositivo deve fidarsi della root CA generata da mkcert.

Trova il percorso della root CA con:

```bash
mkcert -CAROOT
```

Copia e installa solo:

```txt
rootCA.pem
```

Non copiare e non condividere mai:

```txt
rootCA-key.pem
```

## Android

Copia `rootCA.pem` sul telefono e installalo dalle impostazioni di sicurezza come certificato CA. Il percorso esatto cambia a seconda del produttore.

## iPhone / iPad

Invia `rootCA.pem` al dispositivo, installalo come profilo e poi abilita la fiducia completa nelle impostazioni certificati.

## Firewall

Se la porta non e raggiungibile, apri la porta TCP `5280` sul server.

Esempio Linux con UFW:

```bash
sudo ufw allow 5280/tcp
```

## Verifica veloce

Nella console del browser, su `https://192.168.0.28:5280`, devono essere veri:

```js
window.isSecureContext
Boolean(navigator.mediaDevices?.getUserMedia)
```

Su Windows, `curl.exe` puo fallire con `CRYPT_E_NO_REVOCATION_CHECK` per la CA locale mkcert.
Per verificare solo il protocollo HTTPS da shell:

```powershell
curl.exe --ssl-no-revoke -I https://192.168.0.28:5280/mic-test.html
```
