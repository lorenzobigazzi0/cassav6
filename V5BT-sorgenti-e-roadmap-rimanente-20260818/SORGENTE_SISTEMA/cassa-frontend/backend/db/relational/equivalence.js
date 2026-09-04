import { createHash } from "node:crypto";
import { mapAuditEventToRow } from "./audit-events.repo.js";
import { buildMenuSettingsRelationalRows } from "./menu-settings.repo.js";
import { buildOrdersRelationalRows } from "./orders.repo.js";
import { buildPaymentsRelationalRows } from "./payments.repo.js";
import { buildReservationsRelationalRows } from "./reservations.repo.js";
import {
  mapSaleSessionToRelationalRow,
  mapSolarClosureToRelationalRow,
} from "./sale-sessions.repo.js";
import { mapSessionToRelationalRow } from "./sessions.repo.js";
import { buildTablesBillsRelationalRows } from "./tables-bills.repo.js";
import { mapUserToRelationalRows } from "./users.repo.js";

export const RELATIONAL_EQUIVALENCE_DOMAINS = [
  "auditEvents",
  "users",
  "sessions",
  "saleSessions",
  "payments",
  "menuSettings",
  "orders",
  "tablesBills",
  "reservations",
];

function safeJsonParse(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{\[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = safeJsonParse(trimmed);
    return parsed === trimmed ? trimmed : normalizeValue(parsed);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeValue(entry))
      .sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right)),
      );
  }
  if (typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeValue(value[key]);
    }
    return normalized;
  }
  return String(value);
}

function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

function checksumFor(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function countDomainRows(canonicalRows) {
  if (!canonicalRows || typeof canonicalRows !== "object") return 0;
  return Object.values(canonicalRows).reduce(
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0,
  );
}

function tableExists(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function missingTables(db, names) {
  return names.filter((name) => !tableExists(db, name));
}

function queryRows(db, sql) {
  return db.prepare(sql).all();
}

function buildAuditEventsRowsFromAppState(appState) {
  return {
    auditEvents: (Array.isArray(appState?.auditEvents)
      ? appState.auditEvents
      : []
    )
      .map((event, index) => mapAuditEventToRow(event, index))
      .filter((row) => row !== null),
  };
}

function buildUsersRowsFromAppState(appState) {
  const mapped = (Array.isArray(appState?.users) ? appState.users : [])
    .map((user) => mapUserToRelationalRows(user))
    .filter((row) => row !== null);
  return {
    users: mapped.map((row) => row.user),
    userPermissions: mapped.flatMap((row) =>
      row.permissions.map((permission) => ({
        userId: row.user.id,
        permission,
      })),
    ),
    userEnabledRooms: mapped.flatMap((row) =>
      row.enabledRoomIds.map((roomId) => ({ userId: row.user.id, roomId })),
    ),
    userAuthorizedRooms: mapped.flatMap((row) =>
      row.authorizedRoomIds.map((roomId) => ({ userId: row.user.id, roomId })),
    ),
    userPaymentMethods: mapped.flatMap((row) =>
      row.paymentMethodIds.map((paymentMethodId) => ({
        userId: row.user.id,
        paymentMethodId,
      })),
    ),
  };
}

function buildSessionsRowsFromAppState(appState) {
  return {
    sessions: (Array.isArray(appState?.sessions) ? appState.sessions : [])
      .map((session) => mapSessionToRelationalRow(session))
      .filter((row) => row !== null),
  };
}

function buildSaleSessionsRowsFromAppState(appState) {
  return {
    saleSessions: (Array.isArray(appState?.saleSessions)
      ? appState.saleSessions
      : []
    )
      .map((session) => mapSaleSessionToRelationalRow(session))
      .filter((row) => row !== null),
    solarClosures: (Array.isArray(appState?.solarClosures)
      ? appState.solarClosures
      : []
    )
      .map((closure, index) => mapSolarClosureToRelationalRow(closure, index))
      .filter((row) => row !== null),
  };
}

function buildMenuSettingsRowsFromAppState(appState) {
  const rows = buildMenuSettingsRelationalRows(appState);
  return {
    ...rows,
    rooms: rows.rooms.map(({ sortOrder: _sortOrder, ...row }) => row),
  };
}

function omitAggregateOutboxMetadata(row) {
  const { lastEventId: _lastEventId, ...rest } = row;
  return rest;
}

function buildOrdersRowsFromAppState(appState) {
  const rows = buildOrdersRelationalRows(appState);
  return {
    ...rows,
    orders: rows.orders.map(omitAggregateOutboxMetadata),
  };
}

function buildTablesBillsRowsFromAppState(appState) {
  const rows = buildTablesBillsRelationalRows(appState);
  return {
    ...rows,
    tableStates: rows.tableStates.map(omitAggregateOutboxMetadata),
  };
}

function buildAppStateDomainRows(appState, domain) {
  switch (domain) {
    case "auditEvents":
      return buildAuditEventsRowsFromAppState(appState);
    case "users":
      return buildUsersRowsFromAppState(appState);
    case "sessions":
      return buildSessionsRowsFromAppState(appState);
    case "saleSessions":
      return buildSaleSessionsRowsFromAppState(appState);
    case "payments":
      return buildPaymentsRelationalRows(appState);
    case "menuSettings":
      return buildMenuSettingsRowsFromAppState(appState);
    case "orders":
      return buildOrdersRowsFromAppState(appState);
    case "tablesBills":
      return buildTablesBillsRowsFromAppState(appState);
    case "reservations":
      return buildReservationsRelationalRows(appState);
    default:
      return null;
  }
}

function buildRelationalAuditEventsRows(db) {
  return {
    auditEvents: queryRows(
      db,
      `
        SELECT
          id,
          occurred_at AS occurredAt,
          actor_user_id AS actorUserId,
          actor_role AS actorRole,
          room_id AS roomId,
          device_id AS deviceId,
          action,
          entity_type AS entityType,
          entity_id AS entityId,
          correlation_id AS correlationId,
          payload_json AS payloadJson,
          before_json AS beforeJson,
          after_json AS afterJson,
          deleted_at AS deletedAt,
          deleted_by AS deletedBy,
          delete_reason AS deleteReason,
          app_state_position AS appStatePosition
        FROM audit_events
      `,
    ),
  };
}

function buildRelationalUsersRows(db) {
  return {
    users: queryRows(
      db,
      `
        SELECT
          id,
          username,
          full_name AS fullName,
          role,
          pin_hash AS pinHash,
          pin_salt AS pinSalt,
          pin_params_json AS pinParamsJson,
          active,
          default_room_id AS defaultRoomId,
          last_selected_room_id AS lastSelectedRoomId,
          last_selected_room_name AS lastSelectedRoomName,
          last_selected_room_at AS lastSelectedRoomAt,
          last_selected_room_device_uuid AS lastSelectedRoomDeviceUuid,
          raw_json AS rawJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM users
      `,
    ),
    userPermissions: queryRows(
      db,
      "SELECT user_id AS userId, permission FROM user_permissions",
    ),
    userEnabledRooms: queryRows(
      db,
      "SELECT user_id AS userId, room_id AS roomId FROM user_enabled_rooms",
    ),
    userAuthorizedRooms: queryRows(
      db,
      "SELECT user_id AS userId, room_id AS roomId FROM user_authorized_rooms",
    ),
    userPaymentMethods: queryRows(
      db,
      "SELECT user_id AS userId, payment_method_id AS paymentMethodId FROM user_payment_methods",
    ),
  };
}

function buildRelationalSessionsRows(db) {
  return {
    sessions: queryRows(
      db,
      `
        SELECT
          id,
          user_id AS userId,
          token_hash AS tokenHash,
          device_uuid AS deviceUuid,
          client_app AS clientApp,
          created_at AS createdAt,
          last_seen_at AS lastSeenAt,
          expires_at AS expiresAt,
          revoked_at AS revokedAt,
          raw_json AS rawJson
        FROM sessions
      `,
    ),
  };
}

function buildRelationalSaleSessionsRows(db) {
  return {
    saleSessions: queryRows(
      db,
      `
        SELECT
          id,
          business_date AS businessDate,
          opened_at AS openedAt,
          opened_by_user_id AS openedByUserId,
          closed_at AS closedAt,
          closed_by_user_id AS closedByUserId,
          status,
          opening_float_cents AS openingFloatCents,
          closing_total_cents AS closingTotalCents,
          notes,
          raw_json AS rawJson
        FROM sale_sessions
      `,
    ),
    solarClosures: queryRows(
      db,
      `
        SELECT
          id,
          business_date AS businessDate,
          closed_at AS closedAt,
          closed_by_user_id AS closedByUserId,
          totals_json AS totalsJson,
          raw_json AS rawJson
        FROM solar_closures
      `,
    ),
  };
}

function buildRelationalPaymentsRows(db) {
  return {
    containers: queryRows(
      db,
      `
        SELECT
          id,
          table_id AS tableId,
          bill_id AS billId,
          order_id AS orderId,
          status,
          total_cents AS totalCents,
          paid_cents AS paidCents,
          due_cents AS dueCents,
          created_at AS createdAt,
          updated_at AS updatedAt,
          revision,
          raw_json AS rawJson
        FROM payment_containers
      `,
    ),
    parts: queryRows(
      db,
      `
        SELECT
          id,
          container_id AS containerId,
          method_id AS methodId,
          method_type AS methodType,
          amount_cents AS amountCents,
          fiscal_status AS fiscalStatus,
          created_at AS createdAt,
          raw_json AS rawJson
        FROM payment_parts
      `,
    ),
    transactions: queryRows(
      db,
      `
        SELECT
          id,
          container_id AS containerId,
          idempotency_key AS idempotencyKey,
          table_id AS tableId,
          bill_id AS billId,
          order_id AS orderId,
          amount_cents AS amountCents,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt,
          revision,
          raw_json AS rawJson
        FROM payment_transactions
      `,
    ),
    fiscalReceipts: queryRows(
      db,
      `
        SELECT
          id,
          payment_transaction_id AS paymentTransactionId,
          attempt_scope AS attemptScope,
          fiscal_provider AS fiscalProvider,
          fiscal_status AS fiscalStatus,
          fiscal_document_number AS fiscalDocumentNumber,
          issued_at AS issuedAt,
          payload_json AS payloadJson,
          raw_json AS rawJson
        FROM fiscal_receipts
      `,
    ),
  };
}

function buildRelationalMenuSettingsRows(db) {
  return {
    categories: queryRows(
      db,
      "SELECT id, name, sort_order AS sortOrder, active, raw_json AS rawJson FROM menu_categories",
    ),
    items: queryRows(
      db,
      `
        SELECT
          id,
          category_id AS categoryId,
          name,
          description,
          price_cents AS priceCents,
          active,
          available,
          department,
          station_id AS stationId,
          stations_json AS stationsJson,
          metadata_json AS metadataJson,
          raw_json AS rawJson
        FROM menu_items
      `,
    ),
    variants: queryRows(
      db,
      `
        SELECT
          id,
          item_id AS itemId,
          name,
          price_delta_cents AS priceDeltaCents,
          required,
          active,
          raw_json AS rawJson
        FROM menu_item_variants
      `,
    ),
    paymentMethods: queryRows(
      db,
      "SELECT id, name, type, active, fiscal, sort_order AS sortOrder, raw_json AS rawJson FROM payment_methods",
    ),
    rooms: queryRows(
      db,
      "SELECT id, name, active, raw_json AS rawJson FROM pos_rooms",
    ),
    tables: queryRows(
      db,
      `
        SELECT
          id,
          room_id AS roomId,
          name,
          number,
          active,
          layout_json AS layoutJson,
          raw_json AS rawJson
        FROM pos_tables
      `,
    ),
  };
}

function buildRelationalOrdersRows(db) {
  return {
    orders: queryRows(
      db,
      `
        SELECT
          id,
          table_id AS tableId,
          room_id AS roomId,
          status,
          source,
          idempotency_key AS idempotencyKey,
          created_by_user_id AS createdByUserId,
          created_by_device_uuid AS createdByDeviceUuid,
          total_cents AS totalCents,
          created_at AS createdAt,
          updated_at AS updatedAt,
          delivered_at AS deliveredAt,
          cancelled_at AS cancelledAt,
          paid_at AS paidAt,
          operator_user_id AS operatorUserId,
          station_id AS stationId,
          revision,
          raw_json AS rawJson
        FROM orders
      `,
    ),
    lines: queryRows(
      db,
      `
        SELECT
          id,
          order_id AS orderId,
          product_id AS productId,
          product_name AS productName,
          quantity,
          unit_price_cents AS unitPriceCents,
          total_cents AS totalCents,
          status,
          station_id AS stationId,
          prepared_quantity AS preparedQuantity,
          delivered_quantity AS deliveredQuantity,
          cancelled_quantity AS cancelledQuantity,
          raw_json AS rawJson
        FROM order_lines
      `,
    ),
    variants: queryRows(
      db,
      `
        SELECT
          id,
          line_id AS lineId,
          variant_id AS variantId,
          name,
          price_delta_cents AS priceDeltaCents,
          raw_json AS rawJson
        FROM order_line_variants
      `,
    ),
    events: queryRows(
      db,
      `
        SELECT
          id,
          order_id AS orderId,
          event_type AS eventType,
          occurred_at AS occurredAt,
          actor_user_id AS actorUserId,
          payload_json AS payloadJson,
          raw_json AS rawJson
        FROM order_events
      `,
    ),
  };
}

function buildRelationalTablesBillsRows(db) {
  return {
    tableStates: queryRows(
      db,
      `
        SELECT
          table_id AS tableId,
          room_id AS roomId,
          status,
          covers,
          customer_name AS customerName,
          notes,
          total_due_cents AS totalDueCents,
          total_paid_cents AS totalPaidCents,
          updated_at AS updatedAt,
          revision,
          raw_json AS rawJson
        FROM table_states
      `,
    ),
    bills: queryRows(
      db,
      `
        SELECT
          id,
          table_id AS tableId,
          status,
          total_cents AS totalCents,
          paid_cents AS paidCents,
          due_cents AS dueCents,
          created_at AS createdAt,
          updated_at AS updatedAt,
          raw_json AS rawJson
        FROM table_bills
      `,
    ),
    locks: queryRows(
      db,
      `
        SELECT
          table_id AS tableId,
          user_id AS userId,
          device_uuid AS deviceUuid,
          acquired_at AS acquiredAt,
          heartbeat_at AS heartbeatAt,
          expires_at AS expiresAt,
          revision,
          raw_json AS rawJson
        FROM table_locks
      `,
    ),
  };
}

function buildRelationalReservationsRows(db) {
  return {
    reservationStateVersions: queryRows(
      db,
      `
        SELECT
          room_id AS roomId,
          service_date AS serviceDate,
          state_key AS stateKey,
          version
        FROM reservation_state_versions
      `,
    ),
    reservations: queryRows(
      db,
      `
        SELECT
          id,
          room_id AS roomId,
          service_date AS serviceDate,
          state_key AS stateKey,
          reservation_at_ms AS reservationAtMs,
          customer_name AS customerName,
          customer_phone AS customerPhone,
          covers,
          status,
          intolerances,
          note,
          assigned_table_id AS assignedTableId,
          created_at_ms AS createdAtMs,
          updated_at_ms AS updatedAtMs,
          released_at_ms AS releasedAtMs,
          arrived_at_ms AS arrivedAtMs,
          no_show_at_ms AS noShowAtMs,
          cancelled_at_ms AS cancelledAtMs,
          revision,
          raw_json AS rawJson
        FROM reservations
      `,
    ),
    assignments: queryRows(
      db,
      `
        SELECT
          reservation_id AS reservationId,
          table_id AS tableId,
          position,
          raw_json AS rawJson
        FROM reservation_table_assignments
      `,
    ),
    locks: queryRows(
      db,
      `
        SELECT
          reservation_id AS reservationId,
          lock_id AS lockId,
          user_id AS userId,
          device_uuid AS deviceUuid,
          expires_at_ms AS expiresAtMs,
          revision,
          raw_json AS rawJson
        FROM reservation_locks
      `,
    ),
    roomChangeRequests: queryRows(
      db,
      `
        SELECT
          request_id AS requestId,
          user_id AS userId,
          session_id AS sessionId,
          device_uuid AS deviceUuid,
          target_room_id AS targetRoomId,
          target_room_name AS targetRoomName,
          status,
          created_at_ms AS createdAtMs,
          expires_at_ms AS expiresAtMs,
          approved_at_ms AS approvedAtMs,
          cancelled_at_ms AS cancelledAtMs,
          revision,
          raw_json AS rawJson
        FROM room_change_requests
      `,
    ),
    tableRoomMoveRequests: queryRows(
      db,
      `
        SELECT
          request_id AS requestId,
          requester_user_id AS requesterUserId,
          requester_username AS requesterUsername,
          requester_full_name AS requesterFullName,
          requester_device_uuid AS requesterDeviceUuid,
          from_room_id AS fromRoomId,
          from_room_name AS fromRoomName,
          target_room_id AS targetRoomId,
          target_room_name AS targetRoomName,
          from_table_id AS fromTableId,
          from_table_label AS fromTableLabel,
          target_table_ids_json AS targetTableIdsJson,
          target_table_labels_json AS targetTableLabelsJson,
          source_leaf_count AS sourceLeafCount,
          target_table_count AS targetTableCount,
          adjust_covers_delta AS adjustCoversDelta,
          status,
          created_at_ms AS createdAtMs,
          expires_at_ms AS expiresAtMs,
          approved_at_ms AS approvedAtMs,
          rejected_at_ms AS rejectedAtMs,
          resolved_by_user_id AS resolvedByUserId,
          resolved_by_username AS resolvedByUsername,
          revision,
          raw_json AS rawJson
        FROM table_room_move_requests
      `,
    ),
  };
}

const RELATIONAL_DOMAIN_TABLES = {
  auditEvents: ["audit_events"],
  users: [
    "users",
    "user_permissions",
    "user_enabled_rooms",
    "user_authorized_rooms",
    "user_payment_methods",
  ],
  sessions: ["sessions"],
  saleSessions: ["sale_sessions", "solar_closures"],
  payments: [
    "payment_containers",
    "payment_parts",
    "payment_transactions",
    "fiscal_receipts",
  ],
  menuSettings: [
    "menu_categories",
    "menu_items",
    "menu_item_variants",
    "payment_methods",
    "pos_rooms",
    "pos_tables",
  ],
  orders: ["orders", "order_lines", "order_line_variants", "order_events"],
  tablesBills: ["table_states", "table_bills", "table_locks"],
  reservations: [
    "reservation_state_versions",
    "reservations",
    "reservation_table_assignments",
    "reservation_locks",
    "room_change_requests",
    "table_room_move_requests",
  ],
};

function buildRelationalDomainRows(db, domain) {
  switch (domain) {
    case "auditEvents":
      return buildRelationalAuditEventsRows(db);
    case "users":
      return buildRelationalUsersRows(db);
    case "sessions":
      return buildRelationalSessionsRows(db);
    case "saleSessions":
      return buildRelationalSaleSessionsRows(db);
    case "payments":
      return buildRelationalPaymentsRows(db);
    case "menuSettings":
      return buildRelationalMenuSettingsRows(db);
    case "orders":
      return buildRelationalOrdersRows(db);
    case "tablesBills":
      return buildRelationalTablesBillsRows(db);
    case "reservations":
      return buildRelationalReservationsRows(db);
    default:
      return null;
  }
}

function buildChecksumResult(domain, rows) {
  const canonicalRows = normalizeValue(rows);
  return {
    domain,
    implemented: true,
    rowCount: countDomainRows(canonicalRows),
    checksum: checksumFor(canonicalRows),
    rows: canonicalRows,
  };
}

export function computeAppStateDomainChecksum(appState, domain) {
  const rows = buildAppStateDomainRows(appState, domain);
  if (!rows) {
    return {
      domain,
      implemented: false,
      skipped: true,
      reason: `Dominio relazionale non implementato per equivalenza: ${domain}`,
    };
  }
  return buildChecksumResult(domain, rows);
}

export function computeRelationalDomainChecksum(db, domain) {
  const requiredTables = RELATIONAL_DOMAIN_TABLES[domain];
  if (!requiredTables) {
    return {
      domain,
      implemented: false,
      skipped: true,
      reason: `Dominio relazionale non implementato per equivalenza: ${domain}`,
    };
  }
  const missing = missingTables(db, requiredTables);
  if (missing.length > 0) {
    return {
      domain,
      implemented: false,
      skipped: true,
      reason: `Dominio ${domain} non disponibile nel DB relazionale, tabelle mancanti: ${missing.join(", ")}`,
    };
  }
  const rows = buildRelationalDomainRows(db, domain);
  return buildChecksumResult(domain, rows);
}

export function compareDomain(appState, relationalDb, domain) {
  const appStateChecksum = computeAppStateDomainChecksum(appState, domain);
  const relationalChecksum = computeRelationalDomainChecksum(
    relationalDb,
    domain,
  );
  if (appStateChecksum.skipped) return appStateChecksum;
  if (relationalChecksum.skipped) return relationalChecksum;
  return {
    domain,
    implemented: true,
    skipped: false,
    appState: appStateChecksum,
    relational: relationalChecksum,
    matches:
      appStateChecksum.rowCount === relationalChecksum.rowCount &&
      appStateChecksum.checksum === relationalChecksum.checksum,
  };
}
