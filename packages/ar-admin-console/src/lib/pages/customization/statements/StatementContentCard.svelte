<script lang="ts">
	import { isSupportedLocale, localeDir } from '#lib/i18n/locales.js';
	import type { ConsentLocalization, ConsentVersion } from '#lib/api/consent-statements.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Columns from '#lib/ui/patterns/Columns.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import StatementPreview from './StatementPreview.svelte';
	import StatementTextForm from './StatementTextForm.svelte';
	import {
		languageName,
		languageProblems,
		languageValue,
		sortedLanguages,
		versionLabel,
		type LanguageProblem,
		type StatementEditorValue
	} from './statement-model';

	/**
	 * What a version says, per language, with a preview beside it. The draft version is edited
	 * here (a title, a summary, and the text or a link to the document); a version already
	 * published is shown as it is and cannot be changed.
	 */
	interface Props {
		versions: readonly ConsentVersion[];
		/** The version shown. */
		viewId: string;
		onview: (id: string) => void;
		/** The texts of the shown version when it is not the draft; null while they load. */
		texts: readonly ConsentLocalization[] | null;
		/** The draft's content type and texts: edited when the draft is shown. */
		value: StatementEditorValue;
		/** The draft is shown and the admin may change it. */
		editable: boolean;
		/** Save was pressed: say what is missing. */
		attempted: boolean;
	}

	let {
		versions,
		viewId,
		onview,
		texts,
		value = $bindable(),
		editable,
		attempted
	}: Props = $props();

	let chosen = $state('');

	const viewed = $derived(versions.find((version) => version.id === viewId) ?? null);
	const languages = $derived(
		sortedLanguages(
			editable ? Object.keys(value.languages) : (texts ?? []).map((item) => item.language)
		)
	);
	const language = $derived(languages.includes(chosen) ? chosen : (languages[0] ?? ''));
	const contentType = $derived(editable ? value.contentType : (viewed?.content_type ?? 'inline'));
	const shownValue = $derived.by(() => {
		if (editable) return value.languages[language];
		const item = (texts ?? []).find((entry) => entry.language === language);
		return item ? languageValue(item) : undefined;
	});
	const problems = $derived.by((): LanguageProblem[] =>
		editable && attempted && value.languages[language]
			? languageProblems(value.languages[language], value.contentType)
			: []
	);
	const versionOptions = $derived(
		versions.map((version) => ({
			value: version.id,
			label: `${versionLabel(version.version)} · ${t(`cs.version.status.${version.status}` as MessageKey)}`
		}))
	);
	const dir = $derived(isSupportedLocale(language) ? localeDir(language) : undefined);
</script>

<Card title={t('cs.content.title')} description={t('cs.content.intro')}>
	{#if versions.length === 0}
		<Callout>{t('cs.content.noVersion')}</Callout>
	{:else}
		<div class="content">
			<div class="content__bar">
				<Select
					label={t('cs.content.version')}
					size="sm"
					options={versionOptions}
					value={viewId}
					onchange={onview}
				/>
				{#if languages.length > 0}
					<SegmentedControl
						label={t('cs.content.language')}
						size="sm"
						options={languages.map((code) => ({ value: code, label: languageName(code) }))}
						value={language}
						onchange={(code) => (chosen = code)}
					/>
				{/if}
			</div>

			{#if !editable && viewed && viewed.status !== 'draft'}
				<Callout>{t('cs.content.readOnly')}</Callout>
			{/if}

			{#if !editable && texts === null}
				<LoadingState label={t('common.loading')} />
			{:else if editable}
				<Columns columns={2} minWidth="320px">
					<StatementTextForm
						bind:value
						{language}
						onlanguage={(code) => (chosen = code)}
						{problems}
					/>
					<StatementPreview value={shownValue} {contentType} {dir} />
				</Columns>
			{:else}
				<StatementPreview value={shownValue} {contentType} {dir} />
			{/if}
		</div>
	{/if}
</Card>

<style>
	.content {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}

	.content__bar {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-related);
	}
</style>
