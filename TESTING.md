# Testing GitSync

Testing is two-layered. **Git semantics** (merge / commit / staging / selective
restore / path normalization) run offline against the real isomorphic-git. The
**Obsidian layers** (`GitFs`, the `requestUrl` HTTP client, modals, status bar,
auto-sync timer) have no test runner — they must be exercised live in a vault,
including at least one **mobile** device, because that is where the plugin's
hardest constraints live (memory, frozen background timers, NFD filenames,
flaky networks).

## 1. Offline regression suite

```bash
npm test          # node scripts/regression.mjs
```

Spins up throwaway temp repos and asserts the Git guarantees the plugin depends
on: two-parent merges with no loss of non-conflicting changes, conflict markers,
the selective-sync snapshot/restore (C2), NFC path collapsing (H4), and
branch-name validation (M6). Exit code is non-zero on failure, so it works in CI.

This is the fast inner loop when changing `git.ts` — extend `scripts/regression.mjs`
with a new scenario before reaching for a live vault. It does **not** test the
Obsidian-coupled code; for that, see below.

## 2. Build + install in a test vault (desktop)

```bash
npm run build     # tsc + esbuild → main.js
```

Symlink the project into a vault's plugin folder (folder name must match the
manifest `id`, `gitsync`):

```bash
ln -s "$(pwd)" "/path/to/TestVault/.obsidian/plugins/gitsync"
```

Then in Obsidian: Settings → Community plugins → enable **GitSync**. After every
`npm run build`, toggle the plugin off/on to load the new `main.js` (or use
`npm run dev` for a watch build, still toggling to reload).

> Use a throwaway vault and a throwaway GitHub repo + token. Never test against
> notes or a repo you care about.

## 3. Install on a mobile device

Obsidian mobile can't symlink, so copy the three build artifacts into the
vault's plugin folder. The vault must be reachable from the phone — either it
already syncs (iCloud / the very repo you're testing) or you copy files over.

You need exactly these three files in `<Vault>/.obsidian/plugins/gitsync/`:

```
manifest.json
main.js          # produced by `npm run build`
styles.css
```

Pick whichever transfer path fits your platform:

- **Via the Git repo itself (works on both):** commit `manifest.json`, `main.js`
  and `styles.css` to a scratch branch, then on the phone clone/pull into the
  plugin folder. `main.js` is normally `.gitignore`d — force-add it for this
  scratch branch only, never merge it to `main`.
- **iOS / iPadOS:** if the vault lives in iCloud Drive, drop the three files
  into `iCloud Drive/Obsidian/<Vault>/.obsidian/plugins/gitsync/` from a Mac or
  the Files app, then open Obsidian. (The `.obsidian` folder is hidden — enable
  "show hidden" in Files, or copy from a Mac.)
- **Android:** the vault is a normal folder. Copy the three files into
  `<Vault>/.obsidian/plugins/gitsync/` over USB/MTP, a file manager, or any
  cloud share.

Then on the phone: Settings → Community plugins → turn off **Restricted mode** →
enable **GitSync**. To load a rebuild, replace `main.js` and toggle the plugin
off/on. There is no symlink/watch on mobile — every change is a manual copy.

> The manifest already has `isDesktopOnly: false`, so the plugin is offered on
> mobile. If it doesn't appear, double-check the folder name is exactly
> `gitsync` and all three files are present.

## 4. Live checklist — what the sandbox can't cover

Configure HTTPS remote URL + a PAT in settings first. Prioritise the stability
and mobile items.

### Stability (critical)

- [ ] **C1 — concurrent sync.** Set auto-sync to 1 min. Force a conflict (edit
      the same file from two devices / the web), run sync → conflict modal
      opens. Wait past the interval without closing it. **Expect:** auto-sync
      does not start over the half-merged tree; no new commit appears.
- [ ] **H1 — network timeout.** Start a sync and kill Wi-Fi/network mid-push (or
      throttle in dev-tools). **Expect:** within ~60s the sync fails with a
      network error and the status bar leaves "syncing" — it never hangs
      forever.
- [ ] **C2 — no lost edits.** Selective sync: select some files, leave edits in
      unselected ones. Drop the network between commit and push. **Expect:** the
      unselected edits are still on disk (not clobbered).

### Mobile-specific (high)

- [ ] **H4 — NFC filenames.** Create a note with a combining-diacritic name
      (`café.md`, or Cyrillic `й`) on desktop and sync. Open the same vault on an
      **iPhone** and sync. **Expect:** no phantom "deleted café.md / added
      café.md" commit loop across the two platforms.
- [ ] **H2 — large vault / first clone.** Initialise against a repo with real
      history and large binary attachments on a phone. **Expect:** the first
      sync completes without an out-of-memory crash (shallow `depth: 1` clone).
- [ ] **M2 — background catch-up.** With auto-sync on, background Obsidian (or
      lock the screen) for longer than the interval, then return. **Expect:** a
      sync fires shortly after the app comes back to the foreground.
- [ ] **C3 — conflict modal fits.** Create 3+ conflicting files. **Expect:** the
      file list scrolls and the Resolve/Cancel buttons stay pinned and reachable
      at the bottom on a phone-width screen.
- [ ] **M5 — editor wraps.** A long line in the conflict editor wraps instead of
      scrolling horizontally.
- [ ] **Touch targets.** Checkboxes/rows in the review modal are comfortably
      tappable.

### First sync on a shallow repo (verify explicitly)

- [ ] Initialise against a **real GitHub repo with >1 commit**, then run a full
      cycle: init → edit → sync, including a case where the remote has moved
      ahead. **Expect:** fetch/merge deepen the shallow clone correctly. (The
      `deepen` path runs only through our `obsidianHttpClient`; the offline
      suite can only check structure via system git.)

### UX / silent mode

- [ ] **H5 — silent mode.** Let auto-sync run with an expired/invalid token.
      **Expect:** no Notice spam every tick — only a sticky status-bar error;
      tapping it surfaces the issue. A conflict during silent sync is parked in
      the status bar ("tap to resolve"), not auto-opened over your work.
- [ ] **M6 — settings validation.** Enter an SSH URL (`git@github.com:...`) →
      hint shown. Enter a branch name with a space → error, not saved.

## 5. Known not-yet-covered (low priority, deferred)

These were identified in review but intentionally left for later; watch for them
during live testing:

- **M3** — `writeFile` is not atomic; a process kill mid-`checkout` can leave a
  truncated file.
- **L1** — executable bit / symlinks are not preserved (mode hard-coded).
- **L2** — binary-file conflicts render as garbage in the manual-edit textarea.
