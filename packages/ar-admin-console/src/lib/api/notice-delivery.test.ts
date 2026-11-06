import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { createFakeNoticeDelivery } from './fake/notice-delivery-fake';
import {
	channelFromRow,
	deliveryErrorField,
	deliveryFromRow,
	httpNoticeDelivery,
	isSlackWebhookUrl,
	isTemporarilyUnavailable,
	preferencesFromRow
} from './notice-delivery';

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const lastCall = (fetchMock: ReturnType<typeof respond>) =>
	fetchMock.mock.calls[0] as unknown as [string, RequestInit];

const URL_OK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';

describe('from the wire', () => {
	it('fills defaults for preferences, channels and deliveries', () => {
		expect(preferencesFromRow({})).toEqual({
			email_enabled: true,
			email_min_severity: 'high',
			updated_at: null
		});
		expect(preferencesFromRow({ email_enabled: false, email_min_severity: 'bogus' })).toMatchObject(
			{
				email_enabled: false,
				email_min_severity: 'high'
			}
		);
		expect(channelFromRow({ id: 'c', scope_type: 'platform', enabled: true })).toMatchObject({
			scope_type: 'platform',
			enabled: true,
			min_severity: 'high'
		});
		expect(deliveryFromRow({ id: 'd', channel: 'slack', status: 'weird' })).toMatchObject({
			channel: 'slack',
			status: 'queued',
			attempts: 0
		});
	});

	it('accepts only Slack Incoming Webhook URLs', () => {
		expect(isSlackWebhookUrl(URL_OK)).toBe(true);
		expect(isSlackWebhookUrl('https://hooks.slack.com/services/')).toBe(false);
		expect(isSlackWebhookUrl('http://hooks.slack.com/services/a')).toBe(false);
		expect(isSlackWebhookUrl('https://example.com/services/a')).toBe(false);
	});

	it('reads the refused field and a 503 from an error', () => {
		expect(deliveryErrorField(new ApiError(400, 'x', '', { field: 'webhook_url' }))).toBe(
			'webhook_url'
		);
		expect(deliveryErrorField(new Error('x'))).toBeUndefined();
		expect(isTemporarilyUnavailable(new ApiError(503, 'temporarily_unavailable', ''))).toBe(true);
	});
});

describe('over HTTP', () => {
	it('reads and saves the email choices without the tenant header', async () => {
		let fetchMock = respond({
			preferences: { email_enabled: false, email_min_severity: 'info', updated_at: 5 }
		});
		const read = await httpNoticeDelivery.getPreferences();
		expect(read).toEqual({ email_enabled: false, email_min_severity: 'info', updated_at: 5 });
		let [url, init] = lastCall(fetchMock);
		expect(url).toBe('/api/admin/me/notice-preferences');
		expect(new Headers(init.headers).has('X-Tenant-Id')).toBe(false);

		fetchMock = respond({ preferences: { email_enabled: true, email_min_severity: 'critical' } });
		await httpNoticeDelivery.setPreferences({
			email_enabled: true,
			email_min_severity: 'critical'
		});
		[url, init] = lastCall(fetchMock);
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body as string)).toEqual({
			email_enabled: true,
			email_min_severity: 'critical'
		});
		expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
	});

	it('lists, creates, changes and removes channels', async () => {
		let fetchMock = respond({ items: [{ id: 'c1', name: 'a' }] });
		expect((await httpNoticeDelivery.listChannels()).map((c) => c.id)).toEqual(['c1']);
		expect(lastCall(fetchMock)[0]).toBe('/api/admin/notice-channels');

		fetchMock = respond({ channel: { id: 'c2', name: 'b' } }, 201);
		const created = await httpNoticeDelivery.createChannel({ name: 'b', webhook_url: URL_OK });
		expect(created.id).toBe('c2');
		expect(lastCall(fetchMock)[1].method).toBe('POST');

		fetchMock = respond({ channel: { id: 'a/b', enabled: false } });
		await httpNoticeDelivery.updateChannel('a/b', { enabled: false });
		expect(lastCall(fetchMock)[0]).toBe('/api/admin/notice-channels/a%2Fb');
		expect(lastCall(fetchMock)[1].method).toBe('PATCH');

		fetchMock = respond({ channel: { id: 'c1' } });
		await httpNoticeDelivery.replaceWebhookUrl('c1', URL_OK);
		expect(lastCall(fetchMock)[0]).toBe('/api/admin/notice-channels/c1/webhook-url');
		expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({ webhook_url: URL_OK });

		fetchMock = respond({ deleted: true });
		await httpNoticeDelivery.deleteChannel('c1');
		expect(lastCall(fetchMock)[1].method).toBe('DELETE');
	});

	it('sends a test post and reads the result', async () => {
		const fetchMock = respond({ delivered: false, error: 'invalid_webhook' });
		expect(await httpNoticeDelivery.testChannel('c1')).toEqual({
			delivered: false,
			error: 'invalid_webhook'
		});
		expect(lastCall(fetchMock)[0]).toBe('/api/admin/notice-channels/c1/test');
		respond({ delivered: true });
		expect(await httpNoticeDelivery.testChannel('c1')).toEqual({ delivered: true });
	});

	it('lists the deliveries of a notice a page at a time, with their counts', async () => {
		const fetchMock = respond({
			items: [{ id: 'd1', channel: 'email', status: 'sent' }],
			next_cursor: 'd1',
			summary: [{ channel: 'email', status: 'sent', count: 250 }]
		});
		const page = await httpNoticeDelivery.listDeliveries('n/1');
		expect(page.items[0]).toMatchObject({ id: 'd1', status: 'sent' });
		expect(page.next).toBe('d1');
		expect(page.summary).toEqual([{ channel: 'email', status: 'sent', count: 250 }]);
		expect(lastCall(fetchMock)[0]).toBe('/api/admin/notices/n%2F1/deliveries');
		respond({ items: [], next_cursor: null, summary: [] });
		const next = await httpNoticeDelivery.listDeliveries('n/1', { after: 'd 1' });
		expect(next.next).toBeNull();
	});

	it('pages the fake deliveries the same way', async () => {
		const fake = createFakeNoticeDelivery({ deliveryPageSize: 2 });
		const first = await fake.listDeliveries('any');
		expect(first.items).toHaveLength(2);
		const second = await fake.listDeliveries('any', { after: first.next });
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
		expect(first.summary.reduce((sum, entry) => sum + entry.count, 0)).toBeGreaterThan(2);
	});

	it('turns a failed call into an ApiError that keeps the refused field', async () => {
		respond({ error: 'invalid_request', field: 'webhook_url' }, 400);
		const error = await httpNoticeDelivery
			.createChannel({ name: 'x', webhook_url: 'bad' })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(deliveryErrorField(error)).toBe('webhook_url');
		respond({ error: 'temporarily_unavailable' }, 503);
		expect(
			isTemporarilyUnavailable(await httpNoticeDelivery.listChannels().catch((e: unknown) => e))
		).toBe(true);
	});
});

describe('fake notice delivery API', () => {
	it('checks the URL and name, and never returns the URL', async () => {
		const fake = createFakeNoticeDelivery();
		await expect(
			fake.createChannel({ name: 'x', webhook_url: 'https://x.example' })
		).rejects.toMatchObject({
			status: 400,
			body: { field: 'webhook_url' }
		});
		await expect(fake.createChannel({ name: ' ', webhook_url: URL_OK })).rejects.toMatchObject({
			body: { field: 'name' }
		});
		const made = await fake.createChannel({ name: '#sec', webhook_url: URL_OK });
		expect(made.webhook_url_hint).toBe('…WXYZ');
		expect(JSON.stringify(made)).not.toContain('hooks.slack.com');
		expect(JSON.stringify(await fake.listChannels())).not.toContain('hooks.slack.com');
	});

	it('keeps platform channels to platform admins and writes to writers', async () => {
		const tenant = createFakeNoticeDelivery();
		expect((await tenant.listChannels()).map((c) => c.id)).not.toContain('nch_platform');
		await expect(
			tenant.createChannel({ scope_type: 'platform', name: 'p', webhook_url: URL_OK })
		).rejects.toMatchObject({ status: 403 });
		const platform = createFakeNoticeDelivery({ platform: true });
		expect((await platform.listChannels()).map((c) => c.id)).toContain('nch_platform');
		const viewer = createFakeNoticeDelivery({ canWrite: false });
		await expect(viewer.updateChannel('nch_ops', { enabled: false })).rejects.toMatchObject({
			status: 403
		});
	});

	it('changes, replaces, tests and deletes a channel', async () => {
		const fake = createFakeNoticeDelivery();
		expect((await fake.updateChannel('nch_ops', { enabled: false })).enabled).toBe(false);
		expect((await fake.replaceWebhookUrl('nch_ops', URL_OK)).webhook_url_hint).toBe('…WXYZ');
		expect(await fake.testChannel('nch_ops')).toEqual({ delivered: true });
		await fake.deleteChannel('nch_ops');
		await expect(fake.deleteChannel('nch_ops')).rejects.toMatchObject({ status: 404 });
	});

	it('keeps the email choices', async () => {
		const fake = createFakeNoticeDelivery();
		expect((await fake.getPreferences()).email_min_severity).toBe('high');
		await fake.setPreferences({ email_enabled: false, email_min_severity: 'info' });
		expect(await fake.getPreferences()).toMatchObject({
			email_enabled: false,
			email_min_severity: 'info'
		});
	});
});
