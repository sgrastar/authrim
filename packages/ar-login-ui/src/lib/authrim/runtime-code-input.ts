/**
 * A screen's blocks as drawn once an authenticator-app code has been asked for.
 *
 * A Flow whose method selection is followed by a step of its own for the code draws the code input
 * there. When the selection is not followed by one (the default Flow), the code is entered on the
 * selection's own screen, so its input is added to the blocks the screen has, as soon as the code
 * has been asked for. A screen that shows a code input that takes the authenticator code (the mode
 * auto, or totp) is left as it is; one whose only code input is fixed to the emailed code, or is
 * not shown, gets one for the authenticator app besides.
 *
 * What is shown is judged as the screen judges it (`isShown`, the display condition of a block, and
 * the row it is in: the blocks of a row that is not shown are not shown), and the input that is
 * added is placed where it is shown: after the last block that is, before any run of rows at the
 * end that is not.
 */
type CodeInputBlock = {
	block_type?: string;
	code_input_mode?: string | null;
	auth_method?: string | null;
	display_condition?: { mode?: string } | null;
};

/** The display condition alone: a block that is not marked hidden is shown. */
export function isNotHidden(field: CodeInputBlock): boolean {
	return field.display_condition?.mode !== 'hidden';
}

export function withRequestedTotpCodeInput<T extends CodeInputBlock>(
	fields: T[],
	fieldValues: Record<string, unknown>,
	codeInputField: T,
	isShown: (field: T) => boolean = isNotHidden
): T[] {
	const requested =
		fieldValues.totp_code_requested === true || fieldValues.totp_code_requested === 'true';
	if (!requested) return fields;

	// Whether each block is where it is shown: the blocks before any row are, the others are if
	// their row is, and a row that is shown is the first of its blocks.
	const inShownRow: boolean[] = [];
	let rowShown = true;
	for (const field of fields) {
		if (field.block_type === 'layout_row') rowShown = isShown(field);
		inShownRow.push(rowShown);
	}
	const shown = (index: number) =>
		inShownRow[index] && fields[index].block_type !== 'layout_row' && isShown(fields[index]);

	if (fields.some((field, index) => shown(index) && takesTotpCode(field))) return fields;

	let insertAt = 0;
	for (let index = fields.length - 1; index >= 0; index -= 1) {
		if (inShownRow[index]) {
			insertAt = index + 1;
			break;
		}
	}
	return [...fields.slice(0, insertAt), codeInputField, ...fields.slice(insertAt)];
}

/** A code input that takes an authenticator code (not one fixed to the emailed code). */
function takesTotpCode(field: CodeInputBlock): boolean {
	if (field.block_type !== 'code_input_widget') return false;
	const mode = field.code_input_mode ?? field.auth_method ?? 'auto';
	return mode === 'auto' || mode === 'totp';
}
