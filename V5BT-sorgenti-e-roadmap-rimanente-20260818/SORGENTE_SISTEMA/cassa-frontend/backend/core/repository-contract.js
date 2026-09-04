const REPOSITORY_METHOD_KINDS = new Set(["read", "write"]);
const REPOSITORY_TRANSACTION_REQUIREMENTS = new Set([
  "none",
  "supported",
  "required",
]);

function normalizedSourcePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function contractError(message) {
  const error = new TypeError(message);
  error.code = "REPOSITORY_CONTRACT_INVALID";
  return error;
}

export function repositorySourceRole(sourcePath) {
  const normalized = normalizedSourcePath(sourcePath);
  const basename = normalized.split("/").at(-1) ?? "";
  if (normalized.startsWith("backend/db/")) return "infrastructure";
  if (basename.endsWith(".repo.js") || basename.endsWith(".repository.js")) {
    return "repository";
  }
  if (
    normalized === "backend/server.js"
    || basename.endsWith(".handlers.js")
    || basename.endsWith(".routes.js")
    || basename.endsWith(".controller.js")
    || basename.endsWith(".controllers.js")
    || basename === "route-handlers.js"
  ) {
    return "handler";
  }
  return "application";
}

export function defineRepositoryContract(input = {}) {
  const domain = String(input.domain ?? "").trim();
  if (!/^[a-z][a-zA-Z0-9.-]{1,63}$/.test(domain)) {
    throw contractError("domain del repository non valido.");
  }
  if (!Array.isArray(input.methods) || input.methods.length === 0) {
    throw contractError(`Il repository ${domain} deve dichiarare almeno un metodo.`);
  }

  const names = new Set();
  const methods = input.methods.map((method) => {
    const name = String(method?.name ?? "").trim();
    const kind = String(method?.kind ?? "").trim().toLowerCase();
    const transaction = String(method?.transaction ?? "").trim().toLowerCase();
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
      throw contractError(`Nome metodo repository non valido per ${domain}.`);
    }
    if (names.has(name)) {
      throw contractError(`Metodo repository duplicato: ${domain}.${name}.`);
    }
    if (!REPOSITORY_METHOD_KINDS.has(kind)) {
      throw contractError(`kind non valido per ${domain}.${name}.`);
    }
    if (!REPOSITORY_TRANSACTION_REQUIREMENTS.has(transaction)) {
      throw contractError(`transaction non valido per ${domain}.${name}.`);
    }
    names.add(name);
    return Object.freeze({ kind, name, transaction });
  });

  return Object.freeze({
    domain,
    methods: Object.freeze(methods),
  });
}

export function assertRepositoryImplementation(contract, implementation) {
  if (!contract || !Array.isArray(contract.methods)) {
    throw contractError("Contratto repository assente o non valido.");
  }
  if (!implementation || (typeof implementation !== "object" && typeof implementation !== "function")) {
    const error = new TypeError(`Implementazione repository ${contract.domain} assente.`);
    error.code = "REPOSITORY_CONTRACT_MISMATCH";
    throw error;
  }
  for (const method of contract.methods) {
    if (typeof implementation[method.name] !== "function") {
      const error = new TypeError(
        `Implementazione repository incompleta: manca ${contract.domain}.${method.name}().`,
      );
      error.code = "REPOSITORY_CONTRACT_MISMATCH";
      throw error;
    }
  }
  return implementation;
}

