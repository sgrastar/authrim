/**
 * What the identifier import dialogs decide without the server: whether a file is only the
 * header line (it empties an exception list), what a refused row says, and how a finished import
 * reads. Pure, so it is tested without a page.
 */
import type { MessageKey } from '#lib/i18n/messages/ja.js';
import type {
	CsvImportKind,
	CsvRowError,
	ExceptionsImportCounts,
	ImportCounts
} from '#lib/api/identifier-materials.js';

/** What a finished CSV import reports. */
export type CsvImportResult =
	| { kind: 'source' | 'store'; name: string; counts: ImportCounts }
	| { kind: 'exceptions'; name: string; counts: ExceptionsImportCounts };

/** The reasons the API gives a refused cell or row, each with a message of its own. */
const ROW_ERROR_CODES = [
	'field_count',
	'required',
	'too_long',
	'invalid_account',
	'control_characters',
	'surrounding_whitespace',
	'whitespace',
	'unknown_account',
	'another_value_for_account',
	'value_of_another_account',
	'value_retired',
	'another_identifier_for_account',
	'identifier_of_another_account',
	'duplicate',
	'invalid_action',
	'not_allowed',
	'invalid_salt_name',
	'unknown_salt'
] as const;

/** The message for a refused row's reason; none for a reason this console does not know. */
export function rowErrorKey(code: string): MessageKey | null {
	return (ROW_ERROR_CODES as readonly string[]).includes(code)
		? (`pid.rowError.${code}` as MessageKey)
		: null;
}

/** A file with only its header line (or nothing after it): for an exception list, the list is emptied. */
export function isHeaderOnly(csv: string): boolean {
	return csv.split(/\r?\n/u).filter((line) => line.trim() !== '').length <= 1;
}

/** How many rows are listed at most (the API reports 100 and says no more). */
export const ROW_ERRORS_SHOWN = 100;

/** The refused rows in the order of the file. */
export function sortedRowErrors(errors: readonly CsvRowError[]): CsvRowError[] {
	return [...errors].sort((a, b) => a.row - b.row);
}

/** The columns a kind's file has, for the help under the file field. */
export function columnsOf(kind: CsvImportKind): string[] {
	return {
		source: ['account', 'value'],
		store: ['audience', 'account', 'identifier'],
		exceptions: ['account', 'audience', 'action', 'salt']
	}[kind];
}
