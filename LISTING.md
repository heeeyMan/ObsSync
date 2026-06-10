# Community store listing

Copy for the Obsidian community hub **Edit listing** page. Keep this in sync
with each release so the store entry stays accurate.

## Short description (one-liner / manifest description)

> Sync your whole vault to GitHub with one click — on desktop and mobile.
> Interactive conflict resolution, commit preview, and auto-sync. Pure
> JavaScript, no system Git required.

## Long description (About)

```markdown
**Git Vault Sync** keeps your vault backed up and in sync across every device
through your own GitHub repository — one button, no command line, no system Git.
It's pure JavaScript, so it works on **Android and iOS** just like on desktop.

### Why it's different
Most Git workflows choke on a phone. Git Vault Sync ships **two engines** and
picks the right one automatically:
- **Desktop → Git engine** — full local history and true two-parent merges.
- **Mobile → GitHub API engine** — transfers one file at a time instead of a
  whole packfile, so even large vaults sync on a phone without running out of
  memory.

Both talk to the same GitHub remote, so all your devices stay consistent.

### Features
- **One-click sync** — stage → commit → fetch → merge → push, from the ribbon.
- **Interactive conflict resolution** — a dialog lists each conflicting file and
  lets you keep local, keep remote, or edit the merged result by hand.
- **Commit preview / selective sync** — review every change and uncheck what you
  don't want to commit yet. Deselected edits stay safe, even across a merge.
- **Status-bar indicator** — pending change count, live spinner, ✓ when clean,
  last-sync time on hover.
- **Auto-sync** — on startup and/or on a timer.
- **Excluded paths** — glob patterns and your repo's `.gitignore`, honored on
  both engines.
- **English & Russian UI**, following your Obsidian language.

### Security
Auth is HTTPS + a Personal Access Token, stored locally. The plugin's own token
file is always excluded from sync — it can never be pushed by accident.
```

## Tags / categories

`Git` · `Syncing` · `Backup`

## Screenshot shot-list (order = priority)

1. **Status bar + ribbon** — vault with a couple of pending changes: the sync
   button and the "N changes" indicator. First frame = "what this looks like
   day to day."
2. **Conflict resolution dialog** — the standout feature: per-file choice of
   local / remote / manual. The most persuasive frame.
3. **Commit preview / selective sync** — the modal with per-file checkboxes.
4. **Settings** — engine selector (Auto / Git / API) + the Authorize button +
   remote/branch/token fields (redact the token!).
5. **Mobile screenshot** — syncing on a phone (the key differentiator; even one
   Android/iOS frame strengthens the listing a lot).

Capture tips: dark theme, a clean demo vault, no real notes or tokens on screen.
