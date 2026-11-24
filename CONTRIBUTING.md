# Contributing to Tensor

> [!IMPORTANT]
> By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md). Report violations to the project maintainers.

Thanks for wanting to help! Tensor is built in public, and bug reports, translations, docs, and code are all equally welcome.

## Ways to Contribute

| I want to… | How |
|---|---|
| Report a bug | [Search existing issues](../../issues) first, then [open one](../../issues/new/choose) with a repro |
| Suggest a feature | Check the [Roadmap](ROADMAP.md) first, then open an issue (see **Big ideas** below) |
| Improve the docs | Docs live in `docs/`; PRs welcome |
| Translate Tensor | Edit `locales/*.json` and open a PR — see [Translating](#translating) |
| Write code | Start with [Development setup](#development-setup) |

### Big ideas

Feature requests are welcome — but if it's a big idea (a new subsystem, format behavior, anything touching the pagination engine), **open a discussion or issue *before* writing code.** It lets us align on the approach while the change is still cheap to steer.

## Development setup

**Prerequisites:**

- [Node.js](https://nodejs.org) 22 or newer
- [Rust](https://rustup.rs) (stable toolchain)
- Tauri's platform dependencies — on Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

```bash
git clone https://github.com/ccaidenm/tensor.git
cd tensor
npm install
npm run tauri dev
```

| Command | What it does |
|---|---|
| `npm run tauri dev` | Full desktop app with hot reload — the normal dev loop |
| `npm run dev` | Frontend only, in a plain browser — Tauri APIs (dialogs, saving) won't work there |
| `npm run build` | Type-check (`tsc`) and bundle the frontend |
| `npm run tauri build` | Production build — compiles the Rust side and packages installers |
| `npm test` | Run the test suite (Vitest) |
| `npm run lint` | ESLint over `src/` |

Notes:

- Dev and build runs regenerate `src/generated/licenses.json` first (bundled fonts and libraries must be attributed) — never hand-edit it.
- The engine package has its own scripts. Run them from the repo root with `npm run <script> -w @tensor-editor/engine`.

## Project structure

```
tensor/
├── src/                 ← frontend: editor, UI shell
├── src-tauri/           ← Tauri shell: Rust side, config, permissions
├── packages/engine/     ← pagination engine — start at ARCHITECTURE.md inside
├── locales/             ← translation files (en.json = source of truth)
├── docs/                ← user + contributor docs
└── scripts/             ← repo tooling (license generation, release helpers)
```

## Versioning

Tensor follows [Semantic Versioning](https://semver.org): breaking changes bump the major, features the minor, fixes the patch. Pre-1.0 history was exempt.

Releases are cut by tag: version numbers are bumped in `package.json`, `packages/engine/package.json`, and `src-tauri/tauri.conf.json`, a `v*` tag is pushed, and CI builds installers for every platform (see the Release workflow). Every release gets a section in [CHANGELOG.md](CHANGELOG.md) (changelog is automatically compiled).

## Pull request process

1. Branch from `main`: `feat/<short-name>` or `fix/<issue-number>`.
2. Rebase onto `main` before opening the PR; no merge commits.
3. Before opening: tests pass, `npm run lint` clean, and **user-facing changes update `docs/` in the same PR** — PRs that change behavior without appropriate documentation updates will be blocked.
4. The PR title follows the commit conventions: it becomes the squash commit message on merge.
5. Checklist:
   - [ ] Commits follow the conventions above
   - [ ] Tests added or updated for the change
   - [ ] User-facing behavior → docs updated
   - [ ] New UI is keyboard-reachable and screen-reader labeled
   - [ ] No new dependencies without prior discussion

## Style guide

- Formatting is enforced by ESLint — run `npm run lint` to verify code.
- **shadcn/ui: extend, don't fork.** Customize with variants and design tokens; don't rewrite primitives.
- **Accessibility is a feature, not a patch.** See [docs/concepts/accessibility.md](docs/concepts/accessibility.md) for the model.

## Translating

Tensor's strings live in `locales/*.json`, with `en.json` as the source of truth. To contribute a translation, copy `en.json` to `<locale>.json`, translate the values (never the keys), and open a PR. Structured Weblate support is planned once we meet Libre requirements — see the [Roadmap](ROADMAP.md).

## License

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License v3.0. Note that AGPL extends copyleft to network use.
