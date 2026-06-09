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

export class GitSyncSettingTab extends PluginSettingTab {
	plugin: GitSyncPlugin;

	constructor(app: App, plugin: GitSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("setRemoteName"))
			.setDesc(t("setRemoteDesc"))
			.addText((text) =>
				text
					.setPlaceholder("https://github.com/user/vault.git")
					.setValue(this.plugin.settings.remoteUrl)
					.onChange(async (value) => {
						this.plugin.settings.remoteUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setBranchName"))
			.setDesc(t("setBranchDesc"))
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim() || "main";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: t("headAuth") });

		new Setting(containerEl)
			.setName(t("setUserName"))
			.setDesc(t("setUserDesc"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setTokenName"))
			.setDesc(t("setTokenDesc"))
			.addText((text) => {
				text
					.setPlaceholder("ghp_...")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		containerEl.createEl("h3", { text: t("headCommits") });

		new Setting(containerEl)
			.setName(t("setAuthorNameName"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setAuthorEmailName"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.authorEmail)
					.onChange(async (value) => {
						this.plugin.settings.authorEmail = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setCommitMsgName"))
			.setDesc(t("setCommitMsgDesc"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.commitMessage)
					.onChange(async (value) => {
						this.plugin.settings.commitMessage = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: t("headAutoSync") });

		new Setting(containerEl)
			.setName(t("setStartupName"))
			.setDesc(t("setStartupDesc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setTimerName"))
			.setDesc(t("setTimerDesc"))
			.addToggle((tg) =>
				tg
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.applyAutoSync();
					})
			);

		new Setting(containerEl)
			.setName(t("setIntervalName"))
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const n = Math.max(1, Number(value) || 10);
						this.plugin.settings.autoSyncInterval = n;
						await this.plugin.saveSettings();
						this.plugin.applyAutoSync();
					});
			});

		new Setting(containerEl)
			.setName(t("setExcludeName"))
			.setDesc(t("setExcludeDesc"))
			.addTextArea((ta) => {
				ta.setValue(this.plugin.settings.excludePaths).onChange(
					async (value) => {
						this.plugin.settings.excludePaths = value;
						await this.plugin.saveSettings();
					}
				);
				ta.inputEl.rows = 6;
				ta.inputEl.addClass("gitsync-exclude-textarea");
			});

		containerEl.createEl("h3", { text: t("headRepo") });

		new Setting(containerEl)
			.setName(t("setLangName"))
			.setDesc(t("setLangDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("auto", t("langAuto"))
					.addOption("en", t("langEn"))
					.addOption("ru", t("langRu"))
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as LangPref;
						await this.plugin.saveSettings();
						this.display(); // re-render in the new language
					})
			);

		new Setting(containerEl)
			.setName(t("setInitName"))
			.setDesc(t("setInitDesc"))
			.addButton((b) =>
				b
					.setButtonText(t("setInitButton"))
					.setWarning()
					.onClick(async () => {
						if (
							!this.plugin.settings.remoteUrl ||
							!this.plugin.settings.token
						) {
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
	}
}
