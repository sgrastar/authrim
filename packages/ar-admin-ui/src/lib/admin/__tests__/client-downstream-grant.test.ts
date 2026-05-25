import { describe, expect, it } from 'vitest';
import {
	buildClientDownstreamGrantFormFromClient,
	createPresetClientDownstreamGrantForm,
	parseScopeRestrictionList,
	parseTextareaList,
	toClientDownstreamGrantCreateInput,
	toClientDownstreamGrantUpdateInput
} from '../client-downstream-grant';

describe('client-downstream-grant helpers', () => {
	it('enables token exchange defaults for the m2m preset', () => {
		expect(createPresetClientDownstreamGrantForm('m2m-service')).toMatchObject({
			token_exchange_allowed: true,
			client_credentials_allowed: true,
			delegation_mode: 'delegation'
		});
	});

	it('parses textarea lists by newline and comma', () => {
		expect(parseTextareaList('svc-a\nsvc-b, svc-c')).toEqual(['svc-a', 'svc-b', 'svc-c']);
	});

	it('parses scope restrictions by whitespace and commas', () => {
		expect(parseScopeRestrictionList('openid profile,\nemail custom:read')).toEqual([
			'openid',
			'profile',
			'email',
			'custom:read'
		]);
	});

	it('builds create input from the downstream grant form', () => {
		expect(
			toClientDownstreamGrantCreateInput({
				token_exchange_allowed: true,
				client_credentials_allowed: true,
				delegation_mode: 'impersonation',
				default_scope: 'openid profile',
				default_audience: 'svc://op-userinfo/customer-profile',
				allowed_scopes: 'openid profile',
				allowed_subject_token_clients: 'svc-client-a\nsvc-client-b',
				allowed_token_exchange_resources:
					'svc://op-userinfo/customer-profile\nsvc://op-userinfo/customer-export'
			})
		).toEqual({
			token_exchange_allowed: true,
			client_credentials_allowed: true,
			delegation_mode: 'impersonation',
			default_scope: 'openid profile',
			default_audience: 'svc://op-userinfo/customer-profile',
			allowed_scopes: ['openid', 'profile'],
			allowed_subject_token_clients: ['svc-client-a', 'svc-client-b'],
			allowed_token_exchange_resources: [
				'svc://op-userinfo/customer-profile',
				'svc://op-userinfo/customer-export'
			]
		});
	});

	it('builds update input with nullable text fields', () => {
		expect(
			toClientDownstreamGrantUpdateInput({
				token_exchange_allowed: false,
				client_credentials_allowed: false,
				delegation_mode: 'delegation',
				default_scope: '',
				default_audience: '',
				allowed_scopes: '',
				allowed_subject_token_clients: '',
				allowed_token_exchange_resources: ''
			})
		).toEqual({
			token_exchange_allowed: false,
			client_credentials_allowed: false,
			delegation_mode: 'delegation',
			default_scope: null,
			default_audience: null,
			allowed_scopes: [],
			allowed_subject_token_clients: [],
			allowed_token_exchange_resources: []
		});
	});

	it('maps client arrays back into form textareas', () => {
		expect(
			buildClientDownstreamGrantFormFromClient({
				token_exchange_allowed: true,
				client_credentials_allowed: true,
				delegation_mode: 'delegation',
				default_scope: 'openid profile',
				default_audience: 'svc://op-userinfo/customer-profile',
				allowed_scopes: ['openid', 'profile'],
				allowed_subject_token_clients: ['svc-client-a', 'svc-client-b'],
				allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile']
			})
		).toMatchObject({
			token_exchange_allowed: true,
			client_credentials_allowed: true,
			delegation_mode: 'delegation',
			default_scope: 'openid profile',
			default_audience: 'svc://op-userinfo/customer-profile',
			allowed_scopes: 'openid profile',
			allowed_subject_token_clients: 'svc-client-a\nsvc-client-b',
			allowed_token_exchange_resources: 'svc://op-userinfo/customer-profile'
		});
	});
});
