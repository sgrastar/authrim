<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		active: 'settings' | 'migration' | 'compliance' | 'fleet';
	}

	let { active }: Props = $props();

	const tabs = $derived([
		{
			id: 'settings',
			href: '/admin/directory-authentication',
			icon: 'i-ph-sliders-horizontal',
			label: $LL.admin_directory_authentication_tab_settings()
		},
		{
			id: 'migration',
			href: '/admin/directory-authentication/migration',
			icon: 'i-ph-arrows-clockwise',
			label: $LL.admin_directory_authentication_tab_migration()
		},
		{
			id: 'compliance',
			href: '/admin/directory-authentication/compliance',
			icon: 'i-ph-shield-check',
			label: $LL.admin_directory_authentication_tab_compliance()
		},
		{
			id: 'fleet',
			href: '/admin/directory-authentication/fleet',
			icon: 'i-ph-network',
			label: $LL.admin_directory_authentication_tab_fleet()
		}
	] as const);
</script>

<nav class="directory-auth-tabs" aria-label={$LL.admin_directory_authentication_tabs_aria()}>
	{#each tabs as tab (tab.id)}
		<a
			href={tab.href}
			class="directory-auth-tab"
			class:active={active === tab.id}
			aria-current={active === tab.id ? 'page' : undefined}
		>
			<i class={tab.icon} aria-hidden="true"></i>
			<span>{tab.label}</span>
		</a>
	{/each}
</nav>

<style>
	.directory-auth-tabs {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		margin: 0 0 1.5rem;
		border-bottom: 1px solid var(--color-border);
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}

	.directory-auth-tabs::-webkit-scrollbar {
		display: none;
	}

	.directory-auth-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		padding: 0 0.125rem;
		border-bottom: 2px solid transparent;
		color: var(--color-text-muted);
		font-size: 0.875rem;
		font-weight: 650;
		text-decoration: none;
		white-space: nowrap;
		transition:
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.directory-auth-tab i {
		font-size: 1rem;
	}

	.directory-auth-tab:hover,
	.directory-auth-tab.active {
		color: var(--color-text);
	}

	.directory-auth-tab.active {
		border-bottom-color: var(--color-accent);
	}

	.directory-auth-tab:focus-visible {
		outline: 2px solid var(--color-focus, var(--color-accent));
		outline-offset: 3px;
	}

	@media (max-width: 720px) {
		.directory-auth-tabs {
			gap: 1rem;
			-webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent);
			mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent);
		}
	}
</style>
