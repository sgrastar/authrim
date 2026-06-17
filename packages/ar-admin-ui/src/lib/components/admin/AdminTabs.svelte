<script lang="ts" module>
	export interface AdminTabItem {
		id: string;
		label: string;
		icon?: string;
		panelId?: string;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		items: ReadonlyArray<AdminTabItem>;
		active: string;
		onChange: (id: string) => void;
		ariaLabel?: string;
	}

	let { items, active, onChange, ariaLabel }: Props = $props();
</script>

<div class="admin-tabs" role="tablist" aria-label={ariaLabel ?? $LL.admin_tabs_page_sections()}>
	{#each items as item (item.id)}
		<button
			type="button"
			role="tab"
			aria-selected={active === item.id}
			aria-disabled={item.disabled}
			aria-controls={item.panelId}
			data-state={active === item.id ? 'active' : undefined}
			class="admin-tabs__tab"
			disabled={item.disabled}
			onclick={() => onChange(item.id)}
		>
			{#if item.icon}
				<i class={item.icon} aria-hidden="true"></i>
			{/if}
			<span>{item.label}</span>
		</button>
	{/each}
</div>

<style>
	.admin-tabs {
		display: flex;
		flex-wrap: nowrap;
		gap: var(--tabs-gap, 8px);
		width: var(--tabs-width, 100%);
		padding: var(--tabs-padding, 6px);
		margin-bottom: var(--tabs-margin-bottom, 22px);
		max-width: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		border: var(--tabs-border, 1px solid var(--color-border));
		border-bottom: var(--tabs-border-bottom, var(--tabs-border, 1px solid var(--color-border)));
		border-radius: var(--tabs-radius, var(--radius-panel, var(--radius-md)));
		background: var(--tabs-bg, var(--color-surface-raised, var(--color-surface)));
		box-shadow: var(--tabs-shadow, var(--shadow-sm));
	}

	.admin-tabs::-webkit-scrollbar {
		display: none;
	}

	.admin-tabs__tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: var(--tabs-tab-height, 38px);
		padding: var(--tabs-tab-padding, 8px 14px);
		border: 1px solid var(--tabs-tab-border, var(--color-border));
		border-radius: var(--tabs-tab-radius, var(--radius-control, var(--radius-sm)));
		background: var(--tabs-tab-bg, var(--color-surface));
		color: var(--tabs-tab-color, var(--color-text-muted));
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--tabs-tab-size, 0.85rem);
		font-weight: var(--tabs-tab-weight, 650);
		letter-spacing: var(--tabs-tab-letter-spacing, 0);
		white-space: nowrap;
		position: relative;
		flex: none;
		cursor: pointer;
		transition:
			background-color var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast),
			box-shadow var(--transition-fast),
			transform var(--transition-fast);
	}

	.admin-tabs__tab:hover {
		color: var(--tabs-tab-hover-color, var(--color-text));
		border-color: var(--tabs-tab-hover-border, var(--color-accent));
		background: var(--tabs-tab-hover-bg, var(--color-surface-raised));
	}

	.admin-tabs__tab:disabled {
		cursor: not-allowed;
		opacity: var(--tabs-tab-disabled-opacity, 0.45);
	}

	.admin-tabs__tab:disabled:hover {
		color: var(--tabs-tab-color, var(--color-text-muted));
		border-color: var(--tabs-tab-border, var(--color-border));
		background: var(--tabs-tab-bg, var(--color-surface));
	}

	.admin-tabs__tab[data-state='active'] {
		color: var(--tabs-tab-active-color, var(--color-accent));
		border-color: var(--tabs-tab-active-border, var(--color-accent));
		background: var(--tabs-tab-active-bg, color-mix(in srgb, var(--color-accent) 14%, transparent));
		box-shadow: var(--tabs-tab-active-shadow, none);
	}

	.admin-tabs__tab[data-state='active']::after {
		content: '';
		display: var(--tabs-tab-active-marker-display, none);
		position: absolute;
		left: var(--tabs-tab-active-marker-left, 18px);
		bottom: var(--tabs-tab-active-marker-bottom, -5px);
		width: var(--tabs-tab-active-marker-width, var(--tabs-tab-active-marker-size, 8px));
		height: var(--tabs-tab-active-marker-height, var(--tabs-tab-active-marker-size, 8px));
		background: var(--tabs-tab-active-marker-bg, var(--color-accent));
		transform: var(--tabs-tab-active-marker-transform, rotate(45deg));
	}

	@media (max-width: 720px) {
		.admin-tabs {
			scroll-padding-inline: 12px;
			-webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent);
			mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent);
		}

		.admin-tabs__tab[data-state='active']::after {
			display: none;
		}
	}

	.admin-tabs__tab:focus-visible {
		outline: 2px solid var(--color-focus, var(--color-accent));
		outline-offset: 3px;
	}
</style>
