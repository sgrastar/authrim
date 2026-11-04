<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import ThemeAdvanced from './ThemeAdvanced.svelte';
	import ThemeBrand from './ThemeBrand.svelte';
	import ThemeDesign from './ThemeDesign.svelte';
	import ThemeImages from './ThemeImages.svelte';
	import ThemePreview from './ThemePreview.svelte';
	import ThemeText from './ThemeText.svelte';
	import { newThemeDraft } from './theme-draft';
	import { THEME_SECTIONS, type PreviewScreen } from './theme-sections';

	/**
	 * Customization → Themes: how the tenant's sign-in screens look.
	 *
	 * The editing column (one tab per section) and the preview column sit side by side and the
	 * preview stays in view while the left column is edited; on a narrow screen they stack,
	 * editing first. What is edited is held in the page (`draft`) and drawn by the preview; it is
	 * not read from or saved to the Admin API yet.
	 */
	let draft = $state(newThemeDraft());
	let section = $state<string>(THEME_SECTIONS[0].id);
	let screen = $state<PreviewScreen>('signIn');
	let mode = $state<'light' | 'dark'>('light');

	// Derived: the language can change while the page is open.
	const tabs = $derived(THEME_SECTIONS.map((item) => ({ id: item.id, label: t(item.tab) })));
</script>

<Page>
	<PageHeader title={t('nav.custom.branding')} description={t('th.desc')}>
		{#snippet badges()}
			<Badge tone="neutral">{t('th.status.published')}</Badge>
		{/snippet}
	</PageHeader>

	<div class="workspace">
		<div class="workspace__edit">
			<Tabs label={t('th.edit.label')} items={tabs} bind:value={section}>
				{#snippet panel(id)}
					<div class="sections">
						{#if id === 'look'}
							<ThemeDesign bind:draft />
						{:else if id === 'brand'}
							<ThemeBrand bind:draft />
						{:else if id === 'text'}
							<ThemeText bind:draft />
						{:else if id === 'images'}
							<ThemeImages bind:draft />
						{:else}
							<ThemeAdvanced bind:draft />
						{/if}
					</div>
				{/snippet}
			</Tabs>
		</div>

		<aside class="workspace__preview">
			<ThemePreview {draft} bind:screen bind:mode />
		</aside>
	</div>
</Page>

<style>
	/* Editing on the start side, the preview on the end side; the preview follows the scroll. */
	.workspace {
		display: grid;
		grid-template-columns: minmax(370px, 1fr) minmax(0, 2fr);
		gap: var(--space-columns);
		align-items: start;
	}

	.workspace__edit {
		display: grid;
		gap: var(--space-section);
		min-width: 0;
	}

	.workspace__preview {
		position: sticky;
		/* Below the sticky header and top navigation, as the sub navigation sits. */
		top: calc(var(--header-h) + var(--subheader-h) + var(--shell-inset) + var(--space-section));
		min-width: 0;
	}

	.sections {
		display: grid;
		gap: var(--space-section);
	}

	@media (max-width: 900px) {
		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.workspace__preview {
			position: static;
		}
	}
</style>
