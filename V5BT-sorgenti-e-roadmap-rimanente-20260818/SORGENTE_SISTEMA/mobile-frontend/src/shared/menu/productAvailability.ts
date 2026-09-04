import type { MenuProduct } from "../../api/menuTypes";

/**
 * Stato di disponibilita' mostrato nel menu.
 *
 * - `available`: ordinabile ovunque.
 * - `low`: esaurito su una o piu' postazioni ma ancora ordinabile altrove.
 *   E' la vecchia "indisponibilita' da postazione", che nella pratica indica
 *   scorte finite su quella postazione, non un prodotto disattivato.
 * - `out`: esaurito ovunque, non ordinabile.
 *
 * Un prodotto disattivato in anagrafica (`enabled: false`) non e' uno stato di
 * disponibilita': non deve comparire affatto nel menu. Il backend lo esclude
 * gia' dal catalogo, `isMenuProductActive` e' la rete di sicurezza lato client.
 */
export type MenuAvailabilityState = "available" | "low" | "out";

export const MENU_AVAILABILITY_LABEL: Record<MenuAvailabilityState, string> = {
  available: "Disponibile",
  low: "Quasi esaurito",
  out: "Esaurito",
};

export const MENU_AVAILABILITY_ORDER: MenuAvailabilityState[] = ["available", "low", "out"];

export function resolveMenuAvailabilityState(product: MenuProduct): MenuAvailabilityState {
  const stations = product.unavailableStations ?? [];
  // Lo scope va letto prima di `available`: un prodotto finito su una
  // postazione arriva con available=false quando la richiesta e' fatta da
  // quella postazione, ma resta ordinabile altrove.
  if (product.availabilityScope === "station" && stations.length > 0) return "low";
  if (product.available === false || product.availabilityScope === "global") return "out";
  return "available";
}

export function isMenuProductActive(product: MenuProduct): boolean {
  const flags = product as MenuProduct & { enabled?: unknown; active?: unknown; status?: unknown };
  if (flags.enabled === false || flags.active === false) return false;
  return String(flags.status ?? "").trim().toLowerCase() !== "disabled";
}

export function menuAvailabilityStationsLabel(product: MenuProduct): string {
  const stations = product.unavailableStations ?? [];
  if (stations.length === 0) return "";
  return `Esaurito su: ${stations.join(", ")}`;
}

/** Conteggio dei prodotti per stato, per i chip del pannello filtri. */
export function buildAvailabilityOptions(products: readonly MenuProduct[]) {
  const counters = new Map<MenuAvailabilityState, number>(
    MENU_AVAILABILITY_ORDER.map((state) => [state, 0])
  );
  products.forEach((product) => {
    const state = resolveMenuAvailabilityState(product);
    counters.set(state, (counters.get(state) ?? 0) + 1);
  });
  return MENU_AVAILABILITY_ORDER.map((state) => ({
    id: state,
    name: MENU_AVAILABILITY_LABEL[state],
    count: counters.get(state) ?? 0,
  }));
}
