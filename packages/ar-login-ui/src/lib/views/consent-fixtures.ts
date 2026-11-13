import type {
	ConsentInformationRelease,
	ConsentScreenData,
	ConsentScreenItem
} from './ConsentView.svelte';

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

/** The information the app would be given: required and optional items, values and a purpose. */
export const informationRelease: ConsentInformationRelease = {
	items: [
		{ name: 'email', required: true, value: 'ada.release@example.com' },
		{ name: 'name', required: true, value: 'Ada Lovelace' },
		{ name: 'phone_number', required: false, previously_approved: true, value: '+81 90 0000 0000' },
		{ name: 'birthdate', required: false, previously_approved: false, value: '1815-12-10' },
		{
			name: 'address',
			required: false,
			value: { street: '1 Main St', locality: 'Tokyo' }
		},
		{ name: 'employee_number', required: false, value: '<b>E-1024</b>' }
	],
	show_values: true,
	presentation_key: 'key-1',
	purpose: {
		statement_id: 'release-purpose',
		version: '1',
		title: 'Sign-in and account notices',
		description: 'Used to identify you and to send account notices.',
		document_url: 'https://example.com/purpose',
		inline_content: '<b>not bold</b>'
	}
};

/** A SAML service provider's screen: no scopes, its attributes and NameID by key, with labels. */
export const samlConsent: ConsentScreenData = {
	...consentBase,
	protocol: 'saml',
	client: { client_id: 'https://sp.example.edu/shibboleth', client_name: 'Library portal' },
	scopes: [],
	information_release: {
		items: [
			{
				name: '["nameid","urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"]',
				kind: 'nameid',
				label: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
				required: true,
				deferred: true
			},
			{
				name: '["attribute","urn:oid:0.9.2342.19200300.100.1.3","urn:oasis:names:tc:SAML:2.0:attrname-format:uri"]',
				kind: 'attribute',
				label: 'Email address',
				required: true,
				value: 'ada.release@example.edu'
			},
			{
				name: '["attribute","urn:oid:1.3.6.1.4.1.5923.1.1.1.10","urn:oasis:names:tc:SAML:2.0:attrname-format:uri"]',
				kind: 'attribute',
				label: 'eduPersonTargetedID',
				required: false,
				deferred: true
			},
			{
				name: '["attribute","urn:oid:1.3.6.1.4.1.5923.1.1.1.9","urn:oasis:names:tc:SAML:2.0:attrname-format:uri"]',
				kind: 'attribute',
				label: 'Affiliation',
				required: false,
				previously_approved: true,
				value: ['member@example.edu', 'student@example.edu']
			}
		],
		show_values: true,
		presentation_key: 'saml-key-1'
	}
};
