<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import CodeField from '#lib/ui/code/CodeField.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { ThemeDraft } from './theme-draft';

	/** Advanced: custom CSS, for what the settings above cannot express. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();
</script>

<ThemeGroup title={t('th.g.css')} info={t('th.g.css.d')}>
	<CodeField
		label={t('th.f.css')}
		language="css"
		rows={14}
		lineNumbers
		wrapToggle
		copyable
		hint={t('th.h.css')}
		bind:value={draft.customCss}
	/>
</ThemeGroup>
