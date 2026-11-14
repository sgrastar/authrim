import type { Mapping, MappingField } from '#lib/ui/patterns/mapping-model.js';
import type { ConnectionKind } from './connection-model.js';

/**
 * Sample data for a connection's mapping (mock). Each service flow has one, in its own
 * direction: a provider's (OP, IdP) flow takes what it sends into Authrim's attributes; an
 * app's (RP, SP) flow makes what the app receives from Authrim's attributes. What Authrim then
 * passes on is the other flows' business. Attribute names are data, so they are not translated.
 * TODO(api): read and write through the field-mapping API, one mapping per connection.
 */
export interface ConnectionMapping {
	direction: 'inbound' | 'outbound';
	sources: MappingField[];
	targets: MappingField[];
	mappings: Mapping[];
}

/** Authrim's attributes, with a sample user's values for the preview. */
const AUTHRIM: MappingField[] = [
	{ key: 'sub', label: 'User ID', type: 'string', example: 'usr_01J8Z4K3M2' },
	{ key: 'email', label: 'Email', type: 'string', example: 'john.smith@example.com' },
	{ key: 'email_verified', label: 'Email verified', type: 'boolean' },
	{ key: 'name', label: 'Name', type: 'string', example: 'John Smith' },
	{ key: 'given_name', label: 'Given name', type: 'string', example: 'John' },
	{ key: 'family_name', label: 'Family name', type: 'string', example: 'Smith' },
	{ key: 'groups', label: 'Groups', type: 'string[]', example: ['sales', 'admins'] }
];

/** What a provider's attributes fill: Authrim's, without the user ID it gives itself. */
const INTO_AUTHRIM: MappingField[] = AUTHRIM.filter((field) => field.key !== 'sub').map(
	({ example: _, ...field }) => ({ ...field, required: field.key === 'email' })
);

const SAMPLES: Record<ConnectionKind, () => ConnectionMapping> = {
	// A social login (an OpenID provider such as Google): its claims into Authrim's attributes.
	op: (): ConnectionMapping => ({
		direction: 'inbound',
		sources: [
			{ key: 'sub', label: 'Subject', type: 'string', example: '108204268033311' },
			{ key: 'email', label: 'Email', type: 'string', example: 'John.Smith@gmail.com' },
			{ key: 'email_verified', label: 'Email verified', type: 'boolean' },
			{ key: 'given_name', label: 'Given name', type: 'string', example: 'John' },
			{ key: 'family_name', label: 'Family name', type: 'string', example: 'Smith' },
			{ key: 'name', label: 'Name', type: 'string', example: 'John Smith' }
		],
		targets: INTO_AUTHRIM,
		mappings: [
			{
				id: 'op1',
				target: 'email',
				sources: ['email'],
				steps: [{ id: 'op1s1', transform: 'case', params: { mode: 'lower' } }]
			},
			{ id: 'op2', target: 'email_verified', sources: ['email_verified'], steps: [] },
			{ id: 'op3', target: 'name', sources: ['name'], steps: [] },
			{ id: 'op4', target: 'given_name', sources: ['given_name'], steps: [] },
			{ id: 'op5', target: 'family_name', sources: ['family_name'], steps: [] }
		]
	}),
	// A SAML identity provider (a directory): its attributes into Authrim's.
	idp: (): ConnectionMapping => ({
		direction: 'inbound',
		sources: [
			{ key: 'mail', label: 'Email', type: 'string', example: 'John.Smith@Example.com' },
			{ key: 'givenName', label: 'Given name', type: 'string', example: 'John' },
			{ key: 'sn', label: 'Surname', type: 'string', example: 'Smith' },
			{ key: 'memberOf', label: 'Groups', type: 'string[]', example: ['sales', 'admins'] }
		],
		targets: INTO_AUTHRIM,
		mappings: [
			{
				id: 'idp1',
				target: 'email',
				sources: ['mail'],
				steps: [
					{ id: 'idp1s1', transform: 'trim', params: {} },
					{ id: 'idp1s2', transform: 'case', params: { mode: 'lower' } }
				]
			},
			{
				id: 'idp2',
				target: 'name',
				sources: ['givenName', 'sn'],
				steps: [{ id: 'idp2s1', transform: 'concat', params: { delimiter: ' ' } }]
			},
			{ id: 'idp3', target: 'groups', sources: ['memberOf'], steps: [] }
		]
	}),
	// An app signing in with OpenID Connect: Authrim's attributes into the claims it receives.
	rp: (): ConnectionMapping => ({
		direction: 'outbound',
		sources: AUTHRIM,
		targets: [
			{ key: 'sub', label: 'Subject', type: 'string', required: true },
			{ key: 'email', label: 'Email', type: 'string' },
			{ key: 'email_verified', label: 'Email verified', type: 'boolean' },
			{ key: 'name', label: 'Name', type: 'string' },
			{ key: 'groups', label: 'Groups', type: 'string[]' }
		],
		mappings: [
			{ id: 'rp1', target: 'sub', sources: ['sub'], steps: [] },
			{ id: 'rp2', target: 'email', sources: ['email'], steps: [] },
			{ id: 'rp3', target: 'email_verified', sources: ['email_verified'], steps: [] },
			{ id: 'rp4', target: 'name', sources: ['name'], steps: [] }
		]
	}),
	// A SAML service: Authrim's attributes into the assertion's attributes.
	sp: (): ConnectionMapping => ({
		direction: 'outbound',
		sources: AUTHRIM,
		targets: [
			{ key: 'NameID', label: 'Subject', type: 'string', required: true },
			{ key: 'mail', label: 'Email', type: 'string', required: true },
			{ key: 'displayName', label: 'Display name', type: 'string' },
			{ key: 'memberOf', label: 'Groups', type: 'string[]' }
		],
		mappings: [
			{ id: 'sp1', target: 'NameID', sources: ['sub'], steps: [] },
			{ id: 'sp2', target: 'mail', sources: ['email'], steps: [] },
			{ id: 'sp3', target: 'displayName', sources: ['name'], steps: [] },
			{ id: 'sp4', target: 'memberOf', sources: ['groups'], steps: [] }
		]
	})
};

/** A fresh sample mapping for a connection of this kind. */
export function sampleMapping(kind: ConnectionKind): ConnectionMapping {
	return structuredClone(SAMPLES[kind]());
}
