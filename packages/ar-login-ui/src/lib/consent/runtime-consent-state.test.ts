import { describe, expect, it } from 'vitest';
import type { FlowRuntimeConsentPolicyContent } from '$lib/api/flow-runtime';
import {
	buildRuntimeConsentDecisionPayload,
	canSubmitRuntimeConsentPolicy,
	initializeRuntimeConsentDecisions
} from './runtime-consent-state';

const policy: FlowRuntimeConsentPolicyContent = {
	id: 'policy_1',
	display_name: 'Legal documents',
	description: null,
	language: 'en',
	default_language: 'en',
	items: [
		{
			statement_id: 'terms',
			slug: 'terms',
			category: 'terms',
			title: 'Terms',
			description: '',
			document_url: null,
			inline_content: 'Terms',
			version: '1',
			version_id: 'terms_v1',
			is_required: true,
			checkbox_mode: 'required',
			checkbox_default_checked: false,
			display_order: 0,
			acceptance_status: 'accepted',
			action_required: false,
			accepted_at: 1_700_000_000,
			accepted_record_id: 'record_1'
		},
		{
			statement_id: 'privacy',
			slug: 'privacy',
			category: 'privacy',
			title: 'Privacy',
			description: '',
			document_url: null,
			inline_content: 'Privacy',
			version: '1',
			version_id: 'privacy_v1',
			is_required: true,
			checkbox_mode: 'required',
			checkbox_default_checked: false,
			display_order: 1,
			acceptance_status: 'pending',
			action_required: true,
			accepted_at: null,
			accepted_record_id: null
		}
	]
};

describe('runtime consent state', () => {
	it('initializes accepted items as checked and still requires pending required items', () => {
		const decisions = initializeRuntimeConsentDecisions(policy);

		expect(decisions).toEqual({ terms: true, privacy: false });
		expect(canSubmitRuntimeConsentPolicy(policy, decisions, {})).toBe(false);
		expect(canSubmitRuntimeConsentPolicy(policy, { ...decisions, privacy: true }, {})).toBe(true);
	});

	it('never sends an accepted disabled item back in the submit payload', () => {
		const payload = buildRuntimeConsentDecisionPayload(policy, { terms: false, privacy: true }, {});

		expect(payload).toEqual({
			consent_item_decisions: { privacy: 'granted' },
			consent_item_selected_values: {}
		});
	});

	it('keeps required OIDC scopes selected while allowing an optional scope subset', () => {
		const oidcPolicy: FlowRuntimeConsentPolicyContent = {
			...policy,
			id: '__oidc_authorization_release__',
			gate_kind: 'oidc_authorization',
			items: [
				{
					...policy.items[1],
					statement_id: 'oidc:scope:openid',
					slug: 'oidc-scope-openid',
					title: 'OpenID',
					category: 'scope_claim_release',
					checkbox_default_checked: true,
					release_kind: 'scope',
					release_name: 'openid',
					release_locked: true
				},
				{
					...policy.items[1],
					statement_id: 'oidc:scope:profile',
					slug: 'oidc-scope-profile',
					title: 'Profile',
					category: 'scope_claim_release',
					is_required: false,
					checkbox_mode: 'optional',
					checkbox_default_checked: true,
					action_required: false,
					release_kind: 'scope',
					release_name: 'profile',
					release_locked: false
				}
			]
		};
		const decisions = initializeRuntimeConsentDecisions(oidcPolicy);

		expect(decisions).toEqual({
			'oidc:scope:openid': true,
			'oidc:scope:profile': true
		});
		expect(
			buildRuntimeConsentDecisionPayload(
				oidcPolicy,
				{ ...decisions, 'oidc:scope:profile': false },
				{}
			)
		).toMatchObject({
			consent_item_decisions: {
				'oidc:scope:openid': 'granted',
				'oidc:scope:profile': 'denied'
			}
		});
	});
});
