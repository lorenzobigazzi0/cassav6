import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const LAN_IP = process.env.LAN_IP || "192.168.1.182";
const CERT_DIR = process.env.CERT_DIR
  ? path.resolve(projectRoot, process.env.CERT_DIR)
  : path.resolve(projectRoot, "certs");

const certPath = path.join(CERT_DIR, `${LAN_IP}.pem`);
const keyPath = path.join(CERT_DIR, `${LAN_IP}-key.pem`);

function localMkcertCandidate() {
  if (process.platform !== "win32") {
    return null;
  }

  const baseDir = process.env.LOCALAPPDATA;
  if (!baseDir) {
    return null;
  }

  return path.join(baseDir, "Programs", "mkcert", "mkcert.exe");
}

function resolveMkcertCommand() {
  const localCandidate = localMkcertCandidate();
  if (localCandidate && fs.existsSync(localCandidate)) {
    return localCandidate;
  }

  return "mkcert";
}

const mkcertCommand = resolveMkcertCommand();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Comando fallito: ${command} ${args.join(" ")}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function ensureMkcert() {
  const result = spawnSync(mkcertCommand, ["-help"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  if (result.error || result.status !== 0) {
    console.error("\nmkcert non risulta installato o non e nel PATH.");
    console.error("\nInstalla mkcert prima di continuare:");
    console.error("- macOS: brew install mkcert");
    console.error("- Windows con Chocolatey: choco install mkcert");
    console.error("- Windows con Scoop: scoop install mkcert");
    console.error("- Linux Debian/Ubuntu: installa libnss3-tools e poi mkcert");
    console.error("\nDopo l'installazione, rilancia: npm run cert:lan\n");
    process.exit(1);
  }
}

function installLocalCa() {
  try {
    if (process.platform !== "win32") {
      run(mkcertCommand, ["-install"]);
      return true;
    }

    const caRoot = capture(mkcertCommand, ["-CAROOT"]);
    const rootCaPath = caRoot ? path.join(caRoot, "rootCA.pem") : "";
    if (!rootCaPath || !fs.existsSync(rootCaPath)) {
      throw new Error("rootCA.pem non trovato dopo la generazione dei certificati mkcert.");
    }

    run("certutil", ["-user", "-f", "-addstore", "Root", rootCaPath]);
    return true;
  } catch (error) {
    console.warn("\nInstallazione automatica della CA mkcert non completata.");
    console.warn(`Motivo: ${error?.message || error}`);
    console.warn("I certificati HTTPS sono stati generati; installa manualmente rootCA.pem sui client.\n");
    return false;
  }
}

fs.mkdirSync(CERT_DIR, { recursive: true });
ensureMkcert();

console.log(`\nGenero certificato HTTPS locale per ${LAN_IP}...\n`);

run(mkcertCommand, [
  "-cert-file",
  certPath,
  "-key-file",
  keyPath,
  LAN_IP,
  "localhost",
  "127.0.0.1",
]);
const caInstalled = installLocalCa();

const caRoot = capture(mkcertCommand, ["-CAROOT"]);

console.log("\nCertificati generati:");
console.log(`- Certificato: ${certPath}`);
console.log(`- Chiave:      ${keyPath}`);

if (caRoot) {
  console.log("\nRoot CA mkcert:");
  console.log(caRoot);
  console.log("\nPer telefoni o altri PC, copia e installa SOLO rootCA.pem dal percorso sopra.");
  console.log("Non condividere mai rootCA-key.pem.\n");
  if (!caInstalled) {
    console.log(`CA non installata automaticamente. File client da installare: ${path.join(caRoot, "rootCA.pem")}\n`);
  }
}

console.log(`Avvia ora Vite con: npm run dev:lan:https`);
console.log(`Poi apri: https://${LAN_IP}:5280\n`);
