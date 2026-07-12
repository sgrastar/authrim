<script lang="ts" module>
	export interface AdminBreadcrumbItem {
		label: string;
		href?: string;
		icon?: string;
	}
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		items?: AdminBreadcrumbItem[];
	}

	let { items = [] }: Props = $props();

	const visibleItems = $derived(items.filter((item) => item.label.trim().length > 0));
</script>

{#if visibleItems.length > 0}
	<nav class="admin-breadcrumbs" aria-label={$LL.admin_header_breadcrumb()}>
		<ol class="admin-breadcrumbs__list">
			{#each visibleItems as item, index (item.href ?? `${index}-${item.label}`)}
				{@const isCurrent = index === visibleItems.length - 1}
				<li class="admin-breadcrumbs__item">
					{#if item.href && !isCurrent}
						<a class="admin-breadcrumbs__link" href={item.href}>
							{#if item.icon}
								<i class={item.icon} aria-hidden="true"></i>
							{/if}
							<span>{item.label}</span>
						</a>
					{:else}
						<span class="admin-breadcrumbs__current" aria-current="page">
							{#if item.icon}
								<i class={item.icon} aria-hidden="true"></i>
							{/if}
							<span>{item.label}</span>
						</span>
					{/if}
				</li>
			{/each}
		</ol>
	</nav>
{/if}

<style>
	.admin-breadcrumbs {
		min-width: 0;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--breadcrumb-font-size, 0.78rem);
	}

	.admin-breadcrumbs__list {
		display: flex;
		align-items: center;
		gap: var(--breadcrumb-gap, 8px);
		min-width: 0;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.admin-breadcrumbs__item {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.admin-breadcrumbs__item:not(:last-child)::after {
		content: var(--breadcrumb-separator, '/');
		margin-left: var(--breadcrumb-gap, 8px);
		color: var(--color-border-strong);
	}

	.admin-breadcrumbs__link,
	.admin-breadcrumbs__current {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: min(32vw, 280px);
		color: inherit;
		text-decoration: none;
	}

	.admin-breadcrumbs__link:hover {
		color: var(--color-accent);
	}

	.admin-breadcrumbs__current {
		color: var(--color-text);
		font-weight: 700;
	}

	.admin-breadcrumbs :global(i) {
		width: 1em;
		height: 1em;
		flex: none;
	}

	.admin-breadcrumbs span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 640px) {
		.admin-breadcrumbs__link,
		.admin-breadcrumbs__current {
			max-width: 44vw;
		}

		.admin-breadcrumbs__item:not(:last-child):not(:first-child) {
			display: none;
		}
	}
</style>
