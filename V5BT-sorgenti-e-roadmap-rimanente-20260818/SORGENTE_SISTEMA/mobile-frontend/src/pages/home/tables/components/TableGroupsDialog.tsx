import { useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import type { DiningTable } from "../../../../api/tables";
import type { Room } from "../../../../api/locations";
import { formatRoomMoveAvailability, type RoomMoveAvailability } from "../roomMoveAvailability";
import {
  buildSplitTableGroups,
  buildTablesById,
  canMergeTableGroupNodes,
  flattenTableGroupNodeIds,
  getTableGroupActiveLeaves,
  simpleFreeLogicalTableItems,
  tableGroupByRoot,
  tableGroupCompositionLabel,
  tableGroupDirectNodeKey,
  tableGroupLeafLabels,
  tableGroupLogicalNodeForId,
  tableStatus,
  tableStatusLabel,
  topLogicalTableItems,
  type TableGroup,
  type TableGroupNode,
} from "../../../../api/tableGroups";

export type TableGroupsDialogState =
  | { type: "context"; tableId: string }
  | { type: "merge"; tableId: string }
  | { type: "move"; tableId: string }
  | { type: "roomMoveRoom"; tableId: string }
  | { type: "roomMoveTable"; tableId: string; targetRoomId: string }
  | { type: "split"; tableId: string }
  | { type: "cancel"; tableId: string };

type TableGroupsDialogProps = {
  state: TableGroupsDialogState;
  tables: DiningTable[];
  groups: TableGroup[];
  rooms: Room[];
  currentRoomId: string;
  roomMoveTables: DiningTable[];
  roomMoveGroups: TableGroup[];
  roomMoveAvailability: ReadonlyMap<string, RoomMoveAvailability>;
  roomMoveAvailabilityLoading: boolean;
  roomMoveAvailabilityReady: boolean;
  roomsLoading: boolean;
  roomMoveTablesLoading: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onChangeState: (state: TableGroupsDialogState) => void;
  onMerge: (
    rootId: string,
    selectedIds: string[],
    options?: { requiresActiveConfirmation?: boolean }
  ) => void;
  onSplit: (rootId: string, selectedKeys: Set<string>) => void;
  onMove: (rootId: string, targetIds: string[]) => void;
  onChooseRoomMoveRoom: (rootId: string, room: Room) => void;
  onRoomMove: (rootId: string, targetRoomId: string, targetTableIds: string[]) => void;
  canCancelTable?: boolean;
  onCancelTable?: (rootId: string, reason: string) => void;
};

function nodeTitle(node: TableGroupNode, tablesById: Map<string, DiningTable>) {
  return `Tavolo ${tableGroupCompositionLabel(node, tablesById)}`;
}

function nodeHistory(node: TableGroupNode, tablesById: Map<string, DiningTable>) {
  const labels = tableGroupLeafLabels(node, tablesById);
  return labels.length > 1 ? `Storico: ${labels.join(", ")}` : "";
}

export function TableGroupsDialog({
  state,
  tables,
  groups,
  rooms,
  currentRoomId,
  roomMoveTables,
  roomMoveGroups,
  roomMoveAvailability,
  roomMoveAvailabilityLoading,
  roomMoveAvailabilityReady,
  roomsLoading,
  roomMoveTablesLoading,
  busy,
  error,
  onClose,
  onChangeState,
  onMerge,
  onSplit,
  onMove,
  onChooseRoomMoveRoom,
  onRoomMove,
  canCancelTable = false,
  onCancelTable,
}: TableGroupsDialogProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedSplitKeys, setSelectedSplitKeys] = useState<Set<string>>(() => new Set());
  const [cancelReason, setCancelReason] = useState("");
  const tablesById = useMemo(() => buildTablesById(tables), [tables]);
  const items = useMemo(() => topLogicalTableItems(tables, groups), [groups, tables]);
  const rootTable = tablesById.get(state.tableId) ?? null;
  const rootGroup = tableGroupByRoot(groups, state.tableId);
  const rootNode = tableGroupLogicalNodeForId(groups, state.tableId);
  const rootLeafTables = flattenTableGroupNodeIds(rootNode)
    .map((id) => tablesById.get(id))
    .filter((table): table is DiningTable => Boolean(table));
  const rootContextTables =
    rootLeafTables.length > 0 ? rootLeafTables : rootTable ? [rootTable] : [];
  const hasRootContextActivity = rootContextTables.some((table) => tableStatus(table) !== "libero");
  const hasRootContextReservation = rootContextTables.some(
    (table) => Boolean(table.reservationAt) || Boolean(table.reservationPreview)
  );
  const canShowCancelTable =
    canCancelTable && (hasRootContextActivity || hasRootContextReservation);
  const rootLabel = rootGroup
    ? tableGroupCompositionLabel(rootGroup, tablesById)
    : String(rootTable?.number ?? "");

  const selectedNodes = selectedIds.map((id) => tableGroupLogicalNodeForId(groups, id));
  const rootActiveCount = getTableGroupActiveLeaves(rootNode, tablesById).length;
  const selectedActiveCount = selectedNodes.reduce(
    (sum, node) => sum + getTableGroupActiveLeaves(node, tablesById).length,
    0
  );
  const sourceLeafCount = Math.max(1, flattenTableGroupNodeIds(rootNode).length);
  const requiredMoveTargetCount = Math.max(1, rootActiveCount);
  const mergeIsStrictlyCompatible = canMergeTableGroupNodes(
    [rootNode, ...selectedNodes],
    tablesById
  );
  const requiresActiveMergeConfirmation = rootActiveCount + selectedActiveCount > 1;
  const canConfirmMerge =
    selectedIds.length > 0 && (mergeIsStrictlyCompatible || requiresActiveMergeConfirmation);
  const moveItems = useMemo(() => {
    return simpleFreeLogicalTableItems(tables, groups, state.tableId);
  }, [groups, state.tableId, tables]);
  const selectedMoveIds = selectedIds.slice(0, sourceLeafCount);
  const canSelectMoreMoveTargets = selectedMoveIds.length < sourceLeafCount;
  const roomMoveRooms = useMemo(
    () => rooms.filter((room) => String(room.id ?? "").trim() !== currentRoomId),
    [currentRoomId, rooms]
  );
  const roomMoveTargetRoom =
    state.type === "roomMoveTable"
      ? (rooms.find((room) => String(room.id ?? "").trim() === state.targetRoomId) ?? null)
      : null;
  const roomMoveItems = useMemo(
    () => simpleFreeLogicalTableItems(roomMoveTables, roomMoveGroups, ""),
    [roomMoveGroups, roomMoveTables]
  );
  const selectedRoomMoveIds = selectedIds.slice(0, sourceLeafCount);
  const canSelectMoreRoomMoveTargets = selectedRoomMoveIds.length < sourceLeafCount;

  const toggleSelectedId = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const toggleMoveTarget = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      if (!canSelectMoreMoveTargets) return current;
      return [...current, id].slice(0, sourceLeafCount);
    });
  };

  const toggleRoomMoveTarget = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      if (!canSelectMoreRoomMoveTargets) return current;
      return [...current, id].slice(0, sourceLeafCount);
    });
  };

  const toggleSplitKey = (key: string) => {
    setSelectedSplitKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderError = () => (
    <div className="mobile-table-groups-error" hidden={!error}>
      {error}
    </div>
  );

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (busy || event.target !== event.currentTarget) return;
    onClose();
  };

  const stopDialogClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const stopDialogPointer = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  if (state.type === "context") {
    return (
      <div
        className="mobile-table-groups-backdrop mobile-table-groups-context-backdrop"
        onClick={closeFromBackdrop}
      >
        <div
          className="mobile-table-groups-context"
          role="dialog"
          aria-modal="true"
          aria-label="Azioni tavolo"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-context-head">
            <button
              type="button"
              className="smallbtn mobile-table-groups-context-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            >
              <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                <path d="M6 6l12 12M18 6l-12 12" />
              </svg>
            </button>
            <div className="mobile-table-groups-context-title">Tavolo {rootLabel || "?"}</div>
          </div>
          <button
            type="button"
            className="mobile-table-groups-action"
            onClick={() => {
              setSelectedIds([]);
              onChangeState({ type: "merge", tableId: state.tableId });
            }}
          >
            Unisci
          </button>
          <button
            type="button"
            className="mobile-table-groups-action"
            onClick={() => {
              setSelectedIds([]);
              onChangeState({ type: "move", tableId: state.tableId });
            }}
          >
            Sposta
          </button>
          <button
            type="button"
            className="mobile-table-groups-action"
            onClick={() => {
              setSelectedIds([]);
              onChangeState({ type: "roomMoveRoom", tableId: state.tableId });
            }}
          >
            Cambia sala
          </button>
          {rootGroup && (
            <button
              type="button"
              className="mobile-table-groups-action"
              onClick={() => {
                setSelectedSplitKeys(new Set());
                onChangeState({ type: "split", tableId: state.tableId });
              }}
            >
              Dividi
            </button>
          )}
          {canShowCancelTable && (
            <button
              type="button"
              className="mobile-table-groups-action mobile-table-groups-action-danger"
              onClick={() => {
                setCancelReason("");
                onChangeState({ type: "cancel", tableId: state.tableId });
              }}
            >
              Cancellazione
            </button>
          )}
        </div>
      </div>
    );
  }

  if (state.type === "roomMoveRoom") {
    return (
      <div
        className="mobile-table-groups-backdrop mobile-table-move-backdrop"
        onClick={closeFromBackdrop}
      >
        <div
          className="mobile-table-groups-dialog mobile-table-move-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Cambia sala"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-head">
            <strong>Cambia sala</strong>
            <button
              type="button"
              className="mobile-table-groups-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            />
          </div>
          <div className="mobile-table-groups-list">
            {roomMoveRooms.map((room) => {
              const availability = roomMoveAvailability.get(room.id) ?? {
                freeCount: 0,
                totalCount: 0,
              };
              const isFull = roomMoveAvailabilityReady && availability.freeCount === 0;
              const availabilityLabel = roomMoveAvailabilityReady
                ? formatRoomMoveAvailability(availability)
                : roomMoveAvailabilityLoading
                  ? "Verifica..."
                  : "N/D";

              return (
                <button
                  key={room.id}
                  type="button"
                  className={`mobile-table-groups-row mobile-table-groups-room-row ${
                    isFull ? "is-full" : ""
                  }`}
                  disabled={busy || isFull}
                  onClick={() => {
                    setSelectedIds([]);
                    onChooseRoomMoveRoom(state.tableId, room);
                  }}
                >
                  <span className="mobile-table-groups-row-main">
                    <strong>{room.name}</strong>
                    <span className="mobile-table-groups-row-history">
                      {room.activityName || "Sala disponibile"}
                    </span>
                  </span>
                  <span
                    className={`mobile-table-groups-room-availability ${
                      isFull ? "is-full" : roomMoveAvailabilityReady ? "is-free" : "is-loading"
                    }`}
                  >
                    {availabilityLabel}
                  </span>
                </button>
              );
            })}
            {!roomsLoading && roomMoveRooms.length === 0 && (
              <div className="mobile-table-groups-empty">
                Nessun'altra sala disponibile per questo utente.
              </div>
            )}
          </div>
          {renderError()}
        </div>
      </div>
    );
  }

  if (state.type === "roomMoveTable") {
    return (
      <div
        className="mobile-table-groups-backdrop mobile-table-move-backdrop"
        onClick={closeFromBackdrop}
      >
        <div
          className="mobile-table-groups-dialog mobile-table-move-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Scegli tavolo destinazione"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-head mobile-table-groups-room-head">
            <button
              type="button"
              className="mobile-table-groups-back"
              disabled={busy}
              onClick={() => {
                setSelectedIds([]);
                onChangeState({ type: "roomMoveRoom", tableId: state.tableId });
              }}
              aria-label="Torna alla lista sale"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <strong>{roomMoveTargetRoom?.name || "Altra sala"}</strong>
            <button
              type="button"
              className="mobile-table-groups-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            />
          </div>
          <div className="mobile-table-groups-list">
            {roomMoveItems.map((item) => {
              const checked = selectedRoomMoveIds.includes(item.id);
              const active = tableStatus(item.table);
              const rowDisabled = busy || (!checked && !canSelectMoreRoomMoveTargets);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`mobile-table-groups-row ${checked ? "is-selected" : ""}`}
                  aria-pressed={checked}
                  disabled={rowDisabled}
                  onClick={() => toggleRoomMoveTarget(item.id)}
                >
                  <span className="mobile-table-groups-row-main">
                    <strong>Tavolo {item.label}</strong>
                    <span className="mobile-table-groups-row-history">
                      {sourceLeafCount > 1
                        ? `Destinazione libera ${selectedRoomMoveIds.length}/${sourceLeafCount}`
                        : "Destinazione libera"}
                    </span>
                  </span>
                  <span className="mobile-table-groups-select-mark" aria-hidden="true">
                    {checked ? "\u2713" : ""}
                  </span>
                  <span className="mobile-table-groups-row-state">{tableStatusLabel(active)}</span>
                </button>
              );
            })}
            {!roomMoveTablesLoading && roomMoveItems.length === 0 && (
              <div className="mobile-table-groups-empty">
                Nessun tavolo libero disponibile in questa sala.
              </div>
            )}
          </div>
          {renderError()}
          <div className="mobile-table-groups-actions">
            <button
              type="button"
              className="mobile-table-groups-confirm"
              disabled={selectedRoomMoveIds.length < requiredMoveTargetCount || busy}
              onClick={() => onRoomMove(state.tableId, state.targetRoomId, selectedRoomMoveIds)}
            >
              Sposta
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.type === "cancel") {
    const trimmedReason = cancelReason.trim();
    return (
      <div className="mobile-table-groups-backdrop" onClick={closeFromBackdrop}>
        <div
          className="mobile-table-groups-dialog mobile-table-cancel-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Cancellazione tavolo"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-head">
            <strong>Cancellazione tavolo</strong>
            <button
              type="button"
              className="mobile-table-groups-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            />
          </div>
          <div className="mobile-table-groups-cancel-body">
            <div className="mobile-table-groups-empty mobile-table-groups-cancel-warning">
              Verranno cancellati ordini pendenti, comande inviate, pagamenti pendenti e occupazione
              del tavolo {rootLabel || "?"}.
            </div>
            <label className="mobile-table-groups-reason">
              <span>Motivazione obbligatoria</span>
              <textarea
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Scrivi il motivo della cancellazione..."
                maxLength={240}
                disabled={busy}
              />
            </label>
          </div>
          {renderError()}
          <div className="mobile-table-groups-actions mobile-table-groups-actions-split">
            <button
              type="button"
              className="mobile-table-groups-confirm mobile-table-groups-secondary"
              disabled={busy}
              onClick={() => onChangeState({ type: "context", tableId: state.tableId })}
            >
              Annulla
            </button>
            <button
              type="button"
              className="mobile-table-groups-confirm mobile-table-groups-danger"
              disabled={trimmedReason.length < 3 || busy || !onCancelTable}
              onClick={() => onCancelTable?.(state.tableId, trimmedReason)}
            >
              Cancella tavolo
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.type === "move") {
    return (
      <div
        className="mobile-table-groups-backdrop mobile-table-move-backdrop"
        onClick={closeFromBackdrop}
      >
        <div
          className="mobile-table-groups-dialog mobile-table-move-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Sposta tavolo"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-head">
            <strong>Sposta tavolo</strong>
            <button
              type="button"
              className="mobile-table-groups-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            />
          </div>
          <div className="mobile-table-groups-list">
            {moveItems.map((item) => {
              const checked = selectedMoveIds.includes(item.id);
              const active = tableStatus(item.table);
              const rowDisabled = busy || (!checked && !canSelectMoreMoveTargets);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`mobile-table-groups-row ${checked ? "is-selected" : ""}`}
                  aria-pressed={checked}
                  disabled={rowDisabled}
                  onClick={() => toggleMoveTarget(item.id)}
                >
                  <span className="mobile-table-groups-row-main">
                    <strong>Tavolo {item.label}</strong>
                    <span className="mobile-table-groups-row-history">
                      {sourceLeafCount > 1
                        ? `Destinazione libera ${selectedMoveIds.length}/${sourceLeafCount}`
                        : "Destinazione libera"}
                    </span>
                  </span>
                  <span className="mobile-table-groups-select-mark" aria-hidden="true">
                    {checked ? "\u2713" : ""}
                  </span>
                  <span className="mobile-table-groups-row-state">{tableStatusLabel(active)}</span>
                </button>
              );
            })}
            {moveItems.length === 0 && (
              <div className="mobile-table-groups-empty">
                Nessun tavolo libero disponibile in questa sala.
              </div>
            )}
          </div>
          {renderError()}
          <div className="mobile-table-groups-actions">
            <button
              type="button"
              className="mobile-table-groups-confirm"
              disabled={selectedMoveIds.length < requiredMoveTargetCount || busy}
              onClick={() => onMove(state.tableId, selectedMoveIds)}
            >
              Sposta
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.type === "split" && rootGroup) {
    const previewGroups = buildSplitTableGroups(groups, state.tableId, selectedSplitKeys);
    const canConfirmSplit = selectedSplitKeys.size > 0 && previewGroups !== groups;
    return (
      <div className="mobile-table-groups-backdrop" onClick={closeFromBackdrop}>
        <div
          className="mobile-table-groups-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Dividi tavolo"
          onPointerDown={stopDialogPointer}
          onClick={stopDialogClick}
        >
          <div className="mobile-table-groups-head">
            <strong>Dividi tavolo</strong>
            <button
              type="button"
              className="mobile-table-groups-close"
              disabled={busy}
              onClick={onClose}
              aria-label="Chiudi"
            />
          </div>
          <div className="mobile-table-groups-list">
            {rootGroup.children.map((child, index) => {
              const key = tableGroupDirectNodeKey(child, index);
              const checked = selectedSplitKeys.has(key);
              const history = nodeHistory(child, tablesById);
              return (
                <button
                  key={key}
                  type="button"
                  className={`mobile-table-groups-row ${checked ? "is-selected" : ""}`}
                  aria-pressed={checked}
                  onClick={() => toggleSplitKey(key)}
                >
                  <span className="mobile-table-groups-row-main">
                    <strong className="mobile-table-groups-row-title">
                      {nodeTitle(child, tablesById)}
                    </strong>
                    {history && <span className="mobile-table-groups-row-history">{history}</span>}
                  </span>
                  <span className="mobile-table-groups-select-mark" aria-hidden="true">
                    {checked ? "\u2713" : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {renderError()}
          <div className="mobile-table-groups-actions">
            <button
              type="button"
              className="mobile-table-groups-confirm"
              disabled={!canConfirmSplit || busy}
              onClick={() => onSplit(state.tableId, selectedSplitKeys)}
            >
              Dividi
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-table-groups-backdrop" onClick={closeFromBackdrop}>
      <div
        className="mobile-table-groups-dialog mobile-table-move-dialog mobile-table-merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Unisci tavoli"
        onPointerDown={stopDialogPointer}
        onClick={stopDialogClick}
      >
        <div className="mobile-table-groups-head">
          <strong>Unisci tavoli</strong>
          <button
            type="button"
            className="mobile-table-groups-close"
            disabled={busy}
            onClick={onClose}
            aria-label="Chiudi"
          />
        </div>
        <div className="mobile-table-groups-list">
          {items.map((item) => {
            const checked = selectedIds.includes(item.id);
            const isMain = item.id === state.tableId;
            const itemActiveCount = getTableGroupActiveLeaves(item.node, tablesById).length;
            const itemRequiresConfirmation = !isMain && rootActiveCount + itemActiveCount > 1;
            const compatible =
              isMain ||
              canMergeTableGroupNodes([rootNode, item.node], tablesById) ||
              itemRequiresConfirmation;
            const rowDisabled = isMain || !compatible;
            const rowBadge = itemRequiresConfirmation
              ? "CONFERMA"
              : !compatible
                ? "NON DISPONIBILE"
                : "";
            const active = tableStatus(
              flattenTableGroupNodeIds(item.node)
                .map((id) => tablesById.get(id))
                .find((table) => tableStatus(table) !== "libero")
            );
            return (
              <button
                key={item.id}
                type="button"
                className={`mobile-table-groups-row ${isMain ? "is-main" : ""} ${
                  checked ? "is-selected" : ""
                }`}
                aria-pressed={checked}
                disabled={rowDisabled}
                onClick={() => toggleSelectedId(item.id)}
              >
                <span className="mobile-table-groups-row-main">
                  <span className="mobile-table-groups-row-title-line">
                    <strong>Tavolo {item.label}</strong>
                    {rowBadge && (
                      <span
                        className={`mobile-table-groups-row-note mobile-table-groups-row-note-badge ${
                          rowDisabled ? "is-incompatible" : "is-warning"
                        }`}
                      >
                        {rowBadge}
                      </span>
                    )}
                  </span>
                  {isMain && <em>Tavolo principale</em>}
                </span>
                <span className="mobile-table-groups-select-mark" aria-hidden="true">
                  {checked ? "\u2713" : ""}
                </span>
                <span className="mobile-table-groups-row-state">{tableStatusLabel(active)}</span>
              </button>
            );
          })}
        </div>
        {renderError()}
        <div className="mobile-table-groups-actions">
          <button
            type="button"
            className="mobile-table-groups-confirm"
            disabled={!canConfirmMerge || busy}
            onClick={() =>
              onMerge(state.tableId, selectedIds, {
                requiresActiveConfirmation: requiresActiveMergeConfirmation,
              })
            }
          >
            Unisci
          </button>
        </div>
      </div>
    </div>
  );
}
