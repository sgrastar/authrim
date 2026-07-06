import { describe, expect, it } from 'vitest';
import type { ExternalProvider } from '$lib/api/authentication-methods';
import type { FlowRuntimeStep } from '$lib/api/flow-runtime';
import {
	runtimeAllowsAuthenticationHandle,
	runtimeAllowsExternalProvider
} from '../runtime-auth-handles';

function createAuthStep(outputHandles: unknown[]): FlowRuntimeStep {
	return {
		id: 'auth-step',
		source_node_id: 'auth-node',
		component: 'authentication_method_selector',
		render: true,
		config: {
			output_handles: outputHandles
		}
	};
}

function createExternalProvider(overrides: Partial<ExternalProvider> = {}): ExternalProvider {
	return {
		id: 'd704c529-85ed-4725-a117-9c8598b04874',
		name: 'GakuNin Test IdP',
		type: 'saml',
		startMode: 'saml_sp',
		enabled: true,
		loginEnabled: true,
		...overrides
	};
}

describe('runtime auth handles', () => {
	it('allows a SAML external provider when the Flow handle uses the protocol prefix', () => {
		const provider = createExternalProvider();
		const step = createAuthStep(['passkey', `saml_${provider.id}`]);

		expect(runtimeAllowsExternalProvider(step, provider)).toBe(true);
	});

	it('keeps disabled methods hidden when they are absent from the Flow handles', () => {
		const provider = createExternalProvider();
		const step = createAuthStep(['passkey', `saml_${provider.id}`]);

		expect(runtimeAllowsAuthenticationHandle(step, 'mail_otp', ['email_code'])).toBe(false);
		expect(runtimeAllowsAuthenticationHandle(step, 'totp', ['otp'])).toBe(false);
	});

	it('allows TOTP when the Flow handle uses the generic OTP alias', () => {
		const step = createAuthStep(['otp']);

		expect(runtimeAllowsAuthenticationHandle(step, 'totp', ['otp'])).toBe(true);
	});

	it('allows all external providers for a generic external IdP handle', () => {
		const step = createAuthStep(['external_idp']);

		expect(runtimeAllowsExternalProvider(step, createExternalProvider())).toBe(true);
		expect(
			runtimeAllowsExternalProvider(
				step,
				createExternalProvider({
					id: 'oidc-provider',
					type: 'oidc',
					startMode: 'oauth_redirect'
				})
			)
		).toBe(true);
	});

	it('matches normalized provider slug aliases', () => {
		const step = createAuthStep(['saml_test_idp']);

		expect(
			runtimeAllowsExternalProvider(
				step,
				createExternalProvider({
					slug: 'test.idp'
				})
			)
		).toBe(true);
	});

	it('does not restrict methods outside authentication selector steps', () => {
		const step: FlowRuntimeStep = {
			id: 'consent-step',
			source_node_id: 'consent-node',
			component: 'consent_policy',
			render: true,
			config: {
				output_handles: ['accepted']
			}
		};

		expect(runtimeAllowsAuthenticationHandle(step, 'mail_otp')).toBe(true);
	});
});
