<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { adminSession } from '#lib/auth/session.svelte.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AppShell from '#lib/shell/AppShell.svelte';
	import EnvironmentBanner from '#lib/shell/EnvironmentBanner.svelte';
	import StepUpDialog from '#lib/shell/StepUpDialog.svelte';
	import { noticeInbox } from '#lib/shell/notice-inbox.js';
	import { isStandalonePath, resolveNavPath } from '#lib/shell/nav.js';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import type { ScopeOption } from '#lib/shell/ScopeSwitcher.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Page from '#lib/ui/templates/Page.svelte';

	let { children } = $props();

	// The pages built so far (every other address in the navigation shows a placeholder): the
	// left nav marks the rest as under construction.
	const builtPages = new Set(
		Object.keys(import.meta.glob('./**/+page.svelte'))
			.filter((file) => !file.includes('['))
			.map((file) => `/admin${file.slice(1).replace(/\/\+page\.svelte$/, '')}`)
	);

	let ready = $state(false);

	$effect(() => {
		let cancelled = false;
		(async () => {
			const state = await adminSession.check();
			if (cancelled) return;
			if (state === 'anonymous') {
				await goto('/admin/login', { replace: true });
				return;
			}
			if (state === 'authenticated') {
				const session = adminSession.current;
				if (session?.user_id) timePreference.loadFor(session.user_id);
				await tenantScope.load(session?.tenant_id ?? null, adminSession.isPlatformAdmin);
			}
			if (!cancelled) ready = true;
		})();
		return () => {
			cancelled = true;
		};
	});

	// The header's inbox: read when the console is ready, again for each tenant, then kept fresh.
	$effect(() => {
		if (!ready || adminSession.state !== 'authenticated') return;
		void tenantScope.tenantId;
		void noticeInbox.refresh({ reset: true });
	});
	$effect(() => {
		if (!ready || adminSession.state !== 'authenticated') return;
		return noticeInbox.start();
	});

	const environmentBanner = $derived(adminSession.current?.environment_banner ?? null);
	const standalone = $derived(isStandalonePath(page.url.pathname));
	const location = $derived(resolveNavPath(page.url.pathname) ?? resolveNavPath('/admin')!);

	const scopes = $derived<ScopeOption[]>([
		...(adminSession.isPlatformAdmin
			? [{ id: 'platform', kind: 'platform' as const, name: t('scope.platform.name'), mark: '◆' }]
			: []),
		...tenantScope.tenants.map((tenant) => ({
			id: tenant.id,
			kind: 'tenant' as const,
			name: tenant.name,
			mark: tenant.name.trim().charAt(0).toUpperCase() || '?'
		}))
	]);

	const currentScopeId = $derived(
		location.kind === 'platform' ? 'platform' : (tenantScope.tenantId ?? '')
	);

	async function selectScope(option: ScopeOption) {
		if (option.kind === 'platform') {
			await goto('/admin/platform');
			return;
		}
		tenantScope.select(option.id);
		if (location.kind === 'platform') await goto('/admin');
	}
</script>

{#snippet banner()}
	{#if environmentBanner}
		<EnvironmentBanner
			text={environmentBanner.text}
			textLocalizations={environmentBanner.text_localizations}
		/>
	{/if}
{/snippet}

{#if !ready}
	<LoadingState label={t('common.loading')} />
{:else if adminSession.state === 'forbidden'}
	<Page>
		<EmptyState icon="lock" title={t('login.error.forbidden')}>
			{#snippet action()}
				<Button icon="logout" onclick={() => adminSession.signOut()}>{t('account.signOut')}</Button>
			{/snippet}
		</EmptyState>
	</Page>
{:else}
	<AppShell
		{location}
		path={page.url.pathname}
		{scopes}
		{currentScopeId}
		onscope={selectScope}
		account={{
			name: adminSession.displayName,
			email: adminSession.current?.email,
			initials: adminSession.initials
		}}
		onsignout={() => adminSession.signOut()}
		built={(href) => builtPages.has(href)}
		{standalone}
		notifications={noticeInbox.notifications}
		ondismiss={(id) => noticeInbox.dismiss(id)}
		banner={environmentBanner ? banner : undefined}
	>
		{@render children()}
	</AppShell>
	<StepUpDialog />
{/if}
