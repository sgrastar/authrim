export type EmailResolutionPolicy = 'exact_email_then_domain' | 'exact_email_only' | 'disabled';

export interface DiscoveryMethodFormState {
	emailResolutionPolicy: EmailResolutionPolicy;
	tenantCodeEnabled: boolean;
	tenantSlugEnabled: boolean;
}

const VALID_POLICIES: EmailResolutionPolicy[] = [
	'exact_email_then_domain',
	'exact_email_only',
	'disabled'
];

export function parseDiscoveryMethods(value: unknown): string[] {
	if (typeof value !== 'string' || !value.trim()) return [];

	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string');
	} catch {
		return [];
	}
}

export function resolveEmailResolutionPolicy(
	discoveryMethodsValue: unknown,
	storedPolicy: unknown
): EmailResolutionPolicy {
	const methods = parseDiscoveryMethods(discoveryMethodsValue);
	if (!methods.includes('email_domain')) {
		return 'disabled';
	}

	if (
		typeof storedPolicy === 'string' &&
		VALID_POLICIES.includes(storedPolicy as EmailResolutionPolicy)
	) {
		return storedPolicy as EmailResolutionPolicy;
	}

	return 'exact_email_then_domain';
}

export function buildDiscoveryMethodsValue(state: DiscoveryMethodFormState): string {
	const methods: string[] = [];

	if (state.emailResolutionPolicy !== 'disabled') {
		methods.push('email_domain');
	}

	if (state.tenantCodeEnabled) {
		methods.push('tenant_code');
	}

	if (state.tenantSlugEnabled) {
		methods.push('tenant_slug');
	}

	return JSON.stringify(methods);
}

export function getMethodToggles(discoveryMethodsValue: unknown): {
	tenantCodeEnabled: boolean;
	tenantSlugEnabled: boolean;
} {
	const methods = parseDiscoveryMethods(discoveryMethodsValue);
	return {
		tenantCodeEnabled: methods.includes('tenant_code'),
		tenantSlugEnabled: methods.includes('tenant_slug')
	};
}
