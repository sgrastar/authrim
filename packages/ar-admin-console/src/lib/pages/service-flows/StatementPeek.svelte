<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ConsentContentType, ConsentLocalization } from '#lib/api/consent-statements.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import { isSupportedLocale, localeDir } from '#lib/i18n/locales.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import StatementPreview from '#lib/pages/customization/statements/StatementPreview.svelte';
	import {
		languageName,
		languageValue,
		sortedLanguages
	} from '#lib/pages/customization/statements/statement-model.js';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * What a chosen statement's current version says, as the person asked reads it, in each of its
	 * languages (the admin's own first). Shown as it is: it is changed on the statement's page.
	 */
	interface Props {
		statementId: string;
		versionId: string;
		contentType: ConsentContentType;
	}

	let { statementId, versionId, contentType }: Props = $props();

	const { consentStatements: client } = useFlowResources();
	const controller = new AbortController();
	onDestroy(() => controller.abort());
	let texts = $state<ConsentLocalization[] | null>(null);
	let failed = $state(false);
	let chosen = $state('');

	async function load() {
		failed = false;
		texts = null;
		try {
			const list = await client.localizations(statementId, versionId, controller.signal);
			if (!controller.signal.aborted) texts = list;
		} catch {
			if (!controller.signal.aborted) failed = true;
		}
	}
	onMount(() => void load());

	const languages = $derived(sortedLanguages((texts ?? []).map((item) => item.language)));
	const language = $derived(
		languages.includes(chosen)
			? chosen
			: languages.includes(i18n.locale)
				? i18n.locale
				: (languages[0] ?? '')
	);
	const shown = $derived.by(() => {
		const item = (texts ?? []).find((entry) => entry.language === language);
		return item ? languageValue(item) : undefined;
	});
	const dir = $derived(isSupportedLocale(language) ? localeDir(language) : undefined);
</script>

<div class="peek">
	{#if failed}
		<Callout tone="warning">
			{t('af.consent.peek.failed')}
			<Button size="sm" onclick={load}>{t('common.retry')}</Button>
		</Callout>
	{:else if texts === null}
		<LoadingState label={t('common.loading')} />
	{:else}
		{#if languages.length > 1}
			<SegmentedControl
				label={t('cs.content.language')}
				size="sm"
				options={languages.map((code) => ({ value: code, label: languageName(code) }))}
				value={language}
				onchange={(code) => (chosen = code)}
			/>
		{/if}
		<StatementPreview value={shown} {contentType} {dir} />
	{/if}
</div>

<style>
	.peek {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
	}
</style>
