import { publicClientJwksProblem } from '@authrim/ar-lib-core/utils/public-client-keys';
import type { RpForm } from './connection-model';

export function publicKeyInput(
	form: RpForm,
	allowEmpty = false
): { jwks_uri: string | null; jwks: null } | { jwks: Record<string, unknown>; jwks_uri: null } {
	if (allowEmpty && !(form.keySource === 'inline' ? form.publicJwks : form.jwksUri)?.trim())
		return { jwks: null, jwks_uri: null };
	if (form.keySource !== 'inline') {
		const uri = form.jwksUri?.trim() ?? '';
		const parsed = new URL(uri);
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
			throw new Error('Use a public HTTPS JWKS URL');
		return { jwks_uri: uri, jwks: null };
	}
	const jwks: unknown = JSON.parse(form.publicJwks ?? '');
	const error = publicClientJwksProblem(jwks, null);
	if (error) throw new Error(error);
	if (!jwks || typeof jwks !== 'object' || Array.isArray(jwks)) throw new Error('Invalid JWKS');
	return { jwks: Object.fromEntries(Object.entries(jwks)), jwks_uri: null };
}
export function publicKeyProblem(form: RpForm, allowEmpty = false): string | undefined {
	try {
		publicKeyInput(form, allowEmpty);
		return undefined;
	} catch (error) {
		return error instanceof SyntaxError
			? 'Paste a valid public JWKS JSON object'
			: error instanceof Error
				? error.message
				: 'Invalid public key settings';
	}
}
