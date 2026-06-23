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
 * The modal is also given a flex layout on mobile (see styles.css) so its body
 * scrolls internally and the action footer stays pinned and visible — the rest
 * of this helper just bounds the modal's height to the keyboard-free area and
 * keeps it clear of the system status bar via the top safe-area inset.
 *
 * Desktop is left completely untouched (no-op). Returns a cleanup function that
 * removes the listeners and restores the inline styles; call it on modal close.
 */
export function keepModalAboveKeyboard(
	containerEl: HTMLElement,
	modalEl: HTMLElement
): () => void {
	if (!Platform.isMobile) return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const GAP = 8; // breathing room above/below the modal, in px
	// Respect the notch/status-bar inset so the title isn't drawn under it.
	const safeTop = "env(safe-area-inset-top, 0px)";

	const apply = () => {
		const h = Math.round(vv.height);
		// Shrink the (full-screen, flex-centring) container down to just the
		// visible region and pin the modal to its top. Horizontal centring,
		// driven by the container's own `justify-content`, is left intact.
		containerEl.style.height = `${h}px`;
		containerEl.style.top = `${Math.round(vv.offsetTop)}px`;
		containerEl.style.alignItems = "flex-start";
		containerEl.style.paddingTop = `calc(${safeTop} + ${GAP}px)`;
		// Bound the modal to the space left between the status bar and the
		// keyboard; its flex body then scrolls internally instead of spilling
		// under the keyboard.
		modalEl.style.maxHeight = `calc(${h}px - ${safeTop} - ${GAP * 2}px)`;
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
