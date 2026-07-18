<script lang="ts">
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';

	const items = $derived([
		{ href: '/admin/agent-access', label: $LL.admin_agent_access_tab_overview() },
		{ href: '/admin/agent-access/grants', label: $LL.admin_agent_access_tab_grants() },
		{ href: '/admin/agent-access/task-sets', label: $LL.admin_agent_access_tab_task_sets() },
		{
			href: '/admin/agent-access/scope-policies',
			label: $LL.admin_agent_access_tab_scope_policies()
		},
		{ href: '/admin/agent-access/plans', label: $LL.admin_agent_access_tab_plans() },
		{ href: '/admin/agent-access/bulk-plans', label: $LL.admin_agent_access_tab_bulk_plans() },
		{ href: '/admin/agent-access/baselines', label: $LL.admin_agent_access_tab_baselines() },
		{ href: '/admin/agent-access/templates', label: $LL.admin_agent_access_tab_templates() },
		{ href: '/admin/agent-access/secret-refs', label: $LL.admin_agent_access_tab_secrets() },
		{ href: '/admin/agent-access/settings', label: $LL.admin_agent_access_tab_settings() }
	]);

	function active(href: string): boolean {
		return href === '/admin/agent-access'
			? $page.url.pathname === href
			: $page.url.pathname.startsWith(href);
	}
</script>

<nav class="agent-access-nav" aria-label={$LL.admin_agent_access_title()}>
	{#each items as item (item.href)}
		<a href={item.href} aria-current={active(item.href) ? 'page' : undefined}>
			{item.label}
		</a>
	{/each}
</nav>

<style>
	.agent-access-nav {
		display: flex;
		gap: 6px;
		margin: -8px 0 24px;
		padding-bottom: 10px;
		overflow-x: auto;
		border-bottom: 1px solid var(--color-border);
	}

	a {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: 7px 12px;
		border-radius: var(--radius-control, var(--radius-sm));
		color: var(--color-text-muted);
		font-size: 0.84rem;
		font-weight: 650;
		text-decoration: none;
		white-space: nowrap;
	}

	a:hover {
		color: var(--color-text);
		background: var(--color-surface-raised);
	}

	a[aria-current='page'] {
		color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
	}
</style>
