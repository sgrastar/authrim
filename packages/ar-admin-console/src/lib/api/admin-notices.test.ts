import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasMessage, t } from '#lib/i18n/i18n.svelte.js';
import { ApiError } from './api-error';
import {
	httpAdminNotices,
	isConsolePath,
	noticeErrorCode,
	noticeFromRow,
	noticeText,
	noticeToShell
} from './admin-notices';
import { createFakeAdminNotices, sampleNotices } from './fake/admin-notices-fake';

afterEach(() => vi.unstubAllGlobals());

const ctx = { t, hasMessage, locale: 'en', zone: 'utc' as const };
const [recovery, dlq, , announcement] = sampleNotices();

describe('notice to header notification', () => {
	it('uses the localized message of a system notice, with its parameters', () => {
		expect(noticeText(recovery, ctx)).toBe(
			t('notice.msg.second_factor_recovery_requested', { email: 'sam@example.com' })
		);
		expect(noticeText(recovery, ctx)).toContain('sam@example.com');
	});

	it('falls back to the title when the message key has no text', () => {
		expect(noticeText({ ...dlq, message_key: 'brand_new_category' }, ctx)).toBe(dlq.title);
		expect(noticeText(announcement, ctx)).toBe('Maintenance on Saturday');
	});

	it('keeps id and severity and formats the time', () => {
		const shell = noticeToShell(recovery, ctx);
		expect(shell).toMatchObject({ id: 'ntc_recovery', severity: 'high' });
		expect(shell.time).toMatch(/2026/);
		expect(shell.time).toMatch(/UTC/);
	});

	it('has a text for every operational category', () => {
		for (const key of [
			'storage_registry_security',
			'storage_registry_health',
			'tenant_database_stats',
			'tenant_database_health',
			'control_plane_drift',
			'logging_destination_health',
			'logging_delivery_failure',
			'logging_fallback_used',
			'logging_dlq_backlog',
			'logging_quota_warning',
			'logging_repair_job_status',
			'notification_delivery_failure'
		]) {
			expect(hasMessage(`notice.msg.${key}`), key).toBe(true);
		}
	});
});

describe('notice from the wire', () => {
	it('fills what is missing and allows dismissing information only', () => {
		const notice = noticeFromRow({ id: 'a', severity: 'high', dismissible: true, title: 'x' });
		expect(notice).toMatchObject({
			id: 'a',
			scope_type: 'tenant',
			params: {},
			body: null,
			dismissible: false
		});
		expect(noticeFromRow({ id: 'b', severity: 'info', dismissible: true }).dismissible).toBe(true);
		expect(noticeFromRow({ id: 'c', severity: 'bogus' }).severity).toBe('info');
	});

	it('links only to console paths', () => {
		expect(isConsolePath('/admin/me')).toBe(true);
		expect(isConsolePath('//evil.example/admin/')).toBe(false);
		expect(isConsolePath('https://evil.example')).toBe(false);
		expect(isConsolePath(null)).toBe(false);
	});

	it('reads the API code of an error, also from a 409 body', () => {
		expect(noticeErrorCode(new ApiError(403, 'forbidden', ''))).toBe('forbidden');
		expect(noticeErrorCode(new ApiError(409, 'conflict', '', { error: 'notice_resolved' }))).toBe(
			'notice_resolved'
		);
	});
});

function respond(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('over HTTP', () => {
	it('lists the open notices', async () => {
		const fetchMock = respond({ items: [{ id: 'n1', severity: 'info', title: 'Hi' }] });
		const items = await httpAdminNotices.list();
		expect(items.map((item) => item.id)).toEqual(['n1']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/notices');
		expect(init.credentials).toBe('include');
	});

	it('reads, dismisses and resolves one notice by its id', async () => {
		let fetchMock = respond({ notice: { id: 'a/b', severity: 'high' } });
		expect((await httpAdminNotices.get('a/b')).id).toBe('a/b');
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/admin/notices/a%2Fb');

		fetchMock = respond({ ok: true });
		await httpAdminNotices.dismiss('n1');
		let [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/notices/n1/dismiss');
		expect(init.method).toBe('POST');

		fetchMock = respond({ notice: { id: 'n1', severity: 'high', resolved_at: 5 } });
		expect((await httpAdminNotices.resolve('n1')).resolved_at).toBe(5);
		[url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/notices/n1/resolve');
	});

	it('publishes an announcement as JSON', async () => {
		const fetchMock = respond({ notice: { id: 'n9', severity: 'info', title: 'T' } }, 201);
		const notice = await httpAdminNotices.publish({
			scope_type: 'tenant',
			severity: 'info',
			title: 'T'
		});
		expect(notice.id).toBe('n9');
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({
			scope_type: 'tenant',
			severity: 'info',
			title: 'T'
		});
		expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
	});

	it('turns a failed call into an ApiError that keeps the code', async () => {
		respond({ error: 'notice_resolved', message: 'already' }, 409);
		const error = await httpAdminNotices.resolve('n1').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(noticeErrorCode(error)).toBe('notice_resolved');
		respond({ error: 'forbidden' }, 403);
		await expect(httpAdminNotices.list()).rejects.toMatchObject({ status: 403 });
	});
});

describe('fake notices API', () => {
	it('hides platform notices from a tenant admin and dismisses information only', async () => {
		const fake = createFakeAdminNotices();
		expect((await fake.list()).map((n) => n.id)).not.toContain('ntc_platform');
		await expect(fake.dismiss('ntc_dlq')).rejects.toMatchObject({ status: 409 });
		await fake.dismiss('ntc_announce');
		expect((await fake.list()).map((n) => n.id)).not.toContain('ntc_announce');
	});

	it('resolves once for everyone', async () => {
		const fake = createFakeAdminNotices();
		const done = await fake.resolve('ntc_dlq');
		expect(done.resolved_at).not.toBeNull();
		expect((await fake.list()).map((n) => n.id)).not.toContain('ntc_dlq');
		expect((await fake.get('ntc_dlq')).resolved_at).not.toBeNull();
		const again = await fake.resolve('ntc_dlq').catch((e: unknown) => e);
		expect(noticeErrorCode(again)).toBe('notice_resolved');
	});

	it('checks an announcement before keeping it', async () => {
		const fake = createFakeAdminNotices();
		const base = { scope_type: 'tenant', severity: 'info' } as const;
		await expect(fake.publish({ ...base, title: ' ' })).rejects.toMatchObject({ status: 400 });
		await expect(fake.publish({ ...base, title: 'x'.repeat(201) })).rejects.toMatchObject({
			status: 400
		});
		await expect(
			fake.publish({ ...base, title: 'x', link: 'https://x.example' })
		).rejects.toMatchObject({
			status: 400
		});
		await expect(fake.publish({ ...base, scope_type: 'client', title: 'x' })).rejects.toMatchObject(
			{
				status: 400
			}
		);
		await expect(
			fake.publish({ ...base, scope_type: 'platform', title: 'x' })
		).rejects.toMatchObject({
			status: 403
		});
		const made = await fake.publish({ ...base, title: 'Hello', link: '/admin/me' });
		expect(made.dismissible).toBe(true);
		expect((await fake.list())[0].id).toBe(made.id);
	});
});
