import { App, Modal, Notice } from "obsidian";
import { t } from "./i18n";

/** A recorded sync failure, kept by the plugin so the user can inspect it. */
export interface SyncErrorInfo {
	/** The user-facing (possibly generic) message that was shown as a Notice. */
	message: string;
	/** Full detail: the raw error chain + stack, for diagnosis/copying. */
	detail: string;
	/** Epoch ms when it happened. */
	when: number;
}

/**
 * Shows the last sync error in a dismissible, selectable, copyable dialog —
 * unlike the transient Notice, which auto-hides and only shows the mapped
 * (often generic) message. The detail carries the raw error chain so the true
 * cause (e.g. a payload-too-large push behind a generic "network" message) is
 * visible.
 */
export class ErrorDetailModal extends Modal {
	constructor(app: App, private readonly info: SyncErrorInfo) {
		super(app);
	}

	onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText(t("errModalTitle"));

		contentEl.createEl("p", {
			text: this.info.message,
			cls: "gitsync-error-message",
		});
		contentEl.createEl("p", {
			text: t("errModalWhen", { when: new Date(this.info.when).toLocaleString() }),
			cls: "gitsync-error-when",
		});

		contentEl.createEl("p", { text: t("errModalDetail") });
		const pre = contentEl.createEl("pre", { cls: "gitsync-error-detail" });
		pre.setText(this.info.detail || this.info.message);

		contentEl.createEl("p", {
			text: t("errModalHint"),
			cls: "gitsync-error-hint",
		});

		const nav = contentEl.createDiv({ cls: "gitsync-wizard-nav" });
		const copy = nav.createEl("button", {
			text: t("errModalCopy"),
			cls: "mod-cta",
		});
		copy.addEventListener("click", () => void this.copyDetails());
		const close = nav.createEl("button", { text: t("errModalClose") });
		close.addEventListener("click", () => this.close());
	}

	private async copyDetails() {
		const text = `${this.info.message}\n\n${this.info.detail}`;
		try {
			await navigator.clipboard.writeText(text);
			new Notice(t("errModalCopied"));
		} catch {
			// Clipboard API can be unavailable (e.g. mobile); the <pre> is
			// selectable, so the user can still copy manually.
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
