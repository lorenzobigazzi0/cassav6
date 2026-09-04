import { compileCommercialConfiguration } from "./commercial-configuration.compiler.js";
import { createEmptyCommercialConfiguration, normalizeCommercialConfiguration } from "./commercial-configuration.normalization.js";
import { buildCommercialLegacyMenuItems, resolveCommercialSellable } from "./commercial-pricing.service.js";
import { buildCommercialConfigurationFromLegacy } from "./legacy-commercial-configuration.adapter.js";
import { buildActor, deepClone, sha256, stableStringify } from "./commercial-configuration.utils.js";
import { validateCommercialConfiguration } from "./commercial-configuration.validation.js";

function diffObjects(left, right, path = "") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [{ path, before: left, after: right }];
    const changes = [];
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      changes.push(...diffObjects(left[index], right[index], `${path}[${index}]`));
    }
    return changes;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].sort().flatMap((key) => diffObjects(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return [{ path, before: left, after: right }];
}

export class CommercialConfigurationService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.logger = options.logger ?? console;
  }

  async getWorkspace() {
    const [state, published, draft, versions] = await Promise.all([
      this.repository.getState(),
      this.repository.getPublishedVersion(),
      this.repository.getDraftVersion(),
      this.repository.listVersions({ limit: 50 }),
    ]);
    return {
      ok: true,
      state,
      published,
      draft,
      versions,
      emptyConfiguration: createEmptyCommercialConfiguration(),
    };
  }

  async createDraft(input = {}) {
    const actor = buildActor(input.actor);
    return this.repository.createDraft({
      actor,
      sourceVersionId: input.sourceVersionId ?? null,
      forceNew: input.forceNew === true,
      idempotencyKey: input.idempotencyKey,
      emptySnapshot: createEmptyCommercialConfiguration(),
    });
  }

  async saveDraft(input = {}) {
    const normalized = normalizeCommercialConfiguration(input.snapshot);
    const validation = validateCommercialConfiguration(normalized, input.validationOptions);
    const result = await this.repository.saveDraft({
      draftId: input.draftId,
      expectedRevision: input.expectedRevision,
      snapshot: normalized,
      actor: buildActor(input.actor),
      idempotencyKey: input.idempotencyKey,
      validation,
    });
    return { ...result, validation };
  }

  async validateDraft(input = {}) {
    const draft = input.snapshot
      ? { snapshot: normalizeCommercialConfiguration(input.snapshot) }
      : await this.repository.getVersion(input.draftId ?? (await this.repository.getState()).currentDraftVersionId);
    if (!draft?.snapshot) {
      const error = new Error("Bozza commerciale non trovata.");
      error.code = "COMMERCIAL_DRAFT_NOT_FOUND";
      throw error;
    }
    const validation = validateCommercialConfiguration(draft.snapshot, input.validationOptions);
    let compiled = null;
    if (validation.ok) compiled = compileCommercialConfiguration(validation.configuration, { compiledAt: this.nowIso() });
    return {
      ok: validation.ok,
      validation,
      checksum: compiled?.checksum ?? sha256(validation.configuration),
      compiledSummary: compiled
        ? {
            sourceChecksum: compiled.compiled.sourceChecksum,
            catalogIds: Object.keys(compiled.compiled.catalogsById),
            priceListIds: Object.keys(compiled.compiled.priceListsById),
          }
        : null,
    };
  }

  async publishDraft(input = {}) {
    const draft = await this.repository.getVersion(input.draftId);
    if (!draft?.snapshot) {
      const error = new Error("Bozza commerciale non trovata.");
      error.code = "COMMERCIAL_DRAFT_NOT_FOUND";
      throw error;
    }
    const compiled = compileCommercialConfiguration(draft.snapshot, {
      compiledAt: this.nowIso(),
      knownScopes: input.validationOptions?.knownScopes,
    });
    const result = await this.repository.publishDraft({
      draftId: input.draftId,
      expectedRevision: input.expectedRevision,
      compiled: compiled.compiled,
      checksum: compiled.checksum,
      actor: buildActor(input.actor),
      note: String(input.note ?? "").trim(),
      idempotencyKey: input.idempotencyKey,
    });
    return { ...result, validation: compiled.validation };
  }

  async listVersions(input = {}) {
    return { ok: true, versions: await this.repository.listVersions(input) };
  }

  async diffVersions(input = {}) {
    const [left, right] = await Promise.all([
      this.repository.getVersion(input.leftVersionId),
      this.repository.getVersion(input.rightVersionId),
    ]);
    if (!left || !right) {
      const error = new Error("Una delle versioni richieste non esiste.");
      error.code = "COMMERCIAL_VERSION_NOT_FOUND";
      throw error;
    }
    const changes = diffObjects(left.snapshot, right.snapshot).slice(0, 20_000);
    return {
      ok: true,
      left: { id: left.id, versionNumber: left.versionNumber, checksum: left.checksum },
      right: { id: right.id, versionNumber: right.versionNumber, checksum: right.checksum },
      changes,
      truncated: changes.length >= 20_000,
    };
  }

  async rollback(input = {}) {
    const target = await this.repository.getVersion(input.targetVersionId);
    if (!target?.snapshot) {
      const error = new Error("Versione di rollback non trovata.");
      error.code = "COMMERCIAL_VERSION_NOT_FOUND";
      throw error;
    }
    const compiled = compileCommercialConfiguration(target.snapshot, { compiledAt: this.nowIso() });
    return this.repository.rollback({
      targetVersionId: target.id,
      snapshot: target.snapshot,
      compiled: compiled.compiled,
      checksum: compiled.checksum,
      actor: buildActor(input.actor),
      note: String(input.note ?? "Rollback configurazione commerciale").trim(),
      idempotencyKey: input.idempotencyKey,
    });
  }

  async simulate(input = {}) {
    const compiledVersion = await this.getCompiledVersion(input.versionId);
    const result = resolveCommercialSellable(compiledVersion.compiled, input.context, input.sellable);
    return {
      ok: true,
      version: compiledVersion.version,
      result,
    };
  }

  async getCompiledVersion(versionId = null) {
    const version = versionId
      ? await this.repository.getVersion(versionId)
      : await this.repository.getPublishedVersion();
    if (!version?.snapshot) {
      const error = new Error("Nessuna configurazione commerciale pubblicata.");
      error.code = "COMMERCIAL_CONFIGURATION_NOT_PUBLISHED";
      throw error;
    }
    if (version.compiled && version.checksum) return { version, compiled: version.compiled };
    const compiled = compileCommercialConfiguration(version.snapshot, { compiledAt: this.nowIso() });
    return { version, compiled: compiled.compiled };
  }

  async buildLegacyMenuItems(input = {}) {
    const { version, compiled } = await this.getCompiledVersion(input.versionId);
    return {
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        checksum: version.checksum,
        publishedAt: version.publishedAt,
      },
      ...buildCommercialLegacyMenuItems(compiled, input.context),
    };
  }

  async resolveLine(input = {}) {
    const { version, compiled } = await this.getCompiledVersion(input.versionId);
    const result = resolveCommercialSellable(compiled, input.context, input.line);
    return {
      ...result,
      configurationVersionId: version.id,
      configurationVersionNumber: version.versionNumber,
      configurationChecksum: version.checksum || compiled.sourceChecksum,
      pricingSnapshot: {
        schemaVersion: 2,
        configurationVersionId: version.id,
        configurationVersionNumber: version.versionNumber,
        configurationChecksum: version.checksum || compiled.sourceChecksum,
        catalogId: result.catalogId,
        priceListChain: result.priceListChain,
        appliedAssignmentIds: result.appliedAssignmentIds,
        sellableType: result.sellableType,
        sellableId: result.sellableId,
        basePriceCents: result.basePriceCents,
        variantDeltaCents: result.variantDeltaCents,
        offerSupplementCents: result.offerSupplementCents,
        finalUnitPriceCents: result.finalUnitPriceCents,
        selectionSnapshot: result.selectionSnapshot,
        priceFingerprint: result.priceFingerprint,
        resolvedAt: result.resolvedAt,
        pricingTrace: result.pricingTrace,
      },
    };
  }

  async bootstrapFromLegacy(input = {}) {
    const snapshot = buildCommercialConfigurationFromLegacy(input.db);
    let draft = await this.repository.getDraftVersion();
    if (!draft || input.forceNew === true) {
      draft = await this.repository.createDraft({
        actor: buildActor(input.actor),
        forceNew: input.forceNew === true,
        emptySnapshot: createEmptyCommercialConfiguration(),
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:create` : undefined,
      });
    }
    const saved = await this.saveDraft({
      draftId: draft.id ?? draft.version?.id,
      expectedRevision: draft.revision ?? draft.version?.revision ?? 0,
      snapshot,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:save` : undefined,
      validationOptions: input.validationOptions,
    });
    return { ok: true, snapshot, draft: saved.version ?? saved, validation: saved.validation };
  }

  async exportVersion(input = {}) {
    const version = input.versionId
      ? await this.repository.getVersion(input.versionId)
      : await this.repository.getDraftVersion() ?? await this.repository.getPublishedVersion();
    if (!version) {
      const error = new Error("Nessuna configurazione da esportare.");
      error.code = "COMMERCIAL_VERSION_NOT_FOUND";
      throw error;
    }
    return {
      ok: true,
      exportedAt: this.nowIso(),
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        status: version.status,
        revision: version.revision,
        checksum: version.checksum,
      },
      snapshot: deepClone(version.snapshot),
      exportChecksum: sha256(stableStringify(version.snapshot)),
    };
  }
}
