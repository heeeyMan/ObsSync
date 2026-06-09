import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import type GitSyncPlugin from "./main";
import { fetchGitHubRepos, fetchGitHubUser, GitHubRepo } from "./github-api";
import type { ApiSyncBaseline } from "./github-sync";
import { LangPref, t } from "./i18n";

export interface GitSyncSettings {
	/** HTTPS clone URL of the remote, e.g. https://github.com/user/repo.git */
	remoteUrl: string;
	/** Branch to sync against. */
	branch: string;
	/** Author name written into commits. */
	authorName: string;
	/** Author email written into commits. */
	authorEmail: string;
	/** GitHub username (used together with the token for HTTPS auth). */
	username: string;
	/** Personal Access Token. Stored in plaintext in data.json. */
	token: string;
	/** Commit message template; {{date}} is substituted with an ISO timestamp. */
	commitMessage: string;
	/** Sync automatically on a timer. */
	autoSyncEnabled: boolean;
	/** Auto-sync interval in minutes. */
	autoSyncInterval: number;
	/** Sync once when Obsidian starts. */
	syncOnStartup: boolean;
	/** Epoch ms of the last successful sync (0 = never). Maintained by the plugin. */
	lastSyncAt: number;
	/** Newline-separated glob patterns of files GitSync should never sync. */
	excludePaths: string;
	/** Interface language ("auto" follows Obsidian). */
	language: LangPref;
	/**
	 * Which sync engine to use:
	 * - "auto"  → API on mobile, Git (isomorphic-git) on desktop (recommended);
	 * - "git"   → always isomorphic-git;
	 * - "api"   → always the GitHub Git Data API engine (github-sync.ts).
	 * The API engine avoids out-of-memory on large repos on mobile.
	 */
	syncEngine: "auto" | "git" | "api";
	/**
	 * Persistent baseline for the experimental API sync engine (github-sync.ts):
	 * the confirmed common state (remote commit + per-path blob shas) after the
	 * last successful API sync. Stored in data.json; not shown in the UI.
	 */
	apiBaseline: ApiSyncBaseline;
}

export const DEFAULT_SETTINGS: GitSyncSettings = {
	remoteUrl: "",
	branch: "main",
	authorName: "",
	authorEmail: "",
	username: "",
	token: "",
	commitMessage: "vault sync {{date}}",
	autoSyncEnabled: false,
	autoSyncInterval: 10,
	syncOnStartup: false,
	lastSyncAt: 0,
	// Default workspace excludes are config-dir dependent and applied at
	// first run in loadSettings() (the config folder is not always ".obsidian").
	excludePaths: [".DS_Store", ".trash/"].join("\n"),
	language: "auto",
	syncEngine: "auto",
	apiBaseline: { commitSha: null, shas: {} },
};

const NEW_BRANCH = "__gitsync_new_branch__";
const REMOTE_MANUAL = "__gitsync_remote_manual__";

export class GitSyncSettingTab extends PluginSettingTab {
	plugin: GitSyncPlugin;
	/** Branch names fetched from the remote (for the branch dropdown). */
	private remoteBranches: string[] = [];
	private branchesFetched = false;
	private creatingBranch = false;
	/** Repositories fetched from GitHub after authorization (for the remote
	 *  dropdown). Empty until the user authorizes. */
	private repos: GitHubRepo[] = [];
	/** When true, the remote URL is edited via the manual text field rather than
	 *  picked from the repo dropdown. Recomputed in display(). */
	private remoteManual = false;

	constructor(app: App, plugin: GitSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// Preserve scroll position across re-renders (language change, branch
		// create/refresh, etc.) so the view doesn't jump to the top.
		const scroller = this.scrollContainer();
		const prevScroll = scroller?.scrollTop ?? 0;

		const { containerEl } = this;
		containerEl.empty();

		const s = this.plugin.settings;
		const hasCreds = !!s.remoteUrl && !!s.token;

		// Auto-load remote branches the first time the tab opens with creds set.
		if (hasCreds && !this.branchesFetched) {
			this.branchesFetched = true;
			void this.fetchBranches(true);
		}

		// --- 0. Sync now (only once configured: token + remote URL set) ---
		// This is the very first element, above the Authentication heading, so a
		// configured user can sync straight from the tab. Rendered only when the
		// plugin is set up for syncing; this persists across restarts (unlike the
		// transient fetched repo list).
		if (hasCreds) {
			new Setting(containerEl)
				.setName(t("syncNow"))
				.setDesc(t("syncNowDesc"))
				.addButton((b) => {
					b.setButtonText(t("syncNow")).setCta();
					b.onClick(async () => {
						const original = t("syncNow");
						b.setDisabled(true).setButtonText(t("cmSyncing"));
						try {
							// Non-silent sync: same as a manual run (notices,
							// conflict modal). The plugin manages its own syncing
							// flag and status bar; we only reflect button state.
							await this.plugin.sync(false);
						} finally {
							b.setDisabled(false).setButtonText(original);
						}
					});
				});
		}

		// --- 1. Authentication / connection ---
		new Setting(containerEl).setName(t("headAuth")).setHeading();

		// Token comes first: it gates authorization, which fills in the rest.
		let usernameText: TextComponent | null = null;
		let authBtnSetDisabled: ((d: boolean) => void) | null = null;

		// Token + inline Authorize button live in the same Setting row: the
		// text field renders first, the button to its right. The button is
		// disabled while the field is empty, toggled live on every keystroke.
		const tokenSetting = new Setting(containerEl)
			.setName(t("setTokenName"))
			.setDesc(t("setTokenDesc"))
			.addText((text) => {
				text
					.setPlaceholder("ghp_...")
					.setValue(s.token)
					.onChange(async (value) => {
						s.token = value.trim();
						// Live-toggle the Authorize button as the field changes.
						authBtnSetDisabled?.(!s.token);
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.addClass("gitsync-token-input");
			});

		// Authorize: pull the GitHub user + repo list, autofill username and the
		// remote dropdown. Disabled while the token field is empty.
		tokenSetting.addButton((b) => {
			b.setButtonText(t("btnAuthorize")).setCta();
			b.setDisabled(!s.token);
			authBtnSetDisabled = (d) => {
				b.setDisabled(d);
			};
			b.onClick(async () => {
				const token = s.token.trim();
				if (!token) return;
				b.setDisabled(true).setButtonText(t("authorizing"));
				try {
					const user = await fetchGitHubUser(token);
					s.username = user.login;
					// Reflect the autofilled username in the live field too.
					usernameText?.setValue(user.login);
					// Autofill the commit author from the GitHub profile.
					// Name: profile name, falling back to the login.
					s.authorName = user.name || user.login;
					// Email: only overwrite when the profile exposes one;
					// otherwise keep whatever the user already entered.
					if (user.email) s.authorEmail = user.email;
					this.repos = await fetchGitHubRepos(token);
					// Keep the manual flag in sync: if the current URL matches a
					// fetched repo, switch to dropdown mode automatically.
					this.remoteManual = !this.repos.some(
						(r) => r.cloneUrl === s.remoteUrl
					);
					await this.plugin.saveSettings();
					new Notice(
						t("authOk", {
							user: user.login,
							count: this.repos.length,
						})
					);
					this.display();
				} catch (err) {
					console.error("Git Vault Sync authorize failed", err);
					new Notice(t("authFailed", { msg: (err as Error).message }));
					b.setButtonText(t("btnAuthorize"));
					b.setDisabled(!s.token);
				}
			});
		});

		this.renderRemoteSetting(containerEl);

		this.renderBranchSetting(containerEl);

		new Setting(containerEl)
			.setName(t("setUserName"))
			.setDesc(t("setUserDesc"))
			.addText((text) => {
				usernameText = text;
				text.setValue(s.username).onChange(async (value) => {
					s.username = value.trim();
					await this.plugin.saveSettings();
				});
			});

		// --- 2. Automatic sync ---
		new Setting(containerEl).setName(t("headAutoSync")).setHeading();

		new Setting(containerEl)
			.setName(t("setStartupName"))
			.setDesc(t("setStartupDesc"))
			.addToggle((tg) =>
				tg.setValue(s.syncOnStartup).onChange(async (value) => {
					s.syncOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		// The interval row is always rendered; the toggle just shows/hides it,
		// so flipping it doesn't re-render the tab (which would jump scroll).
		let intervalEl: HTMLElement | null = null;

		new Setting(containerEl)
			.setName(t("setTimerName"))
			.setDesc(t("setTimerDesc"))
			.addToggle((tg) =>
				tg.setValue(s.autoSyncEnabled).onChange(async (value) => {
					s.autoSyncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.applyAutoSync();
					intervalEl?.toggleClass("gitsync-hidden", !value);
				})
			);

		const intervalSetting = new Setting(containerEl)
			.setName(t("setIntervalName"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.step = "1";
				text
					.setValue(String(s.autoSyncInterval))
					.onChange(async (value) => {
						s.autoSyncInterval = Math.max(
							1,
							Math.floor(Number(value) || 10)
						);
						await this.plugin.saveSettings();
						this.plugin.applyAutoSync();
					});
				// Re-sync the field to the stored (coerced) value on blur.
				text.inputEl.addEventListener("blur", () => {
					text.setValue(String(s.autoSyncInterval));
				});
			});
		intervalEl = intervalSetting.settingEl;
		intervalEl.toggleClass("gitsync-hidden", !s.autoSyncEnabled);

		// --- 3. Commits ---
		new Setting(containerEl).setName(t("headCommits")).setHeading();

		new Setting(containerEl)
			.setName(t("setAuthorNameName"))
			.addText((text) =>
				text.setValue(s.authorName).onChange(async (value) => {
					s.authorName = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("setAuthorEmailName"))
			.addText((text) =>
				text.setValue(s.authorEmail).onChange(async (value) => {
					s.authorEmail = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("setCommitMsgName"))
			.setDesc(t("setCommitMsgDesc"))
			.addText((text) =>
				text.setValue(s.commitMessage).onChange(async (value) => {
					s.commitMessage = value;
					await this.plugin.saveSettings();
				})
			);

		// --- 4. Repository ---
		new Setting(containerEl).setName(t("headRepo")).setHeading();

		new Setting(containerEl)
			.setName(t("setEngineName"))
			.setDesc(t("setEngineDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("auto", t("engineAuto"))
					.addOption("git", t("engineGit"))
					.addOption("api", t("engineApi"))
					.setValue(s.syncEngine)
					.onChange(async (value) => {
						s.syncEngine = value as GitSyncSettings["syncEngine"];
						await this.plugin.saveSettings();
						// Re-render so the Initialize row reflects whether the
						// effective engine is API (where init isn't needed).
						this.display();
					})
			);

		const exclude = new Setting(containerEl)
			.setName(t("setExcludeName"))
			.setDesc(t("setExcludeDesc"))
			.addTextArea((ta) => {
				ta.setValue(s.excludePaths).onChange(async (value) => {
					s.excludePaths = value;
					await this.plugin.saveSettings();
				});
				ta.inputEl.rows = 10;
				ta.inputEl.addClass("gitsync-exclude-textarea");
			});
		// Stack the textarea full-width below its label.
		exclude.settingEl.addClass("gitsync-setting-stacked");

		const initSetting = new Setting(containerEl)
			.setName(t("setInitName"))
			.setDesc(t("setInitDesc"))
			.addButton((b) => {
				b.buttonEl.addClass("mod-warning");
				return b
					.setButtonText(t("setInitButton"))
					.onClick(() => {
						void (async () => {
							if (!s.remoteUrl || !s.token) {
								new Notice(t("noticeInitNeed"));
								return;
							}
							b.setDisabled(true).setButtonText(
								t("setInitWorking")
							);
							try {
								await this.plugin.git.initialize((msg) =>
									new Notice(`Git Vault Sync: ${msg}`)
								);
								new Notice(t("noticeInitReady"));
							} catch (err) {
								console.error(
									"Git Vault Sync initialize failed",
									err
								);
								new Notice(
									t("noticeInitFailed", {
										msg: (err as Error).message,
									})
								);
							} finally {
								b.setDisabled(false).setButtonText(
									t("setInitButton")
								);
							}
						})();
					});
			});
		// Under the API engine the first Sync establishes state from an empty
		// baseline — there's no repo to init/clone — so hide the button.
		initSetting.settingEl.toggleClass(
			"gitsync-hidden",
			this.plugin.effectiveEngine() === "api"
		);

		new Setting(containerEl)
			.setName(t("setLangName"))
			.setDesc(t("setLangDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("auto", t("langAuto"))
					.addOption("en", t("langEn"))
					.addOption("ru", t("langRu"))
					.setValue(s.language)
					.onChange(async (value) => {
						s.language = value as LangPref;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (scroller) scroller.scrollTop = prevScroll;
	}

	/** Nearest scrollable ancestor of the settings content (or null). */
	private scrollContainer(): HTMLElement | null {
		let el: HTMLElement | null = this.containerEl;
		while (el) {
			const overflowY = getComputedStyle(el).overflowY;
			if (
				(overflowY === "auto" || overflowY === "scroll") &&
				el.scrollHeight > el.clientHeight
			) {
				return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	/**
	 * Remote URL chooser. Before authorization (no fetched repos) this is a
	 * plain manual text field so the setting still works standalone. After
	 * authorization it's a dropdown of the user's repositories plus an "enter
	 * manually" option; picking that reveals the manual text field.
	 */
	private renderRemoteSetting(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const hasRepos = this.repos.length > 0;

		// Decide whether to show the manual field. With no repos there's nothing
		// to pick, so always manual. With repos, manual unless the current URL
		// matches a known repo (then default to dropdown selection of it).
		const matchesRepo = this.repos.some((r) => r.cloneUrl === s.remoteUrl);
		const showManual = hasRepos ? this.remoteManual || !matchesRepo : true;

		// The manual text field is created up front so the dropdown can reveal
		// it without a full re-render (avoids scroll jump).
		let manualText: TextComponent | null = null;
		let manualEl: HTMLElement | null = null;
		let updateRemoteHint = () => {};

		if (hasRepos) {
			new Setting(containerEl)
				.setName(t("remoteSelectName"))
				.setDesc(t("remoteSelectDesc"))
				.addDropdown((dd: DropdownComponent) => {
					for (const r of this.repos) {
						const label = r.private
							? `🔒 ${r.fullName}`
							: r.fullName;
						dd.addOption(r.cloneUrl, label);
					}
					dd.addOption(REMOTE_MANUAL, t("remoteManual"));
					dd.setValue(showManual ? REMOTE_MANUAL : s.remoteUrl);
					dd.onChange(async (value) => {
						if (value === REMOTE_MANUAL) {
							this.remoteManual = true;
							manualEl?.toggleClass("gitsync-hidden", false);
							manualText?.inputEl.focus();
							return;
						}
						this.remoteManual = false;
						manualEl?.toggleClass("gitsync-hidden", true);
						s.remoteUrl = value;
						this.branchesFetched = false;
						this.remoteBranches = [];
						await this.plugin.saveSettings();
					});
				});
		}

		const remoteSetting = new Setting(containerEl)
			.setName(t("setRemoteName"))
			.setDesc(t("setRemoteDesc"))
			.addText((text) => {
				manualText = text;
				text
					.setPlaceholder("https://github.com/user/vault.git")
					.setValue(s.remoteUrl)
					.onChange(async (value) => {
						s.remoteUrl = value.trim();
						// New remote → drop the old branch list and allow re-fetch.
						this.branchesFetched = false;
						this.remoteBranches = [];
						updateRemoteHint();
						await this.plugin.saveSettings();
					});
			});
		// Light, non-blocking hint for a clearly non-HTTPS / malformed URL. We
		// still save whatever is typed (the sync path surfaces real errors).
		const remoteHint = remoteSetting.descEl.createDiv({
			cls: "gitsync-setting-hint",
		});
		updateRemoteHint = () => {
			const msg = remoteUrlHint(s.remoteUrl);
			remoteHint.setText(msg ?? "");
			remoteHint.toggleClass("gitsync-hidden", !msg);
		};
		updateRemoteHint();

		manualEl = remoteSetting.settingEl;
		// Hide the manual field when a repo is selected from the dropdown.
		manualEl.toggleClass("gitsync-hidden", hasRepos && !showManual);
	}

	/** Branch chooser: dropdown of known/remote branches + refresh + create-new. */
	private renderBranchSetting(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const known = Array.from(
			new Set([s.branch, ...this.remoteBranches].filter(Boolean))
		);

		new Setting(containerEl)
			.setName(t("setBranchName"))
			.setDesc(t("setBranchDesc"))
			.addDropdown((dd) => {
				for (const b of known) dd.addOption(b, b);
				dd.addOption(NEW_BRANCH, t("branchNew"));
				dd.setValue(s.branch || "main").onChange(async (value) => {
					if (value === NEW_BRANCH) {
						this.creatingBranch = true;
						this.display();
						return;
					}
					s.branch = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip(t("branchRefresh"))
					.onClick(() => void this.fetchBranches(false))
			);

		if (this.creatingBranch) {
			const newBranchSetting = new Setting(containerEl)
				.setName(t("branchNewName"))
				.addText((text) =>
					text
						.setPlaceholder("feature/notes")
						.onChange(async (value) => {
							const name = value.trim();
							// Empty input: leave the existing branch untouched and
							// clear any error (don't save a blank name).
							if (!name) {
								updateBranchError(null);
								return;
							}
							if (!isValidBranchName(name)) {
								updateBranchError(t("branchInvalid"));
								return;
							}
							updateBranchError(null);
							s.branch = name;
							await this.plugin.saveSettings();
						})
				)
				.addExtraButton((b) =>
					b
						.setIcon("check")
						.setTooltip(t("branchDone"))
						.onClick(() => {
							this.creatingBranch = false;
							this.display();
						})
				);
			const branchError = newBranchSetting.descEl.createDiv({
				cls: "gitsync-setting-error",
			});
			const updateBranchError = (msg: string | null) => {
				branchError.setText(msg ?? "");
				branchError.toggleClass("gitsync-hidden", !msg);
			};
			updateBranchError(null);
		}
	}

	/** Fetch remote branch names; re-render on success. Silent skips notices. */
	private async fetchBranches(silent: boolean): Promise<void> {
		const s = this.plugin.settings;
		if (!s.remoteUrl || !s.token) {
			if (!silent) new Notice(t("noticeConfigure"));
			return;
		}
		if (!silent) new Notice(t("branchFetching"));
		try {
			this.remoteBranches = await this.plugin.git.testConnection();
			this.branchesFetched = true;
			this.display();
		} catch (err) {
			console.error("Git Vault Sync fetch branches failed", err);
			if (!silent)
				new Notice(t("noticeConnFailed", { msg: (err as Error).message }));
		}
	}
}

/**
 * Non-blocking sanity check for the remote URL. Returns a translated hint when
 * the value looks wrong (SSH URL or obvious junk), or null when it's plausible
 * or empty. Never blocks saving.
 */
function remoteUrlHint(url: string): string | null {
	const v = url.trim();
	if (!v) return null;
	// SSH-style remotes (git@host:owner/repo.git) aren't supported here.
	if (/^[\w.-]+@[\w.-]+:/.test(v) || v.startsWith("ssh://")) {
		return t("hintRemoteSsh");
	}
	if (!/^https?:\/\//i.test(v)) {
		return t("hintRemoteNotHttps");
	}
	// Past the scheme there should be a host with a dot (or at least a path).
	try {
		const parsed = new URL(v);
		if (!parsed.hostname || !parsed.hostname.includes(".")) {
			return t("hintRemoteNotHttps");
		}
	} catch {
		return t("hintRemoteNotHttps");
	}
	return null;
}

/**
 * Validate a Git branch (ref) name against the rules that matter here: no
 * whitespace, no `~^:?*[` or `..`, no leading/trailing slash, no `.lock`
 * suffix, no empty path components.
 */
function isValidBranchName(name: string): boolean {
	if (!name) return false;
	if (/\s/.test(name)) return false;
	if (/[~^:?*[\\]/.test(name)) return false;
	if (name.includes("..")) return false;
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.startsWith(".") || name.endsWith(".")) return false;
	if (name.endsWith(".lock")) return false;
	if (name.includes("//")) return false;
	if (name.includes("@{")) return false;
	// eslint-disable-next-line no-control-regex -- intentionally reject control chars (incl. NUL/DEL) that Git refs forbid
	if (/[\x00-\x20\x7f]/.test(name)) return false;
	return true;
}
