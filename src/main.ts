import { Menu, Notice, Platform, Plugin, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	GitSyncSettings,
	GitSyncSettingTab,
} from "./settings";
import {
	GitManager,
	MergeConflict,
	buildUserExcludeMatcher,
	parseGitignore,
} from "./git";
import { ConflictModal } from "./conflict-modal";
import { ReviewModal } from "./review-modal";
import {
	apiSync,
	commitResolutions,
	ConflictInfo,
	getBlob,
	parseGitHubRepo,
} from "./github-sync";
import { ApiConflictFile, ApiConflictModal } from "./api-conflict-modal";
import { setLanguage, t } from "./i18n";

export default class GitSyncPlugin extends Plugin {
	settings!: GitSyncSettings;
	git!: GitManager;
	private statusBarEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	/** Ribbon icon for Review/selective sync; hidden under the API engine
	 *  (the default on mobile), where that flow isn't available. */
	private reviewRibbonEl!: HTMLElement;
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
	private currentModal: ConflictModal | ReviewModal | ApiConflictModal | null =
		null;

	async onload() {
		await this.loadSettings();
		setLanguage(this.settings.language);
		this.git = new GitManager(this.app.vault.adapter, () => this.settings);
		// Never let the engine commit our own data.json (it holds the PAT).
		this.git.setAlwaysExclude([
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`,
		]);

		this.addRibbonIcon("refresh-cw", t("ribbonSync"), () => {
			void this.sync();
		});

		this.reviewRibbonEl = this.addRibbonIcon("list-checks", t("ribbonReview"), () => {
			this.openReview();
		});
		this.updateReviewRibbonVisibility();

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
		this.registerDomEvent(activeDocument, "visibilitychange", () =>
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
		if (activeDocument.visibilityState !== "visible") return;
		if (!this.settings.autoSyncEnabled) return;
		if (this.syncing || this.conflictActive) return;
		const intervalMs = Math.max(1, this.settings.autoSyncInterval) * 60_000;
		const elapsed = Date.now() - this.settings.lastSyncAt;
		if (this.settings.lastSyncAt && elapsed < intervalMs) return;
		void this.sync(true);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<GitSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
		// First run only: prepend the config folder's workspace files to the
		// excludes. The config folder is not always ".obsidian", so this is
		// resolved at runtime via vault.configDir. We key off the *absence* of
		// the saved value so an existing user's choice (including an
		// intentionally empty list) is never overwritten.
		if (saved == null || !("excludePaths" in saved)) {
			const cd = this.app.vault.configDir;
			const workspaceExcludes = `${cd}/workspace.json\n${cd}/workspace-mobile.json`;
			this.settings.excludePaths = this.settings.excludePaths
				? `${workspaceExcludes}\n${this.settings.excludePaths}`
				: workspaceExcludes;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setLanguage(this.settings.language);
		this.updateReviewRibbonVisibility();
	}

	/**
	 * Show the Review/selective-sync ribbon icon only under the git engine.
	 * The API engine (default on mobile) has no local repo to inspect, so the
	 * flow isn't available there — hide the icon rather than offer a dead end.
	 * Re-evaluated whenever settings change (the engine setting can switch it).
	 */
	private updateReviewRibbonVisibility() {
		this.reviewRibbonEl?.toggle(this.effectiveEngine() === "git");
	}

	/**
	 * Resolve the active sync engine. "auto" picks the API engine on mobile
	 * (avoids OOM on large repos, no system git) and isomorphic-git on desktop.
	 */
	effectiveEngine(): "git" | "api" {
		if (this.settings.syncEngine === "auto") {
			return Platform.isMobile ? "api" : "git";
		}
		return this.settings.syncEngine;
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
			if (this.effectiveEngine() === "api") {
				await this.syncApi(silent, only, progressNotice);
			} else {
				await this.syncGit(silent, only, progressNotice);
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

	/**
	 * Git (isomorphic-git) sync path — the original behaviour. Stages, commits,
	 * fetches+merges and pushes via {@link GitManager.sync}. A MergeConflict is
	 * rethrown to {@link sync}'s shared catch (which parks it or opens the modal).
	 */
	private async syncGit(
		silent: boolean,
		only: string[] | undefined,
		progressNotice: Notice | null
	): Promise<void> {
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
	}

	/**
	 * GitHub Git Data API sync path (default on mobile). Diffs the working tree
	 * against the persisted baseline, pulls/pushes non-conflicting changes via
	 * {@link apiSync}, then — on conflicts — opens {@link ApiConflictModal} and
	 * commits the user's resolutions. The baseline is persisted only on success.
	 *
	 * Selective sync (`only`) is git-specific and unsupported here in v1: we
	 * inform the user (non-silent) and sync everything. Non-fatal errors during
	 * interactive resolution are surfaced by {@link resolveApiConflicts} itself;
	 * a thrown error propagates to {@link sync}'s shared catch (H5-silent honored).
	 */
	private async syncApi(
		silent: boolean,
		only: string[] | undefined,
		progressNotice: Notice | null
	): Promise<void> {
		if (only && only.length && !silent) {
			new Notice(t("noticeApiNoSelective"));
		}

		const parsed = parseGitHubRepo(this.settings.remoteUrl);
		if (!parsed) {
			throw new Error(t("apiPullBadUrl"));
		}
		const branch = this.settings.branch || "main";
		const token = this.settings.token;

		// User-configurable exclusions: the `excludePaths` setting + the repo's
		// root .gitignore, matched with the SAME glob semantics as the git engine
		// (shared `buildUserExcludeMatcher`/`parseGitignore` from git.ts). On
		// mobile the API engine doesn't go through GitManager, so we read the root
		// .gitignore directly via the vault adapter here. Missing/unreadable →
		// excludePaths only. This fixes the old asymmetry where a path the user
		// excluded on desktop was still pushed from mobile.
		const adapter = this.app.vault.adapter;
		let gitignorePatterns: string[] = [];
		try {
			if (await adapter.exists(".gitignore")) {
				gitignorePatterns = parseGitignore(
					await adapter.read(".gitignore")
				);
			}
		} catch {
			gitignorePatterns = [];
		}
		const matchesUser = buildUserExcludeMatcher(
			this.settings.excludePaths,
			gitignorePatterns
		);

		// excluded predicate: hardcoded exclusions ON TOP OF the user patterns —
		// the config dir (usually .obsidian; intentionally always skipped by the
		// API engine, see README), the repo's own .git, the conflicts staging
		// folder, any leftover diagnostic log notes from old test runs, and this
		// plugin's data.json (which holds the PAT). These can't be turned off.
		const configDir = this.app.vault.configDir;
		const dataJson = `${this.manifest.dir ?? ""}/data.json`.replace(
			/^\/+/,
			""
		);
		const excluded = (p: string): boolean => {
			const path = p.replace(/^\/+/, "");
			if (!path) return true;
			if (path === configDir || path.startsWith(`${configDir}/`))
				return true;
			if (path === ".git" || path.startsWith(".git/")) return true;
			if (path.startsWith("_conflicts/")) return true;
			if (
				path === "GitVaultSync-apitest.md" ||
				path === "GitVaultSync-apisync.md"
			)
				return true;
			if (dataJson && path === dataJson) return true;
			// User-configured excludePaths / .gitignore (same globs as git engine).
			if (matchesUser(path)) return true;
			return false;
		};

		const message = (this.settings.commitMessage || "vault sync {{date}}")
			.split("{{date}}")
			.join(new Date().toISOString());

		const result = await apiSync({
			owner: parsed.owner,
			repo: parsed.repo,
			branch,
			token,
			adapter: this.app.vault.adapter,
			baseline: this.settings.apiBaseline,
			excluded,
			message,
			onProgress: (msg) => {
				this.statusTextEl.setText(msg);
				progressNotice?.setMessage("Git Vault Sync: " + msg);
			},
		});

		// Persist the new baseline so the next sync diffs against the state we
		// just agreed on. Only reached on success (apiSync didn't throw).
		this.settings.apiBaseline = result.newBaseline;
		await this.saveSettings();
		await this.markSynced();

		const parts: string[] = [];
		if (result.committed) parts.push(t("resultCommitted"));
		if (result.pulled.length) parts.push(t("resultPulled"));
		if (result.pushed.length) parts.push(t("resultPushed"));
		if (parts.length || !silent) {
			new Notice(
				t("noticeResult", {
					parts: parts.length
						? parts.join(", ")
						: t("resultUpToDate"),
				})
			);
		}

		// Interactive conflict resolution. Non-conflicting changes were already
		// applied above; here the user picks a winner per clashing file.
		if (result.conflicts.length > 0) {
			// Tear down the sync progress Notice so it isn't left behind the
			// modal (sync's finally also hides it, but it's gone earlier here).
			progressNotice?.hide();
			await this.resolveApiConflicts(
				parsed.owner,
				parsed.repo,
				branch,
				token,
				result.conflicts,
				message
			);
		}
	}

	private openReview() {
		if (!this.settings.remoteUrl || !this.settings.token) {
			new Notice(t("noticeConfigure"));
			return;
		}
		// Review / selective sync is git-specific (it relies on countChanges /
		// listChanges over the local .git, and sync(only)). The API engine has
		// no local repo to inspect, so it isn't available there in v1.
		if (this.effectiveEngine() === "api") {
			new Notice(t("noticeApiNoReview"));
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
			(result) => {
				void (async () => {
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
				})();
			},
			() => {
				void (async () => {
					this.conflictActive = false;
					new Notice(t("noticeAborted"));
					await this.refreshStatus();
				})();
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

	/**
	 * Interactive resolution for the conflicts the API sync left untouched. For each {@link ConflictInfo} we lazily materialize both sides'
	 * bytes — the remote blob via {@link getBlob} (skipped when remote-deleted),
	 * the local file via the adapter (skipped when locally deleted) — then open
	 * {@link ApiConflictModal}. The user's per-file choice becomes the resolved
	 * content (or `null` to delete), which {@link commitResolutions} writes to the
	 * vault, uploads, commits on the live tip and pushes. The returned baseline is
	 * persisted so those paths are no longer seen as diverged next sync.
	 *
	 * Errors are caught and surfaced as a Notice — they never propagate to break
	 * the surrounding sync reporting.
	 */
	private async resolveApiConflicts(
		owner: string,
		repo: string,
		branch: string,
		token: string,
		conflicts: ConflictInfo[],
		message: string
	): Promise<void> {
		const adapter = this.app.vault.adapter;

		// Lazily fetch both sides' bytes for each conflict (one blob at a time;
		// the local file is already on disk). null = deleted on that side.
		const files: ApiConflictFile[] = [];
		try {
			for (const c of conflicts) {
				const remoteContent =
					c.remoteSha !== null
						? await getBlob(owner, repo, c.remoteSha, token)
						: null;
				const localContent = c.localDeleted
					? null
					: new Uint8Array(await adapter.readBinary(c.path));
				files.push({ path: c.path, localContent, remoteContent });
			}
		} catch (err) {
			const e = err as Error;
			console.error("Git Vault Sync: loading conflict content failed", err);
			new Notice(
				t("apiSyncResolveFailed", { msg: e?.message ?? String(err) })
			);
			return;
		}

		// Open the modal and await the user's decision via the callbacks.
		const resolved = await new Promise<Map<string, Uint8Array | null> | null>(
			(resolve) => {
				const modal = new ApiConflictModal(
					this.app,
					files,
					(map) => resolve(map),
					() => resolve(null)
				);
				this.currentModal = modal;
				modal.onCloseHook = () => {
					if (this.currentModal === modal) this.currentModal = null;
				};
				modal.open();
			}
		);

		if (!resolved) {
			new Notice(t("apiSyncResolveCancelled"));
			return;
		}

		const resolveNotice = new Notice(t("apiSyncResolving"), 0);
		try {
			const res = await commitResolutions({
				owner,
				repo,
				branch,
				token,
				adapter,
				baseline: this.settings.apiBaseline,
				resolved: [...resolved].map(([path, content]) => ({
					path,
					content,
				})),
				message,
				// `msg` is already a localized progress string from github-sync's
				// onProgress (e.g. t("progPushing")); just prefix it the same way
				// syncApi does, instead of re-wrapping it through another t() key.
				onProgress: (msg) =>
					resolveNotice.setMessage("Git Vault Sync: " + msg),
			});

			// Persist the updated baseline so resolved paths are now in sync.
			this.settings.apiBaseline = res.newBaseline;
			await this.saveSettings();

			new Notice(t("apiSyncResolved", { n: resolved.size }), 10_000);
		} catch (err) {
			const e = err as Error;
			console.error("Git Vault Sync: commitResolutions failed", err);
			new Notice(
				t("apiSyncResolveFailed", { msg: e?.message ?? String(err) })
			);
		} finally {
			resolveNotice.hide();
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
		// Under the API engine there is no local .git to inspect, and
		// countChanges() would touch git internals — so don't call it. Use the
		// "no count" sentinel (-1): the idle state then shows the clean icon and
		// the last-sync time, without a (meaningless) pending-changes number.
		if (this.effectiveEngine() === "api") {
			this.changeCount = -1;
			this.setStatus("idle");
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
