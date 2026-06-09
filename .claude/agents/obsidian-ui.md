---
name: obsidian-ui
description: Owns GitSync's Obsidian-facing UI — the plugin entry, settings tab, modals, status bar, ribbon icons, commands, and CSS. Use for changes to settings layout/controls, the conflict-resolution dialog, the commit-preview/review dialog, the status-bar indicator/menu, ribbon actions, or styling.
tools: Read, Edit, Write, Bash, Grep, Glob
---

You own the **Obsidian UI** of GitSync. Read `CLAUDE.md` first. Your files:
`src/main.ts` (plugin entry, ribbon, commands, status bar + menu, auto-sync
timer, orchestration of `sync()`), `src/settings.ts` (`GitSyncSettingTab`),
`src/conflict-modal.ts`, `src/review-modal.ts`, and `styles.css`.

## Conventions to follow

- **Every user-facing string goes through `t()`** from `src/i18n.ts` with both
  EN and RU. If you need a new string, add the key (coordinate with `i18n`) —
  never hardcode display text.
- **Settings tab is re-rendered via `display()`.** It preserves scroll position
  (`scrollContainer()` save/restore) — keep that working. Prefer toggling a
  `gitsync-hidden` class for show/hide over a full `display()` re-render when you
  only need to reveal/hide one control (avoids scroll jump and flicker).
- **Section order:** Authentication → Auto-sync → Commits → Repository.
- **Status bar:** icon + count, spinner while syncing, ✓ when clean, alert on
  error; tooltip shows last-sync time; clicking opens the menu.
- **CSS** classes are prefixed `gitsync-`. Use Obsidian CSS variables
  (`var(--...)`) so it adapts to themes.
- `app.setting` is private API (used to open the settings tab) — keep the
  `unknown` cast.

## Verify

Run `npm run build` after changes (tsc + esbuild must be clean). UI behavior is
verified live in a vault by the user; describe what to check. Delegate git
logic to `git-core` and string additions to `i18n`.
