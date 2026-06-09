import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitSyncPlugin from "./main";
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
	excludePaths: [
		".obsidian/workspace.json",
		".obsidian/workspace-mobile.json",
		".DS_Store",
		".trash/",
	].join("\n"),
	language: "auto",
};

const NEW_BRANCH = "__gitsync_new_branch__";

export class GitSyncSettingTab extends PluginSettingTab {
	plugin: GitSyncPlugin;
	/** Branch names fetched from the remote (for the branch dropdown). */
	private remoteBranches: string[] = [];
	private branchesFetched = false;
	private creatingBranch = false;

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

		// --- 1. Authentication / connection ---
		containerEl.createEl("h3", { text: t("headAuth") });

		new Setting(containerEl)
			.setName(t("setRemoteName"))
			.setDesc(t("setRemoteDesc"))
			.addText((text) =>
				text
					.setPlaceholder("https://github.com/user/vault.git")
					.setValue(s.remoteUrl)
					.onChange(async (value) => {
						s.remoteUrl = value.trim();
						// New remote → drop the old branch list and allow re-fetch.
						this.branchesFetched = false;
						this.remoteBranches = [];
						await this.plugin.saveSettings();
					})
			);

		this.renderBranchSetting(containerEl);

		new Setting(containerEl)
			.setName(t("setUserName"))
			.setDesc(t("setUserDesc"))
			.addText((text) =>
				text.setValue(s.username).onChange(async (value) => {
					s.username = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("setTokenName"))
			.setDesc(t("setTokenDesc"))
			.addText((text) => {
				text
					.setPlaceholder("ghp_...")
					.setValue(s.token)
					.onChange(async (value) => {
						s.token = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		// --- 2. Automatic sync ---
		containerEl.createEl("h3", { text: t("headAutoSync") });

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
				text.inputEl.addEventListener("blur", () =>
					text.setValue(String(s.autoSyncInterval))
				);
			});
		intervalEl = intervalSetting.settingEl;
		intervalEl.toggleClass("gitsync-hidden", !s.autoSyncEnabled);

		// --- 3. Commits ---
		containerEl.createEl("h3", { text: t("headCommits") });

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
		containerEl.createEl("h3", { text: t("headRepo") });

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

		new Setting(containerEl)
			.setName(t("setInitName"))
			.setDesc(t("setInitDesc"))
			.addButton((b) =>
				b
					.setButtonText(t("setInitButton"))
					.setWarning()
					.onClick(async () => {
						if (!s.remoteUrl || !s.token) {
							new Notice(t("noticeInitNeed"));
							return;
						}
						b.setDisabled(true).setButtonText(t("setInitWorking"));
						try {
							await this.plugin.git.initialize((msg) =>
								new Notice(`GitSync: ${msg}`)
							);
							new Notice(t("noticeInitReady"));
						} catch (err) {
							console.error("GitSync initialize failed", err);
							new Notice(
								t("noticeInitFailed", {
									msg: (err as Error).message,
								})
							);
						} finally {
							b.setDisabled(false).setButtonText(t("setInitButton"));
						}
					})
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
			new Setting(containerEl)
				.setName(t("branchNewName"))
				.addText((text) =>
					text
						.setPlaceholder("feature/notes")
						.onChange(async (value) => {
							const name = value.trim();
							if (name) {
								s.branch = name;
								await this.plugin.saveSettings();
							}
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
			console.error("GitSync fetch branches failed", err);
			if (!silent)
				new Notice(t("noticeConnFailed", { msg: (err as Error).message }));
		}
	}
}
