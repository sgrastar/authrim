/**
 * Rules the tenant pages share: what a tenant id may look like, what a copy can take from its
 * source, and which lifecycle states allow which actions. Kept apart from the pages so they are
 * tested without rendering.
 */
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { TenantCopyOptions, TenantCopyPart, TenantLifecycleState } from '#lib/api/tenants.js';

/** As the API checks it: a DNS label, 1–63 characters, lowercase letters, digits and hyphens. */
export const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const TENANT_ID_MAX = 63;
/** Reserved for the platform's own records; the API refuses it as an id or a code. */
const RESERVED_TENANT_IDS: ReadonlySet<string> = new Set(['platform']);

export type TenantIdProblem = 'required' | 'format' | 'reserved' | 'same' | 'taken' | null;

/**
 * `sourceId`: the tenant being copied (the copy needs another id). `taken`: ids (or codes) the
 * tenants already have; the API answers a repeat with a plain 400, so it is caught here first.
 */
export function tenantIdProblem(
	value: string,
	options: { sourceId?: string; taken?: ReadonlySet<string> } = {}
): TenantIdProblem {
	const id = value.trim();
	if (!id) return 'required';
	if (id.length > TENANT_ID_MAX || !TENANT_ID_PATTERN.test(id)) return 'format';
	if (RESERVED_TENANT_IDS.has(id)) return 'reserved';
	if (options.sourceId !== undefined && id === options.sourceId) return 'same';
	if (options.taken?.has(id)) return 'taken';
	return null;
}

/** The ids and the codes the listed tenants hold; the API checks each against its own kind. */
export interface TakenIdentifiers {
	ids: ReadonlySet<string>;
	codes: ReadonlySet<string>;
}

export function takenIdentifiers(
	tenants: ReadonlyArray<{ id: string; code: string }>
): TakenIdentifiers {
	return {
		ids: new Set(tenants.map((tenant) => tenant.id)),
		codes: new Set(tenants.map((tenant) => tenant.code))
	};
}

export interface NewTenantProblems {
	id: TenantIdProblem;
	/** About the code field; a code left empty is the id, so a taken one is said here too. */
	code: TenantIdProblem;
}

/** The id and the code of a new tenant (or copy), as the API will check them. */
export function newTenantProblems(
	input: { id: string; code: string },
	taken: TakenIdentifiers,
	sourceId?: string
): NewTenantProblems {
	const id = tenantIdProblem(input.id, { sourceId, taken: taken.ids });
	const code = input.code.trim()
		? tenantIdProblem(input.code, { taken: taken.codes })
		: id === null && taken.codes.has(input.id.trim())
			? 'taken'
			: null;
	return { id, code };
}

/** An id suggested from the name until the admin types one. */
export function suggestTenantId(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, TENANT_ID_MAX)
		.replace(/-+$/, '');
}

/**
 * One thing a copy can take. `part` names it in the clone API; an item without one has no API
 * yet and is shown as "in development", never sent. `requires` is the item it depends on (a
 * secret goes only with what holds it).
 */
export interface CopyItem {
	id: string;
	label: MessageKey;
	description: MessageKey;
	part?: TenantCopyPart;
	requires?: TenantCopyPart;
}

export interface CopyGroup {
	id: string;
	label: MessageKey;
	items: readonly CopyItem[];
}

export const COPY_GROUPS: readonly CopyGroup[] = [
	{
		id: 'configuration',
		label: 'tn.copy.group.configuration',
		items: [
			{
				id: 'settings',
				label: 'tn.copy.settings',
				description: 'tn.copy.settings.desc',
				part: 'settings'
			},
			{
				id: 'secret_settings',
				label: 'tn.copy.secretSettings',
				description: 'tn.copy.secretSettings.desc',
				part: 'secret_settings',
				requires: 'settings'
			},
			{ id: 'flows', label: 'tn.copy.flows', description: 'tn.copy.flows.desc' },
			{ id: 'screens', label: 'tn.copy.screens', description: 'tn.copy.screens.desc' },
			{
				id: 'statements',
				label: 'tn.copy.statements',
				description: 'tn.copy.statements.desc'
			}
		]
	},
	{
		id: 'applications',
		label: 'tn.copy.group.applications',
		items: [
			{
				id: 'clients',
				label: 'tn.copy.clients',
				description: 'tn.copy.clients.desc',
				part: 'clients'
			},
			{
				id: 'client_credentials',
				label: 'tn.copy.clientCredentials',
				description: 'tn.copy.clientCredentials.desc',
				part: 'client_credentials',
				requires: 'clients'
			},
			{
				id: 'saml_providers',
				label: 'tn.copy.samlProviders',
				description: 'tn.copy.samlProviders.desc',
				part: 'saml_providers'
			},
			{
				id: 'webhooks',
				label: 'tn.copy.webhooks',
				description: 'tn.copy.webhooks.desc',
				part: 'webhooks'
			},
			{
				id: 'webhook_secrets',
				label: 'tn.copy.webhookSecrets',
				description: 'tn.copy.webhookSecrets.desc',
				part: 'webhook_secrets',
				requires: 'webhooks'
			}
		]
	},
	{
		id: 'people',
		label: 'tn.copy.group.people',
		items: [
			{
				id: 'roles',
				label: 'tn.copy.roles',
				description: 'tn.copy.roles.desc',
				part: 'roles'
			},
			{
				id: 'admin_access',
				label: 'tn.copy.adminAccess',
				description: 'tn.copy.adminAccess.desc',
				part: 'admin_access'
			},
			{ id: 'end_users', label: 'tn.copy.endUsers', description: 'tn.copy.endUsers.desc' }
		]
	}
];

/** What a new copy starts with, as the API defaults: settings and roles. */
export function defaultCopyOptions(): TenantCopyOptions {
	return {
		settings: true,
		secret_settings: false,
		roles: true,
		admin_access: false,
		clients: false,
		saml_providers: false,
		client_credentials: false,
		webhooks: false,
		webhook_secrets: false
	};
}

/** Sets one part; turning a part off turns off what depends on it, turning one on its base. */
export function setCopyPart(
	options: TenantCopyOptions,
	part: TenantCopyPart,
	on: boolean
): TenantCopyOptions {
	const next = { ...options, [part]: on };
	const dependents = COPY_GROUPS.flatMap((group) => group.items).filter(
		(item): item is CopyItem & { part: TenantCopyPart; requires: TenantCopyPart } =>
			item.part !== undefined && item.requires !== undefined
	);
	// A secret turned on brings what holds it; then whatever lost its base goes.
	for (const item of dependents) if (on && item.part === part) next[item.requires] = true;
	for (const item of dependents) if (!next[item.requires]) next[item.part] = false;
	return next;
}

export type CopyProblem = 'separateStepUps' | null;

/**
 * Copying admin access and webhooks each asks for its own step-up, and one receipt covers one
 * operation, so the API refuses both in one copy.
 */
export function copyProblem(options: TenantCopyOptions): CopyProblem {
	if (options.admin_access && options.webhooks) return 'separateStepUps';
	return null;
}

/** States in which a tenant can be deleted from the console (the API's operator-mutable ones). */
const DELETABLE: ReadonlySet<TenantLifecycleState> = new Set([
	'active',
	'suspended',
	'frozen',
	'migration_read_only'
]);

export function canDelete(tenant: { lifecycleState: TenantLifecycleState; isDefault: boolean }) {
	return !tenant.isDefault && DELETABLE.has(tenant.lifecycleState);
}

/** Only an active tenant can be copied. */
export function canCopy(tenant: { lifecycleState: TenantLifecycleState }) {
	return tenant.lifecycleState === 'active';
}

export type BadgeTone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

export function lifecycleTone(state: TenantLifecycleState): BadgeTone {
	switch (state) {
		case 'active':
			return 'success';
		case 'provisioning':
		case 'restore_pending':
		case 'restore_validating':
			return 'info';
		case 'deleting':
		case 'deleted':
			return 'danger';
		default:
			return 'warning';
	}
}
