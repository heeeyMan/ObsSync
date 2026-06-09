import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsSyncPlugin from "./main";

export interface ObsSyncSettings {
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
	/** Newline-separated glob patterns of files ObsSync should never sync. */
	excludePaths: string;
}

export const DEFAULT_SETTINGS: ObsSyncSettings = {
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
};

export class ObsSyncSettingTab extends PluginSettingTab {
	plugin: ObsSyncPlugin;

	constructor(app: App, plugin: ObsSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Remote URL")
			.setDesc("HTTPS URL of the Git repository, e.g. https://github.com/user/vault.git")
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
			.setName("Branch")
			.setDesc("Branch to sync against.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim() || "main";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Authentication" });

		new Setting(containerEl)
			.setName("Username")
			.setDesc("Your GitHub username.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Personal Access Token")
			.setDesc("Stored in plaintext in this plugin's data.json. Use a fine-grained token scoped to this repo.")
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

		containerEl.createEl("h3", { text: "Commits" });

		new Setting(containerEl)
			.setName("Author name")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Author email")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.authorEmail)
					.onChange(async (value) => {
						this.plugin.settings.authorEmail = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Commit message")
			.setDesc("Template for sync commits. {{date}} is replaced with the current timestamp.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.commitMessage)
					.onChange(async (value) => {
						this.plugin.settings.commitMessage = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Automatic sync" });

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a sync once when Obsidian loads.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync on a timer")
			.setDesc("Periodically sync in the background.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.applyAutoSync();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
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
			.setName("Excluded paths")
			.setDesc(
				"One glob per line. Matching files are never committed or counted (e.g. noisy .obsidian state). Use * within a folder and ** across folders; a trailing / matches a whole folder."
			)
			.addTextArea((ta) => {
				ta.setValue(this.plugin.settings.excludePaths).onChange(
					async (value) => {
						this.plugin.settings.excludePaths = value;
						await this.plugin.saveSettings();
					}
				);
				ta.inputEl.rows = 6;
				ta.inputEl.addClass("obssync-exclude-textarea");
			});

		containerEl.createEl("h3", { text: "Repository" });

		new Setting(containerEl)
			.setName("Initialize / link repository")
			.setDesc(
				"Set up Git in this vault: init if needed, link the remote above, fetch and check out its branch. Use this on a fresh vault."
			)
			.addButton((b) =>
				b
					.setButtonText("Initialize")
					.setWarning()
					.onClick(async () => {
						if (
							!this.plugin.settings.remoteUrl ||
							!this.plugin.settings.token
						) {
							new Notice(
								"ObsSync: set remote URL and token first"
							);
							return;
						}
						b.setDisabled(true).setButtonText("Working…");
						try {
							await this.plugin.git.initialize((msg) =>
								new Notice(`ObsSync: ${msg}`)
							);
							new Notice("ObsSync: repository ready");
						} catch (err) {
							console.error("ObsSync initialize failed", err);
							new Notice(
								`ObsSync: init failed — ${(err as Error).message}`
							);
						} finally {
							b.setDisabled(false).setButtonText("Initialize");
						}
					})
			);
	}
}
