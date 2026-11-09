<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import CodeField from '#lib/ui/code/CodeField.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { cssForEditor, cssFromEditor } from './custom-css-scaffold';
	import type { ThemeDraft } from './theme-draft';
	import { draftToValues, type StoredTheme } from './theme-values';

	/**
	 * Advanced: custom CSS, for what the settings above cannot express, and the theme's definition:
	 * the settings this theme writes when it is saved (over the stored theme, when one is open), as
	 * applying it sets them. Read-only, to compare what the sign-in screens show with what the
	 * theme says. Images chosen but not uploaded yet are not in it.
	 */
	let { draft = $bindable(), stored }: { draft: ThemeDraft; stored?: StoredTheme } = $props();
	let editorCss = $state(cssForEditor(draft.customCss));
	let editorDraft = draft;
	$effect(() => {
		if (draft !== editorDraft) {
			editorDraft = draft;
			editorCss = cssForEditor(draft.customCss);
		}
	});
	function setEditorCss(value: string) {
		editorCss = value;
		draft.customCss = cssFromEditor(value);
	}

	const definition = $derived.by(() => {
		const values = draftToValues(draft, stored);
		const sorted = Object.fromEntries(
			Object.keys(values)
				.sort()
				.map((key) => [key, values[key]])
		);
		return JSON.stringify(sorted, null, 2);
	});
</script>

<ThemeGroup title={t('th.g.css')} info={t('th.g.css.d')}>
	<CodeField
		label={t('th.f.css')}
		language="css"
		rows={24}
		lineNumbers
		wrapToggle
		copyable
		hint={t('th.h.css')}
		bind:value={() => editorCss, setEditorCss}
	/>
	<Disclosure title={t('th.def.title')} description={t('th.def.d')}>
		<CodeField
			label={t('th.def.field')}
			language="json"
			rows={16}
			lineNumbers
			wrapToggle
			copyable
			readonly
			value={definition}
		/>
	</Disclosure>
</ThemeGroup>
