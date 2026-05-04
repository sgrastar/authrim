import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminOperationalLogsAPI } from './admin-operational-logs'

describe('adminOperationalLogsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('builds filter query params for operational log list', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ items: [], total: 0 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminOperationalLogsAPI.list({
			subjectType: 'user',
			subjectId: 'user-1',
			action: 'user.suspend.reason',
			actorId: 'admin-1',
			limit: 25
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(
				'/api/admin/operational-logs?subject_type=user&subject_id=user-1&action=user.suspend.reason&actor_id=admin-1&limit=25'
			),
			expect.any(Object)
		)
	})
})
