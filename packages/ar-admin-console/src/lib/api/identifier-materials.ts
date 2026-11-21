/**
 * What a persistent identifier step reads by name, and the imports that fill them (the Admin API
 * under `/api/admin/identity-mapping/identifier-*`):
 *   - salts: brought from another identity provider (a secret: only a fingerprint comes back),
 *   - identifier sources: a value imported for each account, to make the identifier from,
 *   - stores: identifiers people already have at another identity provider,
 *   - exception lists: per account and recipient, another salt or no identifier at all.
 * Names follow IDENTIFIER_NAME. CSV imports are all-or-nothing: a row with an error refuses the
 * whole file (`row_errors`: line, column, reason; never a value).
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { IDENTIFIER_SALT_NAME } from '@authrim/ar-lib-field-mapping/authoring';

const BASE = `${API_BASE_URL}/api/admin/identifiers`;

/** The names salts, sources, stores and lists are kept under (the runtime's own rule). */
export const IDENTIFIER_NAME = IDENTIFIER_SALT_NAME;

/** The import file the API accepts at most. */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

export type CsvImportKind = 'source' | 'store' | 'exceptions';

/** The columns of each kind's CSV, in order (the first line of the file). */
export const CSV_HEADERS: Readonly<Record<CsvImportKind, string>> = {
	source: 'account,value',
	store: 'audience,account,identifier',
	exceptions: 'account,audience,action,salt'
};

/** What a list call returns for a source, a store or an exception list. */
export interface MaterialSummary {
	name: string;
	/** How many values, identifiers or entries it holds. */
	count: number;
	updatedAt: number;
}

export interface SaltSummary {
	name: string;
	/** The first 16 hex characters of a SHA-256 of the salt. */
	fingerprint: string;
	updatedAt: number;
}

export type SaltEncoding = 'utf8' | 'base64';
export type SaltOutcome = 'created' | 'unchanged' | 'replaced';

export interface SaltResult {
	name: string;
	fingerprint: string;
	outcome: SaltOutcome;
}

/** A source or a store import: how many values were written, replaced or already there. */
export interface ImportCounts {
	created: number;
	replaced: number;
	unchanged: number;
}

export interface ExceptionsImportCounts {
	rows: number;
	salts: number;
	blocks: number;
}

/** A row the import refused: its line (the header is 1), the column and why. */
export interface CsvRowError {
	row: number;
	column: string;
	code: string;
}

export interface IdentifierMaterialsClient {
	salts(signal?: AbortSignal): Promise<SaltSummary[]>;
	sources(signal?: AbortSignal): Promise<MaterialSummary[]>;
	stores(signal?: AbortSignal): Promise<MaterialSummary[]>;
	exceptions(signal?: AbortSignal): Promise<MaterialSummary[]>;
	/**
	 * Keeps a salt under a name. The same salt again changes nothing; a different one is refused
	 * with a ConflictError unless `replaceFingerprint` is the fingerprint of the one kept.
	 */
	importSalt(
		name: string,
		input: { value: string; encoding: SaltEncoding; replaceFingerprint?: string }
	): Promise<SaltResult>;
	/**
	 * Imports `account,value` rows. 400 with row errors writes nothing; a ConflictError says how
	 * many accounts already have another value (`conflicts`, repeat with `replace`) and how many
	 * values another account holds (`valuesOfOthers`, never replaced).
	 */
	importSource(name: string, csv: string, replace?: boolean): Promise<ImportCounts>;
	/** The same for `audience,account,identifier` rows. */
	importStore(name: string, csv: string, replace?: boolean): Promise<ImportCounts>;
	/** Replaces the whole list with the file's `account,audience,action,salt` rows. */
	importExceptions(name: string, csv: string): Promise<ExceptionsImportCounts>;
}

// ---------------------------------------------------------------------------------------------
// From the wire

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value !== null && typeof value === 'object' ? (value as Row) : {};
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function summaries(list: unknown): MaterialSummary[] {
	return (Array.isArray(list) ? list : []).map((item) => {
		const row = record(item);
		return { name: text(row.name), count: count(row.count), updatedAt: count(row.updatedAt) };
	});
}

/** The row errors of a refused import (400); none for any other answer. */
export function rowErrorsOf(body: Record<string, unknown> | undefined): CsvRowError[] {
	const list = body?.row_errors;
	return (Array.isArray(list) ? list : []).map((item) => {
		const row = record(item);
		return {
			// The API names the line `row`; accept `line` too, as its description does.
			row: count(row.row ?? row.line),
			column: text(row.column),
			code: text(row.code)
		};
	});
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json().catch(() => ({})));
}

const post = (body: unknown) => ({
	method: 'POST',
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

const importUrl = (kind: string, name: string) =>
	`${BASE}/${kind}/${encodeURIComponent(name)}/import`;

function counts(body: Row): ImportCounts {
	return {
		created: count(body.created),
		replaced: count(body.replaced),
		unchanged: count(body.unchanged)
	};
}

export const identifierMaterialsClient: IdentifierMaterialsClient = {
	async salts(signal) {
		const body = await readJson(await adminFetch(`${BASE}/salts`, { signal }));
		return (Array.isArray(body.salts) ? body.salts : []).map((item) => {
			const row = record(item);
			return {
				name: text(row.name),
				fingerprint: text(row.fingerprint),
				updatedAt: count(row.updatedAt)
			};
		});
	},
	async sources(signal) {
		return summaries((await readJson(await adminFetch(`${BASE}/sources`, { signal }))).sources);
	},
	async stores(signal) {
		return summaries((await readJson(await adminFetch(`${BASE}/stores`, { signal }))).stores);
	},
	async exceptions(signal) {
		return summaries((await readJson(await adminFetch(`${BASE}/exceptions`, { signal }))).lists);
	},
	async importSalt(name, input) {
		const body = await readJson(
			await adminFetch(`${BASE}/salts/${encodeURIComponent(name)}`, {
				method: 'PUT',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			})
		);
		const outcome = body.outcome;
		return {
			name: text(body.name) || name,
			fingerprint: text(body.fingerprint),
			outcome: outcome === 'unchanged' || outcome === 'replaced' ? outcome : 'created'
		};
	},
	async importSource(name, csv, replace) {
		return counts(
			await readJson(
				await adminFetch(importUrl('sources', name), post({ csv, ...(replace ? { replace } : {}) }))
			)
		);
	},
	async importStore(name, csv, replace) {
		return counts(
			await readJson(
				await adminFetch(importUrl('stores', name), post({ csv, ...(replace ? { replace } : {}) }))
			)
		);
	},
	async importExceptions(name, csv) {
		const body = await readJson(await adminFetch(importUrl('exceptions', name), post({ csv })));
		return { rows: count(body.rows), salts: count(body.salts), blocks: count(body.blocks) };
	}
};

/**
 * What a ConflictError of a source or store import says: how many accounts already have another
 * value (`conflicts`) and how many values another account holds. The API names the second count
 * after what the kind holds: `valuesOfOthers` for a source, `identifiersOfOthers` for a store.
 */
export function importConflictOf(
	kind: 'source' | 'store',
	body: Record<string, unknown>
): { conflicts: number; valuesOfOthers: number } {
	return {
		conflicts: count(body.conflicts),
		valuesOfOthers: count(kind === 'store' ? body.identifiersOfOthers : body.valuesOfOthers)
	};
}
