import {
  WEEKDAYS,
  checkboxField,
  escapeHtml,
  inputField,
  minutesToTime,
  selectField,
  slugId,
  textareaField,
  timeToMinutes,
  uid,
} from "./ui.js";

const splitList = (value) => String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const moneyToCents = (value) => Math.max(0, Math.round((Number(String(value).replace(",", ".")) || 0) * 100));
const signedMoneyToCents = (value) => Math.round((Number(String(value).replace(",", ".")) || 0) * 100);
const centsToInput = (value) => (Number(value ?? 0) / 100).toFixed(2);
const bool = (form, name) => form.get(name) === "on";
const text = (form, name) => String(form.get(name) ?? "").trim();
const integer = (form, name, fallback = 0) => Math.trunc(Number(form.get(name)) || fallback);

function modal(title, description, fields, submitLabel = "Salva") {
  return `<header class="editor-dialog__header"><div><p class="eyebrow">Configurazione commerciale</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><button type="button" class="icon-button" data-action="close-editor">×</button></header><div class="editor-dialog__body form-grid">${fields}</div><footer class="editor-dialog__footer"><button type="button" class="button button--secondary" data-action="close-editor">Annulla</button><button type="submit" class="button button--primary">${escapeHtml(submitLabel)}</button></footer>`;
}

function optionList(items, selected = "", emptyLabel = "— Seleziona —") {
  return [{ value: "", label: emptyLabel }, ...items.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))].map((item) => ({ ...item, selected: item.value === selected }));
}

function selectOptions(items, selected = "", emptyLabel = "— Seleziona —") {
  return [{ value: "", label: emptyLabel }, ...items.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))].map((item) => ({ value: item.value, label: item.label, selected: item.value === selected }));
}

function lookupCatalog(snapshot, catalogId) {
  return (snapshot.catalogs ?? []).find((item) => item.id === catalogId) ?? null;
}
function lookupCategory(snapshot, catalogId, categoryId) {
  return lookupCatalog(snapshot, catalogId)?.categories?.find((item) => item.id === categoryId) ?? null;
}
function lookupPriceList(snapshot, id) {
  return (snapshot.priceLists ?? []).find((item) => item.id === id) ?? null;
}
function lookupOffer(snapshot, id) {
  return (snapshot.offers ?? []).find((item) => item.id === id) ?? null;
}

function sellableOptions(snapshot, selectedType, selectedId) {
  const selectedItems = selectedType === "offer" ? snapshot.offers ?? [] : snapshot.products ?? [];
  return selectOptions(selectedItems, selectedId);
}

function weekdayFields(selected = WEEKDAYS.map(([id]) => id)) {
  return `<fieldset class="field field--wide weekday-grid"><legend>Giorni della settimana</legend>${WEEKDAYS.map(([id, label]) => `<label><input type="checkbox" name="weekday_${id}" ${selected.includes(id) ? "checked" : ""} /><span>${label}</span></label>`).join("")}</fieldset>`;
}

export function editorHtml(kind, id, context, snapshot) {
  if (kind === "edit-product") {
    const current = (snapshot.products ?? []).find((item) => item.id === id) ?? { id: "", name: "", enabled: true, taxRate: 10, basePriceCents: 0, workstationIds: [], tags: [], allergens: [] };
    return modal(id ? "Modifica articolo" : "Nuovo articolo", "Anagrafica unica riutilizzabile in cataloghi, listini e offerte", `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true, help: "Non modificarlo dopo l'uso in ordini o listini." })}${inputField({ label: "SKU", name: "sku", value: current.sku })}${inputField({ label: "Codice a barre", name: "barcode", value: current.barcode })}${inputField({ label: "Prezzo base (€)", name: "basePrice", type: "number", step: "0.01", min: "0", value: centsToInput(current.basePriceCents) })}${inputField({ label: "Aliquota IVA (%)", name: "taxRate", type: "number", step: "0.001", min: "0", max: "100", value: current.taxRate ?? 10 })}${inputField({ label: "Codice IVA", name: "taxCode", value: current.taxCode })}${inputField({ label: "Unità", name: "unit", value: current.unit })}${inputField({ label: "Postazioni", name: "workstationIds", value: (current.workstationIds ?? []).join(", "), help: "ID separati da virgola." })}${inputField({ label: "Tag", name: "tags", value: (current.tags ?? []).join(", ") })}${inputField({ label: "Allergeni", name: "allergens", value: (current.allergens ?? []).join(", ") })}${inputField({ label: "URL immagine", name: "imageUrl", value: current.imageUrl })}${textareaField({ label: "Descrizione", name: "description", value: current.description })}${checkboxField({ label: "Articolo attivo", name: "enabled", checked: current.enabled !== false })}`);
  }

  if (kind === "edit-catalog") {
    const current = lookupCatalog(snapshot, id) ?? { id: "", name: "", status: "active", isDefault: !(snapshot.catalogs ?? []).length, basePriceListId: "", notes: "" };
    return modal(id ? "Modifica catalogo" : "Nuovo catalogo", "Il catalogo stabilisce cosa viene mostrato e in quale ordine", `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${selectField({ label: "Listino base", name: "basePriceListId", value: current.basePriceListId, options: selectOptions((snapshot.priceLists ?? []).filter((item) => !item.catalogId || item.catalogId === current.id), current.basePriceListId) })}${selectField({ label: "Stato", name: "status", value: current.status, options: [{ value: "active", label: "Attivo" }, { value: "disabled", label: "Disabilitato" }] })}${checkboxField({ label: "Catalogo predefinito", name: "isDefault", checked: current.isDefault === true, help: "Usato quando nessuna regola di catalogo è applicabile." })}${textareaField({ label: "Note", name: "notes", value: current.notes })}`);
  }

  if (kind === "edit-category") {
    const catalog = lookupCatalog(snapshot, context);
    const current = catalog?.categories?.find((item) => item.id === id) ?? { id: "", name: "", departmentId: "", departmentName: "", sortOrder: catalog?.categories?.length ?? 0, enabled: true };
    return modal(id ? "Modifica categoria" : "Nuova categoria", `Catalogo: ${catalog?.name ?? context}`, `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${inputField({ label: "ID reparto", name: "departmentId", value: current.departmentId })}${inputField({ label: "Nome reparto", name: "departmentName", value: current.departmentName })}${inputField({ label: "Ordine", name: "sortOrder", type: "number", value: current.sortOrder ?? 0 })}${checkboxField({ label: "Categoria attiva", name: "enabled", checked: current.enabled !== false })}`);
  }

  if (kind === "edit-group") {
    const [catalogId, categoryId] = String(context).split("|");
    const category = lookupCategory(snapshot, catalogId, categoryId);
    const current = category?.groups?.find((item) => item.id === id) ?? { id: "", name: "", sortOrder: category?.groups?.length ?? 0, enabled: true };
    return modal(id ? "Modifica gruppo" : "Nuovo gruppo", `Categoria: ${category?.name ?? categoryId}. Il gruppo organizza la navigazione e non impone scelte.`, `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${inputField({ label: "Ordine", name: "sortOrder", type: "number", value: current.sortOrder ?? 0 })}${checkboxField({ label: "Gruppo attivo", name: "enabled", checked: current.enabled !== false })}`);
  }

  if (kind === "edit-catalog-entry") {
    const [catalogId, categoryId, contextGroupId = ""] = String(context).split("|");
    const category = lookupCategory(snapshot, catalogId, categoryId);
    const current = category?.entries?.find((item) => item.id === id) ?? { id: "", sellableType: "product", sellableId: "", groupId: contextGroupId, sortOrder: category?.entries?.length ?? 0, visible: true, enabled: true };
    return modal(id ? "Modifica voce catalogo" : "Aggiungi voce al catalogo", `Categoria: ${category?.name ?? categoryId}`, `${inputField({ label: "ID voce", name: "id", value: current.id, required: true })}${selectField({ label: "Tipo", name: "sellableType", value: current.sellableType, options: [{ value: "product", label: "Prodotto" }, { value: "offer", label: "Offerta / menù" }] })}${selectField({ label: "Elemento", name: "sellableId", value: current.sellableId, options: sellableOptions(snapshot, current.sellableType, current.sellableId), required: true })}${selectField({ label: "Gruppo facoltativo", name: "groupId", value: current.groupId, options: selectOptions(category?.groups ?? [], current.groupId, "Prodotto diretto nella categoria") })}${inputField({ label: "Ordine", name: "sortOrder", type: "number", value: current.sortOrder ?? 0 })}${checkboxField({ label: "Visibile", name: "visible", checked: current.visible !== false })}${checkboxField({ label: "Attiva", name: "enabled", checked: current.enabled !== false })}<div class="callout callout--info field--wide"><strong>Nota</strong><span>Cambiando il tipo, salva e riapri la voce per aggiornare l'elenco degli elementi.</span></div>`);
  }

  if (kind === "edit-price-list") {
    const current = lookupPriceList(snapshot, id) ?? { id: "", name: "", catalogId: snapshot.catalogs?.[0]?.id ?? "", currency: snapshot.currency ?? "EUR", status: "active", inheritsFromId: null, notes: "" };
    return modal(id ? "Modifica listino" : "Nuovo listino", "Il listino derivato salva soltanto le differenze rispetto al listino padre", `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${selectField({ label: "Catalogo", name: "catalogId", value: current.catalogId, options: selectOptions(snapshot.catalogs ?? [], current.catalogId), required: true })}${inputField({ label: "Valuta", name: "currency", value: current.currency ?? snapshot.currency ?? "EUR", required: true })}${selectField({ label: "Eredita da", name: "inheritsFromId", value: current.inheritsFromId ?? "", options: selectOptions((snapshot.priceLists ?? []).filter((item) => item.id !== current.id && (!current.catalogId || item.catalogId === current.catalogId)), current.inheritsFromId, "Nessuna ereditarietà") })}${selectField({ label: "Stato", name: "status", value: current.status, options: [{ value: "active", label: "Attivo" }, { value: "disabled", label: "Disabilitato" }] })}${textareaField({ label: "Note", name: "notes", value: current.notes })}`);
  }

  if (kind === "edit-price-entry") {
    const list = lookupPriceList(snapshot, context);
    const current = list?.entries?.find((item) => item.id === id) ?? { id: "", sellableType: "product", sellableId: "", priceCents: 0, available: true, enabled: true };
    return modal(id ? "Modifica prezzo" : "Nuovo prezzo", `Listino: ${list?.name ?? context}`, `${inputField({ label: "ID voce", name: "id", value: current.id, required: true })}${selectField({ label: "Tipo", name: "sellableType", value: current.sellableType, options: [{ value: "product", label: "Prodotto" }, { value: "offer", label: "Offerta" }, { value: "variant", label: "Delta variante" }, { value: "offer_option", label: "Delta opzione offerta" }] })}${selectField({ label: "Elemento", name: "sellableId", value: current.sellableId, options: sellableOptions(snapshot, ["offer", "offer_option"].includes(current.sellableType) ? "offer" : "product", current.sellableId), required: true })}${inputField({ label: ["variant", "offer_option"].includes(current.sellableType) ? "Delta (€)" : "Prezzo (€)", name: "price", type: "number", step: "0.01", value: centsToInput(current.priceCents) })}${checkboxField({ label: "Disponibile con questo listino", name: "available", checked: current.available !== false })}${checkboxField({ label: "Voce attiva", name: "enabled", checked: current.enabled !== false })}<div class="callout callout--info field--wide"><strong>Varianti e opzioni</strong><span>Per un delta specifico usare come sellableId la chiave prevista dal resolver; il builder visuale dedicato verrà esteso nella fase varianti avanzate.</span></div>`);
  }

  if (kind === "edit-offer") {
    const current = lookupOffer(snapshot, id) ?? { id: "", name: "", description: "", enabled: true, pricingStrategy: "fixed", taxAllocationStrategy: "component_exact", basePriceCents: 0, workstationIds: [] };
    return modal(id ? "Modifica offerta" : "Nuova offerta", "Menù generico, senza nomi o prezzi commerciali codificati nel software", `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${selectField({ label: "Strategia prezzo", name: "pricingStrategy", value: current.pricingStrategy, options: [{ value: "fixed", label: "Prezzo fisso da listino" }, { value: "sum_components", label: "Somma dei componenti" }] })}${inputField({ label: "Prezzo base (€)", name: "basePrice", type: "number", step: "0.01", min: "0", value: centsToInput(current.basePriceCents) })}${selectField({ label: "Ripartizione fiscale", name: "taxAllocationStrategy", value: current.taxAllocationStrategy, options: [{ value: "component_exact", label: "Esatta per componenti" }, { value: "proportional", label: "Proporzionale" }, { value: "dominant_rate", label: "Aliquota dominante" }] })}${inputField({ label: "Postazioni", name: "workstationIds", value: (current.workstationIds ?? []).join(", ") })}${textareaField({ label: "Descrizione", name: "description", value: current.description })}${checkboxField({ label: "Offerta attiva", name: "enabled", checked: current.enabled !== false })}`);
  }

  if (kind === "edit-included-item") {
    const offer = lookupOffer(snapshot, context);
    const current = offer?.includedItems?.find((item) => item.id === id) ?? { id: "", productId: "", quantity: 1 };
    return modal(id ? "Modifica prodotto incluso" : "Aggiungi prodotto incluso", `Offerta: ${offer?.name ?? context}`, `${inputField({ label: "ID riga", name: "id", value: current.id, required: true })}${selectField({ label: "Prodotto", name: "productId", value: current.productId, options: selectOptions(snapshot.products ?? [], current.productId), required: true })}${inputField({ label: "Quantità", name: "quantity", type: "number", min: "1", max: "999", value: current.quantity ?? 1 })}`);
  }

  if (kind === "edit-choice-group") {
    const offer = lookupOffer(snapshot, context);
    const current = offer?.choiceGroups?.find((item) => item.id === id) ?? { id: "", name: "", required: true, minSelections: 1, maxSelections: 1, includedSelections: 1, allowRepeat: false, sortOrder: offer?.choiceGroups?.length ?? 0 };
    return modal(id ? "Modifica gruppo di scelta" : "Nuovo gruppo di scelta", `Offerta: ${offer?.name ?? context}`, `${inputField({ label: "Nome", name: "name", value: current.name, required: true })}${inputField({ label: "ID stabile", name: "id", value: current.id, required: true })}${inputField({ label: "Minimo scelte", name: "minSelections", type: "number", min: "0", value: current.minSelections ?? 0 })}${inputField({ label: "Massimo scelte", name: "maxSelections", type: "number", min: "0", value: current.maxSelections ?? 1 })}${inputField({ label: "Scelte incluse", name: "includedSelections", type: "number", min: "0", value: current.includedSelections ?? 1 })}${inputField({ label: "Ordine", name: "sortOrder", type: "number", value: current.sortOrder ?? 0 })}${checkboxField({ label: "Gruppo obbligatorio", name: "required", checked: current.required !== false })}${checkboxField({ label: "Consenti ripetizioni", name: "allowRepeat", checked: current.allowRepeat === true })}`);
  }

  if (kind === "edit-choice-option") {
    const [offerId, groupId] = String(context).split("|");
    const offer = lookupOffer(snapshot, offerId);
    const group = offer?.choiceGroups?.find((item) => item.id === groupId);
    const current = group?.options?.find((item) => item.id === id) ?? { id: "", productId: "", labelOverride: "", quantity: 1, supplementCents: 0, enabled: true, sortOrder: group?.options?.length ?? 0 };
    return modal(id ? "Modifica opzione" : "Nuova opzione", `${offer?.name ?? offerId} · ${group?.name ?? groupId}`, `${inputField({ label: "ID opzione", name: "id", value: current.id, required: true })}${selectField({ label: "Prodotto", name: "productId", value: current.productId, options: selectOptions(snapshot.products ?? [], current.productId), required: true })}${inputField({ label: "Etichetta alternativa", name: "labelOverride", value: current.labelOverride })}${inputField({ label: "Quantità", name: "quantity", type: "number", min: "1", value: current.quantity ?? 1 })}${inputField({ label: "Supplemento (€)", name: "supplement", type: "number", step: "0.01", value: centsToInput(current.supplementCents) })}${inputField({ label: "Ordine", name: "sortOrder", type: "number", value: current.sortOrder ?? 0 })}${checkboxField({ label: "Opzione attiva", name: "enabled", checked: current.enabled !== false })}`);
  }

  if (kind === "edit-assignment") {
    const current = (snapshot.assignments ?? []).find((item) => item.id === id) ?? { id: "", targetType: "price_list", targetId: snapshot.priceLists?.[0]?.id ?? "", scopeType: "global", scopeId: "*", priority: 0, enabled: true, weekdays: WEEKDAYS.map(([day]) => day), startMinute: 0, endMinute: 1440, validFrom: null, validTo: null, notes: "" };
    const targets = current.targetType === "catalog" ? snapshot.catalogs ?? [] : snapshot.priceLists ?? [];
    return modal(id ? "Modifica regola" : "Nuova regola", "La specificità prevale in ordine: globale, canale, attività, sala, postazione, ruolo, gruppo, utente", `${inputField({ label: "ID regola", name: "id", value: current.id, required: true })}${selectField({ label: "Tipo destinazione", name: "targetType", value: current.targetType, options: [{ value: "price_list", label: "Listino" }, { value: "catalog", label: "Catalogo" }] })}${selectField({ label: "Destinazione", name: "targetId", value: current.targetId, options: selectOptions(targets, current.targetId), required: true })}${selectField({ label: "Tipo ambito", name: "scopeType", value: current.scopeType, options: [{ value: "global", label: "Globale" }, { value: "channel", label: "Canale" }, { value: "activity", label: "Attività" }, { value: "room", label: "Sala" }, { value: "workstation", label: "Postazione" }, { value: "role", label: "Ruolo" }, { value: "user_group", label: "Gruppo utenti" }, { value: "user", label: "Singolo utente" }] })}${inputField({ label: "ID ambito", name: "scopeId", value: current.scopeId, required: true, help: "Per globale usare *; per gli altri usare l'ID reale." })}${inputField({ label: "Priorità", name: "priority", type: "number", value: current.priority ?? 0 })}${inputField({ label: "Inizio fascia", name: "startTime", type: "time", value: minutesToTime(current.startMinute) })}${inputField({ label: "Fine fascia", name: "endTime", type: "time", value: minutesToTime(current.endMinute) === "24:00" ? "00:00" : minutesToTime(current.endMinute), help: "Una fine precedente all'inizio indica una fascia oltre mezzanotte." })}${inputField({ label: "Valida da", name: "validFrom", type: "datetime-local", value: current.validFrom ? String(current.validFrom).slice(0, 16) : "" })}${inputField({ label: "Valida fino a", name: "validTo", type: "datetime-local", value: current.validTo ? String(current.validTo).slice(0, 16) : "" })}${weekdayFields(current.weekdays)}${textareaField({ label: "Note", name: "notes", value: current.notes })}${checkboxField({ label: "Regola attiva", name: "enabled", checked: current.enabled !== false })}<div class="callout callout--info field--wide"><strong>Nota</strong><span>Cambiando il tipo di destinazione salva e riapri la regola per aggiornare l'elenco.</span></div>`);
  }

  if (kind === "bulk-price-change") {
    return modal("Modifica massiva prezzi", "Applica una percentuale alle voci esplicite del listino selezionato e salva importi finali in centesimi", `${selectField({ label: "Listino", name: "priceListId", value: snapshot.priceLists?.[0]?.id ?? "", options: selectOptions(snapshot.priceLists ?? [], snapshot.priceLists?.[0]?.id), required: true })}${inputField({ label: "Variazione percentuale", name: "percentage", type: "number", step: "0.01", value: 0, help: "Esempio: 10 aumenta del 10%; -5 diminuisce del 5%." })}${selectField({ label: "Arrotondamento", name: "rounding", value: "cent", options: [{ value: "cent", label: "Al centesimo" }, { value: "five_cents", label: "A 0,05 €" }, { value: "ten_cents", label: "A 0,10 €" }, { value: "euro", label: "All'euro" }] })}${checkboxField({ label: "Includi delta negativi", name: "includeNegative", checked: false })}`, "Applica");
  }

  if (kind === "edit-json") {
    return modal("Editor JSON avanzato", "Usare per importazioni controllate o proprietà non ancora esposte dal builder visuale", `${textareaField({ label: "Snapshot completo", name: "snapshotJson", value: JSON.stringify(snapshot, null, 2), rows: 26, help: "Il backend normalizzerà e validerà il contenuto al salvataggio." })}`, "Applica JSON");
  }

  return modal("Editor non disponibile", `Tipo ${kind}`, `<p class="muted field--wide">Questa funzione non è ancora collegata.</p>`, "Chiudi");
}

function ensureId(form, fallbackName, prefix) {
  return text(form, "id") || slugId(text(form, fallbackName), prefix);
}

export function applyEditor(kind, id, context, form, snapshot) {
  if (kind === "edit-product") {
    const productId = ensureId(form, "name", "product");
    const next = { id: productId, name: text(form, "name"), description: text(form, "description"), sku: text(form, "sku"), barcode: text(form, "barcode"), unit: text(form, "unit"), enabled: bool(form, "enabled"), taxRate: Number(form.get("taxRate")) || 0, taxCode: text(form, "taxCode"), basePriceCents: moneyToCents(form.get("basePrice")), workstationIds: splitList(form.get("workstationIds")), tags: splitList(form.get("tags")), allergens: splitList(form.get("allergens")), imageUrl: text(form, "imageUrl"), variants: id ? ((snapshot.products ?? []).find((item) => item.id === id)?.variants ?? []) : [] };
    snapshot.products ??= [];
    const index = snapshot.products.findIndex((item) => item.id === id);
    if (index >= 0) snapshot.products[index] = { ...snapshot.products[index], ...next }; else snapshot.products.push(next);
    return;
  }
  if (kind === "edit-catalog") {
    const catalogId = ensureId(form, "name", "catalog");
    const next = { id: catalogId, name: text(form, "name"), status: text(form, "status") || "active", isDefault: bool(form, "isDefault"), basePriceListId: text(form, "basePriceListId"), notes: text(form, "notes"), categories: id ? (lookupCatalog(snapshot, id)?.categories ?? []) : [] };
    snapshot.catalogs ??= [];
    if (next.isDefault) snapshot.catalogs.forEach((item) => { item.isDefault = false; });
    const index = snapshot.catalogs.findIndex((item) => item.id === id);
    if (index >= 0) snapshot.catalogs[index] = { ...snapshot.catalogs[index], ...next }; else snapshot.catalogs.push(next);
    return;
  }
  if (kind === "edit-category") {
    const catalog = lookupCatalog(snapshot, context); if (!catalog) throw new Error("Catalogo non trovato.");
    catalog.categories ??= [];
    const categoryId = ensureId(form, "name", "category");
    const next = { id: categoryId, name: text(form, "name"), departmentId: text(form, "departmentId"), departmentName: text(form, "departmentName"), sortOrder: integer(form, "sortOrder"), enabled: bool(form, "enabled"), groups: id ? (catalog.categories.find((item) => item.id === id)?.groups ?? []) : [], entries: id ? (catalog.categories.find((item) => item.id === id)?.entries ?? []) : [] };
    const index = catalog.categories.findIndex((item) => item.id === id); if (index >= 0) catalog.categories[index] = { ...catalog.categories[index], ...next }; else catalog.categories.push(next);
    return;
  }
  if (kind === "edit-group") {
    const [catalogId, categoryId] = String(context).split("|"); const category = lookupCategory(snapshot, catalogId, categoryId); if (!category) throw new Error("Categoria non trovata.");
    category.groups ??= []; const groupId = ensureId(form, "name", "group"); const next = { id: groupId, name: text(form, "name"), sortOrder: integer(form, "sortOrder"), enabled: bool(form, "enabled") };
    const index = category.groups.findIndex((item) => item.id === id); if (index >= 0) category.groups[index] = { ...category.groups[index], ...next }; else category.groups.push(next); return;
  }
  if (kind === "edit-catalog-entry") {
    const [catalogId, categoryId] = String(context).split("|"); const category = lookupCategory(snapshot, catalogId, categoryId); if (!category) throw new Error("Categoria non trovata.");
    category.entries ??= []; const sellableType = text(form, "sellableType") || "product"; const sellableId = text(form, "sellableId"); const entryId = text(form, "id") || uid("entry"); const next = { id: entryId, sellableType, sellableId, groupId: text(form, "groupId") || null, sortOrder: integer(form, "sortOrder"), visible: bool(form, "visible"), enabled: bool(form, "enabled") };
    const index = category.entries.findIndex((item) => item.id === id); if (index >= 0) category.entries[index] = next; else category.entries.push(next); return;
  }
  if (kind === "edit-price-list") {
    const listId = ensureId(form, "name", "price_list"); const next = { id: listId, name: text(form, "name"), catalogId: text(form, "catalogId"), currency: text(form, "currency").toUpperCase() || snapshot.currency || "EUR", status: text(form, "status") || "active", inheritsFromId: text(form, "inheritsFromId") || null, notes: text(form, "notes"), entries: id ? (lookupPriceList(snapshot, id)?.entries ?? []) : [] };
    snapshot.priceLists ??= []; const index = snapshot.priceLists.findIndex((item) => item.id === id); if (index >= 0) snapshot.priceLists[index] = { ...snapshot.priceLists[index], ...next }; else snapshot.priceLists.push(next); return;
  }
  if (kind === "edit-price-entry") {
    const list = lookupPriceList(snapshot, context); if (!list) throw new Error("Listino non trovato."); list.entries ??= [];
    const sellableType = text(form, "sellableType") || "product"; const next = { id: text(form, "id") || uid("price"), sellableType, sellableId: text(form, "sellableId"), priceCents: ["variant", "offer_option"].includes(sellableType) ? signedMoneyToCents(form.get("price")) : moneyToCents(form.get("price")), available: bool(form, "available"), enabled: bool(form, "enabled") };
    const index = list.entries.findIndex((item) => item.id === id); if (index >= 0) list.entries[index] = next; else list.entries.push(next); return;
  }
  if (kind === "edit-offer") {
    const offerId = ensureId(form, "name", "offer"); const current = lookupOffer(snapshot, id); const next = { id: offerId, name: text(form, "name"), description: text(form, "description"), enabled: bool(form, "enabled"), pricingStrategy: text(form, "pricingStrategy") || "fixed", taxAllocationStrategy: text(form, "taxAllocationStrategy") || "component_exact", basePriceCents: moneyToCents(form.get("basePrice")), workstationIds: splitList(form.get("workstationIds")), includedItems: current?.includedItems ?? [], choiceGroups: current?.choiceGroups ?? [], metadata: current?.metadata ?? {} };
    snapshot.offers ??= []; const index = snapshot.offers.findIndex((item) => item.id === id); if (index >= 0) snapshot.offers[index] = next; else snapshot.offers.push(next); return;
  }
  if (kind === "edit-included-item") {
    const offer = lookupOffer(snapshot, context); if (!offer) throw new Error("Offerta non trovata."); offer.includedItems ??= []; const next = { id: text(form, "id") || uid("included"), productId: text(form, "productId"), quantity: Math.max(1, integer(form, "quantity", 1)) };
    const index = offer.includedItems.findIndex((item) => item.id === id); if (index >= 0) offer.includedItems[index] = next; else offer.includedItems.push(next); return;
  }
  if (kind === "edit-choice-group") {
    const offer = lookupOffer(snapshot, context); if (!offer) throw new Error("Offerta non trovata."); offer.choiceGroups ??= []; const current = offer.choiceGroups.find((item) => item.id === id); const next = { id: ensureId(form, "name", "choice"), name: text(form, "name"), required: bool(form, "required"), minSelections: Math.max(0, integer(form, "minSelections")), maxSelections: Math.max(0, integer(form, "maxSelections", 1)), includedSelections: Math.max(0, integer(form, "includedSelections", 1)), allowRepeat: bool(form, "allowRepeat"), sortOrder: integer(form, "sortOrder"), options: current?.options ?? [] };
    const index = offer.choiceGroups.findIndex((item) => item.id === id); if (index >= 0) offer.choiceGroups[index] = next; else offer.choiceGroups.push(next); return;
  }
  if (kind === "edit-choice-option") {
    const [offerId, groupId] = String(context).split("|"); const group = lookupOffer(snapshot, offerId)?.choiceGroups?.find((item) => item.id === groupId); if (!group) throw new Error("Gruppo di scelta non trovato."); group.options ??= []; const next = { id: text(form, "id") || uid("option"), productId: text(form, "productId"), labelOverride: text(form, "labelOverride"), quantity: Math.max(1, integer(form, "quantity", 1)), supplementCents: signedMoneyToCents(form.get("supplement")), enabled: bool(form, "enabled"), sortOrder: integer(form, "sortOrder") };
    const index = group.options.findIndex((item) => item.id === id); if (index >= 0) group.options[index] = next; else group.options.push(next); return;
  }
  if (kind === "edit-assignment") {
    const scopeType = text(form, "scopeType") || "global"; const weekdays = WEEKDAYS.filter(([day]) => bool(form, `weekday_${day}`)).map(([day]) => day); const startMinute = timeToMinutes(form.get("startTime"), 0); let endMinute = timeToMinutes(form.get("endTime"), 1440); if (String(form.get("endTime")) === "00:00" && startMinute === 0) endMinute = 1440;
    const next = { id: text(form, "id") || uid("assignment"), targetType: text(form, "targetType") || "price_list", targetId: text(form, "targetId"), scopeType, scopeId: scopeType === "global" ? "*" : text(form, "scopeId"), priority: integer(form, "priority"), enabled: bool(form, "enabled"), validFrom: text(form, "validFrom") ? new Date(text(form, "validFrom")).toISOString() : null, validTo: text(form, "validTo") ? new Date(text(form, "validTo")).toISOString() : null, weekdays: weekdays.length ? weekdays : WEEKDAYS.map(([day]) => day), startMinute, endMinute, notes: text(form, "notes") };
    snapshot.assignments ??= []; const index = snapshot.assignments.findIndex((item) => item.id === id); if (index >= 0) snapshot.assignments[index] = next; else snapshot.assignments.push(next); return;
  }
  if (kind === "bulk-price-change") {
    const list = lookupPriceList(snapshot, text(form, "priceListId")); if (!list) throw new Error("Listino non trovato."); const percentage = Number(form.get("percentage")) || 0; const factor = 1 + percentage / 100; const includeNegative = bool(form, "includeNegative"); const rounding = text(form, "rounding"); const quantum = { cent: 1, five_cents: 5, ten_cents: 10, euro: 100 }[rounding] ?? 1;
    for (const entry of list.entries ?? []) { if (entry.priceCents < 0 && !includeNegative) continue; entry.priceCents = Math.round((entry.priceCents * factor) / quantum) * quantum; } return;
  }
  if (kind === "edit-json") {
    const parsed = JSON.parse(text(form, "snapshotJson")); for (const key of Object.keys(snapshot)) delete snapshot[key]; Object.assign(snapshot, parsed); return;
  }
  throw new Error(`Editor non gestito: ${kind}`);
}
