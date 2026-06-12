import type { ExternalProvider } from '$lib/api/authentication-methods';

const SELECTABLE_ICON_NAMES = new Set([
	'buildings',
	'house',
	'house-simple',
	'bank',
	'building',
	'city',
	'graduation-cap',
	'student',
	'books',
	'chalkboard-teacher',
	'globe',
	'globe-hemisphere-east',
	'shield-check',
	'seal-check',
	'certificate',
	'identification-card',
	'fingerprint',
	'key',
	'briefcase',
	'users-three',
	'network',
	'share-network',
	'tree-structure',
	'handshake',
	'cloud',
	'cloud-check',
	'database',
	'hard-drives',
	'devices',
	'terminal-window',
	'book-open',
	'presentation-chart',
	'rocket-launch',
	'compass',
	'none'
]);

const X_PROVIDER_NAMES = new Set(['x', 'x.com']);

function normalizeProviderName(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function hasProviderNameToken(value: string, token: string): boolean {
	return value.split(/[^a-z0-9]+/u).includes(token);
}

export function getExternalProviderIconClass(provider: ExternalProvider): string {
	const configuredIcon = provider.iconName?.trim().toLowerCase();
	if (configuredIcon === 'none') return '';
	if (configuredIcon && SELECTABLE_ICON_NAMES.has(configuredIcon)) {
		return `i-ph-${configuredIcon}`;
	}

	if (provider.type === 'saml') return 'i-ph-buildings';
	if (provider.type === 'vc') return 'i-ph-identification-badge';

	const name = normalizeProviderName(provider.name || '');
	if (name.includes('google')) return 'i-ph-google-logo';
	if (name.includes('github')) return 'i-ph-github-logo';
	if (name.includes('microsoft') || name.includes('azure')) return 'i-ph-windows-logo';
	if (name.includes('apple')) return 'i-ph-apple-logo';
	if (name.includes('facebook') || name.includes('meta')) return 'i-ph-meta-logo';
	if (hasProviderNameToken(name, 'twitter') || X_PROVIDER_NAMES.has(name)) return 'i-ph-x-logo';
	if (name.includes('linkedin')) return 'i-ph-linkedin-logo';
	return 'i-ph-sign-in';
}
