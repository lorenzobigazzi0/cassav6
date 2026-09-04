import { publicMutationRoute, publicRoute } from "../../core/route-builders.js";

export function buildReservationsRoutes() {
  return [
    publicRoute("POST", "/api/public/reservations/list", "pos.publicReservationsList", {
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lista prenotazioni per frontend inserimento senza login.",
      maxBodySize: 8_192,
    }),
    publicRoute("POST", "/api/public/reservations/availability", "pos.publicReservationsAvailability", {
      mutation: false,
      readOnly: true,
      readOnlyReason: "Disponibilita tavoli per frontend inserimento senza login.",
      maxBodySize: 16_384,
    }),
    publicMutationRoute("POST", "/api/public/reservations/create", "pos.publicReservationsCreate", {
      maxBodySize: 16_384,
      publicReason: "Inserimento prenotazioni da frontend dedicato senza login operativo.",
    }),
    {
      method: "POST",
      path: "/api/pos/reservations/list",
      handlerKey: "pos.reservationsList",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lista prenotazioni autenticata: non deve creare stato ne' ripulire lock durante il refresh.",
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/pos/reservations/create",
      handlerKey: "pos.reservationsCreate",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/lock/acquire",
      handlerKey: "pos.reservationsLockAcquire",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/lock/release",
      handlerKey: "pos.reservationsLockRelease",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/update",
      handlerKey: "pos.reservationsUpdate",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/status",
      handlerKey: "pos.reservationsStatus",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/delete",
      handlerKey: "pos.reservationsDelete",
      mutation: true,
      authRequired: true,
      permission: "manage_reservations",
    },
    {
      method: "POST",
      path: "/api/pos/reservations/availability",
      handlerKey: "pos.reservationsAvailability",
      mutation: true,
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/pos/reservations/lock/state",
      handlerKey: "pos.reservationsLockState",
      mutation: true,
      authRequired: true,
    },
  ];
}
