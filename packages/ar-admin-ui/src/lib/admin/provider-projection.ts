import type { ProviderProjectionJob } from '$lib/api/admin-plugins';

export function shouldShowProviderProjectionStatus(jobs: ProviderProjectionJob[]): boolean {
	return jobs.some((job) => ['pending', 'processing', 'failed'].includes(job.status));
}
