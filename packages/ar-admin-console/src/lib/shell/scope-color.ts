import type { AreaScope } from './nav-types';

/** Accent colour for the kind of subject an area manages. */
export function scopeColor(scope: AreaScope | undefined): string {
	return `var(--accent-${scope ?? 'tenant'})`;
}
