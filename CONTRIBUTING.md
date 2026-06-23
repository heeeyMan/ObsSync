# Contributing to Git Vault Sync

Thanks for helping improve Git Vault Sync — a one-click Git sync plugin for
Obsidian (desktop **and** mobile) built on
[isomorphic-git](https://isomorphic-git.org), with a GitHub-API sync engine for
large repos on mobile and EN/RU localization.

## Building

```bash
npm install
npm run build    # tsc --noEmit + esbuild → main.js (this is also the CI-style check)
npm run dev      # esbuild watch; rebuilds main.js on save
```

`npm run build` must be clean (no TypeScript errors, esbuild succeeds) before
any PR is mergeable.

## Project layout

The whole vault is the working tree; the repo lives in `<vault>/.git`. Because
the plugin runs on mobile, **all** Git operations go through isomorphic-git (or
the GitHub Git Data API) over Obsidian's own filesystem and HTTP — never system
`git` or `child_process`.

`src/` modules, briefly:

- `main.ts` — plugin entry: ribbon, commands, status bar, auto-sync, picks the
  sync engine and orchestrates `sync()`.
- `settings.ts` — settings type, defaults, and the settings tab UI.
- `git.ts` — `GitManager`: all isomorphic-git logic (the **git engine**).
- `git-fs.ts` / `git-http.ts` — Obsidian fs/HTTP adapters for isomorphic-git.
- `github-sync.ts` — the **API sync engine** (default on mobile) over the GitHub
  Git Data API.
- `github-api.ts` — GitHub REST for the settings "Authorize" flow.
- `conflict-modal.ts` / `api-conflict-modal.ts` / `review-modal.ts` — the modals.
- `i18n.ts` — `t(key, vars?)` + the EN/RU string table.

The two sync engines (git via isomorphic-git, and the GitHub Git Data API engine
used on mobile) share the conflict/exclude logic. **Before changing `git.ts` or
`github-sync.ts`,** watch for the non-obvious gotchas: HTTP must go through
Obsidian's `requestUrl` (a plain `fetch` is CORS-blocked); `statusMatrix` relies
on file mtime; `git.merge` rewrites the working tree even on conflict; and source
must contain no NUL bytes.

## Conventions

- **Localization:** every user-facing string goes through `t()` with both an
  `en` and a `ru` entry in `src/i18n.ts`. No hardcoded UI strings.
- **Security:** the Personal Access Token lives in `data.json` (plaintext,
  gitignored). Never let it enter a commit; both engines always exclude the
  plugin's own `data.json`.
- **Mobile-safe:** no system `git`, no `child_process`, no plain `fetch`
  (CORS-blocked inside Obsidian — HTTP must go through `requestUrl`).

## Testing

There is no test runner for the live Obsidian layers. Git semantics are
validated with **throwaway Node scripts** against `node:fs`: create a temp repo,
exercise merge/commit/staging (or, for the API engine, the exclusion predicate),
and assert on the resulting trees/paths. This is the fastest way to verify a
change to `git.ts` / `github-sync.ts` without launching Obsidian.

```bash
npm test    # runs scripts/regression.mjs
```

The Obsidian-only layers (`GitFs`, the `requestUrl` HTTP client, the modals)
must be tested live in a vault.

### Dev install (live testing)

Symlink the project into a vault's plugin folder, then reload the plugin
(toggle it off/on in Obsidian settings) after each rebuild to load the new
`main.js`:

```bash
ln -s "$(pwd)" /path/to/Vault/.obsidian/plugins/git-vault-sync
```

## Pull requests

Every PR must:

1. **Build clean** — `npm run build` passes (tsc + esbuild).
2. **Be reviewed** — a correctness review of the diff; for changes to git
   semantics (`git.ts` / `github-sync.ts`), include or run a throwaway Node
   script that proves the new behavior.

Keep version bumps (`manifest.json`, `versions.json`, `package.json`) out of
feature PRs — releases are tagged separately and built/attested by
`.github/workflows/release.yml`.
