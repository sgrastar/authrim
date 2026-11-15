import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError } from '../api-error';
import { rowErrorsOf } from '../identifier-materials';
import { createFakeIdentifierMaterials, fakeFingerprint } from './identifier-materials-fake';

describe('identifier salts', () => {
	it('keeps a salt, leaves the same one alone and replaces a different one only with its fingerprint', async () => {
		const client = createFakeIdentifierMaterials();
		expect((await client.importSalt('legacy', { value: 'one', encoding: 'utf8' })).outcome).toBe(
			'created'
		);
		expect((await client.importSalt('legacy', { value: 'one', encoding: 'utf8' })).outcome).toBe(
			'unchanged'
		);
		await expect(
			client.importSalt('legacy', { value: 'two', encoding: 'utf8' })
		).rejects.toBeInstanceOf(ConflictError);
		const replaced = await client.importSalt('legacy', {
			value: 'two',
			encoding: 'utf8',
			replaceFingerprint: fakeFingerprint('one')
		});
		expect(replaced).toMatchObject({ outcome: 'replaced', fingerprint: fakeFingerprint('two') });
		expect((await client.salts())[0].fingerprint).toBe(fakeFingerprint('two'));
	});

	it('reads Base64 as the bytes it holds', async () => {
		const client = createFakeIdentifierMaterials();
		await client.importSalt('legacy', { value: 'one', encoding: 'utf8' });
		const same = await client.importSalt('legacy', { value: btoa('one'), encoding: 'base64' });
		expect(same.outcome).toBe('unchanged');
	});
});

describe('CSV imports', () => {
	it('refuse the whole file with the rows at fault, and write nothing', async () => {
		const client = createFakeIdentifierMaterials();
		const refused = await client
			.importSource('numbers', 'account,value\nunknown_1,A\nusr_1')
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(ApiError);
		expect(rowErrorsOf((refused as ApiError).body)).toEqual([
			{ row: 2, column: 'account', code: 'unknown_account' },
			{ row: 3, column: 'row', code: 'field_count' }
		]);
		expect(await client.sources()).toEqual([]);
	});

	it('ask for replace before changing an account’s value, and never replace another account’s', async () => {
		const client = createFakeIdentifierMaterials({
			sources: { numbers: { usr_1: 'A', usr_2: 'B' } }
		});
		const conflict = await client
			.importSource('numbers', 'account,value\nusr_1,C')
			.catch((error: unknown) => error);
		expect((conflict as ConflictError).body).toMatchObject({ conflicts: 1, valuesOfOthers: 0 });
		expect(await client.importSource('numbers', 'account,value\nusr_1,C', true)).toEqual({
			created: 0,
			replaced: 1,
			unchanged: 0
		});
		const taken = await client
			.importSource('numbers', 'account,value\nusr_1,B', true)
			.catch((error: unknown) => error);
		expect((taken as ConflictError).body).toMatchObject({ valuesOfOthers: 1 });
	});

	it('replace an exception list as a whole, and empty it with a header-only file', async () => {
		const client = createFakeIdentifierMaterials({ salts: { legacy: 'x' } });
		const header = 'account,audience,action,salt';
		expect(
			await client.importExceptions('map', `${header}\n*,https://sp.example.org,salt,legacy`)
		).toEqual({ rows: 1, salts: 1, blocks: 0 });
		expect((await client.exceptions())[0].count).toBe(1);
		expect(await client.importExceptions('map', header)).toEqual({ rows: 0, salts: 0, blocks: 0 });
		expect((await client.exceptions())[0].count).toBe(0);
	});
});

describe('identifier salts, non-ASCII', () => {
	it('treat UTF-8 text and the Base64 of the same bytes as the same salt', async () => {
		const client = createFakeIdentifierMaterials();
		await client.importSalt('legacy', { value: 'é', encoding: 'utf8' });
		// "é" is the two bytes C3 A9, "w6k=" in Base64.
		const same = await client.importSalt('legacy', { value: 'w6k=', encoding: 'base64' });
		expect(same.outcome).toBe('unchanged');
	});
});
