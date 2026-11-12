/**
 * The audit endpoints of the console dev mock (`AUTHRIM_ADMIN_UI_DEV_MOCK=true`): the end-user
 * event log (`GET /api/admin/audit-logs`) and the admin audit log (`/api/admin/admin-audit-log`,
 * its `actions/list` and one entry), answered from the same in-memory data as Storybook, in the
 * wire format, for the real query parameters. The sample times are moved so the newest event is
 * a few minutes old, whenever the page is read.
 */
import {
	AUDIT_NOW,
	createFakeAdminAudit,
	sampleAuditEntries
} from '#lib/api/fake/admin-audit-fake.js';
import {
	USER_AUDIT_NOW,
	answerUserAuditList,
	sampleUserAuditEntries
} from '#lib/api/fake/user-audit-fake.js';
import { ApiError } from '#lib/api/api-error.js';
import type { AuditResult } from '#lib/api/admin-audit.js';

export interface MockAnswer {
	status: number;
	body: unknown;
}

/** The answer for an audit request, or null when the path is not an audit one. */
export async function answerAuditMock(
	segments: readonly string[],
	method: string,
	params: URLSearchParams
): Promise<MockAnswer | null> {
	if (method !== 'GET') return null;
	if (segments[0] === 'audit-logs' && segments.length === 1) {
		const shift = Date.now() - USER_AUDIT_NOW;
		const entries = sampleUserAuditEntries().map((entry) => ({
			...entry,
			createdAt: new Date(Date.parse(entry.createdAt) + shift).toISOString()
		}));
		return answerUserAuditList(params, entries);
	}
	if (segments[0] === 'admin-audit-log') return answerAdminAudit(segments.slice(1), params);
	return null;
}

async function answerAdminAudit(
	rest: readonly string[],
	params: URLSearchParams
): Promise<MockAnswer> {
	const shift = Date.now() - AUDIT_NOW;
	const client = createFakeAdminAudit({
		entries: sampleAuditEntries().map((entry) => ({
			...entry,
			created_at: entry.created_at + shift
		}))
	});
	try {
		if (rest[0] === 'actions' && rest[1] === 'list') {
			return { status: 200, body: { items: await client.actions() } };
		}
		if (rest.length === 1) return { status: 200, body: await client.get(rest[0]) };
		const page = Number(params.get('page') ?? 1);
		const result = await client.list({
			actor: params.get('admin_user_id') ?? undefined,
			action: params.get('action') ?? undefined,
			result: (params.get('result') as AuditResult | null) ?? undefined,
			from: params.get('start_date') ? new Date(params.get('start_date') as string) : undefined,
			to: params.get('end_date') ? new Date(params.get('end_date') as string) : undefined,
			at: { page },
			limit: Number(params.get('limit') ?? 50)
		});
		const limit = Number(params.get('limit') ?? 50);
		const total = result.total ?? result.items.length;
		return {
			status: 200,
			body: { items: result.items, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) }
		};
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				status: error.status,
				body: { error: error.code, error_description: error.message }
			};
		}
		throw error;
	}
}
