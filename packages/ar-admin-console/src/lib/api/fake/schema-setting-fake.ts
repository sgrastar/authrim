/**
 * An in-memory schema setting API for Storybook and tests: a tenant's attributes (the base ones
 * from the OIDC preset, and its own), answering as the Admin API does. Base attributes are locked,
 * an attribute that something relies on cannot be deleted, a key that is reserved or in use is
 * refused (with the API's fixed "invalid" answer: it never says why), a type's cardinality cannot
 * change while there are values, and a delete or a rename can end half done.
 */
import { ApiError } from '../api-error';
import type {
	HistoryDetail,
	HistoryEntry,
	NewSchema,
	OperationDetail,
	Preset,
	PresetResult,
	RenameResult,
	RetryResult,
	Schema,
	SchemaChange,
	SchemaDetail,
	SchemaPage,
	SchemaQuery,
	SchemaSettingClient,
	SchemaStats
} from '../schema-setting';

export interface FakeSchemaSettingOptions {
	/** No attributes yet. */
	empty?: boolean;
	/** Milliseconds every call waits (to show loading and in-flight states). */
	delay?: number;
	/** The next delete or rename of a person's data stops half way, as a worker failing would. */
	failPartially?: boolean;
	/** This many more attributes of the tenant's own, to see a long list. */
	extra?: number;
	now?: number;
}

const DAY = 86_400_000;

/** `count` made-up attributes, in a group of their own, after the sample ones. */
function filler(now: number, count: number): Schema[] {
	return Array.from({ length: count }, (_, index) => ({
		...base(now),
		id: `s-extra-${index + 1}`,
		fieldKey: `imported_${String(index + 1).padStart(3, '0')}`,
		label: `Imported attribute ${index + 1}`,
		groupKey: 'imported',
		groupLabel: 'Imported',
		groupOrder: 80,
		fieldOrder: index + 1
	}));
}

/** The keys the API will not let a tenant's own attribute take (a short, representative list). */
const RESERVED = [
	'sub',
	'iss',
	'aud',
	'exp',
	'iat',
	'jti',
	'name',
	'given_name',
	'family_name',
	'email',
	'email_verified',
	'phone_number',
	'birthdate',
	'address',
	'locale',
	'updated_at'
];

function base(now: number): Omit<Schema, 'id' | 'fieldKey' | 'label'> {
	return {
		tenantId: 'acme',
		type: 'string',
		cardinality: 'single',
		isPii: false,
		isRequired: false,
		isActive: true,
		isSystem: false,
		validation: null,
		requiredScopes: [],
		scopeMode: 'any',
		isSearchable: true,
		isExportable: true,
		isVcClaim: false,
		claimNamespace: null,
		description: null,
		displayOrder: 100,
		version: 1,
		status: 'active',
		operation: null,
		createdBy: 'adm_owner',
		createdAt: now - 90 * DAY,
		updatedAt: now - 90 * DAY,
		showOnRegistration: false,
		registrationRequired: false,
		registrationOrder: 0,
		registrationPlaceholder: null,
		groupKey: null,
		groupLabel: null,
		groupOrder: 90,
		fieldOrder: 100,
		examples: null,
		usage: [],
		inUse: false
	};
}

function sampleSchemas(now: number): Schema[] {
	const row = (
		id: string,
		fieldKey: string,
		label: string,
		over: Partial<Schema> = {}
	): Schema => ({ ...base(now), id, fieldKey, label, ...over });
	const system = (over: Partial<Schema>) => ({
		isSystem: true,
		groupKey: 'profile',
		groupLabel: 'Profile',
		groupOrder: 10,
		...over
	});
	return [
		row(
			's-name',
			'name',
			'Full name',
			system({ isPii: true, showOnRegistration: true, registrationOrder: 1, fieldOrder: 10 })
		),
		row(
			's-email',
			'email',
			'Email address',
			system({
				isPii: true,
				groupKey: 'contact',
				groupLabel: 'Contact',
				groupOrder: 20,
				showOnRegistration: true,
				registrationRequired: true,
				registrationOrder: 2,
				fieldOrder: 10,
				inUse: true,
				usage: [
					{
						id: 'derived:passkey:email',
						bindingType: 'authentication_method',
						bindingId: 'passkey_signup',
						protection: 'delete_blocked',
						reason: 'Passkey sign-up asks for it',
						source: 'derived'
					},
					{
						id: 'derived:otp:email',
						bindingType: 'authentication_method',
						bindingId: 'email_otp_login',
						protection: 'delete_blocked',
						reason: 'Email codes are sent to it',
						source: 'derived'
					}
				]
			})
		),
		row(
			's-email-verified',
			'email_verified',
			'Email verified',
			system({
				type: 'boolean',
				groupKey: 'contact',
				groupLabel: 'Contact',
				groupOrder: 20,
				fieldOrder: 20
			})
		),
		row(
			's-phone',
			'phone_number',
			'Phone number',
			system({
				isPii: true,
				groupKey: 'contact',
				groupLabel: 'Contact',
				groupOrder: 20,
				fieldOrder: 30
			})
		),
		row(
			's-birthdate',
			'birthdate',
			'Date of birth',
			system({ isPii: true, type: 'date', fieldOrder: 20 })
		),
		row('s-employee', 'employee_id', 'Employee ID', {
			isRequired: true,
			validation: { min_length: 4, max_length: 8, pattern: '^E\\d+$' },
			description: 'The ID printed on the staff card.',
			showOnRegistration: true,
			registrationRequired: true,
			registrationOrder: 3,
			registrationPlaceholder: 'E1234',
			groupKey: 'workforce',
			groupLabel: 'Workforce',
			groupOrder: 40,
			fieldOrder: 10,
			version: 3,
			updatedAt: now - 3 * DAY
		}),
		row('s-department', 'department', 'Department', {
			type: 'enum',
			validation: { enum_values: ['Engineering', 'Sales', 'Support', 'Finance'] },
			groupKey: 'workforce',
			groupLabel: 'Workforce',
			groupOrder: 40,
			fieldOrder: 20
		}),
		row('s-manager', 'manager_id', 'Manager', {
			isPii: true,
			groupKey: 'workforce',
			groupLabel: 'Workforce',
			groupOrder: 40,
			fieldOrder: 30
		}),
		row('s-cost', 'cost_center', 'Cost center', {
			type: 'number',
			validation: { min: 100, max: 9999 },
			groupKey: 'workforce',
			groupLabel: 'Workforce',
			groupOrder: 40,
			fieldOrder: 40
		}),
		row('s-badge', 'badge_expiry', 'Badge expires on', {
			type: 'date',
			isActive: false,
			groupKey: 'workforce',
			groupLabel: 'Workforce',
			groupOrder: 40,
			fieldOrder: 50
		}),
		row('s-skills', 'skills', 'Skills', { cardinality: 'multi', isSearchable: true }),
		row('s-locker', 'locker_code', 'Locker code', {
			status: 'error',
			operation: {
				operation: 'rename',
				old_key: 'locker',
				new_key: 'locker_code',
				error: 'Partial rename: 2 user(s) failed',
				failed_users: 2,
				total_processed: 40
			}
		}),
		row('s-legacy', 'legacy_ref', 'Legacy reference', {
			status: 'renaming',
			operation: { operation: 'rename', old_key: 'legacy', new_key: 'legacy_ref' }
		})
	];
}

const PRESETS: Preset[] = [
	{
		id: 'oidc_standard',
		label: 'OIDC Standard Claims',
		description: 'The standard profile, contact and address claims of OpenID Connect.',
		fields: [
			['name', 'Full name', 'string', true, 'Profile'],
			['given_name', 'Given name', 'string', true, 'Profile'],
			['family_name', 'Family name', 'string', true, 'Profile'],
			['email', 'Email address', 'string', true, 'Contact'],
			['email_verified', 'Email verified', 'boolean', false, 'Contact'],
			['phone_number', 'Phone number', 'string', true, 'Contact'],
			['address_country', 'Country', 'string', true, 'Address'],
			['birthdate', 'Date of birth', 'date', true, 'Profile']
		].map(([fieldKey, label, type, isPii, groupLabel]) => ({
			fieldKey: fieldKey as string,
			label: label as string,
			type: type as 'string',
			cardinality: 'single' as const,
			isPii: isPii as boolean,
			groupLabel: groupLabel as string,
			description: ''
		}))
	},
	{
		id: 'scim_enterprise_user',
		label: 'SCIM Enterprise User',
		description: 'The workforce attributes of the SCIM enterprise user extension.',
		fields: [
			['employee_number', 'Employee number', 'string', false],
			['cost_center', 'Cost center', 'string', false],
			['organization', 'Organization', 'string', false],
			['department', 'Department', 'string', false],
			['manager_id', 'Manager', 'string', true]
		].map(([fieldKey, label, type, isPii]) => ({
			fieldKey: fieldKey as string,
			label: label as string,
			type: type as 'string',
			cardinality: 'single' as const,
			isPii: isPii as boolean,
			groupLabel: 'Workforce',
			description: ''
		}))
	}
];

const invalid = () => new ApiError(400, 'invalid_request', 'The field format is invalid.', {});
const notFound = () =>
	new ApiError(404, 'invalid_request', 'The requested resource was not found.', {});

export function createFakeSchemaSetting(
	options: FakeSchemaSettingOptions = {}
): SchemaSettingClient {
	const now = options.now ?? Date.now();
	let schemas = options.empty ? [] : [...sampleSchemas(now), ...filler(now, options.extra ?? 0)];
	const history = new Map<string, HistoryDetail[]>();
	let failPartially = options.failPartially ?? false;
	let counter = 100;

	const pause = () =>
		options.delay ? new Promise<void>((resolve) => setTimeout(resolve, options.delay)) : undefined;
	const find = (id: string) => {
		const found = schemas.find((schema) => schema.id === id);
		if (!found) throw notFound();
		return found;
	};
	const activeKeys = () =>
		new Set(schemas.filter((schema) => schema.isActive).map((schema) => schema.fieldKey));
	const ordered = (list: Schema[]) =>
		[...list].sort(
			(a, b) =>
				a.groupOrder - b.groupOrder ||
				a.fieldOrder - b.fieldOrder ||
				a.displayOrder - b.displayOrder ||
				a.createdAt - b.createdAt
		);

	function record(schema: Schema, operation: string, changed: string[] = []) {
		const entries = history.get(schema.id) ?? [];
		entries.push({
			version: entries.length + 1,
			operation,
			createdAt: Date.now(),
			actorId: 'adm_owner',
			actorType: 'admin',
			changeSource: 'admin_api',
			snapshot: { ...schema },
			changes: {
				added: [],
				removed: [],
				modified: ['updated_at', ...changed].map((key) => ({ key, oldValue: null, newValue: null }))
			}
		});
		history.set(schema.id, entries);
	}

	function replace(next: Schema) {
		schemas = schemas.map((schema) => (schema.id === next.id ? next : schema));
		return next;
	}

	function checkNewKey(key: string, current?: string) {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || RESERVED.includes(key)) throw invalid();
		if (key !== current && activeKeys().has(key)) throw invalid();
	}

	const usersWith = (schema: Schema) => (schema.isPii ? 120 : schema.id === 's-employee' ? 96 : 12);

	return {
		async list(_tenantId, query: SchemaQuery = {}) {
			await pause();
			const text = query.search?.toLowerCase();
			let rows = schemas.filter(
				(schema) =>
					(!text ||
						schema.fieldKey.includes(text) ||
						schema.label.toLowerCase().includes(text) ||
						(schema.description ?? '').toLowerCase().includes(text)) &&
					(query.type === undefined || schema.type === query.type) &&
					(query.isPii === undefined || schema.isPii === query.isPii) &&
					(query.isActive === undefined || schema.isActive === query.isActive) &&
					(query.isSystem === undefined || schema.isSystem === query.isSystem) &&
					(query.status === undefined || schema.status === query.status)
			);
			rows = ordered(rows);
			const limit = Math.min(query.limit ?? 50, 100);
			const page = query.page ?? 1;
			const result: SchemaPage = {
				schemas: rows.slice((page - 1) * limit, page * limit),
				page,
				limit,
				total: rows.length,
				totalPages: Math.ceil(rows.length / limit)
			};
			return result;
		},
		async get(_tenantId, id): Promise<SchemaDetail> {
			await pause();
			const schema = find(id);
			return {
				schema,
				userCount: usersWith(schema),
				userCountApproximate: schema.isPii
			};
		},
		async create(_tenantId, input: NewSchema) {
			await pause();
			checkNewKey(input.fieldKey);
			if (!input.label.trim() || input.label.length > 255) throw invalid();
			counter += 1;
			const schema: Schema = {
				...base(Date.now()),
				id: `s-new-${counter}`,
				fieldKey: input.fieldKey,
				label: input.label.trim(),
				type: input.type ?? 'string',
				cardinality: input.cardinality ?? 'single',
				isPii: input.isPii ?? false,
				isRequired: input.isRequired ?? false,
				description: input.description ?? null,
				validation: input.validation ?? null,
				isSearchable: input.isSearchable ?? true,
				isExportable: input.isExportable ?? true,
				showOnRegistration: input.showOnRegistration ?? false,
				registrationRequired: input.registrationRequired ?? false
			};
			schemas = [...schemas, schema];
			record(schema, 'create');
			return schema;
		},
		async update(_tenantId, id, change: SchemaChange) {
			await pause();
			const schema = find(id);
			if (schema.status !== 'active') throw invalid();
			// A base attribute refuses a locked field that is sent at all.
			if (
				schema.isSystem &&
				(change.label !== undefined ||
					change.type !== undefined ||
					change.cardinality !== undefined)
			)
				throw new ApiError(403, 'forbidden', 'Cannot modify label on system claims', {
					error: 'forbidden',
					error_description: 'Cannot modify label on system claims'
				});
			if (change.label !== undefined && (!change.label.trim() || change.label.length > 255))
				throw invalid();
			if (change.cardinality && change.cardinality !== schema.cardinality && usersWith(schema) > 0)
				throw new ApiError(409, 'invalid_request', 'The request conflicts with existing data.', {
					error: 'invalid_request'
				});
			const next: Schema = {
				...schema,
				...definedOnly(change),
				// `null` clears the scopes, as it does at the API.
				requiredScopes:
					change.requiredScopes === undefined
						? schema.requiredScopes
						: (change.requiredScopes ?? []),
				updatedAt: Date.now()
			};
			replace(next);
			record(next, 'update', Object.keys(change));
			return next;
		},
		async remove(_tenantId, id) {
			await pause();
			const schema = find(id);
			if (schema.isSystem)
				throw new ApiError(403, 'forbidden', 'System claims cannot be deleted', {
					error: 'forbidden',
					error_description: 'System claims cannot be deleted'
				});
			if (schema.status !== 'active' && schema.status !== 'error') throw invalid();
			const blocking = schema.usage.filter((entry) => entry.protection === 'delete_blocked');
			if (blocking.length > 0)
				throw new ApiError(409, 'field_in_use', 'This schema field is currently used.', {
					error: 'field_in_use',
					usage_bindings: blocking.map((entry) => ({
						id: entry.id,
						binding_type: entry.bindingType,
						binding_id: entry.bindingId,
						protection: entry.protection,
						reason: entry.reason,
						source: entry.source
					}))
				});
			if (failPartially) {
				failPartially = false;
				replace({
					...schema,
					status: 'error',
					operation: {
						operation: 'delete',
						field_key: schema.fieldKey,
						error: 'Partial deletion: 3 user(s) failed',
						failed_users: 3,
						total_processed: usersWith(schema)
					}
				});
				throw new ApiError(500, '', 'Partial deletion', {
					success: false,
					error: 'Partial deletion: 3 user(s) failed. Schema marked as error state for retry.'
				});
			}
			schemas = schemas.filter((other) => other.id !== id);
		},
		async rename(_tenantId, id, newKey): Promise<RenameResult> {
			await pause();
			const schema = find(id);
			if (schema.isSystem)
				throw new ApiError(403, 'forbidden', 'System claims cannot be renamed', {
					error: 'forbidden',
					error_description: 'System claims cannot be renamed'
				});
			if (schema.status !== 'active') throw invalid();
			checkNewKey(newKey, schema.fieldKey);
			if (newKey === schema.fieldKey) throw invalid();
			if (failPartially) {
				failPartially = false;
				const detail: OperationDetail = {
					operation: 'rename',
					old_key: schema.fieldKey,
					new_key: newKey,
					error: 'Partial rename: 2 user(s) failed'
				};
				replace({ ...schema, status: 'error', operation: detail });
				throw new ApiError(500, '', 'Partial rename', {
					success: false,
					error: 'Partial rename: 2 user(s) failed. Schema marked as error state for retry.'
				});
			}
			const next = replace({
				...schema,
				fieldKey: newKey,
				version: schema.version + 1,
				updatedAt: Date.now()
			});
			record(next, 'rename');
			return { schema: next, affectedUsers: usersWith(schema), oldKey: schema.fieldKey, newKey };
		},
		async retry(_tenantId, id): Promise<RetryResult> {
			await pause();
			const schema = find(id);
			if (schema.status !== 'error') throw invalid();
			const detail = schema.operation;
			if (detail?.operation === 'rename' && detail.old_key && detail.new_key) {
				const next = replace({
					...schema,
					fieldKey: detail.new_key,
					status: 'active',
					operation: null,
					version: schema.version + 1
				});
				record(next, 'rename');
				return { action: 'rename_completed', schema: next, affectedUsers: 40 };
			}
			// A failed delete is only made active again: the delete has to be run once more.
			replace({ ...schema, status: 'active', operation: null });
			return { action: 'reset_to_active' };
		},
		async history(_tenantId, id, paging = {}) {
			await pause();
			const entries = [...(history.get(id) ?? [])].reverse();
			const offset = paging.offset ?? 0;
			const limit = paging.limit ?? 50;
			const versions: HistoryEntry[] = entries.slice(offset, offset + limit).map((entry) => ({
				version: entry.version,
				operation: entry.operation,
				createdAt: entry.createdAt,
				actorId: entry.actorId,
				actorType: entry.actorType,
				changeSource: entry.changeSource,
				summary: { added: 0, removed: 0, modified: entry.changes.modified.length }
			}));
			return { versions, total: entries.length };
		},
		async historyVersion(_tenantId, id, version) {
			await pause();
			const found = history.get(id)?.find((entry) => entry.version === version);
			if (!found) throw notFound();
			return found;
		},
		async presets() {
			await pause();
			return { presets: PRESETS, existingKeys: [...activeKeys()] };
		},
		async applyPreset(_tenantId, presetId, keys): Promise<PresetResult> {
			await pause();
			const preset = PRESETS.find((candidate) => candidate.id === presetId);
			if (!preset) throw new ApiError(400, 'invalid_request', 'The provided value is invalid.', {});
			const wanted = preset.fields.filter((field) => !keys || keys.includes(field.fieldKey));
			if (wanted.length === 0)
				throw new ApiError(400, 'invalid_request', 'The provided value is invalid.', {});
			const taken = new Set(schemas.map((schema) => schema.fieldKey));
			const result: PresetResult = { presetId, createdKeys: [], skippedKeys: [] };
			for (const field of wanted) {
				if (taken.has(field.fieldKey)) {
					result.skippedKeys.push(field.fieldKey);
					continue;
				}
				counter += 1;
				schemas = [
					...schemas,
					{
						...base(Date.now()),
						id: `s-preset-${counter}`,
						fieldKey: field.fieldKey,
						label: field.label,
						type: field.type,
						isPii: field.isPii,
						isSystem: true,
						groupLabel: field.groupLabel,
						groupKey: field.groupLabel.toLowerCase()
					}
				];
				result.createdKeys.push(field.fieldKey);
			}
			return result;
		},
		async reservedNames() {
			await pause();
			return [...RESERVED].sort();
		},
		async stats(): Promise<SchemaStats> {
			await pause();
			const active = schemas.filter((schema) => schema.isActive);
			return {
				total: schemas.length,
				activeNonPii: active.filter((schema) => !schema.isPii).length,
				activePii: active.filter((schema) => schema.isPii).length,
				nonPiiUsersWithData: 96,
				piiUsersWithData: 120,
				piiUsersApproximate: true,
				errorCount: schemas.filter((schema) => schema.status === 'error').length
			};
		}
	};
}

function definedOnly<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
