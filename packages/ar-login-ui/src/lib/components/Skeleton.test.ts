import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Skeleton from './Skeleton.svelte';

describe('Skeleton', () => {
	it('renders as an assistive-technology-hidden placeholder with configurable dimensions', () => {
		const body = render(Skeleton, {
			props: { width: '60%', height: '2rem', radius: '1rem' }
		}).body;

		expect(body).toContain('aria-hidden="true"');
		expect(body).toContain('--skeleton-width: 60%');
		expect(body).toContain('--skeleton-height: 2rem');
		expect(body).toContain('--skeleton-radius: 1rem');
	});

	it('uses theme tokens and disables animation when reduced motion is requested', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./Skeleton.svelte', import.meta.url)),
			'utf8'
		);

		expect(source).toContain('var(--text-primary)');
		expect(source).toContain('var(--bg-card)');
		expect(source).toContain('@media (prefers-reduced-motion: no-preference)');
	});
});
