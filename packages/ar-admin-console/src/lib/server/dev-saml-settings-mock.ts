/**
 * The tenant's SAML identity in the console dev mock (`AUTHRIM_ADMIN_UI_DEV_MOCK=true`):
 * `/api/admin/saml-settings` (read, the published entity IDs), its `local-signing` operations
 * and DR bundle, and the certificate preview — answered by the same in-memory fake as
 * Storybook (`saml-settings-fake.ts`), so a rollover made in the console behaves as the real
 * API does and its errors come back in the wire shape.
 */
import { ApiError } from '#lib/api/api-error.js';
import { createFakeSamlSettings } from '#lib/api/fake/saml-settings-fake.js';
import type { SamlLocalSigningRequest, SamlSettingsClient } from '#lib/api/saml-settings.js';

export interface MockAnswer {
	status: number;
	body: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object';

/**
 * The answer for a SAML identity request, or null when the path is not one. `body` is the
 * request's JSON, already read.
 */
export async function answerSamlSettingsMock(
	client: SamlSettingsClient,
	segments: readonly string[],
	method: string,
	body: unknown
): Promise<MockAnswer | null> {
	try {
		if (segments[0] === 'saml-metadata' && segments[1] === 'certificate-preview') {
			if (method !== 'POST' || segments.length !== 2) return null;
			if (!isObject(body) || typeof body.certificate !== 'string')
				throw new ApiError(400, 'invalid_request', 'certificate is required');
			return { status: 200, body: await client.previewCertificate(body.certificate) };
		}
		if (segments[0] !== 'saml-settings') return null;
		const rest = segments.slice(1);
		if (rest.length === 0 && method === 'GET') return { status: 200, body: await client.get() };
		if (rest.length === 0 && method === 'PUT') {
			if (!isObject(body)) throw new ApiError(400, 'invalid_request', 'A JSON object is required');
			return { status: 200, body: await client.update(body) };
		}
		if (rest[0] === 'local-signing' && method === 'POST') {
			if (rest.length === 1) {
				if (!isObject(body) || typeof body.role !== 'string' || typeof body.action !== 'string')
					throw new ApiError(400, 'invalid_request', 'role and action are required');
				return {
					status: 200,
					body: await client.localSigning(body as unknown as SamlLocalSigningRequest)
				};
			}
			if (rest[1] === 'dr-bundle' && rest.length === 2) {
				const passphrase =
					isObject(body) && typeof body.passphrase === 'string' ? body.passphrase : '';
				return { status: 200, body: await client.exportDrBundle(passphrase) };
			}
			if (rest[1] === 'dr-bundle' && rest[2] === 'import' && rest.length === 3) {
				const passphrase =
					isObject(body) && typeof body.passphrase === 'string' ? body.passphrase : '';
				const bundle = isObject(body) ? body.bundle : undefined;
				return { status: 200, body: await client.importDrBundle(bundle, passphrase) };
			}
		}
		return null;
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				status: error.status,
				body: { ...error.body, error: error.code, error_description: error.message }
			};
		}
		throw error;
	}
}

/** One fake per server process: the rollover state lasts across requests, as on the real API. */
export const devSamlSettings = createFakeSamlSettings();
