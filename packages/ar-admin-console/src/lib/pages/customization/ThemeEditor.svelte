<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import type { ScreenListItem, ScreensClient } from '#lib/api/screens.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ThemeAdvanced from './ThemeAdvanced.svelte';
	import ThemeContent from './ThemeContent.svelte';
	import ThemeLayout from './ThemeLayout.svelte';
	import ThemeDesign from './ThemeDesign.svelte';
	import ThemeImages from './ThemeImages.svelte';
	import { apiBgPresets, type BgPresetSource } from './bg-presets';
	import ThemePreview from './ThemePreview.svelte';
	import { themeScreenPreviews } from './screens/screen-preview-content';
	import type { ChoiceSource } from './screens/screen-model';
	import { newThemeDraft, type ThemeDraft } from './theme-draft';
	import type { StoredTheme } from './theme-values';
	import { THEME_SECTIONS, type PreviewScreen } from './theme-sections';

	/**
	 * The theme editor: how the tenant's sign-in screens look, under the theme page's header.
	 *
	 * The preview column (first) and the editing column (one tab per section, the inspector) sit
	 * side by side and the preview stays in view while the inspector is edited; on a narrow screen
	 * they stack, editing first. Custom CSS sits under both, full width. The inspector is dense: its
	 * controls and spacing are a size down. `draft` is what is edited, drawn by the preview; the
	 * page around it loads and saves it (a new draft when none is given).
	 */
	interface Props {
		draft?: ThemeDraft;
		/** Where the background presets come from (the Admin API unless given). */
		presets?: BgPresetSource;
		/** The theme as stored, when one is open: its definition shows what saving writes over it. */
		stored?: StoredTheme;
		/** Saved screens to use instead of the standalone sample outline. */
		screensClient?: ScreensClient;
		choices?: ChoiceSource;
	}

	let {
		draft = $bindable(newThemeDraft()),
		presets = apiBgPresets,
		stored,
		screensClient,
		choices
	}: Props = $props();
	let section = $state<string>(THEME_SECTIONS[0].id);
	let screen = $state<PreviewScreen>('signIn');
	let mode = $state<'light' | 'dark'>('light');
	let screens = $state<ScreenListItem[]>([]);
	let screenPhase = $state<'loading' | 'ready' | 'failed'>('loading');
	let retryScreens = $state(0);
	const previews = $derived(screensClient ? themeScreenPreviews(screens, choices) : undefined);

	$effect(() => {
		const client = screensClient;
		const attempt = retryScreens;
		if (!client) return;
		const controller = new AbortController();
		screens = [];
		screenPhase = 'loading';
		void client
			.list(controller.signal)
			.then((result) => {
				if (controller.signal.aborted || attempt !== retryScreens) return;
				screens = result.screens;
				screenPhase = 'ready';
			})
			.catch(() => {
				if (!controller.signal.aborted && attempt === retryScreens) screenPhase = 'failed';
			});
		return () => controller.abort();
	});

	// The mode the screens are shown in: the one fixed, or (auto) the one the preview simulates.
	const scheme = $derived(draft.mode === 'auto' ? mode : draft.mode);

	// Derived: the language can change while the page is open.
	const tabs = $derived(THEME_SECTIONS.map((item) => ({ id: item.id, label: t(item.tab) })));
</script>

<div class="editor">
	<div class="workspace">
		<div class="workspace__edit">
			<Tabs label={t('th.edit.label')} items={tabs} bind:value={section}>
				{#snippet panel(id)}
					<div class="sections">
						{#if id === 'layout'}
							<ThemeLayout bind:draft />
						{:else if id === 'look'}
							<ThemeDesign bind:draft {scheme} bind:mode />
						{:else if id === 'content'}
							<ThemeContent bind:draft />
						{:else}
							<ThemeImages bind:draft {presets} />
						{/if}
					</div>
				{/snippet}
			</Tabs>
		</div>

		<aside class="workspace__preview">
			{#if screenPhase === 'failed'}
				<Callout tone="warning" title={t('sc.list.loadFailed')}>
					<Button size="sm" onclick={() => (retryScreens += 1)}>{t('common.retry')}</Button>
				</Callout>
			{/if}
			<ThemePreview
				{draft}
				{scheme}
				{previews}
				screensLoading={screenPhase === 'loading'}
				bind:screen
				bind:mode
			/>
		</aside>
	</div>

	<!-- Custom CSS needs room to read, and it is rarely touched: under both columns, not a tab. -->
	<div class="advanced">
		<ThemeAdvanced bind:draft {stored} />
	</div>
</div>

<style>
	/* The editor's parts are spaced as the page's sections are. */
	.editor {
		display: grid;
		gap: var(--space-section);
		min-width: 0;
	}

	/* The preview on the start side, the inspector on the end side; the preview follows the scroll. */
	.workspace {
		display: grid;
		grid-template-columns: minmax(0, 1fr) clamp(280px, 22%, 300px);
		gap: var(--space-columns);
		align-items: start;
	}

	/*
	 * The inspector is narrow and holds many controls, so it is set a size down: fields at the
	 * dense height, boxes and the gaps between them tighter. (Tokens are scoped to this column.)
	 */
	.workspace__edit {
		--control-h: var(--control-h-dense);
		--space-section: 12px;
		--space-field: 12px;
		--space-grid: 8px;
		--box-pad: 12px;
		--box-head-pad-y: 8px;
		--choice-pad-y: 8px;
		--choice-pad-x: 12px;
		--tab-pad-x: 8px;
		/* A switch needs little room: the name gets most of the row. */
		--row-name-col: 62%;
		grid-column: 2;
		grid-row: 1;
		display: grid;
		gap: var(--space-section);
		min-width: 0;
	}

	.workspace__preview {
		grid-column: 1;
		grid-row: 1;
		position: sticky;
		/* Below the sticky header and top navigation, as the sub navigation sits. */
		top: calc(var(--header-h) + var(--subheader-h) + var(--shell-inset) + var(--space-section));
		min-width: 0;
	}

	.advanced {
		margin-top: var(--space-section);
	}

	.sections {
		display: grid;
		gap: var(--space-section);
	}

	@media (max-width: 900px) {
		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.workspace__edit,
		.workspace__preview {
			grid-column: auto;
			grid-row: auto;
		}

		.workspace__preview {
			position: static;
		}
	}
</style>
