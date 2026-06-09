import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

/**
 * One conflicting file, with both sides' content already resolved to bytes by
 * the caller. `null` on a side means the file was deleted there. The API engine
 * never holds content itself, so the plugin fetches the remote blob and reads
 * the local file before opening this modal.
 */
export interface ApiConflictFile {
	path: string;
	localContent: Uint8Array | null;
	remoteContent: Uint8Array | null;
}

type Choice = "local" | "remote" | "manual";

const TEXT_DECODER = new TextDecoder("utf-8");
const TEXT_ENCODER = new TextEncoder();

/** A NUL byte anywhere marks the content as binary (no manual text edit). */
function looksBinary(bytes: Uint8Array | null): boolean {
	if (!bytes) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

interface FileState {
	file: ApiConflictFile;
	/** Whether either side is binary — disables the manual-edit option. */
	binary: boolean;
	/** True if the file was deleted locally / remotely (frames the choices). */
	localDeleted: boolean;
	remoteDeleted: boolean;
	choice: Choice;
	/** Editable text for the "manual" choice; pre-filled with the local side. */
	manual: string;
}

/**
 * Interactive resolution UI for the experimental Git Data API sync. It mirrors
 * the structure and CSS of {@link ./conflict-modal.ts} (the isomorphic-git
 * path) but operates on READY content rather than a {@link GitManager}: each
 * side's bytes are supplied up front and the modal simply collects the chosen
 * result per file. This keeps the proven git conflict path untouched.
 *
 * Output (via {@link onResolved}): a `Map<path, Uint8Array | null>` of the
 * resolved content, where `null` means "delete this path". The caller passes it
 * to `commitResolutions`. Dismissing the modal without resolving calls
 * {@link onCancelled} and applies nothing.
 */
export class ApiConflictModal extends Modal {
	private states: FileState[] = [];
	private finished = false;
	onCloseHook?: () => void;

	constructor(
		app: App,
		private readonly files: ApiConflictFile[],
		private readonly onResolved: (
			resolved: Map<string, Uint8Array | null>
		) => void,
		private readonly onCancelled: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this;
		// Reuse the git conflict modal's classes so the scroll/footer layout and
		// styling apply unchanged.
		modalEl.addClass("gitsync-conflict-modal");
		titleEl.setText(t("acmTitle", { n: this.files.length }));

		const body = contentEl.createDiv({ cls: "gitsync-conflict-body" });
		body.createEl("p", { text: t("acmIntro") });

		for (const file of this.files) {
			const localDeleted = file.localContent === null;
			const remoteDeleted = file.remoteContent === null;
			const binary =
				looksBinary(file.localContent) || looksBinary(file.remoteContent);
			// Default: keep the remote side (matches "pull wins" expectations) for
			// delete/modify clashes; otherwise pre-select manual when editable so
			// the user reviews a merge, falling back to remote for binaries.
			let choice: Choice;
			if (binary || localDeleted || remoteDeleted) {
				choice = "remote";
			} else {
				choice = "manual";
			}
			const manual = file.localContent
				? TEXT_DECODER.decode(file.localContent)
				: file.remoteContent
				? TEXT_DECODER.decode(file.remoteContent)
				: "";
			const state: FileState = {
				file,
				binary,
				localDeleted,
				remoteDeleted,
				choice,
				manual,
			};
			this.states.push(state);
			this.renderFile(body, state);
		}

		const footer = contentEl.createDiv({ cls: "gitsync-conflict-footer" });
		new Setting(footer)
			.addButton((b) =>
				b
					.setButtonText(t("acmResolve"))
					.setCta()
					.onClick(() => this.resolve())
			)
			.addButton((b) =>
				b.setButtonText(t("acmCancel")).onClick(() => this.cancel())
			);
	}

	private renderFile(parent: HTMLElement, state: FileState) {
		parent.createEl("h3", { text: state.file.path });

		const editor = createDiv();
		const textarea = editor.createEl("textarea", {
			cls: "gitsync-conflict-editor",
		});
		textarea.value = state.manual;
		textarea.addEventListener("input", () => {
			state.manual = textarea.value;
		});

		// Frame each option per the kind of clash so the wording matches reality:
		// a deleted side reads "keep deleted" / "restore", not "use … version".
		const localLabel = state.localDeleted
			? t("acmLocalDeleted")
			: t("cmOptLocal");
		const remoteLabel = state.remoteDeleted
			? t("acmRemoteDeleted")
			: t("cmOptRemote");

		const setting = new Setting(parent).setName(t("cmResolution"));
		setting.addDropdown((dd) => {
			// Manual edit only makes sense for text on both available sides.
			if (!state.binary && !state.localDeleted && !state.remoteDeleted) {
				dd.addOption("manual", t("cmOptManual"));
			}
			dd.addOption("local", localLabel)
				.addOption("remote", remoteLabel)
				.setValue(state.choice)
				.onChange((v) => {
					state.choice = v as Choice;
					editor.toggleClass(
						"gitsync-hidden",
						state.choice !== "manual"
					);
				});
		});

		// Read-only preview of both sides (text shown decoded; binary noted).
		const details = parent.createEl("details");
		details.createEl("summary", { text: t("cmShow") });
		const pre = details.createEl("pre", {
			cls: "gitsync-conflict-preview",
		});
		pre.setText(
			`===== ${t("cmOptLocal")} =====\n${this.previewOf(
				state.file.localContent
			)}\n\n` +
				`===== ${t("cmOptRemote")} =====\n${this.previewOf(
					state.file.remoteContent
				)}`
		);

		editor.toggleClass("gitsync-hidden", state.choice !== "manual");
		parent.appendChild(editor);
	}

	/** Human-readable preview: text decoded, deletions and binaries labelled. */
	private previewOf(bytes: Uint8Array | null): string {
		if (bytes === null) return t("cmDeleted");
		if (looksBinary(bytes)) return t("acmBinary");
		return TEXT_DECODER.decode(bytes);
	}

	private resolve() {
		const resolved = new Map<string, Uint8Array | null>();
		for (const s of this.states) {
			let content: Uint8Array | null;
			switch (s.choice) {
				case "local":
					content = s.file.localContent;
					break;
				case "remote":
					content = s.file.remoteContent;
					break;
				default:
					// Manual: the edited text becomes the new content.
					content = TEXT_ENCODER.encode(s.manual);
					break;
			}
			resolved.set(s.file.path, content);
		}
		this.finished = true;
		this.onResolved(resolved);
		this.close();
	}

	private cancel() {
		this.finished = true;
		this.onCancelled();
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		this.onCloseHook?.();
		// Dismissed (Esc / click-outside) without choosing: treat as a cancel so
		// nothing is committed.
		if (!this.finished) {
			this.finished = true;
			this.onCancelled();
		}
	}
}
