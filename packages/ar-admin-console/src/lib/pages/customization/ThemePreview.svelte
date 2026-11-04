<script lang="ts">
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import { localeDir } from '#lib/i18n/locales.js';
	import Select from '#lib/ui/primitives/Select.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import { FONT_SCALES, FONT_STACKS, type ThemeDraft } from './theme-draft';
	import { PREVIEW_SCREENS, type PreviewScreen } from './theme-sections';

	/**
	 * The sign-in screens as the tenant's end users will see them, drawn from what is being edited
	 * (brand, colours, type, texts, logo, background, template). The toolbar picks the screen, the
	 * colour mode and phone or desktop width. The screens are an outline of a sign-in screen for
	 * now (fields are empty boxes); the real screens replace them later and the frame stays.
	 *
	 * One outline only: the frame is the screen itself, at the full width of the column on
	 * desktop and narrowed to a phone's width (centred) on mobile, so the preview gets all the room.
	 * The content is a picture, not the page: it cannot be focused or clicked (inert). Custom CSS is
	 * not applied here yet.
	 */
	interface Props {
		draft: ThemeDraft;
		screen?: PreviewScreen;
		mode?: 'light' | 'dark';
	}

	let { draft, screen = $bindable('signIn'), mode = $bindable('light') }: Props = $props();

	let width = $state<'mobile' | 'desktop'>('desktop');

	const screenOption = $derived(
		PREVIEW_SCREENS.find((option) => option.value === screen) ?? PREVIEW_SCREENS[0]
	);
	const screenLabel = $derived(t(screenOption.label));
	const texts = $derived(draft.texts[draft.language]);
	// What an empty item falls back to is read in the language being edited, not the console's.
	const title = $derived(texts.titles[screen] || tIn(draft.language, screenOption.label));
	const split = $derived(draft.template === 'split' && width === 'desktop');
	const showName = $derived(draft.logoDisplay !== 'logo');
	const showLogo = $derived(draft.logoDisplay !== 'name');

	/** A chosen file is shown through an object URL, released when it is replaced or removed. */
	let logoUrl = $state<string | null>(null);
	let backgroundUrl = $state<string | null>(null);
	let panelUrl = $state<string | null>(null);

	function imageUrl(value: string | File | null, set: (url: string | null) => void) {
		if (value instanceof File) {
			const url = URL.createObjectURL(value);
			set(url);
			return () => URL.revokeObjectURL(url);
		}
		set(value);
	}

	$effect(() => imageUrl(draft.logo, (url) => (logoUrl = url)));
	$effect(() => imageUrl(draft.backgroundImage, (url) => (backgroundUrl = url)));
	$effect(() => imageUrl(draft.panelImage, (url) => (panelUrl = url)));
</script>

{#snippet brand()}
	<div class="brand">
		{#if showLogo}
			{#if logoUrl}
				<img class="brand__logo" src={logoUrl} alt="" />
			{:else}
				<span class="brand__logo brand__logo--empty"></span>
			{/if}
		{/if}
		{#if showName && draft.brandName}<span class="brand__name">{draft.brandName}</span>{/if}
	</div>
{/snippet}

<section class="theme-preview" aria-labelledby="theme-preview-title">
	<div class="theme-preview__head">
		<h2 id="theme-preview-title">{t('th.preview.title')}</h2>
		<div class="theme-preview__controls">
			<Select
				label={t('th.preview.screen')}
				hideLabel
				options={PREVIEW_SCREENS.map((option) => ({
					value: option.value,
					label: t(option.label)
				}))}
				value={screen}
				onchange={(value) => (screen = value as PreviewScreen)}
			/>
			<SegmentedControl
				label={t('th.preview.mode')}
				hideLabel
				size="sm"
				options={[
					{ value: 'light', label: t('th.mode.light') },
					{ value: 'dark', label: t('th.mode.dark') }
				]}
				value={mode}
				onchange={(value) => (mode = value === 'dark' ? 'dark' : 'light')}
			/>
			<SegmentedControl
				label={t('preview.width')}
				hideLabel
				size="sm"
				options={[
					{ value: 'mobile', label: t('preview.mobile'), icon: 'device' },
					{ value: 'desktop', label: t('preview.desktop'), icon: 'app' }
				]}
				value={width}
				onchange={(value) => (width = value === 'mobile' ? 'mobile' : 'desktop')}
			/>
		</div>
	</div>

	<div class="screen screen--{width}" role="img" aria-label={screenLabel}>
		<div
			class="outline"
			data-admin-theme="standard"
			data-scheme={mode}
			data-template={draft.template}
			inert
			lang={draft.language}
			dir={localeDir(draft.language)}
			style:--ol-bg={draft.background || undefined}
			style:--ol-accent={draft.accent || undefined}
			style:--ol-title={draft.titleColor || undefined}
			style:--ol-text={draft.textColor || undefined}
			style:--ol-scale={FONT_SCALES[draft.scale]}
			style:font-family={FONT_STACKS[draft.font]}
		>
			{#if backgroundUrl}
				<span
					class="outline__image"
					style:background-image={`url("${backgroundUrl}")`}
					style:opacity={draft.backgroundOpacity / 100}
				></span>
			{/if}
			<div class="outline__stage" class:outline__stage--split={split}>
				{#if split}
					<aside class="outline__panel">
						{#if panelUrl}
							<span
								class="outline__image"
								style:background-image={`url("${panelUrl}")`}
								style:opacity={draft.panelImageOpacity / 100}
							></span>
						{/if}
						<div class="outline__panel-content">
							{@render brand()}
							{#if draft.panelTitle}<h3>{draft.panelTitle}</h3>{/if}
							{#if draft.panelText}<p>{draft.panelText}</p>{/if}
						</div>
					</aside>
				{/if}
				<div class="outline__main">
					{#if draft.header && !split}
						<header class="outline__header">{@render brand()}</header>
					{/if}
					<div class="outline__body">
						<div class="outline__card">
							{#if !draft.header && !split}{@render brand()}{/if}
							<h3>{title}</h3>
							{#if texts.tagline}<p>{texts.tagline}</p>{/if}
							<span class="outline__field"></span>
							<span class="outline__field"></span>
							<span class="outline__button">{tIn(draft.language, 'th.preview.continue')}</span>
						</div>
					</div>
				</div>
			</div>
			<!-- The footer runs along the bottom of the whole screen, under the brand panel too. -->
			{#if draft.footer}
				<footer class="outline__footer">
					{texts.footer || `© ${draft.brandName}`}
				</footer>
			{/if}
		</div>
	</div>

	<p class="theme-preview__note">{t('th.preview.note')}</p>
</section>

<style>
	.theme-preview {
		display: grid;
		gap: var(--space-related);
		align-content: start;
	}

	.theme-preview__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
	}

	.theme-preview__head h2 {
		margin: 0;
		font-size: var(--fs-heading);
		font-weight: var(--fw-semibold);
	}

	.theme-preview__controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.theme-preview__note {
		margin: 0;
		font-size: var(--fs-label);
		color: var(--text-secondary);
	}

	/* The one frame: the screen itself. It narrows to a phone's width, centred, on mobile. */
	.screen {
		width: 100%;
		justify-self: center;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		transition: max-width 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
	}

	.screen--mobile {
		max-width: 390px;
	}

	@media (prefers-reduced-motion: reduce) {
		.screen {
			transition: none;
		}
	}

	/*
	 * The outline stands in for the real screen. It carries its own look and scheme (the standard
	 * look in the chosen mode), so the preview does not follow the console's own colour scheme.
	 * What is edited arrives as --ol-* values; unset ones fall back to the look's tokens.
	 */
	.outline {
		position: relative;
		isolation: isolate;
		display: grid;
		/* The stage takes what the footer leaves, so the footer sits on the bottom edge. */
		grid-template-rows: minmax(0, 1fr) auto;
		min-height: 640px;
		background-color: var(--ol-bg, var(--bg-subtle));
		color: var(--ol-text, var(--text-secondary));
		font-size: calc(var(--fs-label) * var(--ol-scale, 1));
	}

	/* The console sets its own display face on headings; the preview's follow the chosen one. */
	.outline :global(h3) {
		font-family: inherit;
	}

	/* A picture laid behind its box with its own opacity (the box's colour stays as it is). */
	.outline__image {
		position: absolute;
		inset: 0;
		background-position: center;
		background-size: cover;
		pointer-events: none;
	}

	.outline__stage {
		position: relative;
		grid-row: 1;
		display: grid;
		min-width: 0;
		min-height: 0;
	}

	.outline__stage--split {
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
	}

	.outline__panel {
		position: relative;
		overflow: hidden;
		display: grid;
		align-content: center;
		padding: 32px;
		background: color-mix(in srgb, var(--ol-accent, var(--text-primary)) 12%, transparent);
	}

	.outline__panel-content {
		position: relative;
		display: grid;
		gap: 12px;
	}

	.outline__panel h3 {
		margin: 0;
		font-size: calc(var(--fs-title) * var(--ol-scale, 1));
		color: var(--ol-title, var(--text-primary));
	}

	.outline__panel p {
		margin: 0;
	}

	.outline__main {
		display: grid;
		grid-template-rows: auto 1fr;
		min-width: 0;
	}

	.outline__header {
		grid-row: 1;
		padding: 14px 24px;
	}

	.outline__footer {
		position: relative;
		grid-row: 2;
		padding: 14px 24px;
		text-align: center;
		font-size: calc(var(--fs-small) * var(--ol-scale, 1));
	}

	.outline__body {
		grid-row: 2;
		display: grid;
		place-items: center;
		padding: 24px;
	}

	.outline__card {
		display: grid;
		gap: 10px;
		width: min(100%, 300px);
		padding: 22px;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
	}

	.outline[data-template='minimal'] .outline__card {
		border-color: transparent;
		background: transparent;
	}

	.outline__card h3 {
		margin: 0;
		font-size: calc(var(--fs-heading) * var(--ol-scale, 1));
		color: var(--ol-title, var(--text-primary));
	}

	.outline__card p {
		margin: 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.brand__logo {
		width: 32px;
		height: 32px;
		border-radius: var(--radius-md);
		object-fit: contain;
	}

	.brand__logo--empty {
		background: var(--border);
	}

	.brand__name {
		font-weight: var(--fw-semibold);
		color: var(--ol-title, var(--text-primary));
	}

	.outline__field {
		display: block;
		height: 32px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-input);
	}

	.outline__button {
		display: grid;
		place-items: center;
		height: 34px;
		border-radius: var(--radius-sm);
		background: var(--ol-accent, var(--text-primary));
		color: var(--text-inverse);
		font-weight: var(--fw-semibold);
	}
</style>
