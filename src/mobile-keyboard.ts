import { Platform } from "obsidian";

/**
 * Keep a modal usable while the on-screen keyboard is open on mobile.
 *
 * The default Obsidian modal is centred in the *layout* viewport and sized in
 * `vh`, neither of which shrinks when the soft keyboard appears — so a focused
 * field (e.g. the conflict editor's textarea) ends up hidden behind the
 * keyboard. We need to bound the modal to the on-screen, keyboard-free area.
 *
 * Detecting that area on Obsidian mobile (a Capacitor WebView) is the tricky
 * part: on some devices `visualViewport` shrinks with the keyboard, on others
 * it doesn't and only the Capacitor/cordova keyboard events report a height.
 * So we listen to *both* and take whichever reports the smaller usable height:
 *
 *   usable = min( innerHeight − keyboardHeight , visualViewport.height )
 *
 * We then shrink the modal's *container* to that height and pin the modal to
 * its top. We never touch the modal's own horizontal positioning — Obsidian
 * centres and animates it with its own transform, and overriding
 * `left`/`transform` would shove it off-screen. The modal also gets a flex
 * layout on mobile (see styles.css) so its body scrolls internally and the
 * action footer stays pinned and visible.
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
	const GAP = 8; // breathing room above/below the modal, in px
	// Respect the notch/status-bar inset so the title isn't drawn under it.
	const safeTop = "env(safe-area-inset-top, 0px)";

	let keyboardHeight = 0;

	const apply = () => {
		const inner = window.innerHeight;
		const byKeyboard = keyboardHeight > 0 ? inner - keyboardHeight : inner;
		const byViewport = vv ? vv.height : inner;
		const usable = Math.round(Math.max(0, Math.min(byKeyboard, byViewport)));
		const offset = vv ? Math.round(vv.offsetTop) : 0;

		// Shrink the (full-screen, flex-centring) container to the usable area
		// and pin the modal to its top. Horizontal centring, driven by the
		// container's own `justify-content`, is left intact.
		containerEl.style.height = `${usable}px`;
		containerEl.style.top = `${offset}px`;
		containerEl.style.alignItems = "flex-start";
		containerEl.style.paddingTop = `calc(${safeTop} + ${GAP}px)`;
		// Bound the modal to that area; its flex body scrolls internally so the
		// pinned footer never slides under the keyboard.
		modalEl.style.maxHeight = `calc(${usable}px - ${safeTop} - ${GAP * 2}px)`;
	};

	const onKeyboardShow = (e: Event) => {
		const h = (e as unknown as { keyboardHeight?: number }).keyboardHeight;
		if (typeof h === "number") keyboardHeight = h;
		apply();
	};
	const onKeyboardHide = () => {
		keyboardHeight = 0;
		apply();
	};

	apply();
	vv?.addEventListener("resize", apply);
	vv?.addEventListener("scroll", apply);
	window.addEventListener("resize", apply);
	// Capacitor / cordova-plugin-ionic-keyboard window events (Obsidian mobile).
	window.addEventListener("keyboardWillShow", onKeyboardShow);
	window.addEventListener("keyboardDidShow", onKeyboardShow);
	window.addEventListener("keyboardWillHide", onKeyboardHide);
	window.addEventListener("keyboardDidHide", onKeyboardHide);

	return () => {
		vv?.removeEventListener("resize", apply);
		vv?.removeEventListener("scroll", apply);
		window.removeEventListener("resize", apply);
		window.removeEventListener("keyboardWillShow", onKeyboardShow);
		window.removeEventListener("keyboardDidShow", onKeyboardShow);
		window.removeEventListener("keyboardWillHide", onKeyboardHide);
		window.removeEventListener("keyboardDidHide", onKeyboardHide);
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
