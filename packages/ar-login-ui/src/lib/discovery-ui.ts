export type DiscoveryMethod =
	| 'email_domain'
	| 'tenant_code'
	| 'tenant_slug'
	| 'invitation'
	| 'app_hint';
export type SelectionPolicy =
	| 'auto_if_single'
	| 'always_select'
	| 'select_if_multiple'
	| 'manual_only';

export function getInteractiveDiscoveryMethods(
	discoveryMethods: string[],
	selectionPolicy: SelectionPolicy
): DiscoveryMethod[] {
	const interactiveMethods = discoveryMethods.filter((method): method is DiscoveryMethod =>
		['email_domain', 'tenant_code', 'tenant_slug'].includes(method)
	);

	if (
		selectionPolicy === 'manual_only' &&
		interactiveMethods.some((method) => method === 'tenant_code' || method === 'tenant_slug')
	) {
		return interactiveMethods.filter(
			(method) => method === 'tenant_code' || method === 'tenant_slug'
		);
	}

	return interactiveMethods;
}

export function getDefaultDiscoveryMode(
	methods: string[]
): 'email' | 'tenant_code' | 'tenant_slug' {
	if (methods.includes('email_domain')) return 'email';
	if (methods.includes('tenant_code')) return 'tenant_code';
	return 'tenant_slug';
}
