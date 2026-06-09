import { Menu, Notice, Plugin, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ObsSyncSettings,
	ObsSyncSettingTab,
} from "./settings";
import { GitManager, MergeConflict } from "./git";
import { ConflictModal } from "./conflict-modal";
import { ReviewModal } from "./review-modal";

export default class ObsSyncPlugin extends Plugin {
	settings!: ObsSyncSettings;
	git!: GitManager;
	private statusBarEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private syncing = false;
	private changeCount = 0;
	private autoSyncTimer: number | null = null;
	private statusRefreshTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.git = new GitManager(this.app.vault.adapter, () => this.settings);

		this.addRibbonIcon("refresh-cw", "ObsSync: Sync vault", () => {
			void this.sync();
		});

		this.addRibbonIcon("list-checks", "ObsSync: Review changes & sync", () => {
			this.openReview();
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("obssync-status-bar");
		this.statusIconEl = this.statusBarEl.createSpan({
			cls: "obssync-status-icon",
		});
		this.statusTextEl = this.statusBarEl.createSpan({
			cls: "obssync-status-text",
		});
		this.statusBarEl.addEventListener("click", (evt) =>
			this.showStatusMenu(evt)
		);
		this.setStatus("idle");

		this.addCommand({
			id: "obssync-sync",
			name: "Sync vault with Git",
			callback: () => void this.sync(),
		});

		this.addCommand({
			id: "obssync-review",
			name: "Review changes & sync",
			callback: () => this.openReview(),
		});

		this.addCommand({
			id: "obssync-test-connection",
			name: "Test connection to remote",
			callback: () => void this.testConnection(),
		});

		this.addSettingTab(new ObsSyncSettingTab(this.app, this));

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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** (Re)start the auto-sync timer based on current settings. */
	applyAutoSync() {
		if (this.autoSyncTimer !== null) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
		if (this.settings.autoSyncEnabled) {
			const ms = Math.max(1, this.settings.autoSyncInterval) * 60_000;
			this.autoSyncTimer = window.setInterval(() => void this.sync(true), ms);
			this.registerInterval(this.autoSyncTimer);
		}
	}

	/**
	 * Run a full sync. When `silent` (auto-sync / startup), suppress the
	 * "nothing to do" chatter and credential prompts.
	 */
	async sync(silent = false, only?: string[]): Promise<void> {
		if (this.syncing) {
			if (!silent) new Notice("ObsSync: sync already in progress");
			return;
		}
		if (!this.settings.remoteUrl || !this.settings.token) {
			if (!silent)
				new Notice(
					"ObsSync: configure remote URL and token in settings first"
				);
			return;
		}

		this.syncing = true;
		this.setStatus("syncing");
		try {
			const result = await this.git.sync(
				(msg) => this.statusTextEl.setText(msg),
				only
			);
			await this.markSynced();
			const parts: string[] = [];
			if (result.committed) parts.push("committed");
			if (result.pulled) parts.push("pulled");
			if (result.pushed) parts.push("pushed");
			if (parts.length || !silent) {
				new Notice(
					`ObsSync: ${parts.length ? parts.join(", ") : "already up to date"}`
				);
			}
		} catch (err) {
			if (err instanceof MergeConflict) {
				console.warn("ObsSync merge conflict", err.files);
				new Notice(
					`ObsSync: ${err.files.length} conflict(s) — resolve them in the dialog.`
				);
				this.openConflictModal(err);
			} else {
				console.error("ObsSync sync failed", err);
				new Notice(`ObsSync: sync failed — ${(err as Error).message}`);
				this.setStatus("error");
			}
		} finally {
			this.syncing = false;
			await this.refreshStatus();
		}
	}

	private openReview() {
		if (!this.settings.remoteUrl || !this.settings.token) {
			new Notice("ObsSync: configure remote URL and token in settings first");
			return;
		}
		new ReviewModal(this.app, this.git, (paths) => {
			if (paths.length === 0) return;
			void this.sync(false, paths);
		}).open();
	}

	private showStatusMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Sync now")
				.setIcon("refresh-cw")
				.onClick(() => void this.sync())
		);
		menu.addItem((i) =>
			i
				.setTitle("Review changes & sync")
				.setIcon("list-checks")
				.onClick(() => this.openReview())
		);
		menu.addItem((i) =>
			i
				.setTitle("Test connection")
				.setIcon("plug")
				.onClick(() => void this.testConnection())
		);
		menu.addItem((i) =>
			i
				.setTitle("Open settings")
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
		this.setStatus("idle");
		new ConflictModal(
			this.app,
			this.git,
			err,
			async (result) => {
				await this.markSynced();
				const parts: string[] = [];
				if (result.committed) parts.push("merged");
				if (result.pushed) parts.push("pushed");
				new Notice(`ObsSync: ${parts.join(", ") || "resolved"}`);
				await this.refreshStatus();
			},
			async () => {
				new Notice("ObsSync: merge aborted, nothing changed");
				await this.refreshStatus();
			}
		).open();
	}

	async testConnection(): Promise<void> {
		if (!this.settings.remoteUrl || !this.settings.token) {
			new Notice("ObsSync: configure remote URL and token in settings first");
			return;
		}
		new Notice("ObsSync: testing connection…");
		try {
			const branches = await this.git.testConnection();
			new Notice(
				`ObsSync: connected. Remote branches: ${
					branches.join(", ") || "(none)"
				}`
			);
		} catch (err) {
			console.error("ObsSync connection test failed", err);
			new Notice(`ObsSync: connection failed — ${(err as Error).message}`);
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
		try {
			this.changeCount = await this.git.countChanges();
		} catch {
			this.changeCount = 0;
		}
		this.setStatus("idle");
	}

	private setStatus(state: "idle" | "syncing" | "error") {
		this.statusBarEl.removeClass(
			"obssync-status-bar--syncing",
			"obssync-status-bar--error"
		);
		let icon: string;
		let text: string;
		let tooltip: string;
		switch (state) {
			case "syncing":
				this.statusBarEl.addClass("obssync-status-bar--syncing");
				icon = "refresh-cw";
				text = "syncing…";
				tooltip = "ObsSync: syncing…";
				break;
			case "error":
				this.statusBarEl.addClass("obssync-status-bar--error");
				icon = "alert-triangle";
				text = "error";
				tooltip = "ObsSync: last sync failed — click to retry";
				break;
			default: {
				const n = this.changeCount;
				const last = formatLastSync(this.settings.lastSyncAt);
				if (n > 0) {
					icon = "arrow-up-circle";
					text = String(n);
					tooltip = `ObsSync: ${n} change${
						n === 1 ? "" : "s"
					} to sync · last sync ${last} · click for options`;
				} else {
					icon = "check-circle";
					text = "";
					tooltip = `ObsSync: up to date · last sync ${last} · click for options`;
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
	if (!epochMs) return "never";
	const secs = Math.floor((Date.now() - epochMs) / 1000);
	if (secs < 60) return "just now";
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}
