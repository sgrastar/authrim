import type { ExternalProvider } from '$lib/api/authentication-methods';
import type { FlowRuntimeStep } from '$lib/api/flow-runtime';

export type RuntimeAuthMethod =
	| 'passkey'
	| 'mail_otp'
	| 'mail_otp_totp'
	| 'totp'
	| 'external_idp'
	| 'directory_password';

export function isRuntimeAuthStep(step: FlowRuntimeStep | null): boolean {
	return (
		!step ||
		step.component === 'authentication_method_selector' ||
		step.component === 'registration_method_selector'
	);
}

export function normalizeRuntimeOutputHandle(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return normalized || 'method';
}

export function runtimeAllowsAuthenticationHandle(
	step: FlowRuntimeStep | null,
	handle: string,
	aliases: string[] = []
): boolean {
	if (!isRuntimeAuthStep(step)) {
		return true;
	}

	const configured = step?.config?.output_handles;
	if (!Array.isArray(configured) || configured.length === 0) {
		return true;
	}

	const allowed = new Set<string>();
	for (const value of configured) {
		const id = readOutputHandleId(value);
		if (!id) continue;
		allowed.add(id);
		allowed.add(normalizeRuntimeOutputHandle(id));
	}

	for (const candidate of [handle, ...aliases]) {
		if (allowed.has(candidate) || allowed.has(normalizeRuntimeOutputHandle(candidate))) {
			return true;
		}
	}

	return false;
}

export function runtimeAllowsExternalProvider(
	step: FlowRuntimeStep | null,
	provider: ExternalProvider
): boolean {
	return runtimeAllowsAuthenticationHandle(
		step,
		provider.id,
		getExternalProviderHandleAliases(provider)
	);
}

function getExternalProviderHandleAliases(provider: ExternalProvider): string[] {
	const aliases = new Set<string>([
		'external',
		'external_idp',
		'ext_idp',
		provider.id,
		`external:${provider.id}`,
		`external_idp:${provider.id}`
	]);

	if (provider.slug) {
		aliases.add(provider.slug);
		aliases.add(`external:${provider.slug}`);
		aliases.add(`external_idp:${provider.slug}`);
	}

	for (const identifier of [provider.id, provider.slug].filter((value): value is string =>
		Boolean(value)
	)) {
		aliases.add(`${provider.type}_${identifier}`);
		aliases.add(`${provider.type}:${identifier}`);
	}

	return Array.from(aliases);
}

function readOutputHandleId(value: unknown): string | null {
	if (typeof value === 'string') {
		return value.trim() || null;
	}
	if (value && typeof value === 'object' && 'id' in value) {
		const id = (value as { id?: unknown }).id;
		return typeof id === 'string' && id.trim() ? id.trim() : null;
	}
	return null;
}
