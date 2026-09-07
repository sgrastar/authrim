import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('tenant detail lifecycle loading', () => {
	it('does not query tenant-routed lifecycle jobs before provisioning completes', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain("if (tenant?.lifecycle_state !== 'provisioning') {");
		expect(source.indexOf('await loadTenant();')).toBeLessThan(
			source.indexOf("if (tenant?.lifecycle_state !== 'provisioning') {")
		);
	});

	it('loads lifecycle jobs after tenant provisioning succeeds', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(source).toContain(
			"if (tenant?.lifecycle_state !== 'provisioning' && !lifecycleJobsLoaded) {"
		);
		expect(source).toContain('await loadLifecycleJobs();');
	});
});
