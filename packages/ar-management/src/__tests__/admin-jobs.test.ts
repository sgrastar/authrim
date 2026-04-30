import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockAuditLog, mockLoggerError } = vi.hoisted(() => ({
	mockAdapter: {
		queryOne: vi.fn(),
		query: vi.fn(),
		execute: vi.fn(),
	} satisfies Pick<DatabaseAdapter, 'queryOne' | 'query' | 'execute'>,
	mockAuditLog: vi.fn(),
	mockLoggerError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
	return {
		...actual,
		createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mockAdapter })),
		createAuditLogFromContext: mockAuditLog,
		getLogger: vi.fn(() => ({
			module: () => ({
				error: mockLoggerError,
			}),
		})),
	};
});

import {
	adminJobResultDownloadHandler,
	adminJobsImportUploadHandler,
	adminJobsImportUploadUrlHandler,
	adminJobsUsersImportHandler,
} from '../admin-jobs';
import { buildUserImportResultKey, buildUserImportUploadKey } from '../user-import-jobs';

interface StoredR2Object {
	body: Uint8Array;
	contentType?: string;
}

function createMockR2Bucket(initial: Record<string, StoredR2Object> = {}) {
	const store = new Map<string, StoredR2Object>(Object.entries(initial));

	return {
		store,
		bucket: {
			put: vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }) => {
				const body =
					typeof value === 'string'
						? new TextEncoder().encode(value)
						: value instanceof ArrayBuffer
							? new Uint8Array(value)
							: value instanceof Uint8Array
								? value
								: new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
				store.set(key, {
					body,
					contentType: options?.httpMetadata?.contentType,
				});
			}),
			get: vi.fn(async (key: string) => {
				const object = store.get(key);
				if (!object) {
					return null;
				}
				return {
					body: new Blob([object.body]).stream(),
					text: async () => new TextDecoder().decode(object.body),
					writeHttpMetadata(headers: Headers) {
						if (object.contentType) {
							headers.set('Content-Type', object.contentType);
						}
					},
				};
			}),
			delete: vi.fn(),
			list: vi.fn(),
			head: vi.fn(),
			createMultipartUpload: vi.fn(),
			resumeMultipartUpload: vi.fn(),
		} as unknown as R2Bucket,
	};
}

function createTestApp(envOverrides: Partial<Env> = {}) {
	const app = new Hono<{
		Bindings: Env;
		Variables: { adminAuth?: { adminId?: string } };
	}>();

	app.use('*', async (c, next) => {
		c.set('adminAuth', { adminId: 'admin-1' });
		await next();
	});

	app.post('/api/admin/jobs/users/import/upload-url', adminJobsImportUploadUrlHandler);
	app.put('/api/admin/jobs/users/import/upload/:upload_id', adminJobsImportUploadHandler);
	app.post('/api/admin/jobs/users/import', adminJobsUsersImportHandler);
	app.get('/api/admin/jobs/:id/result/download', adminJobResultDownloadHandler);

	const env = {
		...envOverrides,
	} as Env;

	return { app, env };
}

function buildHeaders(extra: Record<string, string> = {}): HeadersInit {
	return {
		'Content-Type': 'application/json',
		'X-Tenant-Id': 'tenant-a',
		...extra,
	};
}

function mockRandomUuid(value: string) {
	return vi
		.spyOn((globalThis as unknown as { crypto: Crypto }).crypto, 'randomUUID')
		.mockReturnValue(value);
}

describe('admin-jobs handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRandomUuid('job-123');
		mockAdapter.query.mockResolvedValue([]);
		mockAdapter.queryOne.mockResolvedValue(null);
		mockAdapter.execute.mockResolvedValue(undefined);
		mockAuditLog.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns a tenant-scoped upload URL for CSV imports', async () => {
		const { bucket } = createMockR2Bucket();
		const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });
		mockRandomUuid('upload-123');

		const res = await app.request(
			'/api/admin/jobs/users/import/upload-url',
			{
				method: 'POST',
				headers: buildHeaders(),
				body: JSON.stringify({
					filename: 'users.csv',
					content_type: 'text/csv',
					size_bytes: 128,
				}),
			},
			env
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			upload_url: string;
			file_key: string;
			upload_id: string;
		};
		expect(body.upload_id).toBe('upload-123');
		expect(body.file_key).toBe(buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv'));
		expect(body.upload_url).toContain('/api/admin/jobs/users/import/upload/upload-123');
	});

	it('stores uploaded CSV files in IMPORT_ARTIFACTS', async () => {
		const { bucket, store } = createMockR2Bucket();
		const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });

		const res = await app.request(
			'/api/admin/jobs/users/import/upload/upload-123?filename=users.csv',
			{
				method: 'PUT',
				headers: {
					'Content-Type': 'text/csv',
					'X-Tenant-Id': 'tenant-a',
				},
				body: 'email\nalice@example.com\n',
			},
			env
		);

		expect(res.status).toBe(201);
		expect(store.get(buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv'))).toBeTruthy();
	});

	it('creates a user import job only when the artifact belongs to the tenant', async () => {
		const uploadKey = buildUserImportUploadKey('tenant-a', 'upload-123', 'users.csv');
		const { bucket } = createMockR2Bucket({
			[uploadKey]: {
				body: new TextEncoder().encode('email\nalice@example.com\n'),
				contentType: 'text/csv',
			},
		});
		const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });

		const res = await app.request(
			'/api/admin/jobs/users/import',
			{
				method: 'POST',
				headers: buildHeaders(),
				body: JSON.stringify({
					file_key: uploadKey,
					options: {
						validate_only: true,
					},
				}),
			},
			env
		);

		expect(res.status).toBe(202);
		expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
		expect(mockAdapter.execute).toHaveBeenCalledWith(
			expect.stringContaining('INSERT INTO admin_jobs'),
			expect.arrayContaining([
				'job-123',
				'tenant-a',
				'users/import',
				uploadKey,
				buildUserImportResultKey('tenant-a', 'job-123'),
				'admin-1',
			])
		);
		expect(mockAuditLog).toHaveBeenCalledWith(
			expect.anything(),
			'job.created',
			'job',
			'job-123',
			expect.objectContaining({
				job_type: 'users/import',
				r2_key: uploadKey,
			})
		);
	});

	it('downloads full import results from IMPORT_ARTIFACTS', async () => {
		const resultBody = JSON.stringify({ summary: { total: 1, succeeded: 1, failed: 0 } });
		const resultKey = buildUserImportResultKey('tenant-a', 'job-123');
		const { bucket } = createMockR2Bucket({
			[resultKey]: {
				body: new TextEncoder().encode(resultBody),
				contentType: 'application/json',
			},
		});
		mockAdapter.queryOne.mockResolvedValue({
			id: 'job-123',
			tenant_id: 'tenant-a',
			job_type: 'users/import',
			result_r2_key: resultKey,
		});

		const { app, env } = createTestApp({ IMPORT_ARTIFACTS: bucket });
		const res = await app.request(
			'/api/admin/jobs/job-123/result/download',
			{
				method: 'GET',
				headers: {
					'X-Tenant-Id': 'tenant-a',
				},
			},
			env
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/json');
		expect(res.headers.get('Content-Disposition')).toContain('users-import-job-123.json');
		expect(await res.text()).toBe(resultBody);
	});
});
