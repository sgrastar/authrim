/**
 * What a runtime screen holds. The sign-in and sign-up pages ask whether the screen places the link
 * to the other screen as a part of its own (`auth_switch_link`): when it does the part draws the
 * link, and when it does not (a screen saved before the part existed) the page draws the link at
 * the end of the card, as it always has.
 */
export function screenHasPart(screen: Record<string, unknown> | null | undefined, kind: string) {
	const fields = screen?.fields;
	return (
		Array.isArray(fields) &&
		fields.some(
			(field) =>
				typeof field === 'object' &&
				field !== null &&
				(field as { block_type?: unknown }).block_type === kind
		)
	);
}
