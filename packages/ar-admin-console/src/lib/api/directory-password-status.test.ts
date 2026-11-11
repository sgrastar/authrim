import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	directoryPasswordStatusFromRow,
	httpDirectoryPasswordStatus
} from './directory-password-status';

afterEach(() => vi.unstubAllGlobals());

const connector = {
	id: 'campus',
	transport: 'direct',
	endpoint_url: 'https://wordwarden.example.com/verify',
	auth_mode: 'hmac',
	connector_id: 'wwcon_1234567890123456',
	key_id: 'key-1',
	secret_ref: 'env:AUTHRIM_WORDWARDEN_SECRET'
};

describe('directory password status', () => {
	it('distinguishes missing setup from a configured but disabled connector', () => {
		expect(directoryPasswordStatusFromRow({ connectors: [] })).toBe('unconfigured');
		expect(directoryPasswordStatusFromRow({ connectors: [connector], enabled: false })).toBe(
			'disabled'
		);
		expect(directoryPasswordStatusFromRow({ connectors: [connector], enabled: true })).toBe(
			'ready'
		);
	});

	it('accepts a configured relay and requires the selected default connector', () => {
		expect(
			directoryPasswordStatusFromRow({
				enabled: true,
				connectors: [{ ...connector, transport: 'relay', endpoint_url: '' }]
			})
		).toBe('ready');
		expect(
			directoryPasswordStatusFromRow({
				enabled: true,
				default_connector_id: 'other',
				connectors: [connector]
			})
		).toBe('unconfigured');
	});

	it('reads the selected tenant without changing configuration', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ enabled: true, connectors: [connector] }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		await expect(httpDirectoryPasswordStatus.get('tenant one')).resolves.toBe('ready');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/tenants/tenant%20one/directory-connectors');
		expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('tenant one');
	});
});
