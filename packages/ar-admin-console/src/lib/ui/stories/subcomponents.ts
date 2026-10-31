import type { Component } from 'svelte';

/**
 * addon-svelte-csf types `subcomponents` with the main component's props, so parts with props
 * of their own do not type-check. Docs read each subcomponent's own props for its tab in the
 * props table; this only widens the type.
 */
export const subcomponents = (components: Record<string, Component<never>>) =>
	components as Record<string, never>;

/**
 * Names the main component's tab in a props table that has subcomponents. The dev server wraps
 * components for hot reload, so their own name reads "wrapper".
 */
export function named<T extends Component<never>>(component: T, name: string): T {
	const target = component as T & { __docgenInfo?: Record<string, unknown> };
	target.__docgenInfo = { ...target.__docgenInfo, displayName: name };
	return component;
}
