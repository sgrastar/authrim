<script lang="ts">
	import { untrack } from 'svelte';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import OnboardingChecklist from '#lib/onboarding/OnboardingChecklist.svelte';
	import { onboardingProgress } from '#lib/onboarding/progress.svelte.js';
	import ColumnSpan from '#lib/ui/patterns/ColumnSpan.svelte';
	import Columns from '#lib/ui/patterns/Columns.svelte';
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
	<!-- The checklist's card is what the page opens with, so the heading is not drawn. -->
	<PageHeader title={t('nav.overview')} hidden />
	<!-- The page is a dashboard: a grid of blocks that takes as many columns as the room allows.
	     A block that needs the whole row (the checklist) is wrapped in ColumnSpan; any other goes
	     into the grid as it is. -->
	<Columns columns={3} minWidth="min(320px, 100%)" align="stretch">
		{#if tenantScope.tenantId}
			<ColumnSpan>
				<OnboardingChecklist />
			</ColumnSpan>
		{/if}
	</Columns>
</Page>
