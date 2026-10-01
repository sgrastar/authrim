/**
 * Loopback-only Admin API stand-in for local development (`AUTHRIM_ADMIN_UI_DEV_MOCK=true`).
 * It answers only what the console already uses; add fixtures here as features are rebuilt.
 * The sentinel string lets `check:dev-mock-guard` prove this module never reaches a
 * production build.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
import type { SettingsPatchRequest } from '@authrim/ar-lib-core/utils/settings-manager';
import { persona, type PersonaId } from '$lib/access/personas';
import { ApiError } from '$lib/api/api-error';
import { createFakeSettings } from '$lib/api/fake/settings-fake';
import type { SettingsTarget } from '$lib/api/settings';

const DEV_ADMIN_MOCK_FLAG = 'AUTHRIM_ADMIN_UI_DEV_MOCK';
const DEV_ADMIN_MOCK_SENTINEL = '__AUTHRIM_ADMIN_UI_DEV_MOCK_SENTINEL__';
/** Which kind of admin the mock signs in as: platform (default), tenant, support, viewer. */
const DEV_ADMIN_MOCK_PERSONA = 'AUTHRIM_ADMIN_UI_DEV_MOCK_PERSONA';
const TENANT_ID = 'dev-tenant';
const NOW = 1780704000000;

type EnvLike = Record<string, unknown> | undefined;

interface MockPasskey {
	id: string;
	device_name: string | null;
	aaguid: string | null;
	provider: {
		aaguid: string;
		name: string;
		icon_dark: null;
		icon_light: null;
		known: boolean;
	} | null;
	created_at: number;
	last_used_at: number | null;
}

const ICLOUD_AAGUID = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

/** In-memory passkeys of the mock admin; reset when the dev server restarts. */
let passkeys: MockPasskey[] = [
	{
		id: 'pk-macbook',
		device_name: 'Work MacBook',
		aaguid: ICLOUD_AAGUID,
		provider: {
			aaguid: ICLOUD_AAGUID,
			name: 'iCloud Keychain',
			icon_dark: null,
			icon_light: null,
			known: true
		},
		created_at: NOW - 86400000 * 120,
		last_used_at: NOW - 3600000 * 5
	},
	{
		id: 'pk-yubikey',
		device_name: null,
		aaguid: null,
		provider: null,
		created_at: NOW - 86400000 * 30,
		last_used_at: null
	}
];

function envValue(platformEnv: EnvLike, name: string): string | undefined {
	const importMetaEnv = import.meta.env as Record<string, string | undefined>;
	const value =
		platformEnv?.[name] ??
		importMetaEnv[name] ??
		(typeof process !== 'undefined' ? process.env?.[name] : undefined);
	return typeof value === 'string' ? value : undefined;
}

let personaId: PersonaId = 'platform';

/**
 * Settings of the mock tenant, answered like the Settings API (versions, sources, refusals,
 * access by role). A few values are set so pages show every kind of source.
 */
const settings = createFakeSettings({
	access: () => persona(personaId).access,
	stored: {
		[`tenant:${TENANT_ID}`]: {
			'session.default_ttl': 43200000,
			'oauth.sso_enabled': true,
			'session.ttl.passkey': 1209600000
		}
	},
	env: { 'oauth.refresh_token_expiry': 2592000 }
});

/** GET/PATCH /api/admin/{tenants/:id,platform}/settings/:category. */
async function handleSettings(
	event: RequestEvent,
	target: SettingsTarget,
	category: string,
	method: string
): Promise<Response | null> {
	try {
		if (method === 'GET') return json(await settings.get(target, category as CategoryName));
		if (method === 'PATCH') {
			const body = (await readJson(event)) as unknown as SettingsPatchRequest;
			return json(await settings.patch(target, category as CategoryName, body));
		}
	} catch (error) {
		if (error instanceof ApiError) {
			return json({ error: error.code, message: error.message, ...error.body }, error.status);
		}
		throw error;
	}
	return null;
}

async function readJson(event: RequestEvent): Promise<Record<string, unknown>> {
	try {
		const body = await event.request.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function deviceName(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null;
}

/** GET/POST/PATCH/DELETE /api/admin/me/passkeys[...]. Registration is accepted unverified. */
async function handlePasskeys(
	event: RequestEvent,
	rest: string[],
	method: string
): Promise<Response | null> {
	if (rest.length === 0 && method === 'GET') {
		return json({ passkeys, total: passkeys.length });
	}
	if (rest[0] === 'options' && method === 'POST') {
		const body = await readJson(event);
		const challenge = crypto.randomUUID().replaceAll('-', '');
		return json({
			challenge_id: `mock-${challenge}`,
			options: {
				challenge,
				rp: { id: String(body.rp_id || event.url.hostname), name: 'Authrim (dev mock)' },
				user: { id: 'ZGV2LWFkbWlu', name: 'dev-admin@localhost', displayName: 'Dev Admin' },
				pubKeyCredParams: [
					{ type: 'public-key', alg: -7 },
					{ type: 'public-key', alg: -257 }
				],
				timeout: 60000,
				attestation: 'none',
				excludeCredentials: [],
				authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
			}
		});
	}
	if (rest[0] === 'complete' && method === 'POST') {
		const body = await readJson(event);
		const passkey: MockPasskey = {
			id: `pk-${crypto.randomUUID().slice(0, 8)}`,
			device_name: deviceName(body.device_name),
			aaguid: null,
			provider: null,
			created_at: Date.now(),
			last_used_at: null
		};
		passkeys = [...passkeys, passkey];
		return json({ success: true, passkey });
	}
	const target = passkeys.find((passkey) => passkey.id === rest[0]);
	if (rest.length === 1 && !target) {
		return json({ error: 'not_found', error_description: 'Passkey not found' }, 404);
	}
	if (rest.length === 1 && target && method === 'PATCH') {
		const body = await readJson(event);
		const updated = { ...target, device_name: deviceName(body.device_name) };
		passkeys = passkeys.map((passkey) => (passkey.id === target.id ? updated : passkey));
		return json({ success: true, passkey: updated });
	}
	if (rest.length === 1 && target && method === 'DELETE') {
		if (passkeys.length <= 1) {
			return json(
				{ error: 'last_passkey', error_description: 'Cannot delete the last passkey' },
				400
			);
		}
		passkeys = passkeys.filter((passkey) => passkey.id !== target.id);
		return json({ success: true, message: 'Passkey deleted' });
	}
	return null;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function envFlag(platformEnv: EnvLike): boolean {
	const importMetaEnv = import.meta.env as Record<string, string | undefined>;
	const candidates = [
		platformEnv?.[DEV_ADMIN_MOCK_FLAG],
		importMetaEnv[DEV_ADMIN_MOCK_FLAG],
		typeof process !== 'undefined' ? process.env?.[DEV_ADMIN_MOCK_FLAG] : undefined
	];
	return candidates.some((candidate) => String(candidate || '').toLowerCase() === 'true');
}

export function isDevAdminMockEnabled(event: RequestEvent, platformEnv: EnvLike): boolean {
	return (
		Boolean(import.meta.env.DEV) &&
		!(typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') &&
		isLoopbackHost(event.url.hostname) &&
		envFlag(platformEnv)
	);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'X-Authrim-Dev-Mock': 'admin-ui',
			'X-Authrim-Dev-Mock-Sentinel': DEV_ADMIN_MOCK_SENTINEL
		}
	});
}

export async function handleDevAdminMock(
	event: RequestEvent,
	platformEnv: EnvLike
): Promise<Response | null> {
	if (!isDevAdminMockEnabled(event, platformEnv)) return null;
	if (event.url.pathname !== '/api/admin' && !event.url.pathname.startsWith('/api/admin/')) {
		return null;
	}

	const segments = event.url.pathname
		.replace(/^\/api\/admin\/?/, '')
		.split('/')
		.filter(Boolean)
		.map(decodeURIComponent);
	const method = event.request.method;

	if (segments.length === 0) return json({ ok: true, mode: 'dev-admin-mock' });
	personaId = persona(envValue(platformEnv, DEV_ADMIN_MOCK_PERSONA) ?? 'platform').id;
	if (segments[0] === 'me' && segments[1] === 'session') {
		const { access } = persona(personaId);
		return json({
			active: true,
			user_id: 'dev-admin',
			tenant_id: TENANT_ID,
			email: 'dev-admin@localhost',
			name: 'Dev Admin',
			roles: access.roles,
			permissions: access.permissions,
			admin_scope: access.platform ? 'platform' : 'tenant',
			is_platform_admin: access.platform,
			expires_at: Math.floor(Date.now() / 1000) + 86400,
			created_at: Math.floor(NOW / 1000),
			last_login_at: Math.floor(NOW / 1000)
		});
	}
	if (segments[0] === 'me' && segments[1] === 'passkeys') {
		const response = await handlePasskeys(event, segments.slice(2), method);
		if (response) return response;
	}
	if (segments[0] === 'logout' && method === 'POST') return json({ success: true });
	if (segments[0] === 'tenants' && segments[2] === 'settings' && segments.length === 4) {
		const target: SettingsTarget = { level: 'tenant', tenantId: segments[1] };
		const response = await handleSettings(event, target, segments[3], method);
		if (response) return response;
	}
	if (segments[0] === 'platform' && segments[1] === 'settings' && segments.length === 3) {
		const response = await handleSettings(event, { level: 'platform' }, segments[2], method);
		if (response) return response;
	}
	if (segments[0] === 'tenants' && segments.length === 1 && method === 'GET') {
		return json({
			tenants: [
				{ id: TENANT_ID, name: 'Acme Corporation' },
				{ id: 'globex', name: 'Globex Inc.' }
			]
		});
	}

	return json(
		{
			error: 'not_implemented',
			error_description: `The console dev mock has no fixture for ${method} ${event.url.pathname}`
		},
		501
	);
}
