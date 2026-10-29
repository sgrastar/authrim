import { describe, expect, it } from 'vitest';
import { failureOf } from '../schema-setting';
import { createFakeSchemaSetting } from './schema-setting-fake';

const T = 'acme';
const failure = async (call: () => Promise<unknown>) => {
	try {
		await call();
	} catch (error) {
		return failureOf(error);
	}
	throw new Error('did not fail');
};

describe('the fake schema setting API', () => {
	it('lists in the order of the groups, and filters', async () => {
		const client = createFakeSchemaSetting();
		const all = await client.list(T);
		expect(all.schemas[0].fieldKey).toBe('name');
		expect((await client.list(T, { isSystem: true })).schemas.every((s) => s.isSystem)).toBe(true);
		expect((await client.list(T, { search: 'employee' })).schemas.map((s) => s.fieldKey)).toEqual([
			'employee_id'
		]);
		expect((await client.list(T, { status: 'error' })).total).toBe(1);
		const page = await client.list(T, { limit: 5, page: 2 });
		expect(page.schemas).toHaveLength(5);
		expect(page.totalPages).toBe(Math.ceil(all.total / 5));
	});

	it('refuses a reserved key and a key that is in use, but gives no reason', async () => {
		const client = createFakeSchemaSetting();
		expect((await failure(() => client.create(T, { fieldKey: 'email', label: 'x' }))).kind).toBe(
			'invalid'
		);
		expect(
			(await failure(() => client.create(T, { fieldKey: 'employee_id', label: 'x' }))).kind
		).toBe('invalid');
		expect((await failure(() => client.create(T, { fieldKey: 'Bad', label: 'x' }))).kind).toBe(
			'invalid'
		);
		const created = await client.create(T, { fieldKey: 'badge_number', label: 'Badge' });
		expect(created.type).toBe('string');
		expect(created.isSystem).toBe(false);
		expect((await client.history(T, created.id)).total).toBe(1);
	});

	it('locks a base attribute and does not delete one that something relies on', async () => {
		const client = createFakeSchemaSetting();
		expect((await failure(() => client.update(T, 's-name', { label: 'Other' }))).kind).toBe(
			'forbidden'
		);
		expect((await client.update(T, 's-name', { isRequired: true })).isRequired).toBe(true);
		expect((await failure(() => client.remove(T, 's-name'))).kind).toBe('forbidden');
		expect((await failure(() => client.rename(T, 's-name', 'full_name'))).kind).toBe('forbidden');
		// A custom attribute is fine to delete; one with blocking usage is not.
		await client.remove(T, 's-skills');
		expect((await failure(() => client.get(T, 's-skills'))).kind).toBe('not_found');
	});

	it('does not change the cardinality while there are values', async () => {
		const client = createFakeSchemaSetting();
		expect(
			(await failure(() => client.update(T, 's-employee', { cardinality: 'multi' }))).kind
		).toBe('conflict');
	});

	it('renames, and keeps the history', async () => {
		const client = createFakeSchemaSetting();
		const result = await client.rename(T, 's-cost', 'cost_code');
		expect(result).toMatchObject({ oldKey: 'cost_center', newKey: 'cost_code' });
		expect(result.schema.version).toBe(2);
		expect((await failure(() => client.rename(T, 's-cost', 'cost_code'))).kind).toBe('invalid');
		const { versions } = await client.history(T, 's-cost');
		expect(versions[0].operation).toBe('rename');
	});

	it('ends a rename or a delete half done, and retry finishes the rename but only re-opens the delete', async () => {
		const client = createFakeSchemaSetting({ failPartially: true });
		const renameFailure = await failure(() => client.rename(T, 's-department', 'dept'));
		expect(renameFailure).toMatchObject({ kind: 'partial' });
		const stuck = (await client.get(T, 's-department')).schema;
		expect(stuck.status).toBe('error');
		expect(stuck.fieldKey).toBe('department');
		const retried = await client.retry(T, 's-department');
		expect(retried.action).toBe('rename_completed');
		expect(retried.schema?.fieldKey).toBe('dept');

		const second = createFakeSchemaSetting({ failPartially: true });
		expect((await failure(() => second.remove(T, 's-cost'))).kind).toBe('partial');
		expect((await second.retry(T, 's-cost')).action).toBe('reset_to_active');
		await second.remove(T, 's-cost');
		expect((await failure(() => second.get(T, 's-cost'))).kind).toBe('not_found');
	});

	it('refuses to retry what has not failed, and to change what is being worked on', async () => {
		const client = createFakeSchemaSetting();
		expect((await failure(() => client.retry(T, 's-employee'))).kind).toBe('invalid');
		expect((await failure(() => client.update(T, 's-legacy', { description: 'x' }))).kind).toBe(
			'invalid'
		);
	});

	it('applies a preset: new attributes are base ones, existing keys are skipped', async () => {
		const client = createFakeSchemaSetting();
		const result = await client.applyPreset(T, 'oidc_standard', [
			'name',
			'given_name',
			'family_name'
		]);
		expect(result.createdKeys).toEqual(['given_name', 'family_name']);
		expect(result.skippedKeys).toEqual(['name']);
		const created = (await client.list(T, { search: 'given_name' })).schemas[0];
		expect(created.isSystem).toBe(true);
		expect((await failure(() => client.applyPreset(T, 'nothing'))).kind).toBe('invalid');
		expect((await failure(() => client.applyPreset(T, 'oidc_standard', []))).kind).toBe('invalid');
	});

	it('counts for the page', async () => {
		const stats = await createFakeSchemaSetting().stats(T);
		expect(stats.errorCount).toBe(1);
		expect(stats.total).toBeGreaterThan(5);
		const empty = createFakeSchemaSetting({ empty: true });
		expect((await empty.list(T)).total).toBe(0);
	});
});
