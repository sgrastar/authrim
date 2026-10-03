import type { ConsentScreenData, ConsentScreenItem } from './ConsentView.svelte';

export const consentBase: ConsentScreenData = {
	challenge_id: 'challenge-1',
	client: {
		client_id: 'dashboard',
		client_name: 'Acme Dashboard',
		client_uri: 'https://example.com',
		policy_uri: 'https://example.com/privacy',
		tos_uri: 'https://example.com/terms'
	},
	scopes: [
		{ name: 'openid', title: 'openid', description: '', required: true },
		{ name: 'profile', title: 'profile', description: '', required: false },
		{ name: 'email', title: 'email', description: '', required: false }
	],
	user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' },
	organizations: [],
	primary_org: { id: 'org1', name: 'Acme Inc.', type: 'company', is_primary: true },
	roles: [],
	acting_as: null,
	target_org_id: null,
	features: { org_selector_enabled: false, acting_as_enabled: false, show_roles: false }
};

const item = (overrides: Partial<ConsentScreenItem>): ConsentScreenItem => ({
	statement_id: 'tos',
	slug: 'tos',
	category: 'terms',
	legal_basis: 'consent',
	title: 'Terms of Service',
	description: 'I agree to the Terms of Service.',
	version: '2',
	version_id: 'v2',
	is_required: true,
	enforcement: 'block',
	needs_version_upgrade: false,
	show_deletion_link: false,
	checkbox_mode: 'required',
	display_order: 0,
	...overrides
});

export const consentItems: ConsentScreenItem[] = [
	item({
		document_url: 'https://example.com/terms',
		processing_purpose: 'Operating your account.',
		withdrawal_impact: 'You will no longer be able to use the service.'
	}),
	item({
		statement_id: 'terms-update',
		slug: 'terms-update',
		title: 'Updated privacy notice',
		description: 'We changed how long we keep your data.',
		needs_version_upgrade: true,
		current_version: '1',
		version: '2',
		display_order: 1
	}),
	item({
		statement_id: 'news',
		slug: 'news',
		category: 'marketing',
		title: 'Product news',
		description: 'Send me product news by email.',
		is_required: false,
		enforcement: 'none',
		checkbox_mode: 'optional',
		show_deletion_link: true,
		deletion_url: 'https://example.com/delete',
		display_order: 2
	})
];
