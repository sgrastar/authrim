<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { i18n, t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import { isSupportedLocale, localeDir } from '#lib/i18n/locales.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import StatementPreview from '#lib/pages/customization/statements/StatementPreview.svelte';
	import StatementTextForm from '#lib/pages/customization/statements/StatementTextForm.svelte';
	import {
		apiDetail,
		statementErrorKey
	} from '#lib/pages/customization/statements/statement-errors.js';
	import {
		CATEGORY_KINDS,
		LIMITS,
		SLUG_PATTERN,
		categoryOfKind,
		emptyLanguage,
		languageName,
		languageProblems,
		localizationInput,
		sortedLanguages,
		todayVersion,
		type CategoryKind,
		type StatementEditorValue
	} from '#lib/pages/customization/statements/statement-model.js';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * Makes a consent statement from a service flow, as a sign-in method profile is made there: its
	 * key, its kind and its text in every language it is written in. It is published straight away
	 * (its first version: nobody has agreed to it yet) and chosen, so it is a statement like any
	 * other, shared with every flow. Its other settings, and later versions, are on its own page.
	 */
	interface Props {
		/** It was made and published: its id. */
		oncreated: (id: string) => void;
		oncancel: () => void;
	}

	let { oncreated, oncancel }: Props = $props();

	const STATEMENTS = '/admin/customization/statements';
	const { consentStatements: client } = useFlowResources();
	let gone = false;
	onDestroy(() => (gone = true));

	let slug = $state('');
	let kind = $state<CategoryKind>('terms');
	let value = $state<Pick<StatementEditorValue, 'contentType' | 'languages'>>({
		contentType: 'inline',
		languages: { [i18n.locale]: emptyLanguage() }
	});
	let chosen = $state('');
	let attempted = $state(false);
	let busy = $state(false);
	let error = $state('');
	/** Made but not published: finished on its page. */
	let unfinished = $state('');
	let form = $state<HTMLElement>();

	const languages = $derived(sortedLanguages(Object.keys(value.languages)));
	const language = $derived(languages.includes(chosen) ? chosen : (languages[0] ?? ''));
	const kinds = $derived(
		CATEGORY_KINDS.map((option) => ({ value: option, label: t(`cs.kind.${option}` as MessageKey) }))
	);
	const slugProblem = $derived<MessageKey | null>(
		!slug.trim()
			? 'cs.error.field.slug'
			: !SLUG_PATTERN.test(slug.trim()) || slug.trim().length > LIMITS.slug
				? 'cs.error.field.slugFormat'
				: null
	);
	/** What stops each language being published (the text or link is needed). */
	const problemsOf = (code: string) =>
		value.languages[code] ? languageProblems(value.languages[code], value.contentType, true) : [];
	const dir = $derived(isSupportedLocale(language) ? localeDir(language) : undefined);

	async function create() {
		if (busy) return;
		attempted = true;
		error = '';
		const incomplete = languages.find((code) => problemsOf(code).length > 0);
		if (slugProblem || languages.length === 0 || incomplete) {
			// Show the language that needs something, so its fields say what.
			if (incomplete) chosen = incomplete;
			error = languages.length === 0 ? t('af.consent.new.noLanguage') : t('cs.error.fix');
			await tick();
			form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
			return;
		}
		// What was checked is what is saved: the form is held still while it is (the fieldset), and
		// read once here.
		const input = {
			slug: slug.trim(),
			category: categoryOfKind(kind),
			contentType: value.contentType,
			texts: languages.map((code) => ({
				code,
				text: localizationInput($state.snapshot(value.languages[code]), value.contentType)
			}))
		};
		busy = true;
		let id = '';
		try {
			id = (await client.create({ slug: input.slug, category: input.category })).id;
		} catch (failure) {
			if (!gone) error = t(statementErrorKey(failure, 'create')) + apiDetail(failure);
			busy = false;
			return;
		}
		try {
			const version = await client.createVersion(id, {
				version: todayVersion(),
				content_type: input.contentType,
				effective_at: Date.now()
			});
			for (const { code, text } of input.texts) {
				await client.saveLocalization(id, version.id, code, text);
			}
			// Its first version: nobody has agreed to an earlier one, so nobody is asked again.
			await client.activateVersion(id, version.id, { reconsent: false });
		} catch (failure) {
			// The statement exists but is not published, so it cannot be chosen yet.
			if (!gone) {
				unfinished = id;
				error = t('af.consent.new.unpublished') + apiDetail(failure);
			}
			busy = false;
			return;
		}
		busy = false;
		if (gone) return;
		toast.success(t('af.consent.new.created'));
		oncreated(id);
	}
</script>

<section class="quick" aria-labelledby="new-consent-statement" bind:this={form}>
	<h3 class="quick__title" id="new-consent-statement">{t('af.consent.new.title')}</h3>
	<p class="quick__lead">{t('af.consent.new.lead')}</p>
	{#if error}
		<Callout tone="danger" live>
			{error}
			{#if unfinished}
				<Link href={`${STATEMENTS}/${encodeURIComponent(unfinished)}`} standalone
					>{t('af.consent.new.openUnfinished')}</Link
				>
			{/if}
		</Callout>
	{/if}
	{#if !unfinished}
		<fieldset class="quick__fields" disabled={busy}>
			<TextField
				label={t('cs.create.slug')}
				hint={t('cs.create.slugHint')}
				maxlength={LIMITS.slug}
				spellcheck={false}
				autocomplete="off"
				error={attempted && slugProblem ? t(slugProblem) : undefined}
				bind:value={slug}
			/>
			<Select label={t('cs.basic.kind')} options={kinds} bind:value={kind} />
			{#if languages.length > 0}
				<SegmentedControl
					label={t('cs.content.language')}
					size="sm"
					options={languages.map((code) => ({ value: code, label: languageName(code) }))}
					value={language}
					onchange={(code) => (chosen = code)}
				/>
			{/if}
			<StatementTextForm
				bind:value
				{language}
				onlanguage={(code) => (chosen = code)}
				problems={attempted ? problemsOf(language) : []}
				bodyRows={8}
			/>
		</fieldset>
		<StatementPreview value={value.languages[language]} contentType={value.contentType} {dir} />
		<div class="quick__actions">
			<Button variant="primary" size="sm" loading={busy} onclick={create}
				>{t('af.consent.new.publish')}</Button
			>
			<Button variant="ghost" size="sm" disabled={busy} onclick={oncancel}
				>{t('common.cancel')}</Button
			>
		</div>
	{:else}
		<div class="quick__actions">
			<Button variant="ghost" size="sm" onclick={oncancel}>{t('common.close')}</Button>
		</div>
	{/if}
</section>

<style>
	.quick {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
		padding: var(--space-related);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.quick__fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.quick__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.quick__lead {
		margin: 0;
		color: var(--text-secondary);
	}

	.quick__actions {
		display: flex;
		gap: var(--space-related);
	}
</style>
