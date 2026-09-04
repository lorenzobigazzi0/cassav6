import {
  WEEKDAYS,
  actionButton,
  badge,
  emptyState,
  escapeHtml,
  formatDate,
  formatMoney,
  issueList,
  metricCard,
  minutesToTime,
  pageHeader,
} from "../components/ui.js";

const TABS = [
  ["overview", "Panoramica", "⌂"],
  ["products", "Articoli", "▦"],
  ["catalogs", "Cataloghi", "▤"],
  ["price-lists", "Listini", "€"],
  ["offers", "Menù e offerte", "◇"],
  ["assignments", "Applicazione e orari", "◷"],
  ["simulator", "Simulatore", "◎"],
  ["publication", "Pubblicazione e storico", "↺"],
];

function snapshotOf(state) {
  return state.draftSnapshot ?? state.workspace?.published?.snapshot ?? state.workspace?.emptyConfiguration ?? {};
}

function currentVersion(state) {
  return state.draft ?? state.workspace?.draft ?? state.workspace?.published ?? null;
}

function renderLogin() {
  return `<main class="login-shell"><section class="login-card"><div class="brand-mark">V6</div><div><p class="eyebrow">Cassa V6 · Impostazioni</p><h1>Cataloghi, listini e offerte</h1><p>Accedi con un utente autorizzato alla gestione delle impostazioni.</p></div><form id="login-form" class="login-form"><label class="field"><span>Utente</span><input name="username" autocomplete="username" required /></label><label class="field"><span>PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required /></label><label class="field"><span>UUID dispositivo</span><input name="deviceUuid" value="settings-browser" required /></label><button class="button button--primary" type="submit">Accedi</button></form></section></main>`;
}

function renderTopBar(state) {
  const version = currentVersion(state);
  const status = version?.status ?? (state.draftSnapshot ? "draft" : "none");
  return `<header class="topbar"><div><p class="eyebrow">Configurazione commerciale V2</p><h1>${escapeHtml(snapshotOf(state).name || "Cataloghi, listini e offerte")}</h1></div><div class="topbar__actions"><span class="save-state ${state.dirty ? "save-state--dirty" : ""}">${state.saving ? "Salvataggio…" : state.dirty ? "Modifiche non salvate" : "Salvato"}</span>${badge(status === "draft" ? "Bozza" : status === "published" ? "Pubblicato" : "Non inizializzato", status === "draft" ? "warning" : status === "published" ? "success" : "neutral")}${actionButton("Valida", "validate-draft", { compact: true, disabled: !state.draft })}${actionButton("Salva bozza", "save-draft", { tone: "primary", compact: true, disabled: !state.draft || !state.dirty })}</div></header>`;
}

function renderNav(state) {
  return `<aside class="sidebar"><div class="sidebar__brand"><div class="brand-mark brand-mark--small">V6</div><div><strong>Impostazioni</strong><span>Commerciale V2</span></div></div><nav>${TABS.map(([id, label, icon]) => `<button type="button" class="nav-item ${state.activeTab === id ? "is-active" : ""}" data-action="tab" data-id="${id}"><span>${icon}</span>${escapeHtml(label)}</button>`).join("")}</nav><div class="sidebar__footer"><button type="button" class="nav-item" data-action="reload"><span>↻</span>Ricarica</button><button type="button" class="nav-item" data-action="logout"><span>⇥</span>Esci</button></div></aside>`;
}

function renderOverview(state, snapshot) {
  const draft = state.draft;
  const published = state.workspace?.published;
  const validation = state.validation;
  const nextSchedules = (snapshot.assignments ?? []).filter((item) => item.enabled !== false && (item.validFrom || item.validTo)).slice(0, 6);
  return `${pageHeader("Panoramica", "Stato della configurazione commerciale, copertura e azioni principali.", !draft ? actionButton("Crea bozza", "create-draft", { tone: "primary" }) : "")}
  <div class="metrics-grid">
    ${metricCard("Articoli", String(snapshot.products?.length ?? 0), "Anagrafica vendibile")}
    ${metricCard("Cataloghi", String(snapshot.catalogs?.length ?? 0), "Strutture di navigazione")}
    ${metricCard("Listini", String(snapshot.priceLists?.length ?? 0), "Base e sovrascritture")}
    ${metricCard("Offerte", String(snapshot.offers?.length ?? 0), "Menù e formule componibili")}
    ${metricCard("Regole", String(snapshot.assignments?.length ?? 0), "Ambiti, utenti e orari")}
    ${metricCard("Validazione", validation ? (validation.ok ? "Valida" : `${validation.errors?.length ?? 0} errori`) : "Da eseguire", validation?.warnings?.length ? `${validation.warnings.length} avvisi` : "", validation?.ok ? "success" : validation ? "danger" : "neutral")}
  </div>
  <div class="two-column">
    <section class="panel"><div class="panel__header"><div><h3>Versioni operative</h3><p>La vendita continua a usare la versione pubblicata finché la bozza non viene pubblicata.</p></div></div><dl class="detail-list"><div><dt>Versione pubblicata</dt><dd>${published ? `#${published.versionNumber} · ${formatDate(published.publishedAt)}` : "Nessuna"}</dd></div><div><dt>Bozza corrente</dt><dd>${draft ? `#${draft.versionNumber} · revisione ${draft.revision}` : "Nessuna"}</dd></div><div><dt>Checksum</dt><dd><code>${escapeHtml((published?.checksum ?? draft?.checksum ?? "—").slice(0, 20))}</code></dd></div><div><dt>Fuso orario</dt><dd>${escapeHtml(snapshot.settings?.timeZone ?? "Europe/Rome")}</dd></div></dl><div class="button-row">${actionButton("Importa configurazione attuale", "bootstrap-legacy", { disabled: Boolean(draft && snapshot.products?.length) })}${actionButton("Apri JSON avanzato", "edit-json")}</div></section>
    <section class="panel"><div class="panel__header"><div><h3>Prossime regole programmate</h3><p>Intervalli di validità presenti nella bozza.</p></div></div>${nextSchedules.length ? `<div class="stack-list">${nextSchedules.map((item) => `<article><div><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.scopeType)} · ${escapeHtml(item.scopeId)}</span></div><div class="align-right"><span>${escapeHtml(item.targetId)}</span><small>${formatDate(item.validFrom)} → ${formatDate(item.validTo)}</small></div></article>`).join("")}</div>` : emptyState("Nessuna programmazione futura", "Le regole senza data sono attive secondo giorni e fascia oraria.")}</section>
  </div>
  <section class="panel"><div class="panel__header"><div><h3>Controlli della bozza</h3><p>Gli errori bloccano la pubblicazione; gli avvisi richiedono una verifica amministrativa.</p></div>${actionButton("Esegui validazione", "validate-draft", { disabled: !draft })}</div>${issueList(validation)}</section>`;
}

function renderProducts(snapshot, filter) {
  const currency = snapshot.currency ?? "EUR";
  const query = filter.toLowerCase();
  const products = (snapshot.products ?? []).filter((item) => !query || [item.name, item.sku, item.id, ...(item.tags ?? [])].join(" ").toLowerCase().includes(query));
  const actions = `${actionButton("Importa CSV", "import-products-csv")}${actionButton("Nuovo articolo", "edit-product", { tone: "primary" })}`;
  return `${pageHeader("Articoli", "Anagrafica unica dei prodotti. Un articolo può comparire in più cataloghi senza essere duplicato.", actions)}<div class="toolbar"><input class="search" data-role="filter" value="${escapeHtml(filter)}" placeholder="Cerca nome, SKU, ID o tag…" /><span>${products.length} di ${snapshot.products?.length ?? 0}</span></div>${products.length ? `<div class="table-wrap"><table><thead><tr><th>Articolo</th><th>SKU</th><th>Prezzo base</th><th>IVA</th><th>Postazioni</th><th>Stato</th><th></th></tr></thead><tbody>${products.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.sku || "—")}</td><td>${formatMoney(item.basePriceCents, currency)}</td><td>${escapeHtml(item.taxCode || `${item.taxRate ?? 0}%`)}</td><td>${escapeHtml((item.workstationIds ?? []).join(", ") || "—")}</td><td>${item.enabled === false ? badge("Disabilitato", "neutral") : badge("Attivo", "success")}</td><td class="row-actions">${actionButton("Modifica", "edit-product", { id: item.id, compact: true })}${actionButton("Duplica", "duplicate-product", { id: item.id, compact: true })}${actionButton("Elimina", "delete-product", { id: item.id, tone: "danger", compact: true })}</td></tr>`).join("")}</tbody></table></div>` : emptyState("Nessun articolo", "Crea il primo articolo oppure importa l'anagrafica legacy.", actionButton("Nuovo articolo", "edit-product", { tone: "primary" }))}`;
}

function catalogEntryLabel(snapshot, entry) {
  if (entry.sellableType === "offer") return snapshot.offers?.find((item) => item.id === entry.sellableId)?.name ?? entry.sellableId;
  return snapshot.products?.find((item) => item.id === entry.sellableId)?.name ?? entry.sellableId;
}

function renderCatalogs(snapshot) {
  const catalogs = snapshot.catalogs ?? [];
  return `${pageHeader("Cataloghi", "Organizza categorie, gruppi e prodotti diretti nell'ordine mostrato a Cassa e Palmare.", actionButton("Nuovo catalogo", "edit-catalog", { tone: "primary" }))}${catalogs.length ? `<div class="catalog-grid">${catalogs.map((catalog) => `<section class="panel catalog-card"><div class="panel__header"><div><h3>${escapeHtml(catalog.name)} ${catalog.isDefault ? badge("Predefinito", "success") : ""}</h3><p><code>${escapeHtml(catalog.id)}</code> · listino base ${escapeHtml(catalog.basePriceListId || "non assegnato")}</p></div><div class="row-actions">${actionButton("Modifica", "edit-catalog", { id: catalog.id, compact: true })}${actionButton("Categoria", "edit-category", { context: catalog.id, compact: true })}${actionButton("Elimina", "delete-catalog", { id: catalog.id, tone: "danger", compact: true })}</div></div>${(catalog.categories ?? []).length ? `<div class="catalog-tree">${catalog.categories.map((category) => `<article class="tree-category"><header><div><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(category.departmentName || category.departmentId || "Senza reparto")}</small></div><div class="row-actions">${actionButton("Modifica", "edit-category", { id: category.id, context: catalog.id, compact: true })}${actionButton("Gruppo", "edit-group", { context: `${catalog.id}|${category.id}`, compact: true })}${actionButton("Voce", "edit-catalog-entry", { context: `${catalog.id}|${category.id}`, compact: true })}${actionButton("×", "delete-category", { id: category.id, context: catalog.id, tone: "danger", compact: true })}</div></header><div class="tree-entries">${(category.entries ?? []).filter((entry) => !entry.groupId).map((entry) => `<div class="tree-entry"><span>${entry.sellableType === "offer" ? "◇" : "•"} ${escapeHtml(catalogEntryLabel(snapshot, entry))}</span><div>${actionButton("Modifica", "edit-catalog-entry", { id: entry.id, context: `${catalog.id}|${category.id}`, compact: true })}${actionButton("×", "delete-catalog-entry", { id: entry.id, context: `${catalog.id}|${category.id}`, tone: "danger", compact: true })}</div></div>`).join("")}${(category.groups ?? []).map((group) => `<div class="tree-group"><header><strong>▤ ${escapeHtml(group.name)}</strong><div>${actionButton("Modifica", "edit-group", { id: group.id, context: `${catalog.id}|${category.id}`, compact: true })}${actionButton("Voce", "edit-catalog-entry", { context: `${catalog.id}|${category.id}|${group.id}`, compact: true })}${actionButton("×", "delete-group", { id: group.id, context: `${catalog.id}|${category.id}`, tone: "danger", compact: true })}</div></header>${(category.entries ?? []).filter((entry) => entry.groupId === group.id).map((entry) => `<div class="tree-entry"><span>${entry.sellableType === "offer" ? "◇" : "•"} ${escapeHtml(catalogEntryLabel(snapshot, entry))}</span><div>${actionButton("Modifica", "edit-catalog-entry", { id: entry.id, context: `${catalog.id}|${category.id}|${group.id}`, compact: true })}${actionButton("×", "delete-catalog-entry", { id: entry.id, context: `${catalog.id}|${category.id}`, tone: "danger", compact: true })}</div></div>`).join("") || `<p class="muted">Gruppo vuoto</p>`}</div>`).join("")}</div></article>`).join("")}</div>` : emptyState("Catalogo vuoto", "Aggiungi una categoria, quindi prodotti diretti o gruppi.", actionButton("Aggiungi categoria", "edit-category", { context: catalog.id }))}</section>`).join("")}</div>` : emptyState("Nessun catalogo", "Crea almeno un catalogo con un listino base.", actionButton("Nuovo catalogo", "edit-catalog", { tone: "primary" }))}`;
}

function renderPriceLists(snapshot) {
  const lists = snapshot.priceLists ?? [];
  const currency = snapshot.currency ?? "EUR";
  return `${pageHeader("Listini", "Definisci un listino base per catalogo e listini derivati contenenti soltanto le differenze.", `${actionButton("Modifica massiva", "bulk-price-change")}${actionButton("Nuovo listino", "edit-price-list", { tone: "primary" })}`)}${lists.length ? `<div class="stack-panels">${lists.map((list) => `<section class="panel"><div class="panel__header"><div><h3>${escapeHtml(list.name)} ${list.status === "disabled" ? badge("Disabilitato") : ""}</h3><p><code>${escapeHtml(list.id)}</code> · catalogo ${escapeHtml(list.catalogId || "—")} ${list.inheritsFromId ? `· eredita da ${escapeHtml(list.inheritsFromId)}` : "· listino autonomo"}</p></div><div class="row-actions">${actionButton("Aggiungi prezzo", "edit-price-entry", { context: list.id, compact: true })}${actionButton("Clona", "duplicate-price-list", { id: list.id, compact: true })}${actionButton("Modifica", "edit-price-list", { id: list.id, compact: true })}${actionButton("Elimina", "delete-price-list", { id: list.id, tone: "danger", compact: true })}</div></div>${(list.entries ?? []).length ? `<div class="table-wrap"><table><thead><tr><th>Elemento</th><th>Tipo</th><th>Prezzo/Delta</th><th>Disponibile</th><th></th></tr></thead><tbody>${list.entries.map((entry) => { const target = entry.sellableType === "offer" ? snapshot.offers?.find((item) => item.id === entry.sellableId) : snapshot.products?.find((item) => item.id === entry.sellableId); return `<tr><td><strong>${escapeHtml(target?.name ?? entry.sellableId)}</strong><small>${escapeHtml(entry.sellableId)}</small></td><td>${escapeHtml(entry.sellableType)}</td><td>${formatMoney(entry.priceCents, list.currency || currency)}</td><td>${entry.available === false ? badge("No", "danger") : badge("Sì", "success")}</td><td class="row-actions">${actionButton("Modifica", "edit-price-entry", { id: entry.id, context: list.id, compact: true })}${actionButton("×", "delete-price-entry", { id: entry.id, context: list.id, tone: "danger", compact: true })}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="muted">Nessuna sovrascrittura: i prezzi sono ereditati o letti dall'anagrafica articolo.</p>`}</section>`).join("")}</div>` : emptyState("Nessun listino", "Ogni catalogo deve avere almeno un listino base.", actionButton("Nuovo listino", "edit-price-list", { tone: "primary" }))}`;
}

function renderOffers(snapshot) {
  const offers = snapshot.offers ?? [];
  const currency = snapshot.currency ?? "EUR";
  const productName = (id) => snapshot.products?.find((item) => item.id === id)?.name ?? id;
  return `${pageHeader("Menù e offerte", "Costruisci formule generiche con prodotti inclusi, gruppi di scelta e supplementi per listino.", actionButton("Nuova offerta", "edit-offer", { tone: "primary" }))}${offers.length ? `<div class="stack-panels">${offers.map((offer) => `<section class="panel offer-card"><div class="panel__header"><div><h3>${escapeHtml(offer.name)} ${offer.enabled === false ? badge("Disabilitata") : badge(offer.pricingStrategy === "fixed" ? "Prezzo fisso" : "Somma componenti", "info")}</h3><p>${escapeHtml(offer.description || "Nessuna descrizione")} · base ${formatMoney(offer.basePriceCents, currency)}</p></div><div class="row-actions">${actionButton("Incluso", "edit-included-item", { context: offer.id, compact: true })}${actionButton("Gruppo scelta", "edit-choice-group", { context: offer.id, compact: true })}${actionButton("Modifica", "edit-offer", { id: offer.id, compact: true })}${actionButton("Elimina", "delete-offer", { id: offer.id, tone: "danger", compact: true })}</div></div><div class="two-column"><div><h4>Prodotti sempre inclusi</h4>${(offer.includedItems ?? []).length ? `<div class="stack-list">${offer.includedItems.map((item) => `<article><div><strong>${escapeHtml(productName(item.productId))}</strong><span>Quantità ${item.quantity}</span></div><div>${actionButton("Modifica", "edit-included-item", { id: item.id, context: offer.id, compact: true })}${actionButton("×", "delete-included-item", { id: item.id, context: offer.id, tone: "danger", compact: true })}</div></article>`).join("")}</div>` : `<p class="muted">Nessun prodotto fisso.</p>`}</div><div><h4>Gruppi di scelta</h4>${(offer.choiceGroups ?? []).length ? `<div class="choice-groups">${offer.choiceGroups.map((group) => `<article class="choice-group"><header><div><strong>${escapeHtml(group.name)}</strong><span>${group.minSelections}–${group.maxSelections} scelte · ${group.includedSelections} incluse</span></div><div>${actionButton("Opzione", "edit-choice-option", { context: `${offer.id}|${group.id}`, compact: true })}${actionButton("Modifica", "edit-choice-group", { id: group.id, context: offer.id, compact: true })}${actionButton("×", "delete-choice-group", { id: group.id, context: offer.id, tone: "danger", compact: true })}</div></header>${(group.options ?? []).map((option) => `<div class="tree-entry"><span>${escapeHtml(productName(option.productId))} ${option.supplementCents ? `· +${formatMoney(option.supplementCents, currency)}` : "· incluso"}</span><div>${actionButton("Modifica", "edit-choice-option", { id: option.id, context: `${offer.id}|${group.id}`, compact: true })}${actionButton("×", "delete-choice-option", { id: option.id, context: `${offer.id}|${group.id}`, tone: "danger", compact: true })}</div></div>`).join("") || `<p class="muted">Nessuna opzione.</p>`}</article>`).join("")}</div>` : `<p class="muted">Nessun gruppo di scelta.</p>`}</div></div></section>`).join("")}</div>` : emptyState("Nessuna offerta", "Le offerte sostituiscono tutte le formule codificate direttamente nel software.", actionButton("Nuova offerta", "edit-offer", { tone: "primary" }))}`;
}

function renderAssignments(snapshot) {
  const assignments = snapshot.assignments ?? [];
  const targetName = (item) => item.targetType === "catalog" ? snapshot.catalogs?.find((entry) => entry.id === item.targetId)?.name : snapshot.priceLists?.find((entry) => entry.id === item.targetId)?.name;
  const dayLabel = (days) => (days?.length === 7 ? "Tutti i giorni" : (days ?? []).map((day) => WEEKDAYS.find(([id]) => id === day)?.[1] ?? day).join(", "));
  return `${pageHeader("Applicazione e orari", "Assegna cataloghi e listini a canale, attività, sala, postazione, ruolo, gruppo o singolo utente.", actionButton("Nuova regola", "edit-assignment", { tone: "primary" }))}${assignments.length ? `<div class="table-wrap"><table><thead><tr><th>Destinazione</th><th>Ambito</th><th>Quando</th><th>Priorità</th><th>Stato</th><th></th></tr></thead><tbody>${assignments.map((item) => `<tr><td><strong>${escapeHtml(targetName(item) ?? item.targetId)}</strong><small>${escapeHtml(item.targetType)} · ${escapeHtml(item.targetId)}</small></td><td><strong>${escapeHtml(item.scopeType)}</strong><small>${escapeHtml(item.scopeId)}</small></td><td>${escapeHtml(dayLabel(item.weekdays))}<small>${minutesToTime(item.startMinute)}–${minutesToTime(item.endMinute)}${item.endMinute < item.startMinute ? " · oltre mezzanotte" : ""}${item.validFrom || item.validTo ? ` · ${formatDate(item.validFrom)} → ${formatDate(item.validTo)}` : ""}</small></td><td>${item.priority ?? 0}</td><td>${item.enabled === false ? badge("Disattiva") : badge("Attiva", "success")}</td><td class="row-actions">${actionButton("Modifica", "edit-assignment", { id: item.id, compact: true })}${actionButton("Duplica", "duplicate-assignment", { id: item.id, compact: true })}${actionButton("Elimina", "delete-assignment", { id: item.id, tone: "danger", compact: true })}</td></tr>`).join("")}</tbody></table></div>` : emptyState("Nessuna regola", "Il catalogo predefinito e il listino base saranno usati globalmente.", actionButton("Nuova regola", "edit-assignment", { tone: "primary" }))}`;
}

function renderSimulator(state, snapshot) {
  const products = snapshot.products ?? [];
  const offers = snapshot.offers ?? [];
  const result = state.simulatorResult;
  return `${pageHeader("Simulatore", "Interroga lo stesso resolver previsto per catalogo, ordine, conto e fiscalizzazione.")}
  <div class="two-column simulator-layout"><form id="simulator-form" class="panel form-grid"><label class="field"><span>Data e ora</span><input name="dateTime" type="datetime-local" /></label><label class="field"><span>Canale</span><input name="channel" value="mobile-frontend" /></label><label class="field"><span>Attività</span><input name="activityId" placeholder="activity_main" /></label><label class="field"><span>Sala</span><input name="roomId" placeholder="room_main" /></label><label class="field"><span>Postazione</span><input name="workstationId" placeholder="bar" /></label><label class="field"><span>Ruolo</span><input name="role" placeholder="waiter" /></label><label class="field"><span>Gruppi utente</span><input name="userGroupIds" placeholder="gruppo_1, gruppo_2" /></label><label class="field"><span>Utente</span><input name="userId" placeholder="user_123" /></label><label class="field"><span>Tipo vendibile</span><select name="sellableType"><option value="product">Prodotto</option><option value="offer">Offerta</option></select></label><label class="field"><span>Elemento</span><select name="sellableId"><optgroup label="Prodotti">${products.map((item) => `<option value="product:${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</optgroup><optgroup label="Offerte">${offers.map((item) => `<option value="offer:${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</optgroup></select></label><label class="field field--wide"><span>Selezioni offerta in JSON</span><textarea name="selections" rows="5" placeholder='[{"groupId":"bevanda","optionId":"drink","quantity":1}]'></textarea><small>Usato soltanto per le offerte composte.</small></label><button class="button button--primary" type="submit">Calcola prezzo</button></form><section class="panel"><div class="panel__header"><div><h3>Risultato</h3><p>Provenienza completa del prezzo autorevole.</p></div></div>${result ? `<div class="price-result"><span>Prezzo finale</span><strong>${formatMoney(result.finalUnitPriceCents, snapshot.currency ?? "EUR")}</strong><small>Fingerprint <code>${escapeHtml((result.priceFingerprint ?? "").slice(0, 20))}</code></small></div><dl class="detail-list"><div><dt>Catalogo</dt><dd>${escapeHtml(result.catalogId)}</dd></div><div><dt>Catena listini</dt><dd>${escapeHtml((result.priceListChain ?? []).map((item) => item.name ?? item.id).join(" → "))}</dd></div><div><dt>Prezzo base</dt><dd>${formatMoney(result.basePriceCents, snapshot.currency ?? "EUR")}</dd></div><div><dt>Variante</dt><dd>${formatMoney(result.variantDeltaCents, snapshot.currency ?? "EUR")}</dd></div><div><dt>Supplementi offerta</dt><dd>${formatMoney(result.offerSupplementCents, snapshot.currency ?? "EUR")}</dd></div></dl><h4>Trace</h4><pre class="trace">${escapeHtml(JSON.stringify(result.pricingTrace ?? [], null, 2))}</pre>` : emptyState("Nessuna simulazione", "Compila il contesto e seleziona un elemento.")}</section></div>`;
}

function renderPublication(state) {
  const versions = state.workspace?.versions ?? [];
  const draft = state.draft;
  return `${pageHeader("Pubblicazione e storico", "Valida, confronta, pubblica o ripristina configurazioni immutabili.", `${actionButton("Esporta", "export-version")}${actionButton("Importa JSON", "import-json")}`)}<div class="two-column"><section class="panel"><div class="panel__header"><div><h3>Bozza corrente</h3><p>${draft ? `Versione #${draft.versionNumber}, revisione ${draft.revision}` : "Nessuna bozza aperta"}</p></div></div>${issueList(state.validation)}<div class="publication-box"><label class="field field--wide"><span>Nota di pubblicazione</span><textarea id="publication-note" rows="4" placeholder="Descrivi le modifiche e il motivo della pubblicazione."></textarea></label><div class="button-row">${actionButton("Valida", "validate-draft", { disabled: !draft })}${actionButton("Pubblica", "publish-draft", { tone: "primary", disabled: !draft || state.validation?.ok !== true || state.dirty })}</div><small>Prima della pubblicazione salva la bozza ed esegui la validazione.</small></div></section><section class="panel"><div class="panel__header"><div><h3>Confronto versioni</h3><p>Seleziona esattamente due versioni dallo storico.</p></div></div><div class="button-row">${actionButton("Confronta selezionate", "diff-versions", { disabled: state.selectedVersionIds.length !== 2 })}${actionButton("Nuova bozza dalla pubblicata", "create-draft", { disabled: Boolean(draft) })}</div><div id="diff-result" class="diff-result"></div></section></div><section class="panel"><div class="panel__header"><div><h3>Storico</h3><p>Il rollback crea una nuova versione pubblicata e non cancella la cronologia.</p></div></div>${versions.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Versione</th><th>Stato</th><th>Autore</th><th>Aggiornamento</th><th>Nota</th><th></th></tr></thead><tbody>${versions.map((version) => `<tr><td><input type="checkbox" data-role="version-select" data-id="${escapeHtml(version.id)}" ${state.selectedVersionIds.includes(version.id) ? "checked" : ""} /></td><td><strong>#${version.versionNumber}</strong><small><code>${escapeHtml(version.id)}</code></small></td><td>${badge(version.status, version.status === "published" ? "success" : version.status === "draft" ? "warning" : "neutral")}</td><td>${escapeHtml(version.updatedBy?.username || version.createdBy?.username || "—")}</td><td>${formatDate(version.updatedAt)}</td><td>${escapeHtml(version.publicationNote || "—")}</td><td>${version.status !== "draft" ? actionButton("Ripristina", "rollback-version", { id: version.id, compact: true }) : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState("Storico vuoto", "Crea la prima bozza e pubblicala.")}</section>`;
}

function renderPage(state) {
  const snapshot = snapshotOf(state);
  switch (state.activeTab) {
    case "products": return renderProducts(snapshot, state.filter);
    case "catalogs": return renderCatalogs(snapshot);
    case "price-lists": return renderPriceLists(snapshot);
    case "offers": return renderOffers(snapshot);
    case "assignments": return renderAssignments(snapshot);
    case "simulator": return renderSimulator(state, snapshot);
    case "publication": return renderPublication(state);
    default: return renderOverview(state, snapshot);
  }
}

export function renderApp(state) {
  if (!state.sessionReady) return renderLogin();
  return `<div class="app-shell">${renderNav(state)}<div class="workspace">${renderTopBar(state)}<main class="content">${state.error ? `<div class="callout callout--danger"><strong>Errore</strong><span>${escapeHtml(state.error)}</span><button type="button" data-action="dismiss-error">×</button></div>` : ""}${state.loading ? `<div class="loading-bar"></div>` : ""}${renderPage(state)}</main></div>${state.toast ? `<div class="toast toast--${escapeHtml(state.toast.tone)}">${escapeHtml(state.toast.message)}</div>` : ""}</div><dialog id="editor-dialog" class="editor-dialog"><form method="dialog" id="editor-form"><div id="editor-content"></div></form></dialog><input id="file-input" type="file" hidden />`;
}
