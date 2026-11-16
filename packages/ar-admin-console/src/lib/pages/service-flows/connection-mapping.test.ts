import { describe, expect, it } from 'vitest';
import { ConnectionMappingState } from './connection-mapping.svelte';
import { connectionMappingFixture } from './connection-mapping.fixture';

describe('connection Mapping Set save and binding', () => {
	it('locks the old editor and save until the selected set finishes loading', async () => {
		const fixture = connectionMappingFixture();
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		state.form.value.name += ' old edit';
		const oldContext = state.context;
		let release = () => {};
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = fixture.resources.client.setContent;
		fixture.resources.client.setContent = async (...args) => {
			await delayed;
			return read(...args);
		};
		const selection = state.select('set-shared');
		expect(state.detail?.id).toBe('set-portal');
		expect(state.context).toBe(oldContext);
		expect(state.locked).toBe(true);
		await state.save();
		expect(state.phase).toBe('loading');
		expect(fixture.events).toEqual([]);
		release();
		await selection;
		expect(state.detail?.id).toBe('set-shared');
		expect(state.form.value.name).toBe('Shared staff mapping');
		expect(state.locked).toBe(false);
		await state.save();
		expect(fixture.events).toEqual(['bind']);
		expect(state.bound).toBe('set-shared');
	});
	it('saves the edited graph with the current ETag, preserves content settings, then binds', async () => {
		const fixture = connectionMappingFixture();
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		await state.select('set-shared');
		state.form.value.mappings[0].steps.push({ id: 'trim-email', transform: 'trim', params: {} });
		await state.save();
		expect(fixture.events).toEqual(['save', 'bind']);
		expect(fixture.requests[0].options?.version).toBe('"version-1"');
		expect(fixture.requests[0].request.content).toMatchObject({
			compatibilityRange: '^1',
			sourceProfileIds: ['canonical'],
			rules: [{ transforms: [{ operation: 'trim' }] }, {}]
		});
		expect(state.phase).toBe('saved');
		expect(state.detail?.etag).toBe('"version-2"');
		expect(state.dirty).toBe(false);
	});
	it('binds a selected existing set without saving shared content', async () => {
		const fixture = connectionMappingFixture();
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		await state.select('set-shared');
		await state.save();
		expect(fixture.events).toEqual(['bind']);
		expect(state.bound).toBe('set-shared');
	});
	it('retains the saved set and retries only binding', async () => {
		const fixture = connectionMappingFixture('binding');
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		await state.select('set-shared');
		state.form.value.name += ' updated';
		await state.save();
		expect(state.phase).toBe('binding_failed');
		expect(state.savedSet?.content_version).toBe('version-2');
		expect(state.savedSet?.id).toBe('set-shared');
		const bindingKey = state.bindingKey;
		await state.save();
		expect(fixture.requests).toHaveLength(1);
		await state.retryBinding();
		expect(state.bindingKey).toBe(bindingKey);
		expect(fixture.events).toEqual(['save', 'bind', 'bind']);
		expect(state.phase).toBe('saved');
		expect(state.dirty).toBe(false);
	});
	it('confirms the current impact count and asks again if the server returns a newer count', async () => {
		const fixture = connectionMappingFixture('impact');
		const state = new ConnectionMappingState(fixture.resources);
		const originalSave = fixture.resources.client.saveSet;
		let firstKey = '';
		fixture.resources.client.saveSet = async (_tenant, _id, request, options) => {
			expect(request.confirm_impact).toBe(3);
			firstKey = options.idempotencyKey;
			return {
				kind: 'impact_confirmation_required',
				references: { count: 4, scanComplete: false },
				body: {}
			};
		};
		await state.load();
		state.form.value.name += ' updated';
		await state.save();
		expect(fixture.events).toEqual([]);
		expect(state.impact).toEqual({ count: 3, incomplete: false, connections: ['Other staff app'] });
		await state.confirmImpact();
		expect(state.impact).toEqual({ count: 4, incomplete: true, connections: ['Other staff app'] });
		fixture.resources.client.saveSet = originalSave;
		await state.confirmImpact();
		expect(fixture.requests[0].request.confirm_impact).toBe(4);
		expect(fixture.requests[0].key).not.toBe(firstKey);
		expect(fixture.events).toEqual(['save', 'bind']);
	});
	it('reuses the opaque create key, idempotency key and exact payload after an unknown result', async () => {
		const fixture = connectionMappingFixture('unknown');
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		state.create();
		state.form.value.name = 'A new name';
		state.form.value.profileId = 'profile';
		state.form.value.catalogVersionId = 'catalog-v1';
		state.configure();
		state.form.value.mappings = [{ id: 'email', target: 'email', sources: ['email'], steps: [] }];
		await state.save();
		expect(state.phase).toBe('outcome_unknown');
		expect(fixture.events).toEqual(['save']);
		await state.write();
		expect(fixture.requests[1]).toEqual(fixture.requests[0]);
		expect(fixture.requests[0].request.field_mapping_key).toBe(state.newKey);
		expect(state.newKey).not.toContain('name');
		expect(state.phase).toBe('saved');
	});
	it('keeps conflict and stage failure unsaved and never binds either result', async () => {
		for (const scenario of ['conflict', 'stage'] satisfies Array<'conflict' | 'stage'>) {
			const fixture = connectionMappingFixture(scenario);
			const state = new ConnectionMappingState(fixture.resources);
			await state.load();
			state.form.value.name += ' updated';
			await state.save();
			expect(state.phase).toBe(scenario === 'stage' ? 'stage_failed' : 'conflict');
			expect(state.form.dirty).toBe(true);
			expect(fixture.events).toEqual(['save']);
		}
	});
	it('can inspect the server record after a lost save answer without announcing success or binding', async () => {
		const fixture = connectionMappingFixture();
		const save = fixture.resources.client.saveSet;
		fixture.resources.client.saveSet = async (...args) => {
			await save(...args);
			return { kind: 'outcome_unknown', idempotencyKey: args[3].idempotencyKey, body: {} };
		};
		const state = new ConnectionMappingState(fixture.resources);
		await state.load();
		state.form.value.name += ' updated';
		await state.save();
		expect(state.phase).toBe('outcome_unknown');
		await state.inspectUnknown();
		expect(state.phase).toBe('ready');
		expect(state.detail?.content_version).toBe('version-2');
		expect(fixture.events).toEqual(['save']);
	});
});
