<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import Page from '$lib/ui/templates/Page.svelte';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head
	><title>{t(notFound ? 'error.notFound.title' : 'error.generic.title')}</title></svelte:head
>

<Page>
	<EmptyState
		icon={notFound ? 'map' : 'warning'}
		title={t(notFound ? 'error.notFound.title' : 'error.generic.title')}
		description={notFound ? t('error.notFound.body') : page.error?.message}
	>
		{#snippet action()}
			<Button href="/admin" icon="arrowBack">{t('error.backHome')}</Button>
		{/snippet}
	</EmptyState>
</Page>
