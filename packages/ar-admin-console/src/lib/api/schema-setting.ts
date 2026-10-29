/**
 * Schema setting API: the tenant's attribute schema, one definition per attribute a person can
 * have (its key, type, whether it is personal data, how it is validated and asked for at
 * sign-up). The base attributes (the OIDC standard ones, added from a preset) and the tenant's
 * own are the same kind of record; the base ones are "system" attributes whose key, label, type
 * and personal-data flag are locked.
 *
 * The Admin API answers in its own shape (snake_case, 0/1 for booleans, JSON kept as text, time in
 * seconds). This module turns that into what a page works with (camelCase, real booleans, parsed
 * JSON, time in milliseconds) and back, so no page has to know the wire shape.
 *
 * Pages take a `SchemaSettingClient` rather than calling fetch, so Storybook and tests hand them
 * an in-memory one (`fake/schema-setting-fake.ts`).
 */
import { adminFetch, API_BASE_URL } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';
export type Cardinality = 'single' | 'multi';
export type ScopeMode = 'any' | 'all';
/** What an attribute is doing: `active` is rest; the others are work under way or failed. */
export type OperationStatus = 'active' | 'deleting' | 'renaming' | 'reconfiguring' | 'error';

export const FIELD_TYPES: readonly FieldType[] = ['string', 'number', 'boolean', 'date', 'enum'];

/** How an attribute's value is checked. Keys are the API's own; which apply depends on the type. */
export interface ValidationRules {
	min_length?: number;
	max_length?: number;
	pattern?: string;
	min?: number;
	max?: number;
	enum_values?: string[];
	min_date?: string;
	max_date?: string;
}

/** What a failed or running operation was doing (the API keeps it as JSON text). */
export interface OperationDetail {
	operation: string;
	field_key?: string;
	old_key?: string;
	new_key?: string;
	from?: string;
	to?: string;
	error?: string;
	failed_users?: number;
	total_processed?: number;
	retry_failed?: boolean;
	started_at?: number;
}

export type UsageProtection = 'none' | 'warn' | 'delete_blocked';

/** Where an attribute is relied on, which decides whether it may be deleted. */
export interface UsageBinding {
	id: string;
	bindingType: string;
	bindingId: string;
	protection: UsageProtection;
	reason: string | null;
	/** `derived`: worked out from the tenant's sign-in settings; the others are stored. */
	source: string;
}

export interface Schema {
	id: string;
	tenantId: string;
	fieldKey: string;
	label: string;
	type: FieldType;
	cardinality: Cardinality;
	/** Personal data is stored apart. Fixed when the attribute is created. */
	isPii: boolean;
	isRequired: boolean;
	isActive: boolean;
	/** A base attribute (added from a preset): its key, label, type and flag are locked. */
	isSystem: boolean;
	validation: ValidationRules | null;
	requiredScopes: string[];
	scopeMode: ScopeMode;
	isSearchable: boolean;
	isExportable: boolean;
	isVcClaim: boolean;
	claimNamespace: string | null;
	description: string | null;
	displayOrder: number;
	version: number;
	status: OperationStatus;
	operation: OperationDetail | null;
	createdBy: string | null;
	/** Milliseconds. */
	createdAt: number;
	updatedAt: number;
	showOnRegistration: boolean;
	registrationRequired: boolean;
	registrationOrder: number;
	registrationPlaceholder: string | null;
	groupKey: string | null;
	groupLabel: string | null;
	groupOrder: number;
	fieldOrder: number;
	examples: unknown;
	/** Only in a list and a single read. */
	usage: UsageBinding[];
	/** Something relies on it so much that it cannot be deleted. */
	inUse: boolean;
}

/** What is needed to add an attribute. */
export interface NewSchema {
	fieldKey: string;
	label: string;
	type?: FieldType;
	cardinality?: Cardinality;
	isPii?: boolean;
	isRequired?: boolean;
	description?: string;
	validation?: ValidationRules | null;
	isSearchable?: boolean;
	isExportable?: boolean;
	showOnRegistration?: boolean;
	registrationRequired?: boolean;
}

/**
 * A change: only what differs. Sending what did not change is not harmless: for a base attribute
 * the API refuses a locked field that is sent at all, equal or not.
 */
export interface SchemaChange {
	label?: string;
	type?: FieldType;
	cardinality?: Cardinality;
	isRequired?: boolean;
	isActive?: boolean;
	validation?: ValidationRules | null;
	requiredScopes?: string[] | null;
	scopeMode?: ScopeMode;
	isSearchable?: boolean;
	isExportable?: boolean;
	isVcClaim?: boolean;
	claimNamespace?: string | null;
	description?: string | null;
	displayOrder?: number;
	showOnRegistration?: boolean;
	registrationRequired?: boolean;
	registrationOrder?: number;
	registrationPlaceholder?: string | null;
	groupKey?: string | null;
	groupLabel?: string | null;
	groupOrder?: number;
	fieldOrder?: number;
}

export interface SchemaQuery {
	page?: number;
	limit?: number;
	search?: string;
	type?: FieldType;
	isPii?: boolean;
	isActive?: boolean;
	isSystem?: boolean;
	status?: OperationStatus;
}

export interface SchemaPage {
	schemas: Schema[];
	page: number;
	limit: number;
	total: number;
	totalPages: number;
}

export interface SchemaDetail {
	schema: Schema;
	/** People who have a value for it (for personal data, who have any personal custom data). */
	userCount: number;
	/** The count is not exact (personal data is counted tenant-wide), or -1 when unreachable. */
	userCountApproximate: boolean;
}

export interface RenameResult {
	schema: Schema;
	affectedUsers: number;
	oldKey: string;
	newKey: string;
}

/** What Retry did: it re-ran a rename, or only made the attribute active again. */
export interface RetryResult {
	action: 'rename_completed' | 'reset_to_active';
	schema?: Schema;
	affectedUsers?: number;
}

export interface HistoryEntry {
	version: number;
	operation: string;
	createdAt: number;
	actorId: string | null;
	actorType: string;
	changeSource: string;
	summary: { added: number; removed: number; modified: number };
}

export interface HistoryDetail extends Omit<HistoryEntry, 'summary'> {
	/** The attribute as it was after the change. */
	snapshot: Record<string, unknown>;
	changes: {
		added: string[];
		removed: string[];
		modified: { key: string; oldValue: unknown; newValue: unknown }[];
	};
}

export interface PresetField {
	fieldKey: string;
	label: string;
	type: FieldType;
	cardinality: Cardinality;
	isPii: boolean;
	groupLabel: string;
	description: string;
}

export interface Preset {
	id: string;
	label: string;
	description: string;
	fields: PresetField[];
}

export interface PresetList {
	presets: Preset[];
	/** Keys of the attributes that are active now (an inactive one still blocks adding). */
	existingKeys: string[];
}

export interface PresetResult {
	presetId: string;
	createdKeys: string[];
	skippedKeys: string[];
}

export interface SchemaStats {
	total: number;
	activeNonPii: number;
	activePii: number;
	nonPiiUsersWithData: number;
	/** -1: the personal data store could not be reached. */
	piiUsersWithData: number;
	piiUsersApproximate: boolean;
	errorCount: number;
}

export interface SchemaSettingClient {
	list(tenantId: string, query?: SchemaQuery, signal?: AbortSignal): Promise<SchemaPage>;
	get(tenantId: string, id: string): Promise<SchemaDetail>;
	create(tenantId: string, input: NewSchema): Promise<Schema>;
	update(tenantId: string, id: string, change: SchemaChange): Promise<Schema>;
	remove(tenantId: string, id: string): Promise<void>;
	rename(tenantId: string, id: string, newKey: string): Promise<RenameResult>;
	retry(tenantId: string, id: string): Promise<RetryResult>;
	history(
		tenantId: string,
		id: string,
		paging?: { limit?: number; offset?: number }
	): Promise<{ versions: HistoryEntry[]; total: number }>;
	historyVersion(tenantId: string, id: string, version: number): Promise<HistoryDetail>;
	presets(tenantId: string): Promise<PresetList>;
	applyPreset(tenantId: string, presetId: string, keys?: string[]): Promise<PresetResult>;
	reservedNames(tenantId: string): Promise<string[]>;
	stats(tenantId: string): Promise<SchemaStats>;
}

// ---------------------------------------------------------------------------------------------
// Reading more than the API gives at once

/** What one API call returns at most is 100; the window below asks in chunks of at most this size. */
const CHUNK = 50;

/**
 * A window of the list of any size: `page` of `size` attributes, put together from the API's own
 * smaller pages (it answers at most 100 at a time and has no offset). The first call says how many
 * there are; the rest are asked for together. A window larger than a chunk is a whole number of
 * chunks (250 is five); another size is refused.
 */
export async function listWindow(
	client: SchemaSettingClient,
	tenantId: string,
	query: Omit<SchemaQuery, 'page' | 'limit'>,
	window: { page: number; size: number },
	signal?: AbortSignal
): Promise<SchemaPage> {
	const chunk = Math.min(CHUNK, window.size);
	if (window.size % chunk !== 0)
		throw new RangeError(`window size ${window.size} is not whole chunks`);
	const perWindow = window.size / chunk;
	const first = (window.page - 1) * perWindow + 1;
	// Attributes added or removed while the chunks are read shift the ones after them, so a row can
	// come twice (or be missed). One read again settles that in all but a constant stream of changes;
	// what is still doubled after it is shown once.
	for (let attempt = 0; ; attempt++) {
		const head = await client.list(tenantId, { ...query, page: first, limit: chunk }, signal);
		const lastNeeded = Math.min(first + perWindow - 1, head.totalPages);
		const rest = await Promise.all(
			Array.from({ length: Math.max(0, lastNeeded - first) }, (_, index) =>
				client.list(tenantId, { ...query, page: first + 1 + index, limit: chunk }, signal)
			)
		);
		const all = [head, ...rest].flatMap((part) => part.schemas);
		const unique = [...new Map(all.map((schema) => [schema.id, schema])).values()];
		if (unique.length < all.length && attempt === 0) continue;
		return {
			schemas: unique.slice(0, window.size),
			page: window.page,
			limit: window.size,
			total: head.total,
			totalPages: Math.max(1, Math.ceil(head.total / window.size))
		};
	}
}

// ---------------------------------------------------------------------------------------------
// Failures

/**
 * What went wrong, in the terms a page acts on. The API's validation failures all read the same
 * ("The field format is invalid."), so `invalid` says only that a value was refused: the page
 * checks values itself before sending (see `schema-validation.ts`).
 */
export type SchemaFailureKind =
	| 'invalid'
	| 'conflict'
	| 'in_use'
	| 'forbidden'
	| 'not_found'
	/** Some people's values could not be moved or deleted; the attribute is marked as failed. */
	| 'partial'
	| 'failed';

export interface SchemaFailure {
	kind: SchemaFailureKind;
	/** For `in_use`: what relies on the attribute. */
	usage: UsageBinding[];
	/** For `partial` and `forbidden`: the API's own explanation, when it gave a readable one. */
	detail: string;
}

export function failureOf(error: unknown): SchemaFailure {
	const none: SchemaFailure = { kind: 'failed', usage: [], detail: '' };
	if (!(error instanceof ApiError)) return none;
	const body = error.body;
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	switch (error.status) {
		case 400:
			return { ...none, kind: 'invalid' };
		case 403:
			return { ...none, kind: 'forbidden', detail: text(body.error_description) };
		case 404:
			return { ...none, kind: 'not_found' };
		case 409:
			return body.error === 'field_in_use'
				? { ...none, kind: 'in_use', usage: usageFrom(body.usage_bindings) }
				: { ...none, kind: 'conflict' };
		default:
			// A half-finished delete or rename answers `{ success: false, error }`.
			return body.success === false ? { ...none, kind: 'partial', detail: text(body.error) } : none;
	}
}

// ---------------------------------------------------------------------------------------------
// From the wire

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0) => (typeof value === 'number' ? value : fallback);
const str = (value: unknown) => (typeof value === 'string' ? value : null);
const flag = (value: unknown) => value === 1 || value === true;

function parseJson<T>(value: unknown): T | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') return value as T;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function usageFrom(value: unknown): UsageBinding[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry: Row) => ({
		id: String(entry.id ?? ''),
		bindingType: String(entry.binding_type ?? ''),
		bindingId: String(entry.binding_id ?? ''),
		protection: (entry.protection as UsageProtection) ?? 'none',
		reason: str(entry.reason),
		source: String(entry.source ?? '')
	}));
}

/** A schema as the API sends it. */
export function schemaFromRow(row: Row): Schema {
	const scopes = parseJson<string[]>(row.required_scopes);
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id ?? ''),
		fieldKey: String(row.field_key),
		label: String(row.display_label ?? ''),
		type: (row.field_type as FieldType) ?? 'string',
		cardinality: (row.cardinality as Cardinality) ?? 'single',
		isPii: flag(row.is_pii),
		isRequired: flag(row.is_required),
		isActive: flag(row.is_active),
		isSystem: flag(row.is_system),
		validation: parseJson<ValidationRules>(row.validation_rules),
		requiredScopes: Array.isArray(scopes) ? scopes : [],
		scopeMode: row.scope_mode === 'all' ? 'all' : 'any',
		isSearchable: flag(row.is_searchable),
		isExportable: flag(row.is_exportable),
		isVcClaim: flag(row.is_vc_claim),
		claimNamespace: str(row.claim_namespace),
		description: str(row.description),
		displayOrder: num(row.display_order),
		version: num(row.schema_version, 1),
		status: (row.operation_status as OperationStatus) ?? 'active',
		operation: parseJson<OperationDetail>(row.operation_detail),
		createdBy: str(row.created_by),
		createdAt: num(row.created_at) * 1000,
		updatedAt: num(row.updated_at) * 1000,
		showOnRegistration: flag(row.show_on_registration),
		registrationRequired: flag(row.registration_required),
		registrationOrder: num(row.registration_order),
		registrationPlaceholder: str(row.registration_placeholder),
		groupKey: str(row.ui_group_key),
		groupLabel: str(row.ui_group_label),
		groupOrder: num(row.ui_group_order, 90),
		fieldOrder: num(row.ui_field_order, 100),
		examples: parseJson<unknown>(row.examples_json),
		usage: usageFrom(row.usage_bindings),
		inUse: flag(row.is_system_used)
	};
}

function historyEntryFrom(row: Row): HistoryEntry {
	const summary = (row.changes_summary ?? {}) as Row;
	return {
		version: num(row.version),
		operation: String(row.operation ?? ''),
		createdAt: num(row.created_at) * 1000,
		actorId: str(row.actor_id),
		actorType: String(row.actor_type ?? ''),
		changeSource: String(row.change_source ?? ''),
		summary: {
			added: num(summary.added),
			removed: num(summary.removed),
			modified: num(summary.modified)
		}
	};
}

// ---------------------------------------------------------------------------------------------
// To the wire

/** The keys the API takes, for what a change sets (only what is present). */
function bodyFromChange(change: SchemaChange): Row {
	const map: [keyof SchemaChange, string][] = [
		['label', 'display_label'],
		['type', 'field_type'],
		['cardinality', 'cardinality'],
		['isRequired', 'is_required'],
		['isActive', 'is_active'],
		['validation', 'validation_rules'],
		['requiredScopes', 'required_scopes'],
		['scopeMode', 'scope_mode'],
		['isSearchable', 'is_searchable'],
		['isExportable', 'is_exportable'],
		['isVcClaim', 'is_vc_claim'],
		['claimNamespace', 'claim_namespace'],
		['description', 'description'],
		['displayOrder', 'display_order'],
		['showOnRegistration', 'show_on_registration'],
		['registrationRequired', 'registration_required'],
		['registrationOrder', 'registration_order'],
		['registrationPlaceholder', 'registration_placeholder'],
		['groupKey', 'ui_group_key'],
		['groupLabel', 'ui_group_label'],
		['groupOrder', 'ui_group_order'],
		['fieldOrder', 'ui_field_order']
	];
	const body: Row = {};
	for (const [from, to] of map) if (change[from] !== undefined) body[to] = change[from];
	return body;
}

function bodyFromNew(input: NewSchema): Row {
	return {
		field_key: input.fieldKey,
		display_label: input.label,
		...(input.type !== undefined ? { field_type: input.type } : {}),
		...(input.cardinality !== undefined ? { cardinality: input.cardinality } : {}),
		...(input.isPii !== undefined ? { is_pii: input.isPii } : {}),
		...(input.isRequired !== undefined ? { is_required: input.isRequired } : {}),
		...(input.description ? { description: input.description } : {}),
		...(input.validation ? { validation_rules: input.validation } : {}),
		...(input.isSearchable !== undefined ? { is_searchable: input.isSearchable } : {}),
		...(input.isExportable !== undefined ? { is_exportable: input.isExportable } : {}),
		...(input.showOnRegistration !== undefined
			? { show_on_registration: input.showOnRegistration }
			: {}),
		...(input.registrationRequired !== undefined
			? { registration_required: input.registrationRequired }
			: {})
	};
}

// ---------------------------------------------------------------------------------------------
// Over HTTP

const BASE = '/api/admin/custom-claims';

function query(params: Record<string, string | number | boolean | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params))
		if (value !== undefined && value !== '') search.set(key, String(value));
	const text = search.toString();
	return text ? `?${text}` : '';
}

async function request<T>(
	tenantId: string,
	path: string,
	init: RequestInit & { json?: unknown } = {}
): Promise<T> {
	const { json, ...rest } = init;
	const response = await adminFetch(`${API_BASE_URL}${BASE}${path}`, {
		...rest,
		tenantId,
		...(json !== undefined
			? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }
			: {})
	});
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json()) as T;
}

const idPath = (id: string) => `/${encodeURIComponent(id)}`;
const zeroOne = (value: boolean | undefined) =>
	value === undefined ? undefined : value ? '1' : '0';

export const httpSchemaSetting: SchemaSettingClient = {
	async list(tenantId, q = {}, signal) {
		const data = await request<{
			schemas: Row[];
			pagination: { page: number; limit: number; total: number; total_pages: number };
		}>(
			tenantId,
			query({
				page: q.page,
				limit: q.limit,
				search: q.search,
				field_type: q.type,
				is_pii: zeroOne(q.isPii),
				is_active: zeroOne(q.isActive),
				is_system: zeroOne(q.isSystem),
				operation_status: q.status
			}),
			{ signal }
		);
		return {
			schemas: data.schemas.map(schemaFromRow),
			page: data.pagination.page,
			limit: data.pagination.limit,
			total: data.pagination.total,
			totalPages: data.pagination.total_pages
		};
	},
	async get(tenantId, id) {
		const data = await request<{
			schema: Row;
			user_count: number;
			user_count_approximate: boolean;
		}>(tenantId, idPath(id));
		return {
			schema: schemaFromRow(data.schema),
			userCount: data.user_count,
			userCountApproximate: data.user_count_approximate
		};
	},
	async create(tenantId, input) {
		const data = await request<{ schema: Row }>(tenantId, '', {
			method: 'POST',
			json: bodyFromNew(input)
		});
		return schemaFromRow(data.schema);
	},
	async update(tenantId, id, change) {
		const data = await request<{ schema: Row }>(tenantId, idPath(id), {
			method: 'PUT',
			json: bodyFromChange(change)
		});
		return schemaFromRow(data.schema);
	},
	async remove(tenantId, id) {
		await request(tenantId, idPath(id), { method: 'DELETE' });
	},
	async rename(tenantId, id, newKey) {
		const data = await request<{
			schema: Row;
			affected_users: number;
			old_key: string;
			new_key: string;
		}>(tenantId, `${idPath(id)}/rename`, { method: 'PATCH', json: { new_field_key: newKey } });
		return {
			schema: schemaFromRow(data.schema),
			affectedUsers: data.affected_users,
			oldKey: data.old_key,
			newKey: data.new_key
		};
	},
	async retry(tenantId, id) {
		const data = await request<{
			action: RetryResult['action'];
			schema?: Row;
			affected_users?: number;
		}>(tenantId, `${idPath(id)}/retry`, { method: 'POST' });
		return {
			action: data.action,
			...(data.schema ? { schema: schemaFromRow(data.schema) } : {}),
			...(data.affected_users !== undefined ? { affectedUsers: data.affected_users } : {})
		};
	},
	async history(tenantId, id, paging = {}) {
		const data = await request<{ versions: Row[]; total: number }>(
			tenantId,
			`${idPath(id)}/history${query({ limit: paging.limit, offset: paging.offset })}`
		);
		return { versions: data.versions.map(historyEntryFrom), total: data.total };
	},
	async historyVersion(tenantId, id, version) {
		const data = await request<{ history: Row }>(tenantId, `${idPath(id)}/history/${version}`);
		const row = data.history;
		const changes = (row.changes ?? {}) as Row;
		return {
			...historyEntryFrom({ ...row, changes_summary: undefined }),
			snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
			changes: {
				added: (changes.added as string[]) ?? [],
				removed: (changes.removed as string[]) ?? [],
				modified: ((changes.modified as Row[]) ?? []).map((entry) => ({
					key: String(entry.key),
					oldValue: entry.oldValue,
					newValue: entry.newValue
				}))
			}
		};
	},
	async presets(tenantId) {
		const data = await request<{
			presets: {
				id: string;
				label: string;
				description: string;
				fields: Row[];
			}[];
			existing_field_keys: string[];
		}>(tenantId, '/presets');
		return {
			presets: data.presets.map((preset) => ({
				id: preset.id,
				label: preset.label,
				description: preset.description,
				fields: preset.fields.map((field) => ({
					fieldKey: String(field.field_key),
					label: String(field.display_label),
					type: field.field_type as FieldType,
					cardinality: field.cardinality === 'multi' ? 'multi' : 'single',
					isPii: flag(field.is_pii),
					groupLabel: String(field.ui_group_label ?? ''),
					description: String(field.description ?? '')
				}))
			})),
			existingKeys: data.existing_field_keys
		};
	},
	async applyPreset(tenantId, presetId, keys) {
		const data = await request<{
			preset_id: string;
			created_field_keys: string[];
			skipped_field_keys: string[];
		}>(tenantId, '/presets/apply', {
			method: 'POST',
			json: { preset_id: presetId, ...(keys ? { field_keys: keys } : {}) }
		});
		return {
			presetId: data.preset_id,
			createdKeys: data.created_field_keys,
			skippedKeys: data.skipped_field_keys
		};
	},
	async reservedNames(tenantId) {
		const data = await request<{ reserved_names: string[] }>(tenantId, '/reserved-names');
		return data.reserved_names;
	},
	async stats(tenantId) {
		const data = await request<{
			total: number;
			active_non_pii: number;
			active_pii: number;
			non_pii_users_with_data: number;
			pii_users_with_data: number;
			pii_users_approximate: boolean;
			error_count: number;
		}>(tenantId, '/stats');
		return {
			total: data.total,
			activeNonPii: data.active_non_pii,
			activePii: data.active_pii,
			nonPiiUsersWithData: data.non_pii_users_with_data,
			piiUsersWithData: data.pii_users_with_data,
			piiUsersApproximate: data.pii_users_approximate,
			errorCount: data.error_count
		};
	}
};
