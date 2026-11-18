<script lang="ts">
	import { untrack } from 'svelte';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import OnboardingChecklist from '#lib/onboarding/OnboardingChecklist.svelte';
	import { onboardingProgress } from '#lib/onboarding/progress.svelte.js';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Page from '#lib/ui/templates/Page.svelte';

	// The progress is per tenant: read again when another tenant is selected.
	$effect(() => {
		if (!tenantScope.tenantId) return;
		untrack(() => void onboardingProgress.load());
	});
</script>

<svelte:head>
	<title>{t('nav.overview')} — {t('app.brand')}</title>
</svelte:head>

<Page>
	<PageHeader title={t('nav.overview')} />
	{#if tenantScope.tenantId}
		<OnboardingChecklist />
	{/if}
</Page>
