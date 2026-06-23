import { Platform } from "obsidian";

/**
 * Keep a modal usable while the on-screen keyboard is open on mobile.
 *
 * The default Obsidian modal is centred in the *layout* viewport and sized in
 * `vh`, neither of which shrinks when the soft keyboard appears — so a focused
 * field (e.g. the conflict editor's textarea) ends up hidden behind the
 * keyboard. We listen to `visualViewport` (which *does* track the keyboard) and
 * constrain the modal's *container* to the visible area, aligning the modal to
 * its top. Crucially we never touch the modal's own horizontal positioning —
 * Obsidian centres it (and animates it) with its own transform, so overriding
 * `left`/`transform` would fight that and shove the modal off-screen.
 *
 * Desktop is left completely untouched (no-op). Returns a cleanup function that
 * removes the listeners and restores the inline styles; call it on modal close.
 */
export function keepModalAboveKeyboard(
	containerEl: HTMLElement,
	modalEl: HTMLElement,
	contentEl: HTMLElement
): () => void {
	if (!Platform.isMobile) return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const GAP = 8; // breathing room above the modal, in px

	const apply = () => {
		// Shrink the (full-screen, flex-centring) container down to just the
		// visible region and pin the modal to its top. Horizontal centring,
		// driven by the container's own `justify-content`, is left intact.
		containerEl.style.height = `${Math.round(vv.height)}px`;
		containerEl.style.top = `${Math.round(vv.offsetTop)}px`;
		containerEl.style.alignItems = "flex-start";
		containerEl.style.paddingTop = `${GAP}px`;
		// Bound the modal so a tall one scrolls internally instead of growing
		// past the keyboard.
		const max = `${Math.round(vv.height) - GAP * 2}px`;
		modalEl.style.maxHeight = max;
		contentEl.style.maxHeight = max;
	};

	apply();
	vv.addEventListener("resize", apply);
	vv.addEventListener("scroll", apply);

	return () => {
		vv.removeEventListener("resize", apply);
		vv.removeEventListener("scroll", apply);
		containerEl.style.height = "";
		containerEl.style.top = "";
		containerEl.style.alignItems = "";
		containerEl.style.paddingTop = "";
		modalEl.style.maxHeight = "";
		contentEl.style.maxHeight = "";
	};
}

/**
 * When a text field gains focus on mobile, scroll it into the centre of the
 * visible area after the keyboard has finished animating in. No-op on desktop.
 */
export function scrollIntoViewOnFocus(field: HTMLElement): void {
	if (!Platform.isMobile) return;
	field.addEventListener("focus", () => {
		// Delay so the keyboard is up and the viewport has resized first.
		window.setTimeout(() => {
			field.scrollIntoView({ block: "center" });
		}, 250);
	});
}
