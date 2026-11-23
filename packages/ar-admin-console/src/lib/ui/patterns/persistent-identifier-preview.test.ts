import { describe, expect, it } from 'vitest';
import { newStep, type Mapping, type TransformStep } from './mapping-model';
import { previewMapping } from './mapping-preview';
import {
	PREVIEW_IDP,
	PREVIEW_SCOPE,
	PREVIEW_SP,
	pseudoPersistentIdentifier
} from './persistent-identifier-preview';

const params = (values: Record<string, string>) => values as TransformStep['params'];

describe('a made-up persistent identifier', () => {
	it('has the shape each algorithm gives', () => {
		const shape = (algorithm: string, extra: Record<string, string> = {}) =>
			pseudoPersistentIdentifier(params({ algorithm, format: 'plain', ...extra })) as string;
		expect(shape('authrim_sha256')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// Shibboleth: the digest and the encoding decide the length and the padding.
		expect(shape('shibboleth')).toMatch(/^[A-Za-z0-9]{27}=$/);
		expect(shape('shibboleth', { digest: 'SHA-256' })).toMatch(/^[A-Za-z0-9]{43}=$/);
		expect(shape('shibboleth', { digest: 'SHA-512' })).toMatch(/^[A-Za-z0-9]{86}==$/);
		expect(shape('shibboleth', { digest: 'SHA-1', encoding: 'base32' })).toMatch(/^[A-Z2-7]{32}$/);
		expect(shape('shibboleth', { digest: 'SHA-256', encoding: 'base32' })).toMatch(
			/^[A-Z2-7]{52}={4}$/
		);
		// Keycloak: a version 3 UUID.
		expect(shape('keycloak_sha256')).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(shape('simplesamlphp_targeted_id')).toMatch(/^[0-9a-f]{40}$/);
		expect(shape('simplesamlphp_persistent_nameid')).toMatch(/^[0-9a-f]{40}$/);
		// The SimpleSAMLphp pairwise and subject IDs already end in "@scope".
		expect(shape('simplesamlphp_pairwise_id', { format: 'saml_pairwise_id' })).toMatch(
			new RegExp(`^[0-9a-f]{64}@${PREVIEW_SCOPE.replaceAll('.', '\\.')}$`)
		);
	});

	it('is carried the way the format carries it', () => {
		const base = { algorithm: 'authrim_sha256' };
		const plain = pseudoPersistentIdentifier(params({ ...base, format: 'plain' })) as string;
		// A targeted ID names the identity provider and the service provider with "!".
		expect(pseudoPersistentIdentifier(params({ ...base, format: 'saml_targeted_id' }))).toBe(
			`${PREVIEW_IDP}!${PREVIEW_SP}!${plain}`
		);
		// A scoped one takes the scope that was set, or an example one.
		expect(
			pseudoPersistentIdentifier(
				params({ ...base, format: 'saml_pairwise_id', scope: 'univ.ac.jp' })
			)
		).toBe(`${plain}@univ.ac.jp`);
		expect(pseudoPersistentIdentifier(params({ ...base, format: 'saml_subject_id' }))).toBe(
			`${plain}@${PREVIEW_SCOPE}`
		);
	});

	it('is the same every time, and does not exist before an algorithm is chosen', () => {
		const settings = params({ algorithm: 'shibboleth', format: 'plain' });
		expect(pseudoPersistentIdentifier(settings)).toBe(pseudoPersistentIdentifier(settings));
		expect(pseudoPersistentIdentifier(params({ format: 'plain' }))).toBeNull();
		expect(pseudoPersistentIdentifier(params({ algorithm: 'something_else' }))).toBeNull();
	});
});

describe('a persistent identifier in the sample output of a mapping', () => {
	const step = (transform: TransformStep['transform'], values: Record<string, string> = {}) => ({
		...newStep(transform, transform),
		params: { ...newStep(transform, transform).params, ...values }
	});
	const mapping = (steps: TransformStep[]): Mapping => ({
		id: 'm',
		sources: [],
		target: 'eduPersonTargetedID',
		steps
	});

	it('shows the made-up value, marked as an illustration, instead of "decided at sign-in"', () => {
		const trace = previewMapping(
			mapping([
				step('persistent_identifier', { format: 'saml_targeted_id', algorithm: 'authrim_sha256' })
			]),
			[]
		);
		const output = trace?.output;
		expect(output).toMatchObject({ known: true, illustrative: true });
		expect(String((output as { value: unknown }).value)).toContain(`${PREVIEW_IDP}!${PREVIEW_SP}!`);
	});

	it('lets what comes after work on it, still marked', () => {
		const trace = previewMapping(
			mapping([
				step('persistent_identifier', { format: 'plain', algorithm: 'keycloak_sha256' }),
				step('affix_text', { prefix: 'id-' })
			]),
			[]
		);
		const [first, second] = trace?.steps ?? [];
		expect(first[0]).toMatchObject({ known: true, illustrative: true });
		expect(String((second[0] as { value: unknown }).value)).toMatch(/^id-[0-9a-f]{8}-/);
		expect(second[0]).toMatchObject({ illustrative: true });
	});

	it('says "decided at sign-in" while the algorithm is not chosen, and for a hash', () => {
		const noAlgorithm = previewMapping(
			mapping([step('persistent_identifier', { algorithm: '' })]),
			[]
		);
		expect(noAlgorithm?.output).toEqual({ known: false });
		const hash = previewMapping({ id: 'h', sources: ['in'], target: 't', steps: [step('hash')] }, [
			{ key: 'in', type: 'string', example: 'x' }
		]);
		expect(hash?.output).toEqual({ known: false });
	});
});
