# Quality Gates

## Required Scripts

The repository must expose:

- `npm run typecheck`
- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run test`
- `npm run test:static`
- `npm run test:e2e`
- `npm run build`

`lint` must run ESLint. It must not be an alias for TypeScript typechecking.

## Static Architecture Gate

`tests/static/architectureRules.test.ts` scans source files for prohibited patterns and legacy debt budgets.

Tracked patterns:

- `window.fetch =`
- `window.EventSource =`
- `MutationObserver`
- `querySelector`
- `localStorage.`
- `sessionStorage.`
- `window.__`
- `!important`
- `"/api/"` and `'/api/'` inside React components

Current debt is allowed only through explicit legacy whitelists and budgets. New files should not introduce these patterns.
The current budget for direct `localStorage.` and `sessionStorage.` usage is zero; storage access
must go through `src/shared/storage`.

## E2E Gate

Playwright is installed as the e2e runner. Until real e2e smoke tests are added, `test:e2e` may run with no tests and should be treated as an installed gate, not complete coverage.

## Install Notes

If dependency installation or command execution is blocked by the environment, update `CODEX_HANDOFF.md` with the exact command and failure.
