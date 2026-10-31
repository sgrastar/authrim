import { describe, expect, it } from 'vitest';
import { Draft, sameValue, valueAt } from './draft.svelte';

describe('Draft', () => {
	it('is dirty only while something differs from what was saved', () => {
		const draft = new Draft({ name: 'Acme', methods: ['passkey'] });
		expect(draft.dirty).toBe(false);
		draft.value.methods = ['passkey', 'email'];
		expect(draft.dirty).toBe(true);
		expect(draft.changed('methods')).toBe(true);
		expect(draft.changed('name')).toBe(false);
		draft.value.methods = ['passkey'];
		expect(draft.dirty).toBe(false);
	});

	it('discards back to the saved values and commits the edited ones', () => {
		const draft = new Draft({ mfa: { mode: 'off' } });
		draft.value.mfa.mode = 'always';
		draft.discard();
		expect(draft.value.mfa.mode).toBe('off');
		draft.value.mfa.mode = 'risk';
		draft.commit();
		expect(draft.saved.mfa.mode).toBe('risk');
		expect(draft.dirty).toBe(false);
	});

	it('reads dotted paths', () => {
		expect(valueAt({ a: { b: 2 } }, 'a.b')).toBe(2);
		expect(valueAt({ a: 1 }, 'a.b')).toBeUndefined();
	});

	it('compares values by structure', () => {
		expect(sameValue({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
		expect(sameValue([1, 2], [2, 1])).toBe(false);
		expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
	});

	it('tells chosen files apart by what they are', () => {
		const logo = new File(['a'], 'logo.png', { type: 'image/png', lastModified: 1 });
		const other = new File(['bb'], 'other.png', { type: 'image/png', lastModified: 2 });
		expect(sameValue(logo, other)).toBe(false);
		const sameFile = new File(['a'], 'logo.png', { type: 'image/png', lastModified: 1 });
		expect(sameValue(logo, sameFile)).toBe(true);
		expect(sameValue(logo, 'https://cdn.example.com/logo.png')).toBe(false);
	});

	it('is not dirty right after saving a chosen file', () => {
		const draft = new Draft<{ logo: string | File | null }>({ logo: 'https://cdn/logo.png' });
		draft.value.logo = new File(['a'], 'logo.png', { type: 'image/png', lastModified: 1 });
		expect(draft.dirty).toBe(true);
		draft.commit();
		expect(draft.dirty).toBe(false);
	});
});
