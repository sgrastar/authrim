export type DiscoveryMethod =
	| 'email_exact'
	| 'tenant_code'
	| 'tenant_slug'
	| 'wayf'
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
		['email_exact', 'tenant_code', 'tenant_slug', 'wayf'].includes(method)
	);

	if (
		selectionPolicy === 'manual_only' &&
		interactiveMethods.some(
			(method) => method === 'tenant_code' || method === 'tenant_slug' || method === 'wayf'
		)
	) {
		return interactiveMethods.filter(
			(method) => method === 'tenant_code' || method === 'tenant_slug' || method === 'wayf'
		);
	}

	return interactiveMethods;
}

export function getDefaultDiscoveryMode(
	methods: string[]
): 'email' | 'tenant_code' | 'tenant_slug' | 'wayf' {
	if (methods.includes('email_exact')) return 'email';
	if (methods.includes('tenant_code')) return 'tenant_code';
	if (methods.includes('wayf')) return 'wayf';
	return 'tenant_slug';
}
