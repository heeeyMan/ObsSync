# GitSync

One-click Git sync for [Obsidian](https://obsidian.md), with interactive conflict
resolution, on **desktop and mobile**. Push and pull your whole vault to a Git
remote (GitHub via HTTPS token) with a single button — and pick exactly what
goes into each commit.

GitSync is a pure-JavaScript plugin built on
[isomorphic-git](https://isomorphic-git.org), so it needs no system `git` and
works on Android/iOS as well as desktop.

## Features

- **One-click sync** — stage all changes → commit → fetch → merge → push.
- **Conflict resolution UI** — when a merge conflicts, a dialog lists each file
  and lets you keep the local version, the remote version, or edit the merged
  result by hand.
- **Commit preview / selective sync** — review every change before syncing and
  uncheck files you don't want to commit yet. Deselected edits stay safely on
  disk and out of the commit, even across a merge.
- **Status-bar indicator** — shows pending change count, a spinner while
  syncing, ✓ when clean, and the last-sync time on hover. Click it for a menu.
- **Auto-sync** — optional sync on startup and/or on a timer.
- **Excluded paths** — glob patterns (e.g. `.obsidian/workspace.json`) that are
  never committed or counted.
- **Saved credentials** — remote, branch, and token are stored once.

## Requirements

- A Git repository on GitHub (or any HTTPS Git host).
- A **Personal Access Token** (PAT). For a fine-grained token, grant the repo
  **Contents: Read and write**.

## Installation (manual)

GitSync is not in the community plugin store. To install:

1. Build the plugin (see *Building from source*) or download a release.
2. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/gitsync/`.
3. In Obsidian: **Settings → Community plugins**, enable **GitSync**.

## Configuration

Open **Settings → GitSync** and fill in:

| Setting | Description |
| --- | --- |
| Remote URL | HTTPS clone URL, e.g. `https://github.com/user/vault.git` |
| Branch | Branch to sync (default `main`) |
| Username | Your GitHub username |
| Personal Access Token | Stored in plaintext in this plugin's `data.json` |
| Author name / email | Written into commits |
| Commit message | Template; `{{date}}` is replaced with a timestamp |

Run **GitSync: Test connection to remote** from the command palette to verify
the URL and token.

> ⚠️ **Security:** the token is stored in plaintext in
> `.obsidian/plugins/gitsync/data.json`. If your vault itself is a Git repo,
> make sure that file is `.gitignore`d so the token is never committed.

## Usage

- **Sync** — click the circular-arrows ribbon icon, the status bar (→ *Sync
  now*), or run *Sync vault with Git*.
- **Review & sync** — click the checklist ribbon icon (or *Review changes &
  sync*) to open the commit preview, uncheck files, then **Sync selected**.
- **Resolve conflicts** — if a merge conflicts, the resolution dialog opens
  automatically. Choose per file: *Use local*, *Use remote*, or *Edit
  manually*, then **Resolve & sync**. **Cancel** aborts the merge cleanly.
- **Initialize / link a repo** — on a fresh vault, **Settings → GitSync →
  Initialize** runs `git init`, links the remote, fetches, and checks out the
  remote branch.

## Building from source

```bash
npm install
npm run dev     # watch + rebuild
npm run build   # type-check + production bundle → main.js
```

For development, symlink the project into a test vault so rebuilds are picked up:

```bash
ln -s "$(pwd)" /path/to/Vault/.obsidian/plugins/gitsync
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the module map, sync flow, and implementation
notes (the isomorphic-git filesystem/HTTP adapters, conflict handling, and the
non-obvious gotchas).

## License

MIT
