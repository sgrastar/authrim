/**
 * A fingerprint is drawn as runs of bytes so a narrow line breaks between runs; its text is the
 * runs joined. Stories find it by the `<code>` element whose whole text is the fingerprint.
 */
export function fingerprintText(display: string) {
	return (_content: string, element: Element | null): boolean =>
		element?.tagName === 'CODE' && element.textContent === display;
}
