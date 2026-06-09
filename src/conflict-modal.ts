import { App, Modal, Notice, Setting } from "obsidian";
import {
	GitManager,
	MergeConflict,
	Resolution,
	SyncResult,
} from "./git";

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
		titleEl.setText(
			`Resolve ${this.conflict.files.length} merge conflict(s)`
		);
		contentEl.createEl("p", {
			text: "For each file choose which version to keep, or edit the merged result manually.",
		});

		const loading = contentEl.createEl("p", { text: "Loading versions…" });
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
					.setButtonText("Resolve & sync")
					.setCta()
					.onClick(() => void this.resolve(b.buttonEl))
			)
			.addButton((b) =>
				b.setButtonText("Cancel (abort merge)").onClick(() => void this.cancel())
			);
	}

	private renderFile(parent: HTMLElement, state: FileState) {
		parent.createEl("h3", { text: state.filepath });

		const editor = createDiv();
		const textarea = editor.createEl("textarea", {
			cls: "obssync-conflict-editor",
		});
		textarea.value = state.manual;
		textarea.addEventListener("input", () => {
			state.manual = textarea.value;
		});

		new Setting(parent)
			.setName("Resolution")
			.addDropdown((dd) => {
				dd.addOption("manual", "Edit manually")
					.addOption("local", "Use local (ours)")
					.addOption("remote", "Use remote (theirs)")
					.setValue(state.choice)
					.onChange((v) => {
						state.choice = v as Choice;
						editor.toggleClass(
							"obssync-hidden",
							state.choice !== "manual"
						);
					});
			});

		// Read-only preview of both sides.
		const details = parent.createEl("details");
		details.createEl("summary", { text: "Show local / remote" });
		const pre = details.createEl("pre", { cls: "obssync-conflict-preview" });
		pre.setText(
			`===== LOCAL (ours) =====\n${state.ours ?? "(file deleted)"}\n\n` +
				`===== REMOTE (theirs) =====\n${state.theirs ?? "(file deleted)"}`
		);

		parent.appendChild(editor);
	}

	private async resolve(button: HTMLButtonElement) {
		button.disabled = true;
		button.setText("Syncing…");
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
			console.error("ObsSync completeMerge failed", err);
			new Notice(`ObsSync: resolve failed — ${(err as Error).message}`);
			button.disabled = false;
			button.setText("Resolve & sync");
		}
	}

	private async cancel() {
		this.finished = true;
		try {
			await this.git.abortMerge(this.conflict.branch);
		} catch (err) {
			console.error("ObsSync abortMerge failed", err);
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
				(err) => console.error("ObsSync abortMerge failed", err)
			);
		}
	}
}
