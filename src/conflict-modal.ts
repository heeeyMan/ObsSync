import { App, Modal, Notice, Setting } from "obsidian";
import {
	GitManager,
	MergeConflict,
	Resolution,
	SyncResult,
} from "./git";
import { t } from "./i18n";
import { keepModalAboveKeyboard, scrollIntoViewOnFocus } from "./mobile-keyboard";

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
	/** True while completeMerge is running, to block a racing abort on close. */
	private resolving = false;
	/** One rendered card per conflicting file; only the current one is shown. */
	private steps: HTMLElement[] = [];
	private current = 0;
	private progressEl!: HTMLElement;
	private body!: HTMLElement;
	private footer!: HTMLElement;
	private cleanupKeyboard: () => void = () => {};
	/** Optional callback invoked once when the modal closes (used by the plugin
	 *  to drop its reference). */
	onCloseHook?: () => void;

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
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("gitsync-conflict-modal");
		titleEl.setText(t("cmTitle", { n: this.conflict.files.length }));

		// Scrollable body holds a pinned progress line + intro and one file card
		// at a time (a wizard); the footer with the navigation buttons is pinned
		// below so it stays reachable on mobile.
		const body = contentEl.createDiv({ cls: "gitsync-conflict-body" });
		this.body = body;
		this.progressEl = body.createEl("p", {
			cls: "gitsync-conflict-progress",
		});
		body.createEl("p", { text: t("cmIntro"), cls: "gitsync-conflict-intro" });

		const loading = body.createEl("p", { text: t("cmLoading") });
		try {
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
		} catch (err) {
			loading.setText(t("cmFailed", { msg: (err as Error).message }));
			return;
		}
		loading.remove();

		for (const state of this.states) {
			this.renderFile(body, state);
		}

		this.footer = contentEl.createDiv({ cls: "gitsync-conflict-footer" });
		this.showStep(0);

		// Keep the active editor reachable above the on-screen keyboard (mobile).
		this.cleanupKeyboard = keepModalAboveKeyboard(modalEl, contentEl);
	}

	/** Show a single conflict step and rebuild the navigation footer for it. */
	private showStep(index: number) {
		this.current = index;
		this.steps.forEach((step, i) =>
			step.toggleClass("gitsync-hidden", i !== index)
		);
		this.progressEl.setText(
			t("cmProgress", { i: index + 1, n: this.steps.length })
		);
		this.progressEl.toggleClass("gitsync-hidden", this.steps.length <= 1);
		this.body.scrollTop = 0;
		this.renderFooter();
	}

	private renderFooter() {
		this.footer.empty();
		const nav = this.footer.createDiv({ cls: "gitsync-wizard-nav" });
		const isLast = this.current === this.steps.length - 1;
		if (this.current > 0) {
			const back = nav.createEl("button", { text: t("cmBack") });
			back.addEventListener("click", () => this.showStep(this.current - 1));
		}
		if (isLast) {
			const done = nav.createEl("button", {
				text: t("cmResolve"),
				cls: "mod-cta",
			});
			done.addEventListener("click", () => void this.resolve(done));
		} else {
			const next = nav.createEl("button", {
				text: t("cmNext"),
				cls: "mod-cta",
			});
			next.addEventListener("click", () => this.showStep(this.current + 1));
		}
	}

	private renderFile(parent: HTMLElement, state: FileState) {
		const step = parent.createDiv({ cls: "gitsync-conflict-step" });
		this.steps.push(step);
		step.createEl("h3", { text: state.filepath });

		const editor = createDiv();
		const textarea = editor.createEl("textarea", {
			cls: "gitsync-conflict-editor",
		});
		textarea.value = state.manual;
		textarea.addEventListener("input", () => {
			state.manual = textarea.value;
		});
		scrollIntoViewOnFocus(textarea);

		new Setting(step)
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

		// Editor sits directly under the resolution dropdown (above the preview).
		step.appendChild(editor);

		// Read-only preview of both sides.
		const details = step.createEl("details");
		details.createEl("summary", { text: t("cmShow") });
		const pre = details.createEl("pre", { cls: "gitsync-conflict-preview" });
		const del = t("cmDeleted");
		pre.setText(
			`===== ${t("cmOptLocal")} =====\n${state.ours ?? del}\n\n` +
				`===== ${t("cmOptRemote")} =====\n${state.theirs ?? del}`
		);
	}

	private async resolve(button: HTMLButtonElement) {
		button.disabled = true;
		button.setText(t("cmSyncing"));
		this.resolving = true;
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
			console.error("Git Vault Sync completeMerge failed", err);
			new Notice(t("noticeResolveFailed", { msg: (err as Error).message }));
			button.disabled = false;
			button.setText(t("cmResolve"));
		} finally {
			this.resolving = false;
		}
	}

	onClose() {
		this.cleanupKeyboard();
		this.contentEl.empty();
		this.onCloseHook?.();
		// Dismissed (Esc/click-outside) without resolving and not mid-resolve:
		// abort so the vault isn't left half-merged. Restore deselected edits
		// the merge overwrote.
		if (!this.finished && !this.resolving) {
			this.finished = true;
			void this.abortAndRestore().then(() => this.onAborted());
		}
	}

	/** Abort the merge and restore any deselected-file snapshot. */
	private async abortAndRestore(): Promise<void> {
		try {
			await this.git.abortMerge(
				this.conflict.branch,
				this.conflict.snapshot
			);
		} catch (err) {
			console.error("Git Vault Sync abortMerge failed", err);
		}
	}
}
