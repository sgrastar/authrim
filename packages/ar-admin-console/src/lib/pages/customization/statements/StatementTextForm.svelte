<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import StatementLanguageAdd from './StatementLanguageAdd.svelte';
	import { STATEMENT_HTML_TAGS } from './statement-html';
	import {
		LIMITS,
		emptyLanguage,
		languageName,
		type LanguageProblem,
		type StatementEditorValue
	} from './statement-model';

	/**
	 * The text of a version being written, one language at a time: whether it is written here or
	 * kept at a link, and the title, summary and text (or link) of the language shown. Languages
	 * are added and removed here; which one is shown is the caller's (its language switcher).
	 * Used by the statement page's content card and by a statement made from a service flow.
	 */
	interface Props {
		value: Pick<StatementEditorValue, 'contentType' | 'languages'>;
		/** The language shown. */
		language: string;
		/** A language was added (shown next) or removed (`''`: the first one is shown). */
		onlanguage: (code: string) => void;
		/** What to point out in the language shown. */
		problems?: readonly LanguageProblem[];
		/** The body's height in rows (a narrow panel shows fewer). */
		bodyRows?: number;
		/** Languages are added here (default), or by the caller elsewhere (`StatementLanguageAdd`). */
		addLanguage?: boolean;
	}

	let {
		value = $bindable(),
		language,
		onlanguage,
		problems = [],
		bodyRows = 10,
		addLanguage = true
	}: Props = $props();
	const typeOptions = $derived([
		{ value: 'inline', label: t('cs.content.typeInline') },
		{ value: 'url', label: t('cs.content.typeUrl') }
	]);

	function add(code: string) {
		value.languages[code] = emptyLanguage();
		onlanguage(code);
	}

	function removeLanguage() {
		delete value.languages[language];
		onlanguage('');
	}

	const problem = (field: LanguageProblem) =>
		problems.includes(field) ? t(`cs.error.field.${field}` as MessageKey) : undefined;
</script>

<div class="text-form">
	<RadioGroup
		label={t('cs.content.type')}
		orientation="horizontal"
		options={typeOptions}
		field="contentType"
		bind:value={value.contentType}
	/>
	{#if value.languages[language]}
		<TextField
			label={t('cs.content.name')}
			maxlength={LIMITS.title}
			field={`languages.${language}.title`}
			error={problem('title')}
			bind:value={value.languages[language].title}
		/>
		<TextArea
			label={t('cs.content.summary')}
			hint={t('cs.content.summaryHint', { tags: STATEMENT_HTML_TAGS.join(', ') })}
			rows={3}
			maxlength={LIMITS.description}
			field={`languages.${language}.description`}
			error={problem('description')}
			bind:value={value.languages[language].description}
		/>
		{#if value.contentType === 'url'}
			<TextField
				label={t('cs.content.url')}
				hint={t('cs.content.urlHint')}
				type="url"
				maxlength={LIMITS.url}
				field={`languages.${language}.url`}
				error={problem('url')}
				bind:value={value.languages[language].url}
			/>
		{:else}
			<TextArea
				label={t('cs.content.body')}
				rows={bodyRows}
				maxlength={LIMITS.content}
				field={`languages.${language}.content`}
				error={problem('content')}
				bind:value={value.languages[language].content}
			/>
		{/if}
		<div>
			<Button size="sm" variant="ghost" icon="trash" onclick={removeLanguage}>
				{t('cs.content.removeLanguage', { language: languageName(language) })}
			</Button>
		</div>
	{:else}
		<Callout>{t('cs.content.noLanguage')}</Callout>
	{/if}
	{#if addLanguage}
		<StatementLanguageAdd present={Object.keys(value.languages)} onadd={add} />
	{/if}
</div>

<style>
	.text-form {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}
</style>
