<script lang="ts">
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import { localeDir } from '#lib/i18n/locales.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import { FONT_SCALES, FONT_STACKS, type ThemeDraft } from './theme-draft';
	import { parseFooter } from './footer-links';
	import { PREVIEW_SCREENS, type PreviewScreen } from './theme-sections';

	/**
	 * The sign-in screens as the tenant's end users will see them, drawn from what is being edited
	 * (brand, colours, type, texts, logo, background, template). The toolbar picks the screen, the
	 * colour mode and phone or desktop width. The screens are an outline of a sign-in screen for
	 * now (fields are empty boxes); the real screens replace them later and the frame stays.
	 *
	 * One outline only: the frame is the screen itself, at the full width of the column on
	 * desktop and narrowed to a phone's width (centred) on mobile, so the preview gets all the room.
	 * The content is a picture, not the page: it cannot be focused or clicked (inert), except the footer's links. Custom CSS is
	 * not applied here yet.
	 */
	interface Props {
		draft: ThemeDraft;
		screen?: PreviewScreen;
		mode?: 'light' | 'dark';
	}

	let { draft, screen = $bindable('signIn'), mode = $bindable('light') }: Props = $props();

	let width = $state<'mobile' | 'desktop'>('desktop');

	/**
	 * The screen is drawn at the size of a real one (a desktop window or a phone) and the whole
	 * drawing is scaled down to the frame, as a screenshot would be: its text is as small, next to
	 * the screen, as the end user's text is. The frame's width decides the scale.
	 */
	const VIRTUAL = { desktop: { w: 1120, h: 700 }, mobile: { w: 390, h: 780 } } as const;
	let frameWidth = $state(0);
	const virtual = $derived(VIRTUAL[width]);
	const scale = $derived(frameWidth ? Math.min(1, frameWidth / virtual.w) : 1);

	const screenOption = $derived(
		PREVIEW_SCREENS.find((option) => option.value === screen) ?? PREVIEW_SCREENS[0]
	);
	const screenLabel = $derived(t(screenOption.label));
	const texts = $derived(draft.texts[draft.language]);
	// What an empty item falls back to is read in the language being edited, not the console's.
	// The heading is the screen's default wording, read in the language being edited.
	const title = $derived(tIn(draft.language, screenOption.label));
	const split = $derived(draft.template === 'split' && width === 'desktop');
	// The header and the brand panel each choose what they show of the brand.
	const showName = $derived(draft.logoDisplay !== 'logo');
	const showLogo = $derived(draft.logoDisplay !== 'name');
	const panelShowName = $derived(
		draft.brandLogoDisplay === 'both' || draft.brandLogoDisplay === 'name'
	);
	const panelShowLogo = $derived(
		draft.brandLogoDisplay === 'both' || draft.brandLogoDisplay === 'logo'
	);
	const headerName = $derived(draft.headerName);
	const footerParts = $derived(parseFooter(texts.footer));
	const showTools = $derived(draft.themeToggle || draft.languageSelect);

	/** A chosen file is shown through an object URL, released when it is replaced or removed. */
	let logoUrl = $state<string | null>(null);
	let backgroundUrl = $state<string | null>(null);
	let panelUrl = $state<string | null>(null);
	let cardUrl = $state<string | null>(null);

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
	$effect(() => imageUrl(draft.cardImage, (url) => (cardUrl = url)));

	// The brand side's picture is its own; the background image runs behind the whole screen.
	const brandLayer = $derived(
		panelUrl ? { url: panelUrl, opacity: draft.panelImageOpacity } : null
	);
</script>

{#snippet mark()}
	{#if logoUrl}
		<img class="brand__logo" src={logoUrl} alt="" />
	{:else}
		<span class="brand__logo brand__logo--empty"></span>
	{/if}
{/snippet}

{#snippet brand()}
	<div class="brand">
		{#if showLogo}{@render mark()}{/if}
		<div class="brand__text">
			{#if showName && headerName}<span class="brand__name">{headerName}</span>{/if}
			{#if texts.tagline}<span class="brand__tagline">{texts.tagline}</span>{/if}
		</div>
	</div>
{/snippet}

<!-- The colour mode and language choices, as the end user's screen offers them. -->
{#snippet tools()}
	<div class="tools">
		{#if draft.themeToggle}
			<span class="tools__item tools__item--icon"
				><Icon name={mode === 'dark' ? 'moon' : 'sun'} /></span
			>
		{/if}
		{#if draft.languageSelect}
			<span class="tools__item"
				><Icon name="globe" />{draft.language.toUpperCase()}<Icon name="caret" /></span
			>
		{/if}
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

	<div
		class="screen screen--{width}"
		role="group"
		aria-label={screenLabel}
		style:--vw="{virtual.w}px"
		style:--vh="{virtual.h}px"
		style:--scale={scale}
	>
		<!-- Measures the frame's width only: its height is zero, so scaling never feeds back into it. -->
		<span class="measure" bind:clientWidth={frameWidth}></span>
		<div class="canvas">
			<div
				class="outline"
				data-admin-theme="standard"
				data-scheme={mode}
				data-template={draft.template}
				lang={draft.language}
				dir={localeDir(draft.language)}
				style:--ol-bg={draft.background || undefined}
				style:--ol-accent={draft.accent || undefined}
				style:--ol-title={draft.titleColor || undefined}
				style:--ol-text={draft.textColor || undefined}
				style:--ol-copy={draft.copyColor || undefined}
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
				<!-- The header runs along the top of the whole screen, over the brand panel too, as the footer
				     runs along the bottom. The brand panel has no header of its own. -->
				{#if draft.header}
					<header class="outline__header" inert>
						{@render brand()}
						{#if showTools}{@render tools()}{/if}
					</header>
				{:else if showTools}
					<div class="outline__tools" inert>{@render tools()}</div>
				{/if}
				<div
					class="outline__stage"
					inert
					class:outline__stage--split={split}
					class:outline__stage--right={split && draft.splitSide === 'right'}
					class:outline__stage--wide={split && draft.splitWidth === 'wide'}
					class:outline__stage--card={split && draft.splitFrame === 'card'}
				>
					{#if split}
						<aside
							class="outline__panel"
							data-position={draft.brandPosition}
							data-align={draft.brandAlign}
						>
							{#if brandLayer}
								<span
									class="outline__image"
									style:background-image={`url("${brandLayer.url}")`}
									style:opacity={brandLayer.opacity / 100}
								></span>
							{/if}
							{#if draft.brandLogoDisplay !== 'none'}
								<div class="outline__panel-content">
									<!-- The logo, then the brand name over the title and text (each only when it has something). -->
									{#if logoUrl && panelShowLogo}{@render mark()}{/if}
									{#if panelShowName && draft.brandName}<p class="outline__eyebrow">
											{draft.brandName}
										</p>{/if}
									{#if draft.panelTitle}<h3>{draft.panelTitle}</h3>{/if}
									{#if draft.panelText}<p>{draft.panelText}</p>{/if}
								</div>
							{/if}
						</aside>
					{/if}
					<div class="outline__main">
						<div class="outline__body">
							<div class="outline__card">
								<!-- The login area's own picture, under what the box holds (not drawn in Minimal). -->
								{#if cardUrl && draft.template !== 'minimal'}
									<span
										class="outline__image"
										style:background-image={`url("${cardUrl}")`}
										style:opacity={draft.cardImageOpacity / 100}
									></span>
								{/if}
								{#if !draft.header && !split}{@render brand()}{/if}
								<h3>{title}</h3>
								<span class="outline__field"></span>
								<span class="outline__field"></span>
								<span class="outline__button">{tIn(draft.language, 'th.preview.continue')}</span>
							</div>
						</div>
					</div>
				</div>
				<!-- The footer runs along the bottom of the whole screen, under the brand panel too. -->
				{#if draft.footer}
					<!-- The one part that is not inert: its links work and open in a new window. -->
					<footer class="outline__footer">
						{#each footerParts as part, index (index)}
							{#if 'href' in part}
								<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
							{:else}
								{part.text}
							{/if}
						{/each}
					</footer>
				{/if}
			</div>
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
		position: relative;
		width: 100%;
		justify-self: center;
		/* The scaled drawing's height: a real screen's height times the scale. */
		height: calc(var(--vh) * var(--scale));
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

	.measure {
		position: absolute;
		inset-inline: 0;
		top: 0;
		height: 0;
		pointer-events: none;
	}

	/* The drawing at real size, scaled from its top start corner to fit the frame. */
	.canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--vw);
		height: var(--vh);
		transform: scale(var(--scale));
		transform-origin: top left;
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
		/* The stage takes what the header and footer leave: they sit on the top and bottom edges. */
		grid-template-rows: auto minmax(0, 1fr) auto;
		height: 100%;
		background-color: var(--ol-bg, var(--bg-subtle));
		color: var(--ol-text, var(--text-secondary));
		font-size: calc(var(--preview-fs-body) * var(--ol-scale, 1));
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
		grid-row: 2;
		display: grid;
		min-width: 0;
		min-height: 0;
	}

	/* Narrow form: the brand side takes 3/5. "Right" puts the brand side after the form. */
	.outline__stage--split {
		--brand-track: 3fr;
		--form-track: 2fr;
		grid-template-columns: minmax(0, var(--brand-track)) minmax(0, var(--form-track));
	}

	.outline__stage--wide {
		--brand-track: 2fr;
		--form-track: 3fr;
	}

	.outline__stage--right {
		grid-template-columns: minmax(0, var(--form-track)) minmax(0, var(--brand-track));
	}

	.outline__stage--right .outline__panel {
		order: 2;
	}

	/* A floating card: the split screen sits inside the page, framed, with the page behind it. */
	.outline__stage--card {
		margin: 24px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-card);
		box-shadow: var(--shadow-lg);
	}

	.outline__panel {
		position: relative;
		overflow: hidden;
		display: grid;
		align-content: center;
		padding: 48px;
		/*
		 * The brand side is always painted (never see-through): a fill from the accent colour, so a
		 * background image shows behind the form side, not through this one. Its own picture, if it
		 * has one, is laid over the fill with its opacity; the text on it is the inverse of the page.
		 */
		background: linear-gradient(
			150deg,
			color-mix(in srgb, var(--ol-accent, var(--text-primary)) 78%, var(--bg-card)),
			var(--ol-accent, var(--text-primary))
		);
		color: var(--text-inverse);
	}

	.outline__panel-content {
		position: relative;
		display: grid;
		gap: 18px;
		max-width: 520px;
	}

	/* Where the brand content sits in its side (position: up and down; alignment: across). */
	.outline__panel[data-position='top'] {
		align-content: start;
	}

	.outline__panel[data-position='bottom'] {
		align-content: end;
	}

	.outline__panel[data-align='left'] .outline__panel-content {
		justify-items: left;
		text-align: left;
	}

	.outline__panel[data-align='center'] .outline__panel-content {
		justify-items: center;
		text-align: center;
	}

	.outline__panel[data-align='right'] .outline__panel-content {
		justify-items: right;
		text-align: right;
	}

	.outline__panel h3 {
		margin: 0;
		font-size: calc(var(--preview-fs-hero) * var(--ol-scale, 1));
		line-height: var(--preview-lh-hero);
		color: var(--ol-title, var(--text-inverse));
	}

	.outline__panel p {
		margin: 0;
		line-height: var(--lh-relaxed);
		color: var(--ol-copy, color-mix(in srgb, var(--text-inverse) 80%, transparent));
	}

	/* The brand panel's logo is the big one (the real screen allows up to 260 x 92). */
	.outline__panel .brand__logo {
		width: auto;
		max-width: 260px;
		height: auto;
		max-height: 92px;
	}

	/* The brand name over the title: small, in capitals (the accent is the fill here). */
	.outline__panel .outline__eyebrow {
		font-size: calc(var(--preview-fs-eyebrow) * var(--ol-scale, 1));
		font-weight: var(--fw-semibold);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ol-copy, color-mix(in srgb, var(--text-inverse) 80%, transparent));
	}

	/*
	 * The form side over the page's picture: frosted, as the real screen has it. "Brand only" has
	 * no picture behind it, so it is a plain card (or the fill chosen for it).
	 */
	.outline__stage--split .outline__main {
		background: color-mix(in srgb, var(--bg-card) 72%, transparent);
		backdrop-filter: blur(16px);
	}

	/* The line between the two sides, on the side the brand panel is not. */
	.outline__stage--split .outline__main {
		border-inline-start: 1px solid var(--border);
	}

	.outline__stage--right .outline__main {
		border-inline-start: 0;
		border-inline-end: 1px solid var(--border);
	}

	.outline__main {
		position: relative;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		min-width: 0;
	}

	.outline__header {
		position: relative;
		grid-row: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 20px 40px;
	}

	/* With no header, the choices float at the top end of the screen, as the real one has them. */
	.outline__tools {
		position: absolute;
		z-index: 2;
		inset-block-start: 20px;
		inset-inline-end: 40px;
	}

	.tools {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ol-text, var(--text-secondary));
		font-size: calc(var(--preview-fs-small) * var(--ol-scale, 1));
		--icon-size: var(--icon-md);
	}

	.tools__item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-round);
		background: var(--bg-card);
	}

	.tools__item--icon {
		width: 34px;
		justify-content: center;
		padding: 0;
	}

	.outline__footer {
		position: relative;
		grid-row: 3;
		padding: 16px 40px;
		text-align: center;
		color: var(--ol-copy, var(--ol-text, var(--text-secondary)));
		font-size: calc(var(--preview-fs-small) * var(--ol-scale, 1));
	}

	.outline__footer a {
		color: inherit;
		text-decoration: underline;
	}

	.outline__footer {
		white-space: pre-line;
	}

	.outline__body {
		position: relative;
		grid-row: 1;
		display: grid;
		place-items: center;
		padding: 32px;
	}

	.outline__card {
		position: relative;
		overflow: hidden;
		display: grid;
		gap: 16px;
		width: min(100%, 420px);
		padding: 32px;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
	}

	/* What the box holds sits over its picture. */
	.outline__card > :global(*:not(.outline__image)) {
		position: relative;
	}

	.outline[data-template='minimal'] .outline__card {
		border-color: transparent;
		background: transparent;
	}

	.outline__card h3 {
		margin: 0;
		font-size: calc(var(--preview-fs-heading) * var(--ol-scale, 1));
		color: var(--ol-title, var(--text-primary));
	}

	.outline__card p {
		margin: 0;
		font-size: calc(var(--preview-fs-label) * var(--ol-scale, 1));
		color: var(--ol-copy, var(--ol-text, var(--text-secondary)));
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.brand__logo {
		width: 40px;
		height: 40px;
		border-radius: var(--radius-md);
		object-fit: contain;
	}

	.brand__logo--empty {
		background: var(--border);
	}

	.brand__text {
		display: grid;
		gap: 2px;
	}

	.brand__tagline {
		color: var(--ol-copy, var(--ol-text, var(--text-secondary)));
		font-size: calc(var(--preview-fs-small) * var(--ol-scale, 1));
	}

	.brand__name {
		font-size: calc(var(--preview-fs-name) * var(--ol-scale, 1));
		font-weight: var(--fw-bold);
		color: var(--ol-title, var(--text-primary));
	}

	.outline__field {
		display: block;
		height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-input);
	}

	.outline__button {
		display: grid;
		place-items: center;
		height: 44px;
		font-size: calc(var(--preview-fs-label) * var(--ol-scale, 1));
		border-radius: var(--radius-sm);
		background: var(--ol-accent, var(--text-primary));
		color: var(--text-inverse);
		font-weight: var(--fw-semibold);
	}
</style>
