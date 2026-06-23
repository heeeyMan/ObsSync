import { Platform } from "obsidian";

/**
 * Keep a modal usable while the on-screen keyboard is open on mobile.
 *
 * The default Obsidian modal is centred in the *layout* viewport and sized in
 * `vh`, neither of which shrinks when the soft keyboard appears — so a focused
 * field (e.g. the conflict editor's textarea) ends up hidden behind the
 * keyboard. We listen to `visualViewport` (which *does* track the keyboard) and
 * pin the modal to the top of the currently-visible area, bounding its height
 * to what's actually on screen. The inner scroll container plus a
 * `scrollIntoView` on focus then keep the active field reachable.
 *
 * Desktop is left completely untouched (no-op). Returns a cleanup function that
 * removes the listeners and restores the inline styles; call it on modal close.
 */
export function keepModalAboveKeyboard(
	modalEl: HTMLElement,
	contentEl: HTMLElement
): () => void {
	if (!Platform.isMobile) return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const GAP = 8; // breathing room above/below the modal, in px

	const apply = () => {
		// `position: fixed` is relative to the layout viewport, so offset by the
		// visual viewport's own offset to land at the top of the visible region.
		modalEl.style.position = "fixed";
		modalEl.style.top = `${Math.round(vv.offsetTop) + GAP}px`;
		modalEl.style.left = "50%";
		modalEl.style.transform = "translateX(-50%)";
		modalEl.style.margin = "0";
		modalEl.style.maxHeight = `${Math.round(vv.height) - GAP * 2}px`;
		contentEl.style.maxHeight = `${Math.round(vv.height) - GAP * 2}px`;
	};

	apply();
	vv.addEventListener("resize", apply);
	vv.addEventListener("scroll", apply);

	return () => {
		vv.removeEventListener("resize", apply);
		vv.removeEventListener("scroll", apply);
		for (const el of [modalEl, contentEl]) {
			el.style.position = "";
			el.style.top = "";
			el.style.left = "";
			el.style.transform = "";
			el.style.margin = "";
			el.style.maxHeight = "";
		}
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
