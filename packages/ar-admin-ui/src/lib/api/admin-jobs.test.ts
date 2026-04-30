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
});
