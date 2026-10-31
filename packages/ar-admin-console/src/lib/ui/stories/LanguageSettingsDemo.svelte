<script lang="ts">
	import { i18n } from '$lib/i18n/i18n.svelte';
	import Callout from '../patterns/Callout.svelte';
	import Card from '../patterns/Card.svelte';
	import ChoiceGrid, { type GridChoice } from '../patterns/ChoiceGrid.svelte';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import Select from '../primitives/Select.svelte';
	import { sample } from './sample';

	/**
	 * Storybook demo: the sign-in pages' language settings, rebuilt from the legacy screen that
	 * put three controls in every cell. One question per step:
	 * 1. which languages are shown (a grid of checkboxes; the default one stays on),
	 * 2. which one is the default (a select limited to the languages shown),
	 * 3. which are listed first (a second grid limited to those shown, up to 6, from 11 on).
	 */
	const CODES = [
		'am',
		'ar',
		'bn',
		'zh-Hans',
		'zh-Hant',
		'en',
		'fr',
		'de',
		'hi',
		'id',
		'it',
		'ja',
		'ko',
		'pl',
		'pt',
		'ru',
		'es',
		'sw',
		'th',
		'tr',
		'vi'
	];
	const FIRST_FROM = 11;
	const FIRST_MAX = 6;

	interface Settings {
		shown: string[];
		defaultLang: string;
		first: string[];
		englishNames: boolean;
	}

	const settings = new Draft<Settings>({
		shown: [...CODES],
		defaultLang: 'en',
		first: ['ar', 'zh-Hans', 'en', 'fr', 'hi', 'es'],
		englishNames: false
	});
	const draft = $derived(settings.value);

	/** Name in the console's language, with the language's own name under it when it differs. */
	const names = $derived.by(() => {
		const inUi = new Intl.DisplayNames([i18n.locale], { type: 'language' });
		return (code: string) => {
			const own = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
			const label = inUi.of(code) ?? code;
			return { label, own: own === label ? undefined : own };
		};
	});

	const byName = (a: GridChoice, b: GridChoice) => a.label.localeCompare(b.label, i18n.locale);

	const shownOptions = $derived<GridChoice[]>(
		CODES.map((code) => {
			const { label, own } = names(code);
			const isDefault = code === draft.defaultLang;
			return {
				value: code,
				label,
				detail: own,
				detailLang: code,
				locked: isDefault,
				note: isDefault ? sample('langDefaultNote') : undefined
			};
		}).sort(byName)
	);
	const firstOptions = $derived(
		shownOptions.filter((option) => draft.shown.includes(option.value))
	);
	const firstAvailable = $derived(draft.shown.length >= FIRST_FROM);

	// A language that is no longer shown cannot be listed first.
	$effect(() => {
		const kept = draft.first.filter((code) => draft.shown.includes(code));
		if (kept.length !== draft.first.length) draft.first = kept;
	});

	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<SaveScope draft={settings} onsave={save}>
	<div style="display:grid;gap:16px">
		<Card title={sample('langShown')} description={sample('langShownDesc')}>
			<ChoiceGrid
				label={sample('langShown')}
				options={shownOptions}
				field="shown"
				bind:selected={settings.value.shown}
			/>
		</Card>

		<Card title={sample('langDefault')} description={sample('langDefaultDesc')}>
			<Select
				label={sample('langDefault')}
				hideLabel
				inline
				field="defaultLang"
				value={draft.defaultLang}
				options={firstOptions.map((option) => ({ value: option.value, label: option.label }))}
				onchange={(value) => (draft.defaultLang = value)}
			/>
		</Card>

		<Card title={sample('langFirst')} description={sample('langFirstDesc')}>
			{#if firstAvailable}
				<ChoiceGrid
					label={sample('langFirst')}
					options={firstOptions.map(({ locked: _locked, note: _note, ...option }) => option)}
					max={FIRST_MAX}
					field="first"
					bind:selected={settings.value.first}
				/>
			{:else}
				<Callout>{sample('langFirstNeedsMore')}</Callout>
			{/if}
		</Card>

		<Card>
			<Checkbox
				field="englishNames"
				description={sample('langEnglishNamesDesc')}
				bind:checked={settings.value.englishNames}
			>
				{sample('langEnglishNames')}
			</Checkbox>
		</Card>
	</div>
</SaveScope>
