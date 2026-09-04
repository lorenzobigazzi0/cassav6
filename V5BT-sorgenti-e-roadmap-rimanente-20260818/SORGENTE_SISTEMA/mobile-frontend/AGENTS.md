# Codex Operating Rules

Before every future change in this repository, Codex must read:

- `AGENTS.md`
- `docs/mobile-frontend-v2/CODEX_HANDOFF.md`
- `docs/mobile-frontend-v2/ARCHITECTURE.md`
- `docs/mobile-frontend-v2/CODING_STANDARD.md`
- `docs/mobile-frontend-v2/VISUAL_PARITY.md`
- `docs/mobile-frontend-v2/BRIDGE_RETIREMENT_PLAN.md`
- `docs/mobile-frontend-v2/QUALITY_GATES.md`

Mandatory rules:

- Maintain visual parity with the original mobile frontend.
- Original legacy assets are allowed when they preserve visual parity.
- Legacy bridges are allowed only as documented transitional debt.
- Every bridge must have a target replacement feature or module.
- Do not add new legacy bridges.
- Do not add new `window.fetch` or `window.EventSource` patches.
- Do not add new `MutationObserver` usage for business logic.
- Do not add direct `localStorage` or `sessionStorage` usage outside storage adapters.
- Do not add direct endpoint strings inside React components or features.
- Important changes must update `docs/mobile-frontend-v2/CODEX_HANDOFF.md`.
- Do not implement new features during architecture stabilization prompts.
