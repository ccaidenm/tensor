# AGENTS.md

**Guidance for AI coding agents working on Tensor**

## Project

Tensor: a desktop word processor (Tauri 2 + React + TypeScript + Vite), shadcn/ui components, TipTap/ProseMirror editor, custom pagination engine. Local-first. No cloud, no accounts. AGPLv3.0 licensed.

Monorepo layout:

- `src/` — frontend (editor, UI shell); app logic lives in `src/lib/**`, partitioned by domain
- `src-tauri/` — Tauri shell: Rust side, config, permissions
- `packages/engine/` — pagination & layout engine. **Read `packages/engine/ARCHITECTURE.md` before touching engine code.**
- `locales/` — i18n; `en.json` is the source of truth
- `docs/` — user + contributor docs (Diátaxis-informed, feature-page spine)

## Commands

- `npm run tauri dev` — full desktop app with hot reload (the normal loop)
- `npm run dev` — frontend only in a browser; Tauri APIs unavailable there
- `npm run build` — `tsc` + vite build (predev regenerates the licenses manifest)
- `npm run tauri build` — production build + installers
- `npm test` — Vitest · `npm run lint` — ESLint over `src/`

## Hard rules

1. **Never edit:** `src/generated/licenses.json` (generated), any lockfile, anything under `dist/` or build output.
2. **Verify, don't invent.** Before documenting a command, shortcut, setting, or UI label, read the source that defines it. If unverifiable, insert
3. **Tauri plugin twins travel together:** bumping an npm `@tauri-apps/plugin-*` requires the matching `src-tauri` cargo crate bump in the same change.
4. **Dependencies require discussion first** (per CONTRIBUTING). No new deps in drive-by changes.
5. **shadcn/ui: extend, don't fork.** Variants and tokens over rewritten primitives.
6. **Accessibility is a feature.** New UI must be keyboard-reachable and screen-reader labeled; a11y behavior follows the model in `docs/concepts/accessibility.md`.
7. **Never push.** Unless explicitly instructed by the user, never push git commits to any branches. Committing code must be undoable by the user.

## Commits

Conventional format `type(scope): description` — full rules in [CONTRIBUTING.md](CONTRIBUTING.md#commit-conventions).

## Docs (when editing `docs/`)

- One H1 = filename, sentence case; relative links with `.md`.
- Images in `docs/assets/<page>/`, alt text mandatory.
- Max 2 callouts (`> [!NOTE]` etc.) per page; tables for options.
- Voice: second person, active, contractions fine. Banned: seamlessly, blazing, leverage, utilize, simply, intuitive, easy to use.

## When you find a bug

Report it in your session summary. Do not fix unrelated issues inside an unrelated change.
