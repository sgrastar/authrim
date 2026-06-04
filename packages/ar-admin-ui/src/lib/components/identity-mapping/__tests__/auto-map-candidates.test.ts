import { describe, expect, it } from 'vitest';
import { suggestAutoMapConnections } from '../auto-map-candidates';
import type { MappingNode } from '../types';

function node(id: string, label: string, role: MappingNode['role'], type = 'string'): MappingNode {
	return {
		id,
		ruleId: `${id}-rule`,
		role,
		label,
		caption: label,
		type
	};
}

describe('identity mapping auto-map candidates', () => {
	it('suggests semantic matches without depending on UI fixtures', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-email', 'Email', 'source', 'email'),
				node('src-first', 'FirstName', 'source'),
				node('src-last', 'LastName', 'source'),
				node('src-locale', 'Locale', 'source')
			],
			toNodes: [
				node('target-email', 'Email', 'target', 'String'),
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-family-name', 'Last Name', 'target', 'String'),
				node('target-locale', 'Locale', 'target', 'String')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-email', 'target-email'],
				['src-first', 'target-given-name'],
				['src-last', 'target-family-name'],
				['src-locale', 'target-locale']
			])
		);
	});

	it('matches localized CSV headers to canonical targets', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-mail', 'メール', 'source', 'email'),
				node('src-family', '姓', 'source'),
				node('src-given', '名', 'source'),
				node('src-postal', '郵便番号', 'source')
			],
			toNodes: [
				node('target-email', 'Email', 'target', 'String'),
				node('target-family-name', 'Last Name', 'target', 'String'),
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-postal-code', 'Postal Code', 'target', 'String')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-mail', 'target-email'],
				['src-family', 'target-family-name'],
				['src-given', 'target-given-name'],
				['src-postal', 'target-postal-code']
			])
		);
	});

	it('matches common English enterprise schema variants', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-given', 'givenName', 'source'),
				node('src-family', 'sn', 'source'),
				node('src-dob', 'date_of_birth', 'source', 'date'),
				node('src-username', 'userPrincipalName', 'source', 'identifier')
			],
			toNodes: [
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-family-name', 'Last Name', 'target', 'String'),
				node('target-birthdate', 'Birthdate', 'target', 'Date'),
				node('target-username', 'Preferred Username', 'target', 'String')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-given', 'target-given-name'],
				['src-family', 'target-family-name'],
				['src-dob', 'target-birthdate'],
				['src-username', 'target-username']
			])
		);
	});

	it('matches SAML, LDAP, and AD export attribute names', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-mail', 'mail', 'source', 'email'),
				node('src-given', 'givenName', 'source'),
				node('src-family', 'sn', 'source'),
				node('src-eppn', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6', 'source', 'identifier'),
				node('src-memberof', 'memberOf', 'source', 'array'),
				node('src-entitlement', 'eduPersonEntitlement', 'source', 'array')
			],
			toNodes: [
				node('target-email', 'Email', 'target', 'String'),
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-family-name', 'Last Name', 'target', 'String'),
				node('target-linked-identity', 'Linked Identity', 'target', 'String'),
				node('target-group-membership', 'Group Membership', 'target', 'Array'),
				node('target-entitlements', 'Entitlements', 'target', 'Array')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-mail', 'target-email'],
				['src-given', 'target-given-name'],
				['src-family', 'target-family-name'],
				['src-eppn', 'target-linked-identity'],
				['src-memberof', 'target-group-membership'],
				['src-entitlement', 'target-entitlements']
			])
		);
	});

	it('matches SCIM, OIDC, and VC style paths', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-username', 'userName', 'source'),
				node('src-email', 'emails[type eq work].value', 'source', 'email'),
				node('src-given', 'name.givenName', 'source'),
				node('src-locality', 'addresses.locality', 'source'),
				node('src-birthdate', 'credentialSubject.birthDate', 'source', 'date'),
				node('src-did', 'credentialSubject.id', 'source', 'identifier')
			],
			toNodes: [
				node('target-username', 'Preferred Username', 'target', 'String'),
				node('target-email', 'Email', 'target', 'String'),
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-locality', 'City / Locality', 'target', 'String'),
				node('target-birthdate', 'Birthdate', 'target', 'Date'),
				node('target-linked-identity', 'Linked Identity', 'target', 'String')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-username', 'target-username'],
				['src-email', 'target-email'],
				['src-given', 'target-given-name'],
				['src-locality', 'target-locality'],
				['src-birthdate', 'target-birthdate'],
				['src-did', 'target-linked-identity']
			])
		);
	});

	it('matches non-English aliases beyond Japanese', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-email', 'correo electrónico', 'source', 'email'),
				node('src-first', 'prénom', 'source'),
				node('src-last', 'Nachname', 'source'),
				node('src-phone', '전화번호', 'source', 'phone'),
				node('src-country', '国家', 'source')
			],
			toNodes: [
				node('target-email', 'Email', 'target', 'String'),
				node('target-given-name', 'First Name', 'target', 'String'),
				node('target-family-name', 'Last Name', 'target', 'String'),
				node('target-phone', 'Phone Number', 'target', 'String'),
				node('target-country', 'Country', 'target', 'String')
			],
			existingEdges: []
		});

		expect(candidates.map((candidate) => [candidate.fromId, candidate.toId])).toEqual(
			expect.arrayContaining([
				['src-email', 'target-email'],
				['src-first', 'target-given-name'],
				['src-last', 'target-family-name'],
				['src-phone', 'target-phone'],
				['src-country', 'target-country']
			])
		);
	});

	it('does not suggest duplicate existing edges', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [node('src-email', 'Email', 'source', 'email')],
			toNodes: [node('target-email', 'Email', 'target', 'String')],
			existingEdges: [{ id: 'existing', from: 'src-email', to: 'target-email' }]
		});

		expect(candidates).toEqual([]);
	});

	it('does not map an email value into an email verification boolean', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [node('src-email', 'Email', 'source', 'email')],
			toNodes: [node('target-email-verified', 'Email Verified', 'target', 'Boolean')],
			existingEdges: []
		});

		expect(candidates).toEqual([]);
	});

	it('keeps source mapping conservative for common CSV ambiguity cases', () => {
		const candidates = suggestAutoMapConnections({
			fromNodes: [
				node('src-employee-id', 'Employee Id', 'source'),
				node('src-email', 'Email', 'source', 'email'),
				node('src-first', 'First Name', 'source'),
				node('src-last', 'Last Name', 'source'),
				node('src-display', 'Display Name', 'source'),
				node('src-phone', 'Phone', 'source', 'phone'),
				node('src-mobile', 'Mobile Phone', 'source', 'phone'),
				node('src-locale', 'Locale', 'source'),
				node('src-timezone', 'Timezone', 'source')
			],
			toNodes: [
				node('target-linked-identity', 'Linked Identity', 'target', 'String'),
				node('target-email', 'Email', 'target', 'String'),
				node('target-profile', 'Profile URL', 'target', 'String'),
				node('target-full-name', 'Full Name', 'target', 'String'),
				node('target-display-name', 'Display Name', 'target', 'String'),
				node('target-first', 'First Name', 'target', 'String'),
				node('target-last', 'Last Name', 'target', 'String'),
				node('target-phone', 'Phone Number', 'target', 'String'),
				node('target-locale', 'Locale', 'target', 'String'),
				node('target-timezone', 'Time Zone', 'target', 'String')
			],
			existingEdges: []
		});
		const pairs = candidates.map((candidate) => [candidate.fromId, candidate.toId]);

		expect(pairs).toEqual(
			expect.arrayContaining([
				['src-email', 'target-email'],
				['src-first', 'target-first'],
				['src-last', 'target-last'],
				['src-display', 'target-display-name'],
				['src-locale', 'target-locale'],
				['src-timezone', 'target-timezone']
			])
		);
		expect(pairs).not.toContainEqual(['src-employee-id', 'target-linked-identity']);
		expect(pairs).not.toContainEqual(['src-email', 'target-profile']);
		expect(pairs).not.toContainEqual(['src-display', 'target-full-name']);
		expect(pairs).not.toContainEqual(['src-phone', 'target-phone']);
		expect(pairs).not.toContainEqual(['src-mobile', 'target-phone']);
	});
});
