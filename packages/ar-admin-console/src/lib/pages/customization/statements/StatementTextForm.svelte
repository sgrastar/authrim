<script lang="ts">
	import { SUPPORTED_LOCALES } from '#lib/i18n/locales.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
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
	}

	let { value = $bindable(), language, onlanguage, problems = [], bodyRows = 10 }: Props = $props();

	let adding = $state('');

	const addable = $derived(
		SUPPORTED_LOCALES.filter((code) => !(code in value.languages)).map((code) => ({
			value: code,
			label: languageName(code)
		}))
	);
	const typeOptions = $derived([
		{ value: 'inline', label: t('cs.content.typeInline') },
		{ value: 'url', label: t('cs.content.typeUrl') }
	]);

	function add() {
		if (!adding) return;
		value.languages[adding] = emptyLanguage();
		onlanguage(adding);
		adding = '';
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
			hint={t('cs.content.summaryHint')}
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
	{#if addable.length > 0}
		<div class="text-form__add">
			<Select
				label={t('cs.content.addLanguage')}
				size="sm"
				placeholder={t('cs.content.choose')}
				options={addable}
				bind:value={adding}
			/>
			<Button size="sm" icon="plus" disabled={!adding} onclick={add}>
				{t('cs.content.add')}
			</Button>
		</div>
	{/if}
</div>

<style>
	.text-form {
		display: grid;
		gap: var(--space-related);
		min-inline-size: 0;
	}

	.text-form__add {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-related);
	}
</style>
