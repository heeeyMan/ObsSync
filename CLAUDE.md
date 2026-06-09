# CLAUDE.md

Guidance for working on **Git Vault Sync**, a one-click Git sync plugin for Obsidian
with conflict resolution. Works on desktop **and mobile**.

## Big picture

The whole vault is the working tree; the repo lives in `<vault>/.git`. Because
the plugin must run on mobile (no system `git`, no `child_process`), all Git
operations go through **[isomorphic-git](https://isomorphic-git.org)** (pure JS),
driven over Obsidian's own filesystem and HTTP so it works identically on
desktop and mobile.

Auth is **HTTPS + Personal Access Token** (GitHub-first). Credentials live in
the plugin's `data.json` (plaintext — see *Security*).

## Module map (`src/`)

| File | Responsibility |
| --- | --- |
| `main.ts` | Plugin entry: ribbon icons, commands, status bar (+ menu), auto-sync timer, orchestrates `sync()` and opens the modals. |
| `settings.ts` | `GitSyncSettings`, defaults, and the settings tab UI. |
| `git.ts` | `GitManager` — all isomorphic-git logic: `sync`, `fetchAndMerge`, `pushLoop`, `completeMerge`, `initialize`, `listChanges`, staging, excludes, error mapping. |
| `git-fs.ts` | `GitFs` — adapts Obsidian's `vault.adapter` to the `fs` interface isomorphic-git expects (binary/text, `stat`, path normalization). |
| `git-http.ts` | `obsidianHttpClient` — HTTP client for isomorphic-git built on Obsidian's `requestUrl` (bypasses CORS). |
| `github-sync.ts` | **The API sync engine** (default on mobile): `apiSync`/`commitResolutions` over the GitHub **Git Data API** (`requestUrl`). Per-blob pull + push (blobs→tree→commit→ref), SHA-baseline change detection — avoids isomorphic-git's whole-packfile OOM on large repos. Also `getBranchHead`/`getTree`/`getBlob`/`gitBlobSha`/`parseGitHubRepo`. |
| `github-api.ts` | `fetchGitHubUser`/`fetchGitHubRepos` — GitHub REST for the settings "Authorize" flow (autofills user/author, populates the repo picker). |
| `conflict-modal.ts` | `ConflictModal` — git-engine per-file conflict resolution (local / remote / manual edit), then `completeMerge`. |
| `api-conflict-modal.ts` | `ApiConflictModal` — content-based conflict resolution for the API engine (local / remote / manual; binary- and delete-aware); resolutions applied via `commitResolutions`. |
| `review-modal.ts` | `ReviewModal` — commit preview with checkboxes; runs a selective `sync(only)` (git engine only). |
| `i18n.ts` | `t(key, vars?)` + `setLanguage(pref)` — EN/RU string table. Language follows the "Language" setting (`auto` → `getLanguage()`). All user-facing strings go through `t()`. |

## Two sync engines (`main.ts` `effectiveEngine()`)

`sync()` branches on the `syncEngine` setting (`auto` | `git` | `api`); `auto`
= **API on `Platform.isMobile`, git (isomorphic-git) on desktop**.

- **API engine** (`github-sync.ts` `apiSync`): detect changes vs the persisted
  `apiBaseline` (per-path git-blob SHAs) on both sides, pull changed remote
  blobs one at a time, push local changes as one commit (blobs→tree→commit→
  `updateRef`). Clashes → `ApiConflictModal` → `commitResolutions`. Under the
  API engine the status bar shows no git change-count, and Review/selective +
  Initialize are git-only. The plugin's own `data.json` is always excluded
  (via `setAlwaysExclude` on the git side and the API `excluded` predicate).
- **Git engine** (`GitManager.sync`):

1. **Stage** changes (`stageAll`) — `statusMatrix` → `git.add`/`git.remove`,
   skipping excluded globs. `sync(only)` restricts staging to selected paths.
2. **Commit** if anything was staged.
3. **`fetchAndMerge`** — fetch the branch, then `git.merge({abortOnConflict:false})`.
   On conflict it throws `MergeConflict` (carrying both commit OIDs, the branch,
   deselected `skipPaths`, and a working-tree `snapshot`); otherwise it
   `checkout`s the merged tree.
4. **`pushLoop`** — push; on a non-fast-forward rejection (`PushRejected`),
   re-`fetchAndMerge` once and retry.
5. Conflict path: `main.ts` opens `ConflictModal`, which calls
   `completeMerge` to apply resolutions, stage the merged tree, create the
   two-parent merge commit, restore deselected edits, and push.

## Non-obvious gotchas (read before changing)

- **CORS:** a plain `fetch` is blocked inside Obsidian; HTTP must go through
  `requestUrl` (`git-http.ts`). Don't swap in `isomorphic-git/http/web`.
- **`statusMatrix` uses mtime:** it can miss a change whose file mtime didn't
  advance (e.g. a `checkout` immediately followed by a write in the same tick).
  Stage real user edits (which have normal mtimes); don't rely on it right after
  a programmatic checkout. `git.add` reads content directly and is reliable.
- **Merge rewrites the working tree:** `git.merge` (even on conflict) overwrites
  working files with the merged tree. Uncommitted/deselected edits to *tracked*
  files would be clobbered, so `sync(only)` snapshots deselected files before
  the merge and `restoreSnapshot`s them after the merge commit. Keep this intact
  when touching the selective-sync path.
- **isomorphic-git index ≠ merged tree after conflict:** merge writes
  non-conflicting remote changes to the working dir but NOT the index, so
  `completeMerge` must re-`stageAll` from the working tree (it can't just commit
  the index).
- **No NUL bytes / control chars in source.** A stray `\x00` once made `git.ts`
  read as binary, breaking `grep` and exact-match edits. If `file src/*.ts`
  reports `data` instead of text, strip control bytes.
- **`app.setting` is private API** (used in `main.ts` to open the settings tab);
  it's stable but cast through `unknown`.

## Build & test

```bash
npm install
npm run build    # tsc --noEmit + esbuild → main.js (also the CI-style check)
npm run dev      # esbuild watch
```

There is no test runner. Git semantics are validated with throwaway Node
scripts against `node:fs` (create a temp repo, exercise merge/commit/staging,
assert on the resulting trees) — this is the fastest way to verify changes to
`git.ts` without launching Obsidian. The Obsidian-only layers (`GitFs`,
`requestUrl` HTTP, modals) must be tested live in a vault.

Dev install: symlink the project into a vault's `.obsidian/plugins/git-vault-sync/`.
Reload the plugin (toggle off/on) after each rebuild to load the new `main.js`.

## Agent team (`.claude/agents/`)

This repo defines a team of subagents. Route work through them:

- **team-lead** — orchestrator/planner; decomposes a task, delegates to the
  specialists, and gates "done" on a clean build + review. Start here for
  anything spanning more than one area.
- **git-core** — isomorphic-git engine (`git.ts`, `git-fs.ts`, `git-http.ts`).
- **obsidian-ui** — settings/modals/status bar/CSS (`main.ts`, `settings.ts`,
  `conflict-modal.ts`, `review-modal.ts`, `styles.css`).
- **i18n** — EN/RU string table (`i18n.ts`) and `t()` coverage.
- **reviewer-tester** — build, Node-sandbox validation of git semantics,
  security/correctness review. The quality gate before anything ships.

## Security

`data.json` holds the PAT in plaintext and is `.gitignore`d in this repo. If a
synced vault tracks `.obsidian/`, that vault must also `.gitignore` the plugin's
`data.json` (or the whole plugin folder) so the token is never pushed.
