import { App, Modal, Notice, Setting } from "obsidian";
import {
	GitManager,
	MergeConflict,
	Resolution,
	SyncResult,
} from "./git";
import { t } from "./i18n";

type Choice = "local" | "remote" | "manual";

interface FileState {
	filepath: string;
	ours: string | null;
	theirs: string | null;
	choice: Choice;
	/** Editable content for the "manual" choice (pre-filled with markers). */
	manual: string;
}

/**
 * Lets the user resolve each conflicted file (keep local / keep remote / edit
 * manually), then finishes the merge and pushes via {@link GitManager.completeMerge}.
 */
export class ConflictModal extends Modal {
	private states: FileState[] = [];
	private finished = false;

	constructor(
		app: App,
		private readonly git: GitManager,
		private readonly conflict: MergeConflict,
		private readonly onResolved: (result: SyncResult) => void,
		private readonly onAborted: () => void
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText(t("cmTitle", { n: this.conflict.files.length }));
		contentEl.createEl("p", { text: t("cmIntro") });

		const loading = contentEl.createEl("p", { text: t("cmLoading") });
		for (const filepath of this.conflict.files) {
			const [ours, theirs, working] = await Promise.all([
				this.git.readVersion(this.conflict.oursOid, filepath),
				this.git.readVersion(this.conflict.theirsOid, filepath),
				this.git.readWorkingFile(filepath).catch(() => ""),
			]);
			this.states.push({
				filepath,
				ours,
				theirs,
				choice: "manual",
				manual: working,
			});
		}
		loading.remove();

		for (const state of this.states) {
			this.renderFile(contentEl, state);
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t("cmResolve"))
					.setCta()
					.onClick(() => void this.resolve(b.buttonEl))
			)
			.addButton((b) =>
				b.setButtonText(t("cmCancel")).onClick(() => void this.cancel())
			);
	}

	private renderFile(parent: HTMLElement, state: FileState) {
		parent.createEl("h3", { text: state.filepath });

		const editor = createDiv();
		const textarea = editor.createEl("textarea", {
			cls: "gitsync-conflict-editor",
		});
		textarea.value = state.manual;
		textarea.addEventListener("input", () => {
			state.manual = textarea.value;
		});

		new Setting(parent)
			.setName(t("cmResolution"))
			.addDropdown((dd) => {
				dd.addOption("manual", t("cmOptManual"))
					.addOption("local", t("cmOptLocal"))
					.addOption("remote", t("cmOptRemote"))
					.setValue(state.choice)
					.onChange((v) => {
						state.choice = v as Choice;
						editor.toggleClass(
							"gitsync-hidden",
							state.choice !== "manual"
						);
					});
			});

		// Read-only preview of both sides.
		const details = parent.createEl("details");
		details.createEl("summary", { text: t("cmShow") });
		const pre = details.createEl("pre", { cls: "gitsync-conflict-preview" });
		const del = t("cmDeleted");
		pre.setText(
			`===== ${t("cmOptLocal")} =====\n${state.ours ?? del}\n\n` +
				`===== ${t("cmOptRemote")} =====\n${state.theirs ?? del}`
		);

		parent.appendChild(editor);
	}

	private async resolve(button: HTMLButtonElement) {
		button.disabled = true;
		button.setText(t("cmSyncing"));
		try {
			const resolutions = new Map<string, Resolution>();
			for (const s of this.states) {
				if (s.choice === "manual") {
					resolutions.set(s.filepath, {
						type: "manual",
						content: s.manual,
					});
				} else {
					resolutions.set(s.filepath, { type: s.choice });
				}
			}
			const result = await this.git.completeMerge(
				resolutions,
				this.conflict.oursOid,
				this.conflict.theirsOid,
				this.conflict.branch,
				undefined,
				this.conflict.skipPaths,
				this.conflict.snapshot
			);
			this.finished = true;
			this.onResolved(result);
			this.close();
		} catch (err) {
			console.error("GitSync completeMerge failed", err);
			new Notice(t("noticeResolveFailed", { msg: (err as Error).message }));
			button.disabled = false;
			button.setText(t("cmResolve"));
		}
	}

	private async cancel() {
		this.finished = true;
		try {
			await this.git.abortMerge(this.conflict.branch);
		} catch (err) {
			console.error("GitSync abortMerge failed", err);
		}
		this.onAborted();
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		// If dismissed without resolving, abort so the vault isn't left half-merged.
		if (!this.finished) {
			void this.git.abortMerge(this.conflict.branch).then(
				() => this.onAborted(),
				(err) => console.error("GitSync abortMerge failed", err)
			);
		}
	}
}
