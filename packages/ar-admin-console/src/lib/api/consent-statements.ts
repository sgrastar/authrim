/**
 * The tenant's consent statements (`/api/admin/consent-statements`): the documents people agree to
 * (terms of service, a privacy policy, other agreements), kept as versions.
 *
 * A statement has versions; a version has its text per language. Only a draft version can be
 * changed; publishing (activating) one makes it the current version and archives the one before.
 * Publishing asks people who agreed to an earlier version again unless told not to. A statement is
 * deleted only if it was never used; otherwise it is retired and its records are kept. Where a
 * statement is used (flows, services) comes from `GET …/consent-statements/usage`.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

const BASE = `${API_BASE_URL}/api/admin/consent-statements`;

export type ConsentContentType = 'url' | 'inline';
/** `draft` can be edited; `active` is the current version; `archived` was replaced. */
export type ConsentVersionStatus = 'draft' | 'active' | 'archived';

export interface ConsentStatement {
	id: string;
	slug: string;
	category: string;
	legal_basis: string;
	processing_purpose: string | null;
	display_order: number;
	is_active: boolean;
	record_retention_days: number | null;
	withdrawal_allowed: boolean;
	withdrawal_impact: string | null;
	/** The version (YYYYMMDD) from which agreement is required; read-only. */
	required_consent_version: string | null;
	reconsent_interval_days: number | null;
	/** Set once the statement was retired: it cannot be turned on again. */
	retired_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface ConsentVersion {
	id: string;
	statement_id: string;
	/** YYYYMMDD. */
	version: string;
	content_type: ConsentContentType;
	effective_at: number;
	effective_until: number | null;
	is_current: boolean;
	status: ConsentVersionStatus;
	created_at: number;
	updated_at: number;
}

export interface ConsentLocalization {
	language: string;
	title: string;
	description: string;
	processing_purpose: string | null;
	withdrawal_impact: string | null;
	/** An http(s) link to the document (a version whose content type is `url`). */
	document_url: string | null;
	/** The text itself (a version whose content type is `inline`). */
	inline_content: string | null;
}

/** What is changed on a statement; what is left out stays. */
export interface ConsentStatementInput {
	slug?: string;
	category?: string;
	legal_basis?: string;
	processing_purpose?: string | null;
	is_active?: boolean;
	record_retention_days?: number | null;
	withdrawal_allowed?: boolean;
	withdrawal_impact?: string | null;
	reconsent_interval_days?: number | null;
}

export interface ConsentVersionInput {
	version?: string;
	content_type?: ConsentContentType;
	effective_at?: number;
	effective_until?: number | null;
}

export interface ConsentLocalizationInput {
	title: string;
	description: string;
	processing_purpose?: string | null;
	withdrawal_impact?: string | null;
	document_url?: string | null;
	inline_content?: string | null;
}

/** A statement as one row of the list: its current version (or latest draft) and their titles. */
export interface ConsentStatementListItem {
	statement: ConsentStatement;
	/** The current version, if one was published. */
	current: ConsentVersion | null;
	hasDraft: boolean;
	/** Title per language of the current version, or of the latest draft when none is current. */
	titles: Record<string, string>;
}

export interface ConsentUsageFlow {
	flow_id: string;
	name: string;
	kind: string;
	draft: boolean;
	published: boolean;
}

export interface ConsentUsageService {
	protocol: 'oidc' | 'saml';
	id: string;
	name: string;
}

export interface ConsentStatementUsage {
	flows: ConsentUsageFlow[];
	services: ConsentUsageService[];
}

export interface ConsentUsages {
	/** By statement id; a statement used nowhere is not in it. */
	byStatement: Record<string, ConsentStatementUsage>;
	/** False when a stored document could not be read: the counts are at least these. */
	complete: boolean;
}

export interface ConsentStatementDetail {
	statement: ConsentStatement;
	/** Newest first. */
	versions: ConsentVersion[];
}

export type DeleteDisposition = 'deleted' | 'retired';

export interface ConsentStatementsClient {
	list(signal?: AbortSignal): Promise<ConsentStatementListItem[]>;
	get(id: string, signal?: AbortSignal): Promise<ConsentStatementDetail>;
	/** Where statements are used. Rejects when the API cannot answer (pages carry on without). */
	usages(signal?: AbortSignal): Promise<ConsentUsages>;
	create(input: ConsentStatementInput & { slug: string }): Promise<ConsentStatement>;
	update(id: string, input: ConsentStatementInput): Promise<ConsentStatement>;
	/** A never-used draft is deleted; anything else is retired and its records kept. */
	remove(id: string): Promise<DeleteDisposition>;
	localizations(
		statementId: string,
		versionId: string,
		signal?: AbortSignal
	): Promise<ConsentLocalization[]>;
	createVersion(
		statementId: string,
		input: ConsentVersionInput & { version: string; effective_at: number }
	): Promise<ConsentVersion>;
	/** Draft versions only. */
	updateVersion(
		statementId: string,
		versionId: string,
		input: ConsentVersionInput
	): Promise<ConsentVersion>;
	/** Draft versions only. */
	removeVersion(statementId: string, versionId: string): Promise<void>;
	/** `reconsent` (default true) asks people who agreed to an earlier version again. */
	activateVersion(
		statementId: string,
		versionId: string,
		options?: { reconsent?: boolean }
	): Promise<ConsentVersion>;
	/** Draft versions only. */
	saveLocalization(
		statementId: string,
		versionId: string,
		language: string,
		input: ConsentLocalizationInput
	): Promise<ConsentLocalization>;
	/** Draft versions only. */
	removeLocalization(statementId: string, versionId: string, language: string): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** A number, also one a database returned as text. */
const num = (value: unknown): number | null => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return null;
};
const flag = (value: unknown): boolean => value === true || value === 1 || value === '1';

export function consentStatementFromRow(value: unknown): ConsentStatement {
	const row = record(value);
	return {
		id: text(row.id),
		slug: text(row.slug),
		category: text(row.category) || 'custom',
		legal_basis: text(row.legal_basis) || 'consent',
		processing_purpose: textOrNull(row.processing_purpose),
		display_order: num(row.display_order) ?? 0,
		is_active: flag(row.is_active),
		record_retention_days: num(row.record_retention_days),
		// A statement saved before the column existed allows withdrawal.
		withdrawal_allowed: row.withdrawal_allowed === undefined ? true : flag(row.withdrawal_allowed),
		withdrawal_impact: textOrNull(row.withdrawal_impact),
		required_consent_version: textOrNull(row.required_consent_version),
		reconsent_interval_days: num(row.reconsent_interval_days),
		retired_at: num(row.retired_at),
		created_at: num(row.created_at) ?? 0,
		updated_at: num(row.updated_at) ?? 0
	};
}

export function consentVersionFromRow(value: unknown): ConsentVersion {
	const row = record(value);
	return {
		id: text(row.id),
		statement_id: text(row.statement_id),
		version: text(row.version),
		content_type: row.content_type === 'url' ? 'url' : 'inline',
		effective_at: num(row.effective_at) ?? 0,
		effective_until: num(row.effective_until),
		is_current: flag(row.is_current),
		status: row.status === 'active' || row.status === 'archived' ? row.status : 'draft',
		created_at: num(row.created_at) ?? 0,
		updated_at: num(row.updated_at) ?? 0
	};
}

export function consentLocalizationFromRow(value: unknown): ConsentLocalization {
	const row = record(value);
	return {
		language: text(row.language),
		title: text(row.title),
		description: text(row.description),
		processing_purpose: textOrNull(row.processing_purpose),
		withdrawal_impact: textOrNull(row.withdrawal_impact),
		document_url: textOrNull(row.document_url),
		inline_content: textOrNull(row.inline_content)
	};
}

export function consentUsagesFromBody(value: unknown): ConsentUsages {
	const body = record(value);
	const byStatement: Record<string, ConsentStatementUsage> = {};
	for (const entry of Array.isArray(body.usages) ? body.usages : []) {
		const row = record(entry);
		const id = text(row.statement_id);
		if (!id) continue;
		byStatement[id] = {
			flows: (Array.isArray(row.flows) ? row.flows : []).map((flow) => {
				const item = record(flow);
				return {
					flow_id: text(item.flow_id),
					name: text(item.name),
					kind: text(item.kind),
					draft: flag(item.draft),
					published: flag(item.published)
				};
			}),
			services: (Array.isArray(row.services) ? row.services : []).map((service) => {
				const item = record(service);
				return {
					protocol: item.protocol === 'saml' ? 'saml' : 'oidc',
					id: text(item.id),
					name: text(item.name)
				};
			})
		};
	}
	return { byStatement, complete: body.usages_complete !== false };
}

async function readJson(response: Response): Promise<unknown> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return response.json().catch(() => ({}));
}

const json = (method: string, body: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

const statementUrl = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const versionUrl = (statementId: string, versionId: string) =>
	`${statementUrl(statementId)}/versions/${encodeURIComponent(versionId)}`;
const localizationUrl = (statementId: string, versionId: string, language: string) =>
	`${versionUrl(statementId, versionId)}/localizations/${encodeURIComponent(language)}`;

async function versionsOf(id: string, signal?: AbortSignal): Promise<ConsentVersion[]> {
	const body = record(await readJson(await adminFetch(`${statementUrl(id)}/versions`, { signal })));
	return (Array.isArray(body.versions) ? body.versions : []).map(consentVersionFromRow);
}

async function localizationsOf(
	statementId: string,
	versionId: string,
	signal?: AbortSignal
): Promise<ConsentLocalization[]> {
	const body = record(
		await readJson(
			await adminFetch(`${versionUrl(statementId, versionId)}/localizations`, { signal })
		)
	);
	return (Array.isArray(body.localizations) ? body.localizations : []).map(
		consentLocalizationFromRow
	);
}

/** One row of the list response: the statement and the summary the list endpoint adds to it. */
export function consentStatementListItemFromRow(value: unknown): ConsentStatementListItem {
	const row = record(value);
	const titles: Record<string, string> = {};
	for (const [language, title] of Object.entries(record(row.titles))) {
		if (typeof title === 'string' && title) titles[language] = title;
	}
	return {
		statement: consentStatementFromRow(row),
		current: row.current_version ? consentVersionFromRow(row.current_version) : null,
		hasDraft: flag(row.has_draft),
		titles
	};
}

export const httpConsentStatements: ConsentStatementsClient = {
	async list(signal) {
		// One request: each row carries its current version, draft presence and titles.
		const body = record(await readJson(await adminFetch(BASE, { signal })));
		return (Array.isArray(body.statements) ? body.statements : []).map(
			consentStatementListItemFromRow
		);
	},
	async get(id, signal) {
		const [statement, versions] = await Promise.all([
			readJson(await adminFetch(statementUrl(id), { signal })),
			versionsOf(id, signal)
		]);
		return { statement: consentStatementFromRow(statement), versions };
	},
	async usages(signal) {
		return consentUsagesFromBody(await readJson(await adminFetch(`${BASE}/usage`, { signal })));
	},
	async create(input) {
		return consentStatementFromRow(await readJson(await adminFetch(BASE, json('POST', input))));
	},
	async update(id, input) {
		return consentStatementFromRow(
			await readJson(await adminFetch(statementUrl(id), json('PUT', input)))
		);
	},
	async remove(id) {
		const body = record(await readJson(await adminFetch(statementUrl(id), { method: 'DELETE' })));
		return body.disposition === 'deleted' ? 'deleted' : 'retired';
	},
	localizations: localizationsOf,
	async createVersion(statementId, input) {
		return consentVersionFromRow(
			await readJson(await adminFetch(`${statementUrl(statementId)}/versions`, json('POST', input)))
		);
	},
	async updateVersion(statementId, versionId, input) {
		return consentVersionFromRow(
			await readJson(await adminFetch(versionUrl(statementId, versionId), json('PUT', input)))
		);
	},
	async removeVersion(statementId, versionId) {
		await readJson(await adminFetch(versionUrl(statementId, versionId), { method: 'DELETE' }));
	},
	async activateVersion(statementId, versionId, options = {}) {
		return consentVersionFromRow(
			await readJson(
				await adminFetch(
					`${versionUrl(statementId, versionId)}/activate`,
					json('POST', { reconsent: options.reconsent ?? true })
				)
			)
		);
	},
	async saveLocalization(statementId, versionId, language, input) {
		return consentLocalizationFromRow(
			await readJson(
				await adminFetch(localizationUrl(statementId, versionId, language), json('PUT', input))
			)
		);
	},
	async removeLocalization(statementId, versionId, language) {
		await readJson(
			await adminFetch(localizationUrl(statementId, versionId, language), { method: 'DELETE' })
		);
	}
};
