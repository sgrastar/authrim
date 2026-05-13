// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminJobsAPI, getJobStatusColor, getJobStatusDisplayName } from './admin-jobs';

describe('adminJobsAPI partial failure handling', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it('keeps partial_failure distinct when listing jobs', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: 'job-1',
							tenant_id: 'tenant-1',
							type: 'users/import',
							status: 'partial_failure',
							progress: {
								processed: 10,
								total: 10
							},
							result: {
								summary: {
									success_count: 9,
									failure_count: 1,
									skipped_count: 0
								},
								failures: [{ row: 2, message: 'Duplicate email' }],
								logs: []
							},
							created_by: 'admin',
							created_at: '2026-04-30T00:00:00.000Z'
						}
					],
					pagination: {
						has_more: false
					}
				}),
				{
					status: 200,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			)
		);

		vi.stubGlobal('fetch', fetchMock);

		const response = await adminJobsAPI.list({
			status: 'partial_failure'
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('filter=status%3Dpartial_failure');
		expect(response.data[0]?.status).toBe('partial_failure');
		expect(response.data[0]?.progress?.percentage).toBe(100);
		expect(response.data[0]?.result?.failures[0]?.error).toBe('Duplicate email');
	});

	it('exposes a dedicated label and color for partial_failure', () => {
		expect(getJobStatusDisplayName('partial_failure')).toBe('Partial Failure');
		expect(getJobStatusColor('partial_failure')).toBe('#f59e0b');
	});

	it('lists job type discovery metadata', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					result_delivery_options: [
						{ value: 'auto', description: 'Auto' },
						{ value: 'inline', description: 'Inline' },
						{ value: 'artifact', description: 'Artifact' }
					],
					job_types: [
						{
							job_type: 'reports/generate',
							processor_status: 'scheduled',
							creatable_from_admin_api: true,
							result_object_class: 'admin_job_result',
							supported_result_delivery: ['auto', 'inline', 'artifact'],
							create_endpoint: '/api/admin/jobs/reports/generate'
						}
					]
				}),
				{
					status: 200,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			)
		);

		vi.stubGlobal('fetch', fetchMock);

		const response = await adminJobsAPI.listTypes();

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/jobs/types'),
			expect.objectContaining({ method: 'GET' })
		);
		expect(response.result_delivery_options.map((option) => option.value)).toEqual([
			'auto',
			'inline',
			'artifact'
		]);
		expect(response.job_types[0]).toMatchObject({
			type: 'report_generation',
			supported_result_delivery: ['auto', 'inline', 'artifact']
		});
	});

	it('creates report jobs with top-level date range and result delivery', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					job_id: 'job-1',
					job_type: 'reports/generate',
					status: 'pending',
					created_by: 'admin',
					created_at: '2026-04-30T00:00:00.000Z'
				}),
				{
					status: 202,
					headers: {
						'Content-Type': 'application/json'
					}
				}
			)
		);

		vi.stubGlobal('fetch', fetchMock);

		const job = await adminJobsAPI.createReport({
			type: 'user_activity',
			from_date: '2026-01-01T00:00:00.000Z',
			to_date: '2026-01-31T00:00:00.000Z',
			format: 'csv',
			result_delivery: 'artifact'
		});

		expect(job.type).toBe('report_generation');
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/jobs/reports/generate'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					type: 'user_activity',
					from_date: '2026-01-01T00:00:00.000Z',
					to_date: '2026-01-31T00:00:00.000Z',
					format: 'csv',
					result_delivery: 'artifact'
				})
			})
		);
	});
});
