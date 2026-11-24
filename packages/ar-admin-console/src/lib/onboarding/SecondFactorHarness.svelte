<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { createFakeOnboarding } from '#lib/api/fake/onboarding-fake.js';
	import { httpOnboarding } from '#lib/api/onboarding.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import 'driver.js/dist/driver.css';
	import './guide.css';
	import { CHECKLIST } from './checklist';
	import { guide } from './guide.svelte';
	import ConnectedGuideSteps from './ConnectedGuideSteps.svelte';
	import OnboardingChecklist from './OnboardingChecklist.svelte';
	import { onboardingProgress } from './progress.svelte';
	import { setGuideFact } from './signals';

	/**
	 * Storybook only: the second-factor guide on stand-in pages, without a router or an API. The
	 * stand-ins carry the hooks of the real ones (the account menu, personal settings, the security
	 * keys card and its add buttons), so the guide runs from the console's own definition.
	 */
	interface Props {
		/** An authenticator app can be registered in this environment (the page reports it). */
		totp?: boolean;
		/** Nothing can be registered now (the first-enrollment window is over): no add buttons. */
		blocked?: boolean;
	}

	let { totp = false, blocked = false }: Props = $props();

	const HOME = '/admin';
	const SETTINGS = '/admin/me';
	const secondFactor = CHECKLIST.filter((item) => item.id === 'second-factor');

	let path = $state(HOME);
	let menuOpen = $state(false);

	function go(next: string) {
		path = next;
		menuOpen = false;
		guide.refresh();
	}

	$effect(() =>
		untrack(() => {
			onboardingProgress.use(createFakeOnboarding([]));
			void onboardingProgress.load();
			guide.useItems(secondFactor);
			return guide.connect({ pathname: () => path, goto: go, home: HOME });
		})
	);

	// The security keys panel's report, as the real one makes it when its state has loaded.
	$effect(() => {
		if (path === SETTINGS) {
			setGuideFact('second-factor.blocked', blocked);
			setGuideFact('second-factor.totp', totp && !blocked);
		}
		return () => {
			setGuideFact('second-factor.blocked', false);
			setGuideFact('second-factor.totp', false);
		};
	});

	onDestroy(() => {
		guide.stop();
		guide.useItems(CHECKLIST);
		onboardingProgress.use(httpOnboarding);
	});
</script>

<!-- Stand-in for the header's account menu: an avatar that opens a list with personal settings. -->
<div class="header stand-in">
	<button
		type="button"
		class="avatar"
		aria-label={t('account.menu')}
		aria-expanded={menuOpen}
		data-guide="account-menu"
		onclick={() => (menuOpen = !menuOpen)}>AB</button
	>
	{#if menuOpen}
		<div class="menu">
			<a
				href={SETTINGS}
				data-guide="account-settings"
				onclick={(event) => {
					event.preventDefault();
					go(SETTINGS);
				}}>{t('account.settings')}</a
			>
		</div>
	{/if}
</div>

<Page>
	{#if path === HOME}
		<PageHeader title={t('nav.overview')} />
		<OnboardingChecklist items={secondFactor} activeItemId={guide.activeItemId} probes={{}} />
	{:else}
		<PageHeader title={t('account.settings')} />
		<div data-guide="second-factors">
			<Card title={t('sk.title')}>
				{#snippet actions()}
					{#if !blocked}
						<span class="guide-anchor" data-guide="second-factor-add">
							<Button size="sm" icon="plus" onclick={() => guide.signal('second-factor.added')}
								>{t('sk.add')}</Button
							>
							{#if totp}
								<Button size="sm" icon="plus" onclick={() => guide.signal('second-factor.added')}
									>{t('sk.addTotp')}</Button
								>
							{/if}
						</span>
					{/if}
				{/snippet}
				<p>…</p>
			</Card>
		</div>
	{/if}
</Page>

<!-- The list of the running guide's steps, as the console's layout shows it. -->
<ConnectedGuideSteps />

<style>
	.stand-in {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-field);
		padding: var(--space-related) var(--space-field);
	}

	.avatar {
		width: 30px;
		height: 30px;
		border: 0;
		border-radius: 50%;
		background: var(--accent-platform);
		color: var(--on-accent);
		font-size: var(--fs-caption);
		font-weight: var(--fw-bold);
	}

	.menu {
		position: absolute;
		inset-block-start: 44px;
		inset-inline-end: var(--space-field);
		padding: var(--space-related);
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
	}
</style>
