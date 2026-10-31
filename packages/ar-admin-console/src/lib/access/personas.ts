/**
 * Kinds of admin, for designing and checking pages (Storybook's "Admin" toolbar, the dev
 * mock). The console itself never branches on a kind: it asks `access.ts` about each thing it
 * shows. The permissions are those of the built-in roles (ar-lib-core `ADMIN_ROLE_DEFINITIONS`),
 * so a page checked with a persona matches what that role sees against the real API.
 */
import {
	ADMIN_ROLE_DEFINITIONS,
	ADMIN_ROLES,
	type AdminRoleName
} from '@authrim/ar-lib-core/constants/admin-roles';
import type { MessageKey } from '$lib/i18n/i18n.svelte';
import type { AdminAccess } from './access';

export type PersonaId = 'platform' | 'tenant' | 'support' | 'viewer';

export interface Persona {
	id: PersonaId;
	label: MessageKey;
	description: MessageKey;
	access: AdminAccess;
}

/** What a built-in role carries, as the role definitions say (so a persona cannot drift from the API). */
function builtIn(name: AdminRoleName, platform: boolean): AdminAccess {
	const role = ADMIN_ROLE_DEFINITIONS.find((definition) => definition.name === name);
	if (!role) throw new Error(`unknown built-in role ${name}`);
	return { platform, roles: [name], permissions: [...role.permissions] };
}

export const PERSONAS: readonly Persona[] = [
	{
		// Runs the whole installation: every tenant, and the platform itself.
		id: 'platform',
		label: 'persona.platform',
		description: 'persona.platform.desc',
		access: builtIn(ADMIN_ROLES.SUPER_ADMIN, true)
	},
	{
		// Runs one tenant: its users, apps and settings.
		id: 'tenant',
		label: 'persona.tenant',
		description: 'persona.tenant.desc',
		access: builtIn(ADMIN_ROLES.TENANT_ADMIN, false)
	},
	{
		// Limited to one job in a tenant: helping users (unlock, sign out), no settings.
		id: 'support',
		label: 'persona.support',
		description: 'persona.support.desc',
		access: builtIn(ADMIN_ROLES.SUPPORT, false)
	},
	{
		// Limited to reading: sees users, apps and settings, changes nothing.
		id: 'viewer',
		label: 'persona.viewer',
		description: 'persona.viewer.desc',
		access: builtIn(ADMIN_ROLES.VIEWER, false)
	}
];

export const DEFAULT_PERSONA: PersonaId = 'tenant';

export function persona(id: unknown): Persona {
	return PERSONAS.find((p) => p.id === id) ?? PERSONAS.find((p) => p.id === DEFAULT_PERSONA)!;
}
