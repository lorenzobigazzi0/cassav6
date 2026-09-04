import { commercialApi, clearSession, createRequestId, readSession, writeSession } from "./api/client.js";
import { applyEditor, editorHtml } from "./components/editors.js";
import { escapeHtml, slugId, uid } from "./components/ui.js";
import { getState, resetStore, setState, setToast, subscribe, updateSnapshot } from "./state/store.js";
import { renderApp } from "./pages/render.js";

const app = document.querySelector("#app");
let pendingFileAction = "";

function render() {
  app.innerHTML = renderApp(getState());
}
subscribe(render);

function humanError(error) {
  const details = error?.body?.details ?? error?.body ?? null;
  if (details?.validation?.errors?.length) return `${error.message}: ${details.validation.errors[0].message}`;
  return error instanceof Error ? error.message : String(error);
}

async function guarded(callback, { loading = true } = {}) {
  if (loading) setState({ loading: true, error: "" });
  try {
    return await callback();
  } catch (error) {
    setState({ error: humanError(error) });
    throw error;
  } finally {
    if (loading) setState({ loading: false });
  }
}

async function loadWorkspace() {
  const workspace = await commercialApi.workspace();
  const draft = workspace.draft ?? null;
  const sourceSnapshot = draft?.snapshot ?? workspace.published?.snapshot ?? workspace.emptyConfiguration;
  setState({ workspace, draft, draftSnapshot: structuredClone(sourceSnapshot), dirty: false, validation: null, sessionReady: true, error: "" });
}

async function initialize() {
  const session = readSession();
  if (!session.token || !session.userId || !session.deviceUuid) {
    setState({ sessionReady: false });
    return;
  }
  setState({ sessionReady: true, loading: true });
  try {
    await loadWorkspace();
  } catch (error) {
    if (error?.status === 401) {
      clearSession();
      resetStore();
      setState({ sessionReady: false, error: "Sessione scaduta. Accedi nuovamente." });
      return;
    }
    setState({ error: humanError(error), loading: false });
  }
}

function openEditor(kind, id = "", context = "") {
  const dialog = document.querySelector("#editor-dialog");
  const content = document.querySelector("#editor-content");
  if (!dialog || !content) return;
  dialog.dataset.kind = kind;
  dialog.dataset.id = id;
  dialog.dataset.context = context;
  content.innerHTML = editorHtml(kind, id, context, getState().draftSnapshot ?? {});
  dialog.showModal();
}

function closeEditor() {
  document.querySelector("#editor-dialog")?.close();
}

function removeById(array, id) {
  if (!Array.isArray(array)) return [];
  return array.filter((item) => item.id !== id);
}

function deleteEntity(action, id, context) {
  const labels = {
    "delete-product": "l'articolo e tutti i riferimenti collegati",
    "delete-catalog": "il catalogo, i suoi listini e le regole collegate",
    "delete-category": "la categoria e tutte le sue voci",
    "delete-group": "il gruppo; le sue voci diventeranno prodotti diretti",
    "delete-catalog-entry": "la voce dal catalogo",
    "delete-price-list": "il listino e le regole collegate",
    "delete-price-entry": "la voce di prezzo",
    "delete-offer": "l'offerta e tutti i riferimenti collegati",
    "delete-included-item": "il prodotto incluso",
    "delete-choice-group": "il gruppo di scelta e le sue opzioni",
    "delete-choice-option": "l'opzione",
    "delete-assignment": "la regola",
  };
  if (!globalThis.confirm(`Eliminare ${labels[action] ?? "l'elemento"}?`)) return;
  updateSnapshot((snapshot) => {
    if (action === "delete-product") {
      snapshot.products = removeById(snapshot.products, id);
      for (const catalog of snapshot.catalogs ?? []) for (const category of catalog.categories ?? []) category.entries = (category.entries ?? []).filter((entry) => !(entry.sellableType === "product" && entry.sellableId === id));
      for (const list of snapshot.priceLists ?? []) list.entries = (list.entries ?? []).filter((entry) => !(entry.sellableType === "product" && entry.sellableId === id));
      for (const offer of snapshot.offers ?? []) {
        offer.includedItems = (offer.includedItems ?? []).filter((entry) => entry.productId !== id);
        for (const group of offer.choiceGroups ?? []) group.options = (group.options ?? []).filter((entry) => entry.productId !== id);
      }
    } else if (action === "delete-catalog") {
      const listIds = new Set((snapshot.priceLists ?? []).filter((item) => item.catalogId === id).map((item) => item.id));
      snapshot.catalogs = removeById(snapshot.catalogs, id);
      snapshot.priceLists = (snapshot.priceLists ?? []).filter((item) => !listIds.has(item.id));
      snapshot.assignments = (snapshot.assignments ?? []).filter((item) => !(item.targetType === "catalog" && item.targetId === id) && !(item.targetType === "price_list" && listIds.has(item.targetId)));
      if (snapshot.settings?.defaultCatalogId === id) snapshot.settings.defaultCatalogId = snapshot.catalogs?.[0]?.id ?? "";
    } else if (action === "delete-category") {
      const catalog = snapshot.catalogs?.find((item) => item.id === context); if (catalog) catalog.categories = removeById(catalog.categories, id);
    } else if (action === "delete-group") {
      const [catalogId, categoryId] = String(context).split("|"); const category = snapshot.catalogs?.find((item) => item.id === catalogId)?.categories?.find((item) => item.id === categoryId);
      if (category) { category.groups = removeById(category.groups, id); for (const entry of category.entries ?? []) if (entry.groupId === id) entry.groupId = null; }
    } else if (action === "delete-catalog-entry") {
      const [catalogId, categoryId] = String(context).split("|"); const category = snapshot.catalogs?.find((item) => item.id === catalogId)?.categories?.find((item) => item.id === categoryId); if (category) category.entries = removeById(category.entries, id);
    } else if (action === "delete-price-list") {
      snapshot.priceLists = removeById(snapshot.priceLists, id);
      for (const catalog of snapshot.catalogs ?? []) if (catalog.basePriceListId === id) catalog.basePriceListId = "";
      for (const list of snapshot.priceLists ?? []) if (list.inheritsFromId === id) list.inheritsFromId = null;
      snapshot.assignments = (snapshot.assignments ?? []).filter((item) => !(item.targetType === "price_list" && item.targetId === id));
    } else if (action === "delete-price-entry") {
      const list = snapshot.priceLists?.find((item) => item.id === context); if (list) list.entries = removeById(list.entries, id);
    } else if (action === "delete-offer") {
      snapshot.offers = removeById(snapshot.offers, id);
      for (const catalog of snapshot.catalogs ?? []) for (const category of catalog.categories ?? []) category.entries = (category.entries ?? []).filter((entry) => !(entry.sellableType === "offer" && entry.sellableId === id));
      for (const list of snapshot.priceLists ?? []) list.entries = (list.entries ?? []).filter((entry) => !(entry.sellableType === "offer" && entry.sellableId === id));
    } else if (action === "delete-included-item") {
      const offer = snapshot.offers?.find((item) => item.id === context); if (offer) offer.includedItems = removeById(offer.includedItems, id);
    } else if (action === "delete-choice-group") {
      const offer = snapshot.offers?.find((item) => item.id === context); if (offer) offer.choiceGroups = removeById(offer.choiceGroups, id);
    } else if (action === "delete-choice-option") {
      const [offerId, groupId] = String(context).split("|"); const group = snapshot.offers?.find((item) => item.id === offerId)?.choiceGroups?.find((item) => item.id === groupId); if (group) group.options = removeById(group.options, id);
    } else if (action === "delete-assignment") {
      snapshot.assignments = removeById(snapshot.assignments, id);
    }
  });
  setToast("Elemento eliminato dalla bozza.", "warning");
}

function duplicateEntity(action, id) {
  updateSnapshot((snapshot) => {
    if (action === "duplicate-product") {
      const current = snapshot.products?.find((item) => item.id === id); if (!current) return; snapshot.products.push({ ...structuredClone(current), id: uid("product"), name: `${current.name} copia`, sku: current.sku ? `${current.sku}-COPY` : "" });
    } else if (action === "duplicate-price-list") {
      const current = snapshot.priceLists?.find((item) => item.id === id); if (!current) return; snapshot.priceLists.push({ ...structuredClone(current), id: uid("price_list"), name: `${current.name} copia`, entries: (current.entries ?? []).map((entry) => ({ ...entry, id: uid("price") })) });
    } else if (action === "duplicate-assignment") {
      const current = snapshot.assignments?.find((item) => item.id === id); if (!current) return; snapshot.assignments.push({ ...structuredClone(current), id: uid("assignment"), enabled: false, notes: [current.notes, "Copia da verificare"].filter(Boolean).join(" · ") });
    }
  });
  setToast("Copia aggiunta alla bozza.");
}

async function createDraft() {
  const version = await commercialApi.createDraft({ idempotencyKey: createRequestId("draft_create") });
  const workspace = { ...(getState().workspace ?? {}), draft: version, state: { ...(getState().workspace?.state ?? {}), currentDraftVersionId: version.id } };
  setState({ workspace, draft: version, draftSnapshot: structuredClone(version.snapshot), dirty: false, validation: null });
  setToast("Bozza creata.");
}

async function saveDraft() {
  const state = getState();
  if (!state.draft) return;
  setState({ saving: true, error: "" });
  try {
    const result = await commercialApi.saveDraft({ draftId: state.draft.id, expectedRevision: state.draft.revision, snapshot: state.draftSnapshot, idempotencyKey: createRequestId("draft_save") });
    const draft = result.version;
    setState({ draft, workspace: { ...state.workspace, draft }, draftSnapshot: structuredClone(draft.snapshot), dirty: false, validation: result.validation, saving: false });
    setToast("Bozza salvata.");
  } catch (error) {
    setState({ saving: false, error: humanError(error) });
  }
}

async function validateDraft() {
  const state = getState(); if (!state.draft) return;
  const result = await commercialApi.validateDraft({ draftId: state.draft.id, snapshot: state.draftSnapshot });
  setState({ validation: result.validation, activeTab: state.activeTab === "publication" ? "publication" : state.activeTab });
  setToast(result.validation?.ok ? "Configurazione valida." : "Validazione completata con errori.", result.validation?.ok ? "success" : "danger");
}

async function publishDraft() {
  const state = getState(); if (!state.draft) return;
  const note = String(document.querySelector("#publication-note")?.value ?? "").trim();
  if (!note) { setState({ error: "Inserisci una nota di pubblicazione." }); return; }
  if (!globalThis.confirm("Pubblicare questa configurazione? La vendita userà la nuova versione dopo l'attivazione del runtime V2.")) return;
  await commercialApi.publishDraft({ draftId: state.draft.id, expectedRevision: state.draft.revision, note, idempotencyKey: createRequestId("draft_publish") });
  await loadWorkspace();
  setToast("Configurazione pubblicata.");
}

async function bootstrapLegacy() {
  if (!globalThis.confirm("Importare articoli, listini e pianificazioni dalla configurazione legacy nella bozza V2?")) return;
  const result = await commercialApi.bootstrapLegacy({ forceNew: !getState().draft, idempotencyKey: createRequestId("legacy_bootstrap") });
  const draft = result.draft;
  setState({ draft, workspace: { ...getState().workspace, draft }, draftSnapshot: structuredClone(draft.snapshot ?? result.snapshot), dirty: false, validation: result.validation });
  setToast("Configurazione legacy importata nella bozza.");
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

async function exportVersion() {
  const result = await commercialApi.exportVersion({ versionId: getState().draft?.id ?? getState().workspace?.published?.id });
  downloadJson(`cassav6-commercial-v2-${result.version.versionNumber}.json`, result);
  setToast("Esportazione completata.");
}

function openFile(action, accept) {
  const input = document.querySelector("#file-input"); if (!input) return; pendingFileAction = action; input.value = ""; input.accept = accept; input.click();
}

function parseCsvLine(line) {
  const cells = []; let value = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === '"' && line[index + 1] === '"' && quoted) { value += '"'; index += 1; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { cells.push(value.trim()); value = ""; } else value += char; }
  cells.push(value.trim()); return cells;
}

function importProductsCsv(content) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()); if (lines.length < 2) throw new Error("CSV vuoto.");
  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase()); const index = (name) => headers.indexOf(name);
  const products = lines.slice(1).map((line, rowIndex) => { const cells = parseCsvLine(line); const name = cells[index("name")] || cells[index("nome")] || `Articolo ${rowIndex + 1}`; const price = cells[index("price")] || cells[index("prezzo")] || "0"; return { id: cells[index("id")] || slugId(name, "product"), name, sku: cells[index("sku")] || cells[index("codice")] || "", description: cells[index("description")] || cells[index("descrizione")] || "", basePriceCents: Math.max(0, Math.round((Number(String(price).replace(",", ".")) || 0) * 100)), taxRate: Number(cells[index("taxrate")] || cells[index("iva")] || 10) || 10, taxCode: cells[index("taxcode")] || "", enabled: true, workstationIds: String(cells[index("workstations")] || "").split("|").filter(Boolean), tags: [], allergens: [], variants: [] }; });
  updateSnapshot((snapshot) => { snapshot.products ??= []; const byId = new Map(snapshot.products.map((item) => [item.id, item])); for (const product of products) byId.set(product.id, { ...(byId.get(product.id) ?? {}), ...product }); snapshot.products = [...byId.values()]; });
  setToast(`${products.length} articoli importati.`);
}

async function handleFile(file) {
  const content = await file.text();
  if (pendingFileAction === "import-products-csv") { importProductsCsv(content); return; }
  const parsed = JSON.parse(content); const snapshot = parsed.snapshot ?? parsed;
  if (pendingFileAction === "import-json") {
    if (getState().draft) updateSnapshot((target) => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, snapshot); });
    else { const created = await commercialApi.createDraft({ idempotencyKey: createRequestId("import_create") }); const result = await commercialApi.importSnapshot({ draftId: created.id, expectedRevision: created.revision, snapshot, idempotencyKey: createRequestId("import_save") }); setState({ draft: result.version, workspace: { ...getState().workspace, draft: result.version }, draftSnapshot: structuredClone(result.version.snapshot), dirty: false, validation: result.validation }); }
    setToast("JSON importato nella bozza.");
  }
}

async function runSimulator(form) {
  const raw = Object.fromEntries(new FormData(form)); const [embeddedType, embeddedId] = String(raw.sellableId ?? "").split(":");
  let selections = []; if (String(raw.selections ?? "").trim()) selections = JSON.parse(String(raw.selections));
  const context = { dateTime: raw.dateTime ? new Date(String(raw.dateTime)).toISOString() : new Date().toISOString(), channel: raw.channel, activityId: raw.activityId, roomId: raw.roomId, workstationId: raw.workstationId, role: raw.role, userGroupIds: String(raw.userGroupIds ?? "").split(",").map((item) => item.trim()).filter(Boolean), userId: raw.userId };
  const result = await commercialApi.simulate({ versionId: getState().draft?.id ?? null, context, sellable: { sellableType: embeddedType || raw.sellableType, sellableId: embeddedId || raw.sellableId, selections } });
  setState({ simulatorResult: result.result });
}

async function diffVersions() {
  const [leftVersionId, rightVersionId] = getState().selectedVersionIds; if (!leftVersionId || !rightVersionId) return;
  const result = await commercialApi.diff({ leftVersionId, rightVersionId }); const target = document.querySelector("#diff-result"); if (!target) return;
  target.innerHTML = result.changes.length ? `<p><strong>${result.changes.length}</strong> differenze${result.truncated ? " (elenco troncato)" : ""}.</p><pre class="trace">${escapeHtml(JSON.stringify(result.changes.slice(0, 500), null, 2))}</pre>` : `<div class="callout callout--success"><strong>Nessuna differenza</strong><span>Le configurazioni coincidono.</span></div>`;
}

async function rollbackVersion(id) {
  const note = globalThis.prompt("Nota del rollback:", `Rollback alla versione ${id}`); if (note === null) return;
  if (!globalThis.confirm("Confermare il rollback? Verrà creata una nuova versione pubblicata.")) return;
  await commercialApi.rollback({ targetVersionId: id, note, idempotencyKey: createRequestId("rollback") }); await loadWorkspace(); setToast("Rollback pubblicato.");
}

const editorActions = new Set(["edit-product", "edit-catalog", "edit-category", "edit-group", "edit-catalog-entry", "edit-price-list", "edit-price-entry", "edit-offer", "edit-included-item", "edit-choice-group", "edit-choice-option", "edit-assignment", "bulk-price-change", "edit-json"]);
const deleteActions = new Set(["delete-product", "delete-catalog", "delete-category", "delete-group", "delete-catalog-entry", "delete-price-list", "delete-price-entry", "delete-offer", "delete-included-item", "delete-choice-group", "delete-choice-option", "delete-assignment"]);
const duplicateActions = new Set(["duplicate-product", "duplicate-price-list", "duplicate-assignment"]);

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]"); if (!button) return; const action = button.dataset.action; const id = button.dataset.id ?? ""; const context = button.dataset.context ?? "";
  if (action === "tab") { setState({ activeTab: id, filter: "", error: "" }); return; }
  if (editorActions.has(action)) { openEditor(action, id, context); return; }
  if (deleteActions.has(action)) { deleteEntity(action, id, context); return; }
  if (duplicateActions.has(action)) { duplicateEntity(action, id); return; }
  if (action === "close-editor") { closeEditor(); return; }
  if (action === "dismiss-error") { setState({ error: "" }); return; }
  if (action === "create-draft") void guarded(createDraft);
  else if (action === "save-draft") void saveDraft();
  else if (action === "validate-draft") void guarded(validateDraft);
  else if (action === "publish-draft") void guarded(publishDraft);
  else if (action === "bootstrap-legacy") void guarded(bootstrapLegacy);
  else if (action === "export-version") void guarded(exportVersion);
  else if (action === "import-json") openFile("import-json", ".json,application/json");
  else if (action === "import-products-csv") openFile("import-products-csv", ".csv,text/csv");
  else if (action === "diff-versions") void guarded(diffVersions);
  else if (action === "rollback-version") void guarded(() => rollbackVersion(id));
  else if (action === "reload") void guarded(loadWorkspace);
  else if (action === "logout") void guarded(async () => { try { await commercialApi.logout(); } finally { clearSession(); resetStore(); setState({ sessionReady: false }); } });
});

document.addEventListener("input", (event) => {
  if (event.target.matches('[data-role="filter"]')) setState({ filter: event.target.value });
  if (event.target.matches('[data-role="version-select"]')) {
    const id = event.target.dataset.id; const selected = new Set(getState().selectedVersionIds); if (event.target.checked) selected.add(id); else selected.delete(id); setState({ selectedVersionIds: [...selected].slice(-2) });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "login-form") {
    event.preventDefault(); const form = new FormData(event.target);
    void guarded(async () => { const result = await commercialApi.login({ username: String(form.get("username") ?? "").trim(), pin: String(form.get("pin") ?? "").trim(), deviceUuid: String(form.get("deviceUuid") ?? "settings-browser").trim() }); writeSession({ ...result, userId: result.user?.id, username: result.user?.username, deviceUuid: String(form.get("deviceUuid") ?? "settings-browser") }); await loadWorkspace(); setToast("Accesso effettuato."); }); return;
  }
  if (event.target.id === "editor-form") {
    event.preventDefault(); const dialog = document.querySelector("#editor-dialog"); const kind = dialog?.dataset.kind ?? ""; const id = dialog?.dataset.id ?? ""; const context = dialog?.dataset.context ?? ""; const form = new FormData(event.target);
    try { updateSnapshot((snapshot) => applyEditor(kind, id, context, form, snapshot)); closeEditor(); setToast("Modifica applicata alla bozza."); } catch (error) { setState({ error: humanError(error) }); } return;
  }
  if (event.target.id === "simulator-form") { event.preventDefault(); void guarded(() => runSimulator(event.target)); }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "file-input" && event.target.files?.[0]) void guarded(() => handleFile(event.target.files[0]));
});

render();
void initialize();
