const DEFAULT_MAX_TABLE_GROUPS = 200;
const DEFAULT_MAX_TABLE_GROUP_DEPTH = 6;

function resolveMaxTableGroups(options = {}) {
  const parsed = Number(options.maxGroups);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TABLE_GROUPS;
  return Math.max(1, Math.trunc(parsed));
}

function resolveMaxTableGroupDepth(options = {}) {
  const parsed = Number(options.maxDepth);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TABLE_GROUP_DEPTH;
  return Math.max(1, Math.trunc(parsed));
}

function nowIso(options = {}) {
  return typeof options.nowIso === "function" ? options.nowIso() : new Date().toISOString();
}

export function sanitizeIntegrationTableGroupNode(node, options = {}) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const depth = Math.max(Math.trunc(Number(options.depth) || 0), 0);
  if (depth > resolveMaxTableGroupDepth(options)) return null;
  const validIds = options.validIds instanceof Set ? options.validIds : null;
  const branchIds = options.branchIds instanceof Set ? new Set(options.branchIds) : new Set();
  const id = String(node.id ?? node.tableId ?? "").trim();
  if (!id) return null;
  if (validIds && !validIds.has(id)) return null;
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  if (branchIds.has(id)) {
    return rawChildren.length === 0
      ? {
          id,
          type: "simple",
        }
      : null;
  }
  branchIds.add(id);

  const children = [];
  const directIds = new Set();
  rawChildren.forEach((child) => {
    const normalizedChild = sanitizeIntegrationTableGroupNode(child, {
      ...options,
      depth: depth + 1,
      branchIds,
    });
    if (!normalizedChild) return;
    const childKey = `${normalizedChild.type}:${normalizedChild.id}`;
    if (directIds.has(childKey)) return;
    directIds.add(childKey);
    children.push(normalizedChild);
  });

  if (children.length >= 2) {
    return {
      id,
      type: "complex",
      children,
    };
  }

  return {
    id,
    type: "simple",
  };
}

export function collectIntegrationTableGroupLeafIds(node, output = new Set()) {
  if (!node || typeof node !== "object") return output;
  const id = String(node.id ?? "").trim();
  if (node.type === "complex" && Array.isArray(node.children) && node.children.length > 0) {
    node.children.forEach((child) => collectIntegrationTableGroupLeafIds(child, output));
    return output;
  }
  if (id) output.add(id);
  return output;
}

export function sanitizeIntegrationTableGroups(source, options = {}) {
  const validIds = options.validIds instanceof Set ? options.validIds : null;
  const groups = Array.isArray(source) ? source : [];
  const nextGroups = [];
  const usedRootIds = new Set();
  const usedLeafIds = new Set();

  groups.slice(0, resolveMaxTableGroups(options)).forEach((group) => {
    const normalized = sanitizeIntegrationTableGroupNode(group, {
      ...options,
      validIds,
      depth: 0,
      branchIds: new Set(),
    });
    if (!normalized || normalized.type !== "complex") return;
    if (usedRootIds.has(normalized.id)) return;

    const leafIds = collectIntegrationTableGroupLeafIds(normalized);
    if (leafIds.size < 2) return;
    const overlapsExisting = [...leafIds].some((id) => usedLeafIds.has(id));
    if (overlapsExisting) return;

    usedRootIds.add(normalized.id);
    leafIds.forEach((id) => usedLeafIds.add(id));
    nextGroups.push({
      ...normalized,
      updatedAt: String(group.updatedAt ?? nowIso(options)),
    });
  });

  return nextGroups;
}

export function sanitizeIntegrationTableLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^tavolo\s+/i, "")
    .trim()
    .slice(0, 40);
}

export function formatIntegrationTableNumberGroupLabel(numbers) {
  const unique = [
    ...new Set(
      (Array.isArray(numbers) ? numbers : [])
        .map((entry) => Math.trunc(Number(entry)))
        .filter((entry) => Number.isFinite(entry) && entry > 0)
    ),
  ].sort((a, b) => a - b);
  return unique.length > 0 ? unique.join("/") : "";
}

export function resolveIntegrationLogicalTableLabel(settings, integration, tableId, fallbackNumber = 0) {
  const safeTableId = String(tableId ?? "").trim();
  const tables = Array.isArray(settings?.tables) ? settings.tables : [];
  const tableNumberById = new Map(
    tables
      .map((table) => [
        String(table?.id ?? "").trim(),
        Math.trunc(Number(table?.number) || 0),
      ])
      .filter(([id, number]) => id && Number.isFinite(number) && number > 0)
  );
  const groups = sanitizeIntegrationTableGroups(integration?.tableGroups);
  const group = safeTableId
    ? groups.find((entry) => entry.id === safeTableId || collectIntegrationTableGroupLeafIds(entry).has(safeTableId))
    : null;
  if (group) {
    const label = formatIntegrationTableNumberGroupLabel(
      [...collectIntegrationTableGroupLeafIds(group)].map((id) => tableNumberById.get(id))
    );
    if (label) return label;
  }
  const fallback = Math.trunc(Number(fallbackNumber) || 0);
  return fallback > 0 ? String(fallback) : "";
}

export function findIntegrationTableGroupContaining(integration, tableId) {
  const safeTableId = String(tableId ?? "").trim();
  if (!safeTableId) return null;
  return (
    sanitizeIntegrationTableGroups(integration?.tableGroups).find((group) => {
      if (String(group?.id ?? "").trim() === safeTableId) return true;
      return collectIntegrationTableGroupLeafIds(group).has(safeTableId);
    }) ?? null
  );
}

export function areIntegrationTablesLinkedByGroup(integration, leftTableId, rightTableId) {
  const left = String(leftTableId ?? "").trim();
  const right = String(rightTableId ?? "").trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const leftGroup = findIntegrationTableGroupContaining(integration, left);
  const rightGroup = findIntegrationTableGroupContaining(integration, right);
  return Boolean(leftGroup && rightGroup && String(leftGroup.id ?? "").trim() === String(rightGroup.id ?? "").trim());
}

export function resolveIntegrationLinkedTableIds(integration, tableId) {
  const safeTableId = String(tableId ?? "").trim();
  if (!safeTableId) return [];
  const group = findIntegrationTableGroupContaining(integration, safeTableId);
  if (!group) return [safeTableId];
  return [...new Set([String(group.id ?? "").trim(), ...collectIntegrationTableGroupLeafIds(group)].filter(Boolean))];
}
