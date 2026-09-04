# Coding Standard

## Direction

Favor small, explicit modules that match the target architecture. Do not copy legacy browser scripts into source as a permanent solution.

## Required Practices

- Keep visual parity changes scoped and measurable.
- Put API calls in API/domain modules, not React components.
- Put persistence behind storage adapters.
- Use TanStack Query for server-state caching by domain.
- Use runtime config for environment-dependent URLs and feature flags.
- Keep feature composition in pages.
- Keep CSS overrides documented and shrink them over time.
- Update `CODEX_HANDOFF.md` after meaningful architecture or runtime changes.

## Prohibited New Patterns

- new `window.fetch = ...` patches;
- new `window.EventSource = ...` patches;
- new bridge installation files;
- new `MutationObserver` business logic;
- new direct `querySelector` business flows;
- new direct `localStorage` or `sessionStorage` usage outside adapters;
- new endpoint strings in React components;
- new global CSS override debt unless explicitly documented.

## Legacy Exceptions

Historical bridge debt and CSS debt are tracked in `BRIDGE_RETIREMENT_PLAN.md`. Existing exceptions are transitional, not precedent for new code.
