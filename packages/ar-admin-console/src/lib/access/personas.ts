/**
 * Kinds of admin, for designing and checking pages (Storybook's "Admin" toolbar, the dev
 * mock). The console itself never branches on a kind: it asks `access.ts` about each thing it
 * shows. The permissions are those of the built-in roles (migrations/admin/d1, admin_roles),
 * so a page checked with a persona matches what that role sees against the real API.
 */
import type { MessageKey } from '$lib/i18n/i18n.svelte';
import type { AdminAccess } from './access';

export type PersonaId = 'platform' | 'tenant' | 'support' | 'viewer';

export interface Persona {
	id: PersonaId;
	label: MessageKey;
	description: MessageKey;
	access: AdminAccess;
}

export const PERSONAS: readonly Persona[] = [
	{
		// Runs the whole installation: every tenant, and the platform itself.
		id: 'platform',
		label: 'persona.platform',
		description: 'persona.platform.desc',
		access: { platform: true, roles: ['super_admin'], permissions: ['*'] }
	},
	{
		// Runs one tenant: its users, apps and settings.
		id: 'tenant',
		label: 'persona.tenant',
		description: 'persona.tenant.desc',
		access: {
			platform: false,
			roles: ['admin'],
			permissions: [
				'admin:users:*',
				'admin:clients:*',
				'admin:scopes:*',
				'admin:roles:read',
				'admin:settings:read',
				'admin:audit:read'
			]
		}
	},
	{
		// Limited to one job in a tenant: helping users (unlock, sign out), no settings.
		id: 'support',
		label: 'persona.support',
		description: 'persona.support.desc',
		access: {
			platform: false,
			roles: ['support'],
			permissions: [
				'admin:users:read',
				'admin:users:unlock',
				'admin:sessions:read',
				'admin:sessions:revoke',
				'admin:clients:read',
				'admin:audit:read'
			]
		}
	},
	{
		// Limited to reading: sees users, apps and settings, changes nothing.
		id: 'viewer',
		label: 'persona.viewer',
		description: 'persona.viewer.desc',
		access: {
			platform: false,
			roles: ['viewer'],
			permissions: [
				'admin:users:read',
				'admin:clients:read',
				'admin:roles:read',
				'admin:settings:read'
			]
		}
	}
];

export const DEFAULT_PERSONA: PersonaId = 'tenant';

export function persona(id: unknown): Persona {
	return PERSONAS.find((p) => p.id === id) ?? PERSONAS.find((p) => p.id === DEFAULT_PERSONA)!;
}
