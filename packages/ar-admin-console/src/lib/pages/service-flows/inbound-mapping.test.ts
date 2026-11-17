import { describe, expect, it, vi } from 'vitest';
import { InboundMappingState } from './inbound-mapping.svelte';
import { inboundMappingFixture } from './inbound-mapping.fixture';
import { ApiError } from '#lib/api/api-error.js';

describe('incoming connection Mapping node draft', () => {
	it('saves and reopens the actual compiled incoming graph and evaluates its projection', async () => {
		const fixture = inboundMappingFixture('idp', true);
		const shared = new InboundMappingState(fixture.client, 'idp', 'synthetic-idp');
		await shared.load();
		expect(shared.readonlyReason).toBe(false);
		shared.form.value.mappings[0].steps.push({ id: 'trim', transform: 'trim', params: {} });
		await shared.evaluate('{"saml.attribute":{"mail":" sample@example.test "}}');
		expect(shared.preview).toEqual({ profile: { email: 'sample@example.test' }, customClaims: {} });
		const saved = await shared.save();
		expect(saved?.configured).toBe(true);
		expect(fixture.document.content.rules[0].transforms?.[0].operation).toBe('trim');
		const reopened = new InboundMappingState(fixture.client, 'idp', 'synthetic-idp');
		await reopened.load();
		expect(reopened.form.value.mappings).toEqual(shared.form.value.mappings);
		expect(reopened.dirty).toBe(false);
	});
	it('keeps the draft while pending and retries the exact frozen payload/key after an error', async () => {
		const fixture = inboundMappingFixture('op', true);
		const shared = new InboundMappingState(fixture.client, 'op', 'synthetic-op');
		await shared.load();
		shared.form.value.mappings[0].steps.push({ id: 'trim', transform: 'trim', params: {} });
		let release = () => {};
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const save = fixture.client.save;
		const requests: { body: string; key: string }[] = [];
		fixture.client.save = async (kind, id, body, key) => {
			requests.push({ body: JSON.stringify(body), key });
			if (requests.length === 1) {
				await delayed;
				throw new Error('Temporary failure');
			}
			return save(kind, id, body, key);
		};
		const pending = shared.save();
		expect(shared.pending).toBe(true);
		await shared.save();
		expect(requests).toHaveLength(1);
		release();
		await pending;
		expect(shared.dirty).toBe(true);
		await shared.save();
		expect(requests[1]).toEqual(requests[0]);
	});
	it('preserves the mapping draft on a General revision refresh, and on conflicts', async () => {
		const fixture = inboundMappingFixture('op', true);
		const shared = new InboundMappingState(fixture.client, 'op', 'synthetic-op');
		await shared.load();
		shared.form.value.mappings[0].steps.push({ id: 'trim', transform: 'trim', params: {} });
		fixture.document.revision = 'general-save';
		await shared.refreshRevision();
		expect(shared.document?.revision).toBe('general-save');
		expect(shared.dirty).toBe(true);
		fixture.client.save = vi.fn(async () => {
			throw new ApiError(409, 'conflict', 'Changed');
		});
		await shared.save();
		expect(shared.phase).toBe('conflict');
		expect(shared.form.value.mappings[0].steps[0].transform).toBe('trim');
	});
	it('keeps unsupported legacy graphs inspectable and refuses subject generators', async () => {
		const fixture = inboundMappingFixture('op', true);
		fixture.document.content.rules[0].targetRef = {
			side: 'destination',
			namespace: 'oidc.claim',
			path: 'sub',
			profileId: 'outgoing'
		};
		const shared = new InboundMappingState(fixture.client, 'op', 'synthetic-op');
		await shared.load();
		expect(shared.readonlyReason).toBe(true);
		expect(await shared.save()).toBeNull();
		expect(fixture.writes).toBe(0);
	});
});
