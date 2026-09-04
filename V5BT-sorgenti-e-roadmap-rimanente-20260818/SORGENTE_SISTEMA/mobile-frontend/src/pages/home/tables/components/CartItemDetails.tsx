import { GlassDropdown } from "./GlassDropdown";
import type { SupplementType } from "./menuSupplementPricing";
import type { MenuProduct } from "../../../../api/menu";

type DraftLike = {
  id: string;
  variantId: string;
  note: string;
  supplement: SupplementType;
  customName?: string;
  customPrice?: number;
};

type DropdownOption = { value: string; label: string };

/**
 * Blocco espanso di una riga carrello: nome e prezzo per gli articoli liberi,
 * variante, supplemento e nota per quelli a catalogo.
 *
 * Generico sul tipo della riga perche' il modello del draft vive nel
 * compositore, che resta il proprietario dello stato.
 */
export function CartItemDetails<TItem extends DraftLike>({
  item,
  product,
  isCustom,
  variantOptions,
  supplementOptions,
  interactionBusy,
  updateDraft,
  requestVariantChange,
  requestItemEdit,
}: {
  item: TItem;
  product: MenuProduct | null;
  isCustom: boolean;
  variantOptions: DropdownOption[];
  supplementOptions: DropdownOption[];
  interactionBusy: boolean;
  updateDraft: (itemId: string, patch: Partial<TItem>) => void;
  requestVariantChange: (item: TItem, nextVariantId: string) => void;
  requestItemEdit: (
    item: TItem,
    patch: { variantId?: string; supplement?: SupplementType },
    reason: "variant" | "supplement"
  ) => void;
}) {
  return (
                      <div
                        className="table-order-item-details"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {isCustom && (
                          <label>
                            Nome articolo
                            <input
                              type="text"
                              value={item.customName ?? ""}
                              maxLength={48}
                              onChange={(event) =>
                                updateDraft(item.id, { customName: event.target.value } as Partial<TItem>)
                              }
                              placeholder="Es. Aperitivo special"
                            />
                          </label>
                        )}
                        <div className="table-order-item-row">
                          {isCustom ? (
                            <label>
                              Prezzo
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={Number.isFinite(item.customPrice) ? item.customPrice : ""}
                                onChange={(event) =>
                                  updateDraft(item.id, {
                                    customPrice: Math.max(0, Number(event.target.value) || 0),
                                  } as Partial<TItem>)
                                }
                              />
                            </label>
                          ) : (
                            <label>
                              Variante
                              <GlassDropdown
                                value={item.variantId}
                                options={variantOptions}
                                ariaLabel={`Variante ${product?.name ?? ""}`}
                                disabled={interactionBusy}
                                closeOnSelect={false}
                                onChange={(nextValue) => requestVariantChange(item, nextValue)}
                              />
                            </label>
                          )}
                          <label className="table-order-supplement-field">
                            Supplemento
                            <GlassDropdown
                              className="table-order-supplement-dropdown"
                              value={item.supplement}
                              options={supplementOptions}
                              ariaLabel={`Supplemento ${product?.name ?? item.customName ?? ""}`.trim()}
                              disabled={interactionBusy}
                              onChange={(nextValue) =>
                                requestItemEdit(
                                  item,
                                  { supplement: nextValue as SupplementType },
                                  "supplement"
                                )
                              }
                            />
                          </label>
                        </div>
                        <label>
                          Nota riga
                          <input
                            type="text"
                            value={item.note}
                            maxLength={120}
                            onChange={(event) =>
                              updateDraft(item.id, { note: event.target.value } as Partial<TItem>)
                            }
                            placeholder="Es. senza ghiaccio"
                          />
                        </label>
                      </div>
  );
}
