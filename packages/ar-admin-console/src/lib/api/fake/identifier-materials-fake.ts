/**
 * In-memory identifier materials for Storybook, the whole-console mock and tests. Answers as the
 * Admin API does: a salt kept under a name is replaced only with its fingerprint (409), a CSV
 * with a bad row writes nothing (400 with `row_errors`), another value for an account needs
 * `replace` (409 with `conflicts`) and a value another account holds is never replaced (409 with
 * `valuesOfOthers` for a source, `identifiersOfOthers` for a store). An account whose ID begins with "unknown" does not exist.
 */
import { ApiError, ConflictError } from '../api-error';
import {
	CSV_HEADERS,
	IDENTIFIER_NAME,
	type CsvImportKind,
	type CsvRowError,
	type IdentifierMaterialsClient,
	type MaterialSummary,
	type SaltSummary
} from '../identifier-materials';

export interface FakeIdentifierMaterialsOptions {
	/** Salts kept already, by name, with the secret they hold. */
	salts?: Record<string, string>;
	sources?: Record<string, Record<string, string>>;
	/** Stores: account → audience → identifier. */
	stores?: Record<string, Record<string, Record<string, string>>>;
	/** Exception lists with how many entries each holds. */
	exceptions?: Record<string, number>;
	delay?: number;
	now?: () => number;
}

/** A stand-in for a SHA-256 fingerprint: 16 hex characters that differ per secret. */
export function fakeFingerprint(secret: string | Uint8Array): string {
	// Text is its UTF-8 bytes, so the same salt is the same whichever way it was written.
	const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
	let hash = 0x811c9dc5;
	let out = '';
	for (let round = 0; round < 4; round++) {
		for (const byte of [round, 0x3a, ...bytes]) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		out += (hash & 0xffff).toString(16).padStart(4, '0');
	}
	return out;
}

const byRow = (errors: CsvRowError[]) => [...errors].sort((a, b) => a.row - b.row);

const invalid = (message: string, rows: CsvRowError[] = []) =>
	new ApiError(
		400,
		'invalid_request',
		message,
		rows.length > 0 ? { row_errors: rows.slice(0, 100) } : {}
	);

/** The data lines of a CSV (split on commas, no quoting: the fake's files are plain). */
function parseCsv(
	kind: CsvImportKind,
	csv: string
): { rows: { line: number; cells: string[] }[]; errors: CsvRowError[] } {
	const lines = csv.split(/\r?\n/u);
	if (lines[lines.length - 1] === '') lines.pop();
	if (lines[0]?.trim() !== CSV_HEADERS[kind]) {
		throw invalid(`The first line must be ${CSV_HEADERS[kind]}`);
	}
	const width = CSV_HEADERS[kind].split(',').length;
	const rows: { line: number; cells: string[] }[] = [];
	const errors: CsvRowError[] = [];
	lines.slice(1).forEach((text, index) => {
		const cells = text.split(',');
		if (cells.length !== width) {
			errors.push({ row: index + 2, column: 'row', code: 'field_count' });
			return;
		}
		rows.push({ line: index + 2, cells });
	});
	return { rows, errors };
}

export function createFakeIdentifierMaterials(
	options: FakeIdentifierMaterialsOptions = {}
): IdentifierMaterialsClient {
	const now = options.now ?? Date.now;
	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;
	// Only the fingerprint (a digest of the bytes) is kept, never the salt itself: it is all the
	// API ever gives back, and enough to tell the same salt from another.
	const salts = new Map<string, { fingerprint: string; updatedAt: number }>(
		Object.entries(options.salts ?? {}).map(([name, secret]) => [
			name,
			{ fingerprint: fakeFingerprint(secret), updatedAt: now() }
		])
	);
	/** Sources: name → account → value. */
	const sources = new Map<string, Map<string, string>>(
		Object.entries(options.sources ?? {}).map(([name, rows]) => [
			name,
			new Map(Object.entries(rows))
		])
	);
	/** Stores: name → "audience\naccount" → identifier. */
	const stores = new Map<string, Map<string, string>>(
		Object.entries(options.stores ?? {}).map(([name, accounts]) => [
			name,
			new Map(
				Object.entries(accounts).flatMap(([account, audiences]) =>
					Object.entries(audiences).map(
						([audience, id]) => [`${audience}\n${account}`, id] as const
					)
				)
			)
		])
	);
	const lists = new Map<string, number>(Object.entries(options.exceptions ?? {}));
	const touched = new Map<string, number>();
	const stamp = (kind: string, name: string) => touched.set(`${kind}:${name}`, now());

	const summary = (kind: string, name: string, size: number): MaterialSummary => ({
		name,
		count: size,
		updatedAt: touched.get(`${kind}:${name}`) ?? 0
	});
	const checkName = (name: string) => {
		if (!IDENTIFIER_NAME.test(name)) throw invalid('name is invalid');
	};

	function importPairs(
		kind: 'source' | 'store',
		name: string,
		csv: string,
		replace: boolean | undefined
	) {
		checkName(name);
		const { rows, errors } = parseCsv(kind, csv);
		const accountAt = kind === 'source' ? 0 : 1;
		const valueAt = kind === 'source' ? 1 : 2;
		const valueColumn = kind === 'source' ? 'value' : 'identifier';
		for (const { line, cells } of rows) {
			if (cells[accountAt].startsWith('unknown'))
				errors.push({ row: line, column: 'account', code: 'unknown_account' });
			else if (!cells[accountAt]) errors.push({ row: line, column: 'account', code: 'required' });
			if (cells[valueAt] !== cells[valueAt].trim())
				errors.push({ row: line, column: valueColumn, code: 'surrounding_whitespace' });
			else if (!cells[valueAt]) errors.push({ row: line, column: valueColumn, code: 'required' });
		}
		if (errors.length > 0) throw invalid('csv has rows with errors', byRow(errors));
		const held = (kind === 'source' ? sources : stores).get(name) ?? new Map<string, string>();
		const key = (cells: string[]) => (kind === 'source' ? cells[0] : `${cells[0]}\n${cells[1]}`);
		let created = 0;
		let replaced = 0;
		let unchanged = 0;
		let conflicts = 0;
		let valuesOfOthers = 0;
		for (const { cells } of rows) {
			const current = held.get(key(cells));
			const value = cells[valueAt];
			// A value another account holds (for a store: for the same audience).
			const other = [...held.entries()].find(
				([k, v]) =>
					v === value && k !== key(cells) && (kind === 'source' || k.startsWith(`${cells[0]}\n`))
			);
			if (other) valuesOfOthers++;
			else if (current === undefined) created++;
			else if (current === value) unchanged++;
			else if (replace) replaced++;
			else conflicts++;
		}
		if (valuesOfOthers > 0 || conflicts > 0) {
			throw new ConflictError(
				valuesOfOthers > 0
					? 'Some values already belong to other accounts'
					: 'Some accounts already have another value; import with replace to change them',
				{
					conflicts,
					[kind === 'store' ? 'identifiersOfOthers' : 'valuesOfOthers']: valuesOfOthers
				}
			);
		}
		for (const { cells } of rows) held.set(key(cells), cells[valueAt]);
		(kind === 'source' ? sources : stores).set(name, held);
		stamp(kind, name);
		return { created, replaced, unchanged };
	}

	return {
		async salts() {
			await wait();
			return [...salts.entries()].map(
				([name, { fingerprint, updatedAt }]): SaltSummary => ({
					name,
					fingerprint,
					updatedAt
				})
			);
		},
		async sources() {
			await wait();
			return [...sources.entries()].map(([name, rows]) => summary('source', name, rows.size));
		},
		async stores() {
			await wait();
			return [...stores.entries()].map(([name, rows]) => summary('store', name, rows.size));
		},
		async exceptions() {
			await wait();
			return [...lists.entries()].map(([name, size]) => summary('exceptions', name, size));
		},
		async importSalt(name, input) {
			await wait();
			checkName(name);
			if (!input.value) throw invalid('value is required');
			// The same bytes whichever way they were written, as the API reads them.
			let bytes: Uint8Array;
			try {
				bytes =
					input.encoding === 'base64'
						? Uint8Array.from(atob(input.value), (char) => char.charCodeAt(0))
						: new TextEncoder().encode(input.value);
			} catch {
				throw invalid('value is not valid Base64');
			}
			const fingerprint = fakeFingerprint(bytes);
			const held = salts.get(name);
			if (!held) {
				salts.set(name, { fingerprint, updatedAt: now() });
				return { name, fingerprint, outcome: 'created' };
			}
			if (held.fingerprint === fingerprint) return { name, fingerprint, outcome: 'unchanged' };
			if (input.replaceFingerprint !== held.fingerprint) {
				throw new ConflictError(
					'A different salt is kept under this name; send its fingerprint to replace it',
					{}
				);
			}
			salts.set(name, { fingerprint, updatedAt: now() });
			return { name, fingerprint, outcome: 'replaced' };
		},
		async importSource(name, csv, replace) {
			await wait();
			return importPairs('source', name, csv, replace);
		},
		async importStore(name, csv, replace) {
			await wait();
			return importPairs('store', name, csv, replace);
		},
		async importExceptions(name, csv) {
			await wait();
			checkName(name);
			const { rows, errors } = parseCsv('exceptions', csv);
			const seen = new Set<string>();
			let saltRows = 0;
			let blocks = 0;
			for (const { line, cells } of rows) {
				const [account, audience, action, salt] = cells;
				if (account.startsWith('unknown'))
					errors.push({ row: line, column: 'account', code: 'unknown_account' });
				if (action !== 'salt' && action !== 'block')
					errors.push({ row: line, column: 'action', code: 'invalid_action' });
				else if (action === 'salt' && !salts.has(salt))
					errors.push({ row: line, column: 'salt', code: 'unknown_salt' });
				else if (action === 'block' && salt !== '')
					errors.push({ row: line, column: 'salt', code: 'not_allowed' });
				if (seen.has(`${account}\n${audience}`))
					errors.push({ row: line, column: 'row', code: 'duplicate' });
				seen.add(`${account}\n${audience}`);
				if (action === 'salt') saltRows++;
				if (action === 'block') blocks++;
			}
			if (errors.length > 0) throw invalid('csv has rows with errors', byRow(errors));
			// The whole list is replaced; a file with only the header empties it.
			lists.set(name, rows.length);
			stamp('exceptions', name);
			return { rows: rows.length, salts: saltRows, blocks };
		}
	};
}

/** What the whole-console mock and Storybook start with. */
export const MOCK_IDENTIFIER_MATERIALS: FakeIdentifierMaterialsOptions = {
	salts: { 'legacy-idp': 'legacy salt', 'campus-idp': 'campus salt' },
	sources: { 'employee-number': { usr_01: 'E1001', usr_02: 'E1002' } },
	stores: { 'legacy-ids': { usr_01: { 'https://sp.example.org': 'abc123' } } },
	exceptions: { 'exception-map': 2 }
};
