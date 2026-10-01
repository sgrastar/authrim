<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { adminSession } from '$lib/auth/session.svelte';
	import { tenantScope } from '$lib/auth/tenant-scope.svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import AppShell from '$lib/shell/AppShell.svelte';
	import { isStandalonePath, resolveNavPath } from '$lib/shell/nav';
	import { timePreference } from '$lib/ui/time/time-preference.svelte';
	import type { ScopeOption } from '$lib/shell/ScopeSwitcher.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '$lib/ui/patterns/LoadingState.svelte';
	import Page from '$lib/ui/templates/Page.svelte';

	let { children } = $props();

	let ready = $state(false);

	$effect(() => {
		let cancelled = false;
		(async () => {
			const state = await adminSession.check();
			if (cancelled) return;
			if (state === 'anonymous') {
				await goto('/admin/login', { replaceState: true });
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
		{scopes}
		{currentScopeId}
		onscope={selectScope}
		account={{
			name: adminSession.displayName,
			email: adminSession.current?.email,
			initials: adminSession.initials
		}}
		onsignout={() => adminSession.signOut()}
		{standalone}
	>
		{@render children()}
	</AppShell>
{/if}
