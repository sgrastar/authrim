<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ScreenListItem } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ConsentStatementsField from './ConsentStatementsField.svelte';
	import type { AccountFlowState } from './flow-spec';
	import { screenHasConsentWidget, sharedStatementIds } from './consent-field-model';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * The consent a sign-up screen that has a consent box (a consent widget) asks on the screen
	 * itself, together with its own button. The statements are kept on that screen's own step (not
	 * in a consent step of the flow), so they are asked, agreed to and recorded in the same submit,
	 * and shown to whom the screen is shown. Only for a screen with the box: choosing one without
	 * drops what was chosen here.
	 */
	interface Props {
		form: AccountFlowState;
		/** The key of the screen chosen in this step. */
		screenKey: string;
		/** Where this screen step keeps its statements among the flow's values. */
		statementsKey: string;
	}

	let { form = $bindable(), screenKey, statementsKey }: Props = $props();

	const { screens: client } = useFlowResources();
	let screens = $state<ScreenListItem[]>([]);
	let failed = $state(false);
	let gone = false;
	onDestroy(() => (gone = true));
	async function load() {
		failed = false;
		try {
			const list = await client.list();
			if (!gone) screens = list.screens;
		} catch {
			if (!gone) failed = true;
		}
	}
	onMount(() => void load());

	const chosen = $derived(screens.find((screen) => screen.screen_key === screenKey));
	const shown = $derived(chosen !== undefined && screenHasConsentWidget(chosen.fields));
	const value = $derived(list(statementsKey));

	/** A screen with no consent box asks nothing: what was chosen for another screen is dropped. */
	$effect(() => {
		if (chosen !== undefined && !shown && statementsKey in form.values) {
			delete form.values[statementsKey];
		}
	});

	/** The statements the flow's own consent steps ask too (a person would be asked twice). */
	const twice = $derived(
		form.added.some((id) => id.startsWith('consent:')) &&
			form.added
				.filter((id) => id.startsWith('consent:'))
				.some((id) => {
					const n = id.slice('consent:'.length);
					return sharedStatementIds(value, form.values[`reg.statements:${n}`]).length > 0;
				})
	);

	function list(key: string): string[] {
		const entry = form.values[key];
		return Array.isArray(entry) ? entry : [];
	}
</script>

{#if failed}
	<Callout tone="warning">
		{t('af.screen.loadFailed')}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else if shown}
	<section class="consent" aria-labelledby="screen-consent-title">
		<h3 class="consent__title" id="screen-consent-title">{t('af.screenConsent.title')}</h3>
		<p class="consent__lead">{t('af.screenConsent.lead')}</p>
		<ConsentStatementsField
			label={t('af.field.reg.statements')}
			{value}
			onchange={(next) => {
				if (next.length > 0) form.values[statementsKey] = next;
				else delete form.values[statementsKey];
			}}
		/>
		{#if twice}
			<Callout tone="warning">{t('af.screenConsent.twice')}</Callout>
		{/if}
	</section>
{/if}

<style>
	.consent {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
	}

	.consent__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.consent__lead {
		margin: 0;
		color: var(--text-secondary);
	}
</style>
