import { Menu, Notice, Platform, Plugin, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	GitSyncSettings,
	GitSyncSettingTab,
} from "./settings";
import { GitManager, MergeConflict } from "./git";
import { ConflictModal } from "./conflict-modal";
import { ReviewModal } from "./review-modal";
import { setLanguage, t } from "./i18n";

export default class GitSyncPlugin extends Plugin {
	settings!: GitSyncSettings;
	git!: GitManager;
	private statusBarEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private syncing = false;
	private changeCount = 0;
	private lastSyncError = false;
	/** True while a ConflictModal is open (or a silent conflict awaits the
	 *  user). Blocks auto-sync from running over a half-merged tree. */
	private conflictActive = false;
	/** A conflict surfaced by a silent sync, parked until the user taps to
	 *  resolve it (we don't auto-open the modal in the background). */
	private pendingConflict: MergeConflict | null = null;
	private autoSyncTimer: number | null = null;
	private statusRefreshTimer: number | null = null;
	/** The currently open GitSync modal, so onunload can close it and avoid
	 *  leaving a modal holding a reference to the unloaded plugin's GitManager. */
	private currentModal: ConflictModal | ReviewModal | null = null;

	async onload() {
		await this.loadSettings();
		setLanguage(this.settings.language);
		this.git = new GitManager(this.app.vault.adapter, () => this.settings);

		this.addRibbonIcon("refresh-cw", t("ribbonSync"), () => {
			void this.sync();
		});

		this.addRibbonIcon("list-checks", t("ribbonReview"), () => {
			this.openReview();
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("gitsync-status-bar");
		this.statusIconEl = this.statusBarEl.createSpan({
			cls: "gitsync-status-icon",
		});
		this.statusTextEl = this.statusBarEl.createSpan({
			cls: "gitsync-status-text",
		});
		this.registerDomEvent(this.statusBarEl, "click", (evt) =>
			this.showStatusMenu(evt)
		);
		this.setStatus("idle");

		// The auto-sync setInterval is frozen while Obsidian is backgrounded /
		// the screen is locked (especially on mobile) and doesn't catch up the
		// missed ticks. When we return to the foreground, run a sync if a full
		// interval has elapsed since the last one.
		this.registerDomEvent(document, "visibilitychange", () =>
			this.onVisibilityChange()
		);

		this.addCommand({
			id: "sync",
			name: t("cmdSync"),
			callback: () => void this.sync(),
		});

		this.addCommand({
			id: "review",
			name: t("cmdReview"),
			callback: () => this.openReview(),
		});

		this.addCommand({
			id: "test-connection",
			name: t("cmdTest"),
			callback: () => void this.testConnection(),
		});

		this.addSettingTab(new GitSyncSettingTab(this.app, this));

		// Keep the status-bar change counter fresh as the vault is edited.
		const onVaultChange = () => this.scheduleStatusRefresh();
		this.registerEvent(this.app.vault.on("modify", onVaultChange));
		this.registerEvent(this.app.vault.on("create", onVaultChange));
		this.registerEvent(this.app.vault.on("delete", onVaultChange));
		this.registerEvent(this.app.vault.on("rename", onVaultChange));

		this.app.workspace.onLayoutReady(() => {
			void this.refreshStatus();
			this.applyAutoSync();
			if (this.settings.syncOnStartup) {
				void this.sync(true);
			}
		});
	}

	onunload() {
		if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
		if (this.statusRefreshTimer !== null)
			window.clearTimeout(this.statusRefreshTimer);
		// Close any open modal so it doesn't keep operating on (and holding a
		// reference to) the unloaded plugin's GitManager.
		this.currentModal?.close();
		this.currentModal = null;
	}

	/**
	 * On return to the foreground, catch up auto-sync if a full interval has
	 * elapsed since the last sync (the background setInterval doesn't fire while
	 * suspended). Conservative: only when auto-sync is on and we're idle.
	 */
	private onVisibilityChange() {
		if (document.visibilityState !== "visible") return;
		if (!this.settings.autoSyncEnabled) return;
		if (this.syncing || this.conflictActive) return;
		const intervalMs = Math.max(1, this.settings.autoSyncInterval) * 60_000;
		const elapsed = Date.now() - this.settings.lastSyncAt;
		if (this.settings.lastSyncAt && elapsed < intervalMs) return;
		void this.sync(true);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setLanguage(this.settings.language);
	}

	/** (Re)start the auto-sync timer based on current settings. */
	applyAutoSync() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		if (this.settings.autoSyncEnabled) {
			const ms = Math.max(1, this.settings.autoSyncInterval) * 60_000;
			// Tracked manually (cleared here on re-apply and in onunload); don't
			// also registerInterval, which would accumulate registrations.
			this.autoSyncTimer = window.setInterval(() => void this.sync(true), ms);
		}
	}

	/**
	 * Run a full sync. When `silent` (auto-sync / startup), suppress the
	 * "nothing to do" chatter and credential prompts.
	 */
	async sync(silent = false, only?: string[]): Promise<void> {
		if (this.syncing || this.conflictActive) {
			if (!silent) new Notice(t("noticeInProgress"));
			return;
		}
		if (!this.settings.remoteUrl || !this.settings.token) {
			if (!silent) new Notice(t("noticeConfigure"));
			return;
		}

		this.syncing = true;
		this.lastSyncError = false;
		this.setStatus("syncing");
		// On mobile the status bar is hidden, so a manual sync's progress
		// (the prog* messages we feed below) would be invisible. Surface it
		// with a persistent Notice (timeout 0) that we update in the progress
		// callback and hide in `finally`. Desktop keeps using the status bar
		// only; auto/startup (silent) syncs stay quiet either way.
		const progressNotice =
			!silent && Platform.isMobile
				? new Notice("Git Vault Sync: " + t("statusSyncing"), 0)
				: null;
		try {
			const result = await this.git.sync((msg) => {
				this.statusTextEl.setText(msg);
				progressNotice?.setMessage("Git Vault Sync: " + msg);
			}, only);
			await this.markSynced();
			const parts: string[] = [];
			if (result.committed) parts.push(t("resultCommitted"));
			if (result.pulled) parts.push(t("resultPulled"));
			if (result.pushed) parts.push(t("resultPushed"));
			if (parts.length || !silent) {
				new Notice(
					t("noticeResult", {
						parts: parts.length
							? parts.join(", ")
							: t("resultUpToDate"),
					})
				);
			}
		} catch (err) {
			if (err instanceof MergeConflict) {
				console.warn("Git Vault Sync merge conflict", err.files);
				if (silent) {
					// Background sync: don't open a modal over the user's work.
					// Park the conflict and surface a sticky status-bar state;
					// the user opens the modal explicitly (tap / command).
					this.pendingConflict = err;
					this.conflictActive = true;
				} else {
					new Notice(t("noticeConflicts", { n: err.files.length }));
					this.openConflictModal(err);
				}
			} else {
				console.error("Git Vault Sync sync failed", err);
				// Silent (auto/startup) sync: stay quiet — a stale token or no
				// network would otherwise spam a Notice every tick. The sticky
				// status-bar error indicator (lastSyncError) carries it instead.
				if (!silent) {
					new Notice(
						t("noticeSyncFailed", { msg: (err as Error).message })
					);
				}
				this.lastSyncError = true;
			}
		} finally {
			// Always tear down the progress Notice — including the conflict
			// path, so it's gone before the ConflictModal opens.
			progressNotice?.hide();
			this.syncing = false;
			await this.refreshStatus();
		}
	}

	private openReview() {
		if (!this.settings.remoteUrl || !this.settings.token) {
			new Notice(t("noticeConfigure"));
			return;
		}
		const modal = new ReviewModal(this.app, this.git, (paths) => {
			if (paths.length === 0) return;
			void this.sync(false, paths);
		});
		this.currentModal = modal;
		modal.onCloseHook = () => {
			if (this.currentModal === modal) this.currentModal = null;
		};
		modal.open();
	}

	private showStatusMenu(evt: MouseEvent) {
		// A parked (silent) conflict: tapping the status bar jumps straight to
		// resolving it rather than opening the menu.
		if (this.pendingConflict) {
			this.resolvePendingConflict();
			return;
		}
		const menu = new Menu();
		if (this.conflictActive) {
			menu.addItem((i) =>
				i
					.setTitle(t("menuResolve"))
					.setIcon("alert-triangle")
					.onClick(() => this.resolvePendingConflict())
			);
		}
		menu.addItem((i) =>
			i
				.setTitle(t("menuSyncNow"))
				.setIcon("refresh-cw")
				.onClick(() => void this.sync())
		);
		menu.addItem((i) =>
			i
				.setTitle(t("cmdReview"))
				.setIcon("list-checks")
				.onClick(() => this.openReview())
		);
		menu.addItem((i) =>
			i
				.setTitle(t("menuTest"))
				.setIcon("plug")
				.onClick(() => void this.testConnection())
		);
		menu.addItem((i) =>
			i
				.setTitle(t("menuSettings"))
				.setIcon("settings")
				.onClick(() => this.openSettings())
		);
		menu.showAtMouseEvent(evt);
	}

	private openSettings() {
		// `setting` is not in the public API but is stable across versions.
		const setting = (this.app as unknown as {
			setting: { open(): void; openTabById(id: string): void };
		}).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private openConflictModal(err: MergeConflict) {
		// Block auto-sync for the (possibly long) duration of resolution. The
		// flag is cleared in both modal outcomes below and in onClose.
		this.conflictActive = true;
		this.pendingConflict = null;
		this.setStatus("idle");
		const modal = new ConflictModal(
			this.app,
			this.git,
			err,
			async (result) => {
				this.conflictActive = false;
				await this.markSynced();
				const parts: string[] = [];
				if (result.committed) parts.push(t("resultMerged"));
				if (result.pushed) parts.push(t("resultPushed"));
				new Notice(
					t("noticeResult", {
						parts: parts.join(", ") || t("resultResolved"),
					})
				);
				await this.refreshStatus();
			},
			async () => {
				this.conflictActive = false;
				new Notice(t("noticeAborted"));
				await this.refreshStatus();
			}
		);
		this.currentModal = modal;
		modal.onCloseHook = () => {
			if (this.currentModal === modal) this.currentModal = null;
		};
		modal.open();
	}

	/** Open the modal for a conflict parked by a silent sync (user action). */
	private resolvePendingConflict() {
		const err = this.pendingConflict;
		if (!err) return;
		this.openConflictModal(err);
	}

	async testConnection(): Promise<void> {
		if (!this.settings.remoteUrl || !this.settings.token) {
			new Notice(t("noticeConfigure"));
			return;
		}
		new Notice(t("noticeTesting"));
		try {
			const branches = await this.git.testConnection();
			new Notice(
				t("noticeConnected", {
					branches: branches.join(", ") || t("branchesNone"),
				})
			);
		} catch (err) {
			console.error("Git Vault Sync connection test failed", err);
			new Notice(t("noticeConnFailed", { msg: (err as Error).message }));
		}
	}

	private async markSynced() {
		this.settings.lastSyncAt = Date.now();
		await this.saveSettings();
	}

	private scheduleStatusRefresh() {
		if (this.statusRefreshTimer !== null)
			window.clearTimeout(this.statusRefreshTimer);
		this.statusRefreshTimer = window.setTimeout(() => {
			this.statusRefreshTimer = null;
			void this.refreshStatus();
		}, 1500);
	}

	private async refreshStatus() {
		if (this.syncing) return;
		// A parked silent conflict takes priority: keep prompting the user to
		// resolve it (tap the status bar) until they do.
		if (this.pendingConflict) {
			this.setStatus("conflict");
			return;
		}
		// Keep the error indicator sticky until the next sync attempt.
		if (this.lastSyncError) {
			this.setStatus("error");
			return;
		}
		try {
			this.changeCount = await this.git.countChanges();
		} catch {
			this.changeCount = 0;
		}
		this.setStatus("idle");
	}

	private setStatus(state: "idle" | "syncing" | "error" | "conflict") {
		this.statusBarEl.removeClass(
			"gitsync-status-bar--syncing",
			"gitsync-status-bar--error"
		);
		let icon: string;
		let text: string;
		let tooltip: string;
		switch (state) {
			case "syncing":
				this.statusBarEl.addClass("gitsync-status-bar--syncing");
				icon = "refresh-cw";
				text = t("statusSyncing");
				tooltip = t("tipSyncing");
				break;
			case "error":
				this.statusBarEl.addClass("gitsync-status-bar--error");
				icon = "alert-triangle";
				text = t("statusError");
				tooltip = t("tipError");
				break;
			case "conflict":
				this.statusBarEl.addClass("gitsync-status-bar--error");
				icon = "git-merge";
				text = t("statusConflict");
				tooltip = t("tipConflict");
				break;
			default: {
				const n = this.changeCount;
				const last = formatLastSync(this.settings.lastSyncAt);
				if (n > 0) {
					icon = "arrow-up-circle";
					text = String(n);
					tooltip = t("tipChanges", { n, last });
				} else {
					icon = "check-circle";
					text = "";
					tooltip = t("tipClean", { last });
				}
			}
		}
		setIcon(this.statusIconEl, icon);
		this.statusTextEl.setText(text);
		this.statusBarEl.setAttr("aria-label", tooltip);
	}
}

/** Human-readable "time ago" for the status-bar tooltip. */
function formatLastSync(epochMs: number): string {
	if (!epochMs) return t("lastNever");
	const secs = Math.floor((Date.now() - epochMs) / 1000);
	if (secs < 60) return t("lastJustNow");
	const mins = Math.floor(secs / 60);
	if (mins < 60) return t("lastMin", { n: mins });
	const hours = Math.floor(mins / 60);
	if (hours < 24) return t("lastHour", { n: hours });
	return t("lastDay", { n: Math.floor(hours / 24) });
}
