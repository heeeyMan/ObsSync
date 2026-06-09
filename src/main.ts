import { Menu, Notice, Platform, Plugin, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	GitSyncSettings,
	GitSyncSettingTab,
} from "./settings";
import { GitManager, MergeConflict } from "./git";
import { ConflictModal } from "./conflict-modal";
import { ReviewModal } from "./review-modal";
import { apiSync, dryRunPull, parseGitHubRepo } from "./github-sync";
import { setLanguage, t } from "./i18n";

/** Vault-root markdown log for the experimental API-pull diagnostic. It is
 *  rewritten in full at each stage so the last line survives a mid-run crash. */
const APITEST_LOG_FILE = "GitVaultSync-apitest.md";

/** Vault-root markdown log for the experimental API SYNC (pull+push). Rewritten
 *  in full at each stage so the last line survives a mid-run crash. */
const APISYNC_LOG_FILE = "GitVaultSync-apisync.md";

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

		// Experimental diagnostic. A ribbon icon is the most reliable trigger on
		// mobile (no command palette hunting); the command below still exists too.
		this.addRibbonIcon("flask-conical", t("cmdApiPullTest"), () => {
			void this.apiPullTest();
		});

		// Experimental REAL bidirectional sync over the Git Data API. This one
		// WRITES to the vault and PUSHES to the remote — run it on a test repo
		// first. A ribbon icon is the most reliable trigger on mobile; the
		// command below exists too.
		this.addRibbonIcon("refresh-cw-off", t("cmdApiSync"), () => {
			void this.apiSyncTest();
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

		this.addCommand({
			id: "api-pull-test",
			name: t("cmdApiPullTest"),
			callback: () => void this.apiPullTest(),
		});

		this.addCommand({
			id: "api-sync",
			name: t("cmdApiSync"),
			callback: () => void this.apiSyncTest(),
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
	 * EXPERIMENTAL diagnostic: stream a repo's tip blob-by-blob through the
	 * Git Data API client and report counts/sizes WITHOUT writing anything to
	 * the vault. Meant to be run on a phone against a large repo to confirm the
	 * new engine pulls one blob at a time without OOMing.
	 *
	 * On mobile a transient Notice is easy to miss and the app can be killed
	 * mid-run, so the authoritative record is a markdown log file at the vault
	 * root (`APITEST_LOG_FILE`). Each stage appends a timestamped line and
	 * REWRITES the whole file, awaiting the write before the next heavy step —
	 * so if the app dies mid-pull, the last line on disk shows how far we got
	 * (e.g. "PROGRESS: 150/372 blobs…").
	 */
	async apiPullTest(): Promise<void> {
		const logPath = APITEST_LOG_FILE;
		const lines: string[] = [];
		const stamp = () => new Date().toISOString();
		// Rewrite the whole file from the accumulated lines. Awaited by callers
		// before any further heavy work so the stage is flushed to disk first.
		const log = async (line: string) => {
			lines.push(`- ${stamp()}  ${line}`);
			try {
				await this.app.vault.adapter.write(
					logPath,
					`# Git Vault Sync — API pull test\n\n${lines.join("\n")}\n`
				);
			} catch (e) {
				// Never let a logging failure mask the real diagnostic.
				console.error("Git Vault Sync apiPullTest log write failed", e);
			}
		};

		// Immediate, unmissable proof the command fired — Notice + on-disk
		// STARTED line — BEFORE any validation or network call.
		new Notice(t("apiPullStarting"), 0);
		await log("STARTED");

		let progressNotice: Notice | null = null;
		try {
			if (!this.settings.remoteUrl || !this.settings.token) {
				await log("ERROR: remote URL or token not configured");
				new Notice(t("errNoRemote"));
				return;
			}
			const parsed = parseGitHubRepo(this.settings.remoteUrl);
			if (!parsed) {
				await log("ERROR: cannot parse GitHub owner/repo from remote URL");
				new Notice(t("apiPullBadUrl"));
				return;
			}
			const branch = this.settings.branch || "main";
			// Params WITHOUT the token.
			await log(
				`PARAMS: owner=${parsed.owner}, repo=${parsed.repo}, branch=${branch}`
			);

			// Persistent, updatable Notice so progress is visible on mobile
			// (where the status bar is hidden). Hidden in `finally`.
			progressNotice = new Notice(t("apiPullStarting"), 0);

			// The engine's first onProgress is the pre-tree "fetching" message;
			// the first per-blob message (the first that carries an x/N count) is
			// our "tree received" marker. Subsequent ones are throttled to ~every
			// 50th to keep the log a stage trail rather than a flood. The engine
			// already controls its own emit cadence; we additionally throttle the
			// disk writes here.
			let fetchLogged = false;
			let treeLogged = false;
			let blobCalls = 0;
			const result = await dryRunPull({
				owner: parsed.owner,
				repo: parsed.repo,
				branch,
				token: this.settings.token,
				onProgress: (msg) => {
					progressNotice?.setMessage(t("apiPullProgress", { n: msg }));
					// Fire-and-forget disk writes from inside the tight loop:
					// awaiting here would serialize every blob. The throttle keeps
					// them rare; the final DONE/ERROR lines are awaited.
					const isBlobMsg = msg.includes("/");
					if (!fetchLogged && !isBlobMsg) {
						fetchLogged = true;
						void log(`FETCH: ${msg}`);
					} else if (isBlobMsg) {
						blobCalls++;
						if (!treeLogged) {
							treeLogged = true;
							void log(`TREE: ${msg} (tree received)`);
						} else if (blobCalls % 50 === 0) {
							void log(`PROGRESS: ${msg}`);
						}
					}
				},
			});

			const mb = (result.totalBytes / 1_048_576).toFixed(1);
			const maxmb = (result.maxBlobBytes / 1_048_576).toFixed(1);
			await log(
				`DONE: blobs=${result.blobs}, totalMB=${mb}, maxBlobMB=${maxmb}` +
					(result.truncated ? ", truncated=true" : "")
			);

			let msg = t("apiPullDone", {
				blobs: result.blobs,
				mb,
				maxmb,
			});
			if (result.truncated) msg += t("apiPullTruncated");
			new Notice(msg, 10_000);
			new Notice(t("apiPullLogSaved", { file: logPath }), 10_000);
		} catch (err) {
			console.error("Git Vault Sync API pull test failed", err);
			const e = err as Error;
			await log(`ERROR: ${e?.message ?? String(err)}`);
			if (e?.stack) await log(`STACK: ${e.stack}`);
			new Notice(t("apiPullFailed", { msg: e?.message ?? String(err) }));
		} finally {
			progressNotice?.hide();
		}
	}

	/**
	 * EXPERIMENTAL real bidirectional sync over the Git Data API (the new engine
	 * in github-sync.ts). Unlike {@link apiPullTest}, this one WRITES pulled
	 * changes into the vault and PUSHES local changes to the remote — run it on a
	 * test repo first.
	 *
	 * Like apiPullTest, the authoritative record is a crash-surviving markdown
	 * log at the vault root ({@link APISYNC_LOG_FILE}): each key stage rewrites
	 * the whole file and is awaited before the next heavy step, so if the app is
	 * killed mid-run the last line shows how far we got. The PAT is never logged.
	 */
	async apiSyncTest(): Promise<void> {
		const logPath = APISYNC_LOG_FILE;
		const lines: string[] = [];
		const stamp = () => new Date().toISOString();
		const log = async (line: string) => {
			lines.push(`- ${stamp()}  ${line}`);
			try {
				await this.app.vault.adapter.write(
					logPath,
					`# Git Vault Sync — API sync (experimental)\n\n${lines.join(
						"\n"
					)}\n`
				);
			} catch (e) {
				console.error("Git Vault Sync apiSyncTest log write failed", e);
			}
		};

		// Immediate, unmissable proof the command fired — Notice + on-disk
		// STARTED line — BEFORE any validation or network call.
		new Notice(t("apiSyncStarting"), 0);
		await log("STARTED");

		let progressNotice: Notice | null = null;
		try {
			if (!this.settings.remoteUrl || !this.settings.token) {
				await log("ERROR: remote URL or token not configured");
				new Notice(t("errNoRemote"));
				return;
			}
			const parsed = parseGitHubRepo(this.settings.remoteUrl);
			if (!parsed) {
				await log("ERROR: cannot parse GitHub owner/repo from remote URL");
				new Notice(t("apiPullBadUrl"));
				return;
			}
			const branch = this.settings.branch || "main";
			// Params WITHOUT the token.
			await log(
				`PARAMS: owner=${parsed.owner}, repo=${parsed.repo}, branch=${branch}`
			);

			// Persistent, updatable progress Notice (visible on mobile where the
			// status bar is hidden). Hidden in `finally`.
			progressNotice = new Notice(t("apiSyncStarting"), 0);

			// excluded predicate. v1 scope (see report): skip the config dir
			// (usually .obsidian), the repo's own .git, the conflicts staging
			// folder, our diagnostic logs, and this plugin's data.json (the PAT).
			// Full settings.excludePaths / .gitignore handling comes later.
			const configDir = this.app.vault.configDir;
			const dataJson = `${this.manifest.dir ?? ""}/data.json`.replace(
				/^\/+/,
				""
			);
			const excluded = (p: string): boolean => {
				const path = p.replace(/^\/+/, "");
				if (!path) return true;
				if (
					path === configDir ||
					path.startsWith(`${configDir}/`)
				)
					return true;
				if (path === ".git" || path.startsWith(".git/")) return true;
				if (path.startsWith("_conflicts/")) return true;
				if (
					path === APITEST_LOG_FILE ||
					path === APISYNC_LOG_FILE
				)
					return true;
				if (dataJson && path === dataJson) return true;
				return false;
			};

			// Commit message: same template handling as the regular sync.
			const message = (this.settings.commitMessage || "vault sync {{date}}")
				.split("{{date}}")
				.join(new Date().toISOString());

			// Throttle disk-log writes from the progress callback so the log is a
			// stage trail, not a flood. The final RESULT/ERROR lines are awaited.
			let progressCount = 0;
			const onProgress = (msg: string) => {
				progressNotice?.setMessage(t("apiSyncProgress", { n: msg }));
				progressCount++;
				if (progressCount === 1 || progressCount % 50 === 0) {
					void log(`PROGRESS: ${msg}`);
				}
			};

			await log("SYNCING");
			const result = await apiSync({
				owner: parsed.owner,
				repo: parsed.repo,
				branch,
				token: this.settings.token,
				adapter: this.app.vault.adapter,
				baseline: this.settings.apiBaseline,
				excluded,
				message,
				onProgress,
			});

			// Persist the new baseline so the next sync diffs against the state we
			// just agreed on. Do this BEFORE any other reporting.
			this.settings.apiBaseline = result.newBaseline;
			await this.saveSettings();

			await log(
				`RESULT: pulled=${result.pulled.length}, pushed=${result.pushed.length}, ` +
					`deletedLocal=${result.deletedLocal.length}, deletedRemote=${result.deletedRemote.length}, ` +
					`conflicts=${result.conflicts.length}, committed=${result.committed}, ` +
					`baselineSaved=true`
			);
			if (result.conflicts.length > 0) {
				await log(`CONFLICTS: ${result.conflicts.join(", ")}`);
			}

			new Notice(
				t("apiSyncDone", {
					pulled: result.pulled.length,
					pushed: result.pushed.length,
					delLocal: result.deletedLocal.length,
					delRemote: result.deletedRemote.length,
				}),
				10_000
			);
			if (result.conflicts.length > 0) {
				new Notice(
					t("apiSyncConflicts", { n: result.conflicts.length }),
					10_000
				);
			}
			new Notice(t("apiSyncLogSaved", { file: logPath }), 10_000);
		} catch (err) {
			console.error("Git Vault Sync API sync failed", err);
			const e = err as Error;
			await log(`ERROR: ${e?.message ?? String(err)}`);
			if (e?.stack) await log(`STACK: ${e.stack}`);
			new Notice(t("apiSyncFailed", { msg: e?.message ?? String(err) }));
		} finally {
			progressNotice?.hide();
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
