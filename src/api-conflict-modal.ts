import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";
import { keepModalAboveKeyboard, scrollIntoViewOnFocus } from "./mobile-keyboard";

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

/** Validate in bounded pieces: binary detection must not allocate a decoded
 * string as large as an attachment. Streaming preserves UTF-8 boundaries. */
function looksBinary(bytes: Uint8Array | null): boolean {
	if (!bytes) return false;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		for (let i = 0; i < bytes.length; i += 65536) {
			const part = bytes.subarray(i, i + 65536);
			if (part.includes(0)) return true;
			decoder.decode(part, { stream: true });
		}
		decoder.decode();
		return false;
	} catch { return true; }
}

interface FileState {
	file: ApiConflictFile;
	/** Whether either side is binary — disables the manual-edit option. */
	binary?: boolean;
	/** True if the file was deleted locally / remotely (frames the choices). */
	localDeleted: boolean;
	remoteDeleted: boolean;
	choice?: Choice;
	/** Editable text for the "manual" choice; pre-filled with the local side. */
	manual?: string;
}

/**
 * Interactive resolution UI for the Git Data API sync. It mirrors
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
	/** Only the current card exists in the DOM. Choices and edits survive navigation. */
	private step?: HTMLElement;
	private current = 0;
	private progressEl!: HTMLElement;
	private body!: HTMLElement;
	private footer!: HTMLElement;
	private cleanupKeyboard: () => void = () => {};
	onCloseHook?: () => void;
	onLifecycle?: (stage: string) => void;

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
		this.onLifecycle?.("conflict-modal-open");
		this.containerEl.addEventListener("keydown", event => {
			if (event.key === "Escape") this.onLifecycle?.("conflict-modal-escape-input");
		}, { capture: true });
		this.containerEl.addEventListener("pointerdown", event => {
			if (event.target instanceof Node && !this.modalEl.contains(event.target))
				this.onLifecycle?.("conflict-modal-outside-input");
		}, { capture: true });
		const { contentEl, titleEl, modalEl } = this;
		// Reuse the git conflict modal's classes so the scroll/footer layout and
		// styling apply unchanged.
		modalEl.addClass("gitsync-conflict-modal");
		titleEl.setText(t("acmTitle", { n: this.files.length }));

		const body = contentEl.createDiv({ cls: "gitsync-conflict-body" });
		this.body = body;
		// One conflict per step: a progress line + short intro stay pinned at the
		// top, while each file's editor lives in its own card shown one at a time.
		this.progressEl = body.createEl("p", {
			cls: "gitsync-conflict-progress",
		});
		body.createEl("p", { text: t("acmIntro"), cls: "gitsync-conflict-intro" });

		this.states = this.files.map(file => ({ file,
			localDeleted: file.localContent === null, remoteDeleted: file.remoteContent === null }));

		this.footer = contentEl.createDiv({ cls: "gitsync-conflict-footer" });
		this.showStep(0);

		// Keep the active editor reachable above the on-screen keyboard (mobile).
		this.cleanupKeyboard = keepModalAboveKeyboard(this.containerEl, modalEl);
		this.onLifecycle?.("conflict-modal-rendered");
	}

	/** Show a single conflict step and rebuild the navigation footer for it. */
	private showStep(index: number) {
		this.current = index;
		this.step?.remove();
		this.renderFile(this.body, this.states[index]);
		this.progressEl.setText(t("cmProgress", { i: index + 1, n: this.states.length }));
		this.progressEl.toggleClass("gitsync-hidden", this.states.length <= 1);
		this.body.scrollTop = 0;
		this.renderFooter();
	}

	private renderFooter() {
		this.footer.empty();
		const nav = this.footer.createDiv({ cls: "gitsync-wizard-nav" });
		const isLast = this.current === this.states.length - 1;
		if (this.current > 0) {
			const back = nav.createEl("button", { text: t("cmBack") });
			back.addEventListener("click", () => this.showStep(this.current - 1));
		}
		if (!isLast) {
			const next = nav.createEl("button", { text: t("cmNext") });
			next.addEventListener("click", () => this.showStep(this.current + 1));
		}
		const done = nav.createEl("button", {
			text: t("cmResolve"),
			cls: "mod-cta",
		});
		done.disabled = this.states.some(state => state.choice === undefined);
		if (done.disabled) this.footer.createEl("p", { text: t("apiReviewAll") });
		done.addEventListener("click", () => this.resolve());
		if (this.states.length > 1) {
			const bulk = this.footer.createDiv({ cls: "gitsync-conflict-bulk" });
			for (const choice of ["local", "remote"] as const) {
				const button = bulk.createEl("button", {
					text: t(choice === "local" ? "cmAllLocal" : "cmAllRemote"),
				});
				button.addEventListener("click", () => this.selectAll(choice));
			}
		}
	}

	private selectAll(choice: "local" | "remote") {
		for (const state of this.states) state.choice = choice;

		this.showStep(this.current);
	}

	private renderFile(parent: HTMLElement, state: FileState) {
		const step = parent.createDiv({ cls: "gitsync-conflict-step" });
		this.step = step;
		if (state.binary === undefined) state.binary = looksBinary(state.file.localContent) || looksBinary(state.file.remoteContent);
		if (state.choice === undefined) state.choice = state.binary || state.localDeleted || state.remoteDeleted ? "remote" : "manual";
		if (!state.binary && !state.localDeleted && !state.remoteDeleted && state.manual === undefined)
			state.manual = TEXT_DECODER.decode(state.file.localContent!);
		step.createEl("h3", { text: state.file.path });

		const editor = createDiv();
		if (!state.binary && !state.localDeleted && !state.remoteDeleted) {
			const textarea = editor.createEl("textarea", { cls: "gitsync-conflict-editor" });
			textarea.value = state.manual ?? "";
			textarea.addEventListener("input", () => { state.manual = textarea.value; });
			scrollIntoViewOnFocus(textarea);
		}

		// Frame each option per the kind of clash so the wording matches reality:
		// a deleted side reads "keep deleted" / "restore", not "use … version".
		const localLabel = state.localDeleted
			? t("acmLocalDeleted")
			: t("cmOptLocal");
		const remoteLabel = state.remoteDeleted
			? t("acmRemoteDeleted")
			: t("cmOptRemote");

		const setting = new Setting(step).setName(t("cmResolution"));
		setting.addDropdown((dd) => {
			// Manual edit only makes sense for text on both available sides.
			if (!state.binary && !state.localDeleted && !state.remoteDeleted) {
				dd.addOption("manual", t("cmOptManual"));
			}
			dd.addOption("local", localLabel)
				.addOption("remote", remoteLabel)
				.setValue(state.choice!)
				.onChange((v) => {
					state.choice = v as Choice;
					editor.toggleClass(
						"gitsync-hidden",
						state.choice !== "manual"
					);
				});
		});

		// Editor sits directly under the resolution dropdown (above the preview).
		editor.toggleClass("gitsync-hidden", state.choice !== "manual");
		step.appendChild(editor);

		// Read-only preview of both sides (text shown decoded; binary noted).
		const details = step.createEl("details");
		details.createEl("summary", { text: t("cmShow") });
		const pre = details.createEl("pre", {
			cls: "gitsync-conflict-preview",
		});
		let previewed = false;
		details.addEventListener("toggle", () => {
			if (!details.open || previewed) return;
			previewed = true;
			pre.setText(`===== ${t("cmOptLocal")} =====\n${this.previewOf(state.file.localContent)}\n\n` +
				`===== ${t("cmOptRemote")} =====\n${this.previewOf(state.file.remoteContent)}`);
		});
	}

	/** Human-readable preview: text decoded, deletions and binaries labelled. */
	private previewOf(bytes: Uint8Array | null): string {
		if (bytes === null) return t("cmDeleted");
		if (looksBinary(bytes)) return t("acmBinary");
		const prefix = bytes.subarray(0, 16384);
		return TEXT_DECODER.decode(prefix) + (bytes.length > prefix.length ? "\n" + t("apiPreviewTruncated") : "");
	}

	private resolve() {
		if (this.finished || this.states.some(state => state.choice === undefined)) return;
		this.onLifecycle?.("conflict-modal-submit");
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
					content = TEXT_ENCODER.encode(s.manual ?? "");
					break;
			}
			resolved.set(s.file.path, content);
		}
		this.finished = true;
		this.onResolved(resolved);
		this.close();
	}

	onClose() {
		this.onLifecycle?.(this.finished ? "conflict-modal-close-resolved" : "conflict-modal-close-unresolved");
		this.cleanupKeyboard();
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
