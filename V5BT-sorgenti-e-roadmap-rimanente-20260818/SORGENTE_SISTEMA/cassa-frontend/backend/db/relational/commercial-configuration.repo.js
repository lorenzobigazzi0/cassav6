import { randomUUID } from "node:crypto";
import { runRelationalTransaction } from "./connection.js";
import {
  asString,
  buildActor,
  deepClone,
  safeJsonParse,
  sha256,
  stableStringify,
} from "../../modules/commercial-configuration/commercial-configuration.utils.js";

function stringify(value, fallback = null) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function repositoryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function rowToVersion(row) {
  if (!row) return null;
  return {
    id: row.version_id,
    versionNumber: Number(row.version_number),
    status: row.status,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    sourceVersionId: row.source_version_id ?? null,
    snapshot: safeJsonParse(row.snapshot_json, null),
    compiled: safeJsonParse(row.compiled_json, null),
    checksum: row.checksum,
    publicationNote: row.publication_note ?? "",
    createdAt: row.created_at,
    createdBy: {
      userId: row.created_by_user_id,
      username: row.created_by_username,
    },
    updatedAt: row.updated_at,
    updatedBy: {
      userId: row.updated_by_user_id,
      username: row.updated_by_username,
    },
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_at
      ? {
          userId: row.published_by_user_id,
          username: row.published_by_username,
        }
      : null,
  };
}

function versionSummary(row) {
  const version = rowToVersion(row);
  if (!version) return null;
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    revision: version.revision,
    schemaVersion: version.schemaVersion,
    sourceVersionId: version.sourceVersionId,
    checksum: version.checksum,
    publicationNote: version.publicationNote,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    updatedAt: version.updatedAt,
    updatedBy: version.updatedBy,
    publishedAt: version.publishedAt,
    publishedBy: version.publishedBy,
  };
}

function deleteProjection(db, versionId) {
  const tables = [
    "commercial_offer_choice_options",
    "commercial_offer_choice_groups",
    "commercial_offer_included_items",
    "commercial_offers",
    "commercial_price_list_entries",
    "commercial_price_lists",
    "commercial_catalog_entries",
    "commercial_catalog_groups",
    "commercial_catalog_categories",
    "commercial_catalogs",
    "commercial_products",
    "commercial_assignments",
  ];
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table} WHERE version_id = ?`).run(versionId);
  }
}

function replaceProjection(db, versionId, snapshot) {
  deleteProjection(db, versionId);

  const insertProduct = db.prepare(`
    INSERT INTO commercial_products (
      version_id, product_id, name, sku, enabled, tax_rate, base_price_cents, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const product of snapshot.products ?? []) {
    insertProduct.run(
      versionId,
      product.id,
      product.name,
      product.sku || null,
      product.enabled === false ? 0 : 1,
      Number(product.taxRate ?? 0),
      Number(product.basePriceCents ?? 0),
      stringify(product, {}),
    );
  }

  const insertCatalog = db.prepare(`
    INSERT INTO commercial_catalogs (
      version_id, catalog_id, name, status, is_default, base_price_list_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCategory = db.prepare(`
    INSERT INTO commercial_catalog_categories (
      version_id, catalog_id, category_id, name, department_id, sort_order, enabled, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGroup = db.prepare(`
    INSERT INTO commercial_catalog_groups (
      version_id, catalog_id, category_id, group_id, name, sort_order, enabled, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCatalogEntry = db.prepare(`
    INSERT INTO commercial_catalog_entries (
      version_id, catalog_id, category_id, entry_id, sellable_type, sellable_id,
      group_id, sort_order, visible, enabled, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const catalog of snapshot.catalogs ?? []) {
    insertCatalog.run(
      versionId,
      catalog.id,
      catalog.name,
      catalog.status,
      catalog.isDefault ? 1 : 0,
      catalog.basePriceListId || null,
      stringify(catalog, {}),
    );
    for (const category of catalog.categories ?? []) {
      insertCategory.run(
        versionId,
        catalog.id,
        category.id,
        category.name,
        category.departmentId || null,
        Number(category.sortOrder ?? 0),
        category.enabled === false ? 0 : 1,
        stringify(category, {}),
      );
      for (const group of category.groups ?? []) {
        insertGroup.run(
          versionId,
          catalog.id,
          category.id,
          group.id,
          group.name,
          Number(group.sortOrder ?? 0),
          group.enabled === false ? 0 : 1,
          stringify(group, {}),
        );
      }
      for (const entry of category.entries ?? []) {
        insertCatalogEntry.run(
          versionId,
          catalog.id,
          category.id,
          entry.id,
          entry.sellableType,
          entry.sellableId,
          entry.groupId || null,
          Number(entry.sortOrder ?? 0),
          entry.visible === false ? 0 : 1,
          entry.enabled === false ? 0 : 1,
          stringify(entry, {}),
        );
      }
    }
  }

  const insertPriceList = db.prepare(`
    INSERT INTO commercial_price_lists (
      version_id, price_list_id, catalog_id, name, currency, status, inherits_from_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPriceEntry = db.prepare(`
    INSERT INTO commercial_price_list_entries (
      version_id, price_list_id, entry_id, sellable_type, sellable_id,
      price_cents, available, enabled, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const priceList of snapshot.priceLists ?? []) {
    insertPriceList.run(
      versionId,
      priceList.id,
      priceList.catalogId,
      priceList.name,
      priceList.currency,
      priceList.status,
      priceList.inheritsFromId || null,
      stringify(priceList, {}),
    );
    for (const entry of priceList.entries ?? []) {
      insertPriceEntry.run(
        versionId,
        priceList.id,
        entry.id,
        entry.sellableType,
        entry.sellableId,
        Number(entry.priceCents ?? 0),
        entry.available === false ? 0 : 1,
        entry.enabled === false ? 0 : 1,
        stringify(entry, {}),
      );
    }
  }

  const insertOffer = db.prepare(`
    INSERT INTO commercial_offers (
      version_id, offer_id, name, enabled, pricing_strategy,
      tax_allocation_strategy, base_price_cents, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIncluded = db.prepare(`
    INSERT INTO commercial_offer_included_items (
      version_id, offer_id, included_item_id, product_id, quantity, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertChoiceGroup = db.prepare(`
    INSERT INTO commercial_offer_choice_groups (
      version_id, offer_id, group_id, name, min_selections, max_selections,
      included_selections, allow_repeat, sort_order, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChoiceOption = db.prepare(`
    INSERT INTO commercial_offer_choice_options (
      version_id, offer_id, group_id, option_id, product_id, quantity,
      supplement_cents, enabled, sort_order, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const offer of snapshot.offers ?? []) {
    insertOffer.run(
      versionId,
      offer.id,
      offer.name,
      offer.enabled === false ? 0 : 1,
      offer.pricingStrategy,
      offer.taxAllocationStrategy,
      Number(offer.basePriceCents ?? 0),
      stringify(offer, {}),
    );
    for (const included of offer.includedItems ?? []) {
      insertIncluded.run(
        versionId,
        offer.id,
        included.id,
        included.productId,
        Number(included.quantity ?? 1),
        stringify(included, {}),
      );
    }
    for (const group of offer.choiceGroups ?? []) {
      insertChoiceGroup.run(
        versionId,
        offer.id,
        group.id,
        group.name,
        Number(group.minSelections ?? 0),
        Number(group.maxSelections ?? 0),
        Number(group.includedSelections ?? 0),
        group.allowRepeat ? 1 : 0,
        Number(group.sortOrder ?? 0),
        stringify(group, {}),
      );
      for (const option of group.options ?? []) {
        insertChoiceOption.run(
          versionId,
          offer.id,
          group.id,
          option.id,
          option.productId,
          Number(option.quantity ?? 1),
          Number(option.supplementCents ?? 0),
          option.enabled === false ? 0 : 1,
          Number(option.sortOrder ?? 0),
          stringify(option, {}),
        );
      }
    }
  }

  const insertAssignment = db.prepare(`
    INSERT INTO commercial_assignments (
      version_id, assignment_id, target_type, target_id, scope_type, scope_id,
      priority, enabled, valid_from, valid_to, weekdays_json,
      start_minute, end_minute, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const assignment of snapshot.assignments ?? []) {
    insertAssignment.run(
      versionId,
      assignment.id,
      assignment.targetType,
      assignment.targetId,
      assignment.scopeType,
      assignment.scopeId,
      Number(assignment.priority ?? 0),
      assignment.enabled === false ? 0 : 1,
      assignment.validFrom || null,
      assignment.validTo || null,
      stringify(assignment.weekdays, []),
      Number(assignment.startMinute ?? 0),
      Number(assignment.endMinute ?? 1440),
      stringify(assignment, {}),
    );
  }
}

export class CommercialConfigurationRelationalRepository {
  constructor(db, options = {}) {
    if (!db) throw new TypeError("Connessione relazionale obbligatoria.");
    this.db = db;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.logger = options.logger ?? console;
  }

  getState() {
    const row = this.db.prepare(`
      SELECT current_published_version_id, current_draft_version_id, updated_at
      FROM commercial_config_state WHERE state_id = 1
    `).get();
    return {
      currentPublishedVersionId: row?.current_published_version_id ?? null,
      currentDraftVersionId: row?.current_draft_version_id ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  getVersion(versionId) {
    const normalized = asString(versionId);
    if (!normalized) return null;
    return rowToVersion(this.db.prepare(`
      SELECT * FROM commercial_config_versions WHERE version_id = ?
    `).get(normalized));
  }

  getPublishedVersion() {
    const state = this.getState();
    return state.currentPublishedVersionId ? this.getVersion(state.currentPublishedVersionId) : null;
  }

  getDraftVersion() {
    const state = this.getState();
    return state.currentDraftVersionId ? this.getVersion(state.currentDraftVersionId) : null;
  }

  listVersions(options = {}) {
    const limit = Math.max(1, Math.min(Math.trunc(Number(options.limit) || 50), 500));
    const rows = this.db.prepare(`
      SELECT * FROM commercial_config_versions
      ORDER BY version_number DESC
      LIMIT ?
    `).all(limit);
    return rows.map(versionSummary);
  }

  readCommand(commandKey, action) {
    const key = asString(commandKey);
    if (!key) return null;
    const row = this.db.prepare(`
      SELECT action, response_json FROM commercial_config_commands WHERE command_key = ?
    `).get(key);
    if (!row) return null;
    if (row.action !== action) {
      throw repositoryError(
        "COMMERCIAL_IDEMPOTENCY_CONFLICT",
        `La chiave di idempotenza ${key} è già stata usata per ${row.action}.`,
      );
    }
    return safeJsonParse(row.response_json, null);
  }

  writeCommand(commandKey, action, actor, response) {
    const key = asString(commandKey);
    if (!key) return;
    this.db.prepare(`
      INSERT INTO commercial_config_commands (
        command_key, action, actor_user_id, created_at, response_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(key, action, actor.userId, this.nowIso(), stringify(response, {}));
  }

  appendAudit({ versionId = null, action, actor, payload = {} }) {
    this.db.prepare(`
      INSERT INTO commercial_config_audit_events (
        event_id, version_id, action, actor_user_id, actor_username, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `commercial_audit_${randomUUID().replace(/-/g, "")}`,
      versionId,
      action,
      actor.userId,
      actor.username,
      this.nowIso(),
      stringify(payload, {}),
    );
  }

  createDraft(input = {}) {
    const action = "draft.create";
    const actor = buildActor(input.actor);
    const cached = this.readCommand(input.idempotencyKey, action);
    if (cached) return cached;
    let response;
    runRelationalTransaction(this.db, () => {
      const state = this.getState();
      if (state.currentDraftVersionId && input.forceNew !== true) {
        response = this.getVersion(state.currentDraftVersionId);
        this.writeCommand(input.idempotencyKey, action, actor, response);
        return;
      }
      if (state.currentDraftVersionId && input.forceNew === true) {
        this.db.prepare(`
          UPDATE commercial_config_versions
          SET status = 'archived', updated_at = ?, updated_by_user_id = ?, updated_by_username = ?
          WHERE version_id = ? AND status = 'draft'
        `).run(this.nowIso(), actor.userId, actor.username, state.currentDraftVersionId);
      }
      const sourceVersionId = asString(input.sourceVersionId) || state.currentPublishedVersionId;
      const sourceVersion = sourceVersionId ? this.getVersion(sourceVersionId) : null;
      const snapshot = deepClone(sourceVersion?.snapshot ?? input.emptySnapshot ?? {});
      const versionNumber = Number(this.db.prepare(`
        SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
        FROM commercial_config_versions
      `).get()?.next_number ?? 1);
      const versionId = `commercial_v${String(versionNumber).padStart(6, "0")}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const timestamp = this.nowIso();
      const checksum = sha256(stableStringify(snapshot));
      this.db.prepare(`
        INSERT INTO commercial_config_versions (
          version_id, version_number, status, revision, schema_version,
          source_version_id, snapshot_json, compiled_json, checksum, publication_note,
          created_at, created_by_user_id, created_by_username,
          updated_at, updated_by_user_id, updated_by_username
        ) VALUES (?, ?, 'draft', 0, 2, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        versionNumber,
        sourceVersionId || null,
        stringify(snapshot, {}),
        checksum,
        timestamp,
        actor.userId,
        actor.username,
        timestamp,
        actor.userId,
        actor.username,
      );
      replaceProjection(this.db, versionId, snapshot);
      this.db.prepare(`
        UPDATE commercial_config_state
        SET current_draft_version_id = ?, updated_at = ?
        WHERE state_id = 1
      `).run(versionId, timestamp);
      this.appendAudit({
        versionId,
        action,
        actor,
        payload: { sourceVersionId: sourceVersionId || null, forceNew: input.forceNew === true },
      });
      response = this.getVersion(versionId);
      this.writeCommand(input.idempotencyKey, action, actor, response);
    });
    return response;
  }

  saveDraft(input = {}) {
    const action = "draft.save";
    const actor = buildActor(input.actor);
    const cached = this.readCommand(input.idempotencyKey, action);
    if (cached) return cached;
    const draftId = asString(input.draftId);
    if (!draftId) throw repositoryError("COMMERCIAL_DRAFT_NOT_FOUND", "draftId obbligatorio.");
    let response;
    runRelationalTransaction(this.db, () => {
      const current = this.getVersion(draftId);
      if (!current || current.status !== "draft") {
        throw repositoryError("COMMERCIAL_DRAFT_NOT_FOUND", "Bozza commerciale non trovata.", { draftId });
      }
      const expectedRevision = Number(input.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw repositoryError(
          "COMMERCIAL_REVISION_CONFLICT",
          `Revisione bozza non aggiornata: attesa ${current.revision}, ricevuta ${input.expectedRevision}.`,
          { draftId, expectedRevision: current.revision, receivedRevision: input.expectedRevision },
        );
      }
      const timestamp = this.nowIso();
      const checksum = sha256(stableStringify(input.snapshot));
      const update = this.db.prepare(`
        UPDATE commercial_config_versions
        SET snapshot_json = ?, compiled_json = NULL, checksum = ?, revision = revision + 1,
            updated_at = ?, updated_by_user_id = ?, updated_by_username = ?
        WHERE version_id = ? AND status = 'draft' AND revision = ?
      `).run(
        stringify(input.snapshot, {}),
        checksum,
        timestamp,
        actor.userId,
        actor.username,
        draftId,
        current.revision,
      );
      if (Number(update.changes) !== 1) {
        throw repositoryError("COMMERCIAL_REVISION_CONFLICT", "Conflitto di revisione durante il salvataggio.", { draftId });
      }
      replaceProjection(this.db, draftId, input.snapshot);
      this.db.prepare(`
        UPDATE commercial_config_state SET updated_at = ? WHERE state_id = 1
      `).run(timestamp);
      this.appendAudit({
        versionId: draftId,
        action,
        actor,
        payload: { validation: input.validation?.summary ?? null },
      });
      response = this.getVersion(draftId);
      this.writeCommand(input.idempotencyKey, action, actor, response);
    });
    return { ok: true, version: response };
  }

  publishDraft(input = {}) {
    const action = "draft.publish";
    const actor = buildActor(input.actor);
    const cached = this.readCommand(input.idempotencyKey, action);
    if (cached) return cached;
    const draftId = asString(input.draftId);
    let response;
    runRelationalTransaction(this.db, () => {
      const current = this.getVersion(draftId);
      if (!current || current.status !== "draft") {
        throw repositoryError("COMMERCIAL_DRAFT_NOT_FOUND", "Bozza commerciale non trovata.", { draftId });
      }
      const expectedRevision = Number(input.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw repositoryError(
          "COMMERCIAL_REVISION_CONFLICT",
          `Revisione bozza non aggiornata: attesa ${current.revision}, ricevuta ${input.expectedRevision}.`,
          { draftId, expectedRevision: current.revision, receivedRevision: input.expectedRevision },
        );
      }
      const state = this.getState();
      const timestamp = this.nowIso();
      if (state.currentPublishedVersionId) {
        this.db.prepare(`
          UPDATE commercial_config_versions
          SET status = 'archived', updated_at = ?, updated_by_user_id = ?, updated_by_username = ?
          WHERE version_id = ? AND status = 'published'
        `).run(timestamp, actor.userId, actor.username, state.currentPublishedVersionId);
      }
      const update = this.db.prepare(`
        UPDATE commercial_config_versions
        SET status = 'published', compiled_json = ?, checksum = ?, publication_note = ?,
            revision = revision + 1, updated_at = ?, updated_by_user_id = ?, updated_by_username = ?,
            published_at = ?, published_by_user_id = ?, published_by_username = ?
        WHERE version_id = ? AND status = 'draft' AND revision = ?
      `).run(
        stringify(input.compiled, {}),
        input.checksum,
        asString(input.note),
        timestamp,
        actor.userId,
        actor.username,
        timestamp,
        actor.userId,
        actor.username,
        draftId,
        current.revision,
      );
      if (Number(update.changes) !== 1) {
        throw repositoryError("COMMERCIAL_REVISION_CONFLICT", "Conflitto durante la pubblicazione.", { draftId });
      }
      this.db.prepare(`
        UPDATE commercial_config_state
        SET current_published_version_id = ?, current_draft_version_id = NULL, updated_at = ?
        WHERE state_id = 1
      `).run(draftId, timestamp);
      this.appendAudit({
        versionId: draftId,
        action,
        actor,
        payload: {
          previousPublishedVersionId: state.currentPublishedVersionId,
          note: asString(input.note),
          checksum: input.checksum,
        },
      });
      response = { ok: true, version: this.getVersion(draftId) };
      this.writeCommand(input.idempotencyKey, action, actor, response);
    });
    return response;
  }

  rollback(input = {}) {
    const action = "version.rollback";
    const actor = buildActor(input.actor);
    const cached = this.readCommand(input.idempotencyKey, action);
    if (cached) return cached;
    const targetVersionId = asString(input.targetVersionId);
    let response;
    runRelationalTransaction(this.db, () => {
      const target = this.getVersion(targetVersionId);
      if (!target) {
        throw repositoryError("COMMERCIAL_VERSION_NOT_FOUND", "Versione di rollback non trovata.", { targetVersionId });
      }
      const state = this.getState();
      const timestamp = this.nowIso();
      if (state.currentPublishedVersionId) {
        this.db.prepare(`
          UPDATE commercial_config_versions
          SET status = 'archived', updated_at = ?, updated_by_user_id = ?, updated_by_username = ?
          WHERE version_id = ? AND status = 'published'
        `).run(timestamp, actor.userId, actor.username, state.currentPublishedVersionId);
      }
      const versionNumber = Number(this.db.prepare(`
        SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
        FROM commercial_config_versions
      `).get()?.next_number ?? 1);
      const versionId = `commercial_v${String(versionNumber).padStart(6, "0")}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      this.db.prepare(`
        INSERT INTO commercial_config_versions (
          version_id, version_number, status, revision, schema_version,
          source_version_id, snapshot_json, compiled_json, checksum, publication_note,
          created_at, created_by_user_id, created_by_username,
          updated_at, updated_by_user_id, updated_by_username,
          published_at, published_by_user_id, published_by_username
        ) VALUES (?, ?, 'published', 0, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        versionNumber,
        targetVersionId,
        stringify(input.snapshot, {}),
        stringify(input.compiled, {}),
        input.checksum,
        asString(input.note),
        timestamp,
        actor.userId,
        actor.username,
        timestamp,
        actor.userId,
        actor.username,
        timestamp,
        actor.userId,
        actor.username,
      );
      replaceProjection(this.db, versionId, input.snapshot);
      this.db.prepare(`
        UPDATE commercial_config_state
        SET current_published_version_id = ?, current_draft_version_id = NULL, updated_at = ?
        WHERE state_id = 1
      `).run(versionId, timestamp);
      this.appendAudit({
        versionId,
        action,
        actor,
        payload: {
          targetVersionId,
          previousPublishedVersionId: state.currentPublishedVersionId,
          note: asString(input.note),
        },
      });
      response = { ok: true, version: this.getVersion(versionId) };
      this.writeCommand(input.idempotencyKey, action, actor, response);
    });
    return response;
  }
}
