<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { createFakeOnboarding } from '#lib/api/fake/onboarding-fake.js';
	import { httpOnboarding } from '#lib/api/onboarding.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import 'driver.js/dist/driver.css';
	import './guide.css';
	import { CHECKLIST } from './checklist';
	import { guide } from './guide.svelte';
	import ConnectedGuideSteps from './ConnectedGuideSteps.svelte';
	import OnboardingChecklist from './OnboardingChecklist.svelte';
	import { onboardingProgress } from './progress.svelte';

	/**
	 * Storybook only: the checklist and the theme guide on stand-in pages, without a router or an
	 * API. The stand-ins carry the same hooks as the real pages (`data-guide`, the tabs), so the
	 * guide runs from the console's own definition.
	 */
	interface Props {
		/** Items already finished. */
		completed?: readonly string[];
		/** Start the theme guide at this step (0-based) instead of waiting on the checklist. */
		startAt?: number;
		/** A phone: the navigation is not drawn (it is in the drawer) and the menu button is. */
		phone?: boolean;
	}

	let { completed = [], startAt, phone = false }: Props = $props();

	const HOME = '/admin';
	const LIST = '/admin/customization/branding';
	const EDITOR = '/admin/customization/branding/new';
	const theme = CHECKLIST.filter((item) => item.id === 'theme');

	let path = $state(HOME);
	let tab = $state('layout');
	let chosen = $state(false);

	function go(next: string) {
		path = next;
		guide.refresh();
	}

	$effect(() =>
		untrack(() => {
			onboardingProgress.use(createFakeOnboarding(completed));
			void onboardingProgress.load();
			guide.useItems(theme);
			const disconnect = guide.connect({ pathname: () => path, goto: go, home: HOME });
			if (startAt !== undefined) {
				// Steps 0 (the header), 1-2 (the list) and the rest (the editor) are on three pages.
				path = startAt === 0 ? HOME : startAt <= 2 ? LIST : EDITOR;
				if (startAt >= 6) tab = 'images';
				guide.start('theme', startAt);
			}
			return disconnect;
		})
	);

	onDestroy(() => {
		guide.stop();
		guide.useItems(CHECKLIST);
		onboardingProgress.use(httpOnboarding);
	});

	const tabs = [
		{ id: 'layout', label: 'Layout' },
		{ id: 'look', label: 'Design' },
		{ id: 'images', label: 'Images' }
	];
</script>

<!-- Stand-ins for the console's header category and left navigation link. -->
{#if phone}
	<IconButton icon="list" label={t('app.menu')} data-guide="nav-menu" onclick={() => {}} />
{/if}
<nav class="subnav stand-in" aria-label="Navigation" style:display={phone ? 'none' : undefined}>
	<a
		data-guide="nav-customization"
		href={LIST}
		onclick={(event) => {
			event.preventDefault();
			go(LIST);
		}}>{t('nav.customization')}</a
	>
	{#if path !== HOME}
		<a
			class="subnav__item"
			href={LIST}
			onclick={(event) => {
				event.preventDefault();
				go(LIST);
			}}>{t('nav.custom.branding')}</a
		>
	{/if}
</nav>

<Page>
	{#if path === HOME}
		<PageHeader title={t('nav.overview')} />
		<OnboardingChecklist items={theme} activeItemId={guide.activeItemId} probes={{}} />
	{:else if path === LIST}
		<PageHeader title={t('nav.custom.branding')}>
			{#snippet actions()}
				<span class="guide-anchor" data-guide="theme-create">
					<Button variant="primary" icon="plus" onclick={() => go(EDITOR)}
						>{t('th.list.create')}</Button
					>
				</span>
			{/snippet}
		</PageHeader>
		<Card><p>…</p></Card>
	{:else}
		<PageHeader title={t('th.list.create')}>
			{#snippet actions()}
				<Button
					variant="secondary"
					data-guide="theme-apply"
					onclick={() => guide.signal('theme.applied')}>{t('th.action.apply')}</Button
				>
				<Button
					variant="primary"
					data-guide="theme-save"
					onclick={() => guide.signal('theme.saved')}>{t('th.page.save')}</Button
				>
			{/snippet}
		</PageHeader>
		<!-- Stand-in for the theme's name being typed. -->
		<form data-guide="theme-name" onsubmit={(event) => event.preventDefault()}>
			<input aria-label={t('th.page.name')} value="" />
		</form>
		<div class="editor">
			<Card><p class="preview">{chosen ? '🖼' : '…'}</p></Card>
			<div data-guide="theme-sections">
				<Tabs label={t('th.edit.label')} items={tabs} bind:value={tab}>
					{#snippet panel(id)}
						<Card>
							{#if id === 'images'}
								<IconButton
									icon="folder"
									size="sm"
									label={t('th.bg.browse')}
									data-guide="theme-bg-preset"
									onclick={() => {
										chosen = true;
										guide.signal('theme.preset-chosen');
									}}
								/>
							{:else}
								<p>…</p>
							{/if}
						</Card>
					{/snippet}
				</Tabs>
			</div>
		</div>
	{/if}
</Page>

<!-- The list of the running guide's steps, as the console's layout shows it. -->
<ConnectedGuideSteps />

<style>
	.stand-in {
		display: flex;
		gap: var(--space-field);
		padding: var(--space-related) var(--space-field);
	}

	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		gap: var(--space-columns);
		align-items: start;
	}

	.preview {
		min-height: 220px;
		margin: 0;
		font-size: var(--fs-page-title);
	}
</style>
