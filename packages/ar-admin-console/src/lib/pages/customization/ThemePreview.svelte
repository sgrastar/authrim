<script lang="ts">
	import { apiAssetUrl } from '#lib/api/assets.js';
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import { localeDir } from '#lib/i18n/locales.js';
	import { loginUIImageFilterCss } from '@authrim/ar-lib-core/utils/login-ui-image-filters';
	import { contrastRatio, normalizeHex, splitAlpha } from '#lib/ui/primitives/color.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import ScreenPreview from './screens/ScreenPreview.svelte';
	import {
		localizedScreenPreview,
		type ScreenPreviewContent
	} from './screens/screen-preview-content';
	import { BAR_ALIGNS, DENSITIES, FONT_STACKS, type ThemeDraft } from './theme-draft';
	import { draftColour, THEME_COLOURS, type ThemeColourField } from './theme-colours';
	import { paletteColours, paletteOf } from './theme-palettes';
	import { parseFooter } from './footer-links';
	import { PREVIEW_SCREENS, type PreviewScreen } from './theme-sections';

	/**
	 * The sign-in screens as the tenant's end users will see them, drawn from what is being edited
	 * (brand, colours, type, texts, logo, background, template). The toolbar picks the screen, the
	 * colour mode and phone or desktop width. Saved screen parts can be placed in the same frame;
	 * the standalone Storybook examples retain the sample outline when no screen is supplied.
	 *
	 * One outline only: the frame is the screen itself, at the full width of the column on
	 * desktop and narrowed to a phone's width (centred) on mobile, so the preview gets all the room.
	 * The content is a picture, not the page: it cannot be focused or clicked (inert), except the footer's links. Custom CSS is
	 * not applied here yet.
	 */
	interface Props {
		draft: ThemeDraft;
		/** The mode the screens are shown in: the one fixed, or (auto) the one being simulated. */
		scheme: 'light' | 'dark';
		screen?: PreviewScreen;
		mode?: 'light' | 'dark';
		/** One screen being edited, without a picker. */
		preview?: ScreenPreviewContent;
		/** Saved screens offered in the theme editor's picker. */
		previews?: readonly ScreenPreviewContent[];
		screensLoading?: boolean;
		note?: string;
	}

	let {
		draft,
		scheme,
		screen = $bindable('signIn'),
		mode = $bindable('light'),
		preview,
		previews,
		screensLoading = false,
		note
	}: Props = $props();

	// What is not set here is the real screens' own colour, in the mode shown.
	const defaults = $derived(paletteColours(draft.palette, scheme));
	// The colours set for the mode shown: the light ones, or the dark ones ('' = the palette's).
	const own = $derived(
		Object.fromEntries(
			THEME_COLOURS.map((colour) => [colour.field, draftColour(draft, colour, scheme)])
		) as Record<ThemeColourField, string>
	);
	const shape = $derived(paletteOf(draft.palette).shape);

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
	let selectedId = $state('');
	const actual = $derived(
		preview ?? previews?.find((item) => item.id === selectedId) ?? previews?.[0] ?? null
	);
	const localized = $derived(actual ? localizedScreenPreview(actual, draft.language) : null);
	const screenLabel = $derived(localized?.label ?? t(screenOption.label));
	const texts = $derived(draft.texts[draft.language]);
	// What an empty item falls back to is read in the language being edited, not the console's.
	// The heading is the screen's default wording, read in the language being edited.
	const title = $derived(
		tIn(draft.language, screen === 'signIn' ? 'th.preview.welcome' : screenOption.label)
	);
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
	// "Form bottom" belongs to Split's form side; without a side of its own it is the bottom. The
	// header and footer places need their bar: without it, under the card or along the bottom.
	const topbar = $derived.by(() => {
		const position = split ? draft.topbarPosition : draft.topbarPosition.replace(/^form_/, '');
		if (position.startsWith('header_') && !draft.header) return 'below_card';
		if (position.startsWith('footer_') && !draft.footer) {
			return position.replace(/^footer_/, 'bottom_');
		}
		return position;
	});
	/** The bar the choices sit in, and its side; null when they sit elsewhere. */
	const barTools = $derived.by(() => {
		const match = /^(header|footer)_(left|center|right)$/.exec(topbar);
		return match ? { bar: match[1], side: match[2] } : null;
	});
	// The link that switches between signing in and signing up: the last line of the card.
	const switchLink = $derived(
		screen === 'signIn'
			? tIn(draft.language, 'th.preview.toSignUp')
			: screen === 'signUp'
				? tIn(draft.language, 'th.preview.toSignIn')
				: null
	);
	const showTools = $derived((draft.themeToggle || draft.languageSelect) && topbar !== 'hidden');

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
		// A stored image is a path on the API, which the console may not serve itself.
		set(value ? apiAssetUrl(value) : null);
	}

	$effect(() => imageUrl(draft.logo, (url) => (logoUrl = url)));
	$effect(() => imageUrl(draft.backgroundImage, (url) => (backgroundUrl = url)));
	/**
	 * A set colour that text is laid on, as the Login UI takes it: hex (3, 6 or 8 digits) or rgb(),
	 * with the black or white label that reads better on it (its alpha left aside). Anything else
	 * is dropped there, and so here too: the palette's own colour applies.
	 */
	function labelled(colour: string): { fill: string; solid: string; label: string } | null {
		const value = colour.trim();
		let rgb = /^#[0-9a-f]{8}$/i.test(value)
			? splitAlpha(value).rgb
			: /^#/.test(value)
				? normalizeHex(value)
				: null;
		const channels =
			/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.exec(
				value
			);
		if (!rgb && channels) {
			const parts = channels.slice(1, 4).map(Number);
			if (parts.some((part) => part > 255)) return null;
			rgb = `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
		}
		if (!rgb) return null;
		const label =
			contrastRatio(rgb, '#000000') >= contrastRatio(rgb, '#ffffff') ? '#000000' : '#ffffff';
		return { fill: value, solid: rgb, label };
	}
	const field = $derived(labelled(own.fieldColor));
	// The main button: the colour set, opaque (its alpha left aside), under a black or white label
	// chosen against it, as the Login UI draws it.
	const accent = $derived(own.accent ? labelled(own.accent) : null);
	const button2 = $derived(labelled(own.secondaryButtonColor));
	// The picture's filters in order, as the Login UI draws them.
	const backgroundFilter = $derived(loginUIImageFilterCss(draft.backgroundFilters));
	// A blurred picture fades at its edges: it is drawn that much larger, as the Login UI's blur
	// (of what lies under the page) has no edge inside the screen.
	const backgroundBleed = $derived(
		2 * (draft.backgroundFilters.find((filter) => filter.name === 'blur')?.value ?? 0)
	);
	$effect(() => imageUrl(draft.panelImage, (url) => (panelUrl = url)));
	$effect(() => imageUrl(draft.cardImage, (url) => (cardUrl = url)));

	// The brand side's picture is its own; the background image runs behind the whole screen.
	const brandLayer = $derived(
		panelUrl
			? { url: panelUrl, opacity: draft.panelImageOpacity, gray: draft.panelImageGrayscale }
			: null
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
				><Icon name={scheme === 'dark' ? 'moon' : 'sun'} /></span
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
			{#if !preview}
				{#if previews !== undefined}
					{#if previews.length > 0}
						<Select
							label={t('th.preview.screen')}
							hideLabel
							options={previews.map((item) => ({
								value: item.id,
								label: localizedScreenPreview(item, draft.language).label
							}))}
							value={actual?.id ?? ''}
							onchange={(value) => (selectedId = value)}
						/>
					{/if}
				{:else}
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
				{/if}
			{/if}
			<SegmentedControl
				label={t('th.preview.mode')}
				hideLabel
				size="sm"
				options={[
					{ value: 'light', label: t('th.mode.light') },
					{ value: 'dark', label: t('th.mode.dark') }
				]}
				value={scheme}
				disabled={draft.mode !== 'auto'}
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
				data-scheme={scheme}
				data-template={draft.template}
				data-screen-id={actual?.id}
				lang={draft.language}
				dir={localeDir(draft.language)}
				style:--ol-bg={own.background || defaults.background}
				style:--ol-card={own.cardColor || defaults.card}
				style:--ol-panel={defaults.card}
				style:--ol-accent={accent?.solid || defaults.accent}
				style:--ol-link={own.linkColor || accent?.solid || defaults.accent}
				style:--ol-accent-text={accent?.label || labelled(defaults.accent)?.label}
				style:--ol-title={own.titleColor || defaults.title}
				style:--ol-text={own.textColor || defaults.text}
				style:--ol-copy={own.copyColor || defaults.copy}
				style:--ol-title-own={own.titleColor || undefined}
				style:--ol-copy-own={own.copyColor || undefined}
				style:--ol-header-bg={own.headerBackground || undefined}
				style:--ol-header-text={own.headerText || undefined}
				style:--ol-footer-bg={own.footerBackground || undefined}
				style:--ol-footer-text={own.footerText || undefined}
				style:--ol-field={field?.fill}
				style:--ol-field-text={field?.label}
				data-button2={button2 ? 'set' : undefined}
				style:--ol-button2={button2?.fill}
				style:--ol-button2-text={button2?.label}
				style:--ol-density={DENSITIES[draft.fontScale]}
				style:--ol-card-radius={`${shape.cardRadius}px`}
				style:--ol-control-radius={`${shape.controlRadius}px`}
				style:--ol-button-radius={`${shape.buttonRadius ?? shape.controlRadius}px`}
				style:--ol-field-radius={`${shape.fieldRadius ?? shape.controlRadius}px`}
				data-accent={accent ? 'set' : 'preset'}
				data-shadow={shape.shadow}
				data-frost={shape.frost ? 'true' : 'false'}
				style:font-family={FONT_STACKS[draft.font]}
			>
				{#if backgroundUrl}
					<span
						class="outline__image"
						style:background-image={`url("${backgroundUrl}")`}
						style:opacity={draft.backgroundOpacity / 100}
						style:filter={backgroundFilter || undefined}
						style:inset={backgroundBleed ? `-${backgroundBleed}px` : undefined}
					></span>
				{/if}
				<!-- The header runs along the top of the whole screen, over the brand panel too, as the footer
				     runs along the bottom. The brand panel has no header of its own. -->
				{#if draft.header}
					<header class="outline__header outline__bar" inert>
						{#each BAR_ALIGNS as zone (zone)}
							<div class="outline__zone outline__zone--{zone}">
								{#if draft.headerAlign === zone}{@render brand()}{/if}
								{#if showTools && barTools?.bar === 'header' && barTools.side === zone}
									{@render tools()}
								{/if}
							</div>
						{/each}
					</header>
				{/if}
				<div
					class="outline__stage"
					inert
					class:outline__stage--split={split}
					class:outline__stage--right={split && draft.splitSide === 'right'}
					class:outline__stage--formfull={split && draft.formFrame === 'full'}
					class:outline__stage--formcard={split && draft.formFrame === 'card'}
					class:outline__stage--wide={split && draft.splitWidth === 'wide'}
					class:outline__stage--card={split && draft.splitFrame === 'card'}
					class:outline__stage--over-image={split && !!backgroundUrl}
				>
					{#if split}
						<aside
							class="outline__panel"
							class:outline__panel--over-image={!!backgroundUrl}
							data-position={draft.brandPosition}
							data-align={draft.brandAlign}
						>
							{#if brandLayer}
								<span
									class="outline__image"
									style:background-image={`url("${brandLayer.url}")`}
									style:opacity={brandLayer.opacity / 100}
									style:filter={brandLayer.gray ? 'grayscale(1)' : undefined}
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
							<div class="outline__col" class:outline__col--wide={actual?.canvas === 'wide'}>
								<div class="outline__card">
									<!-- The login area's own picture, under what the box holds (not drawn in Minimal). -->
									{#if cardUrl && draft.template !== 'minimal'}
										<span
											class="outline__image"
											style:background-image={`url("${cardUrl}")`}
											style:opacity={draft.cardImageOpacity / 100}
											style:filter={draft.cardImageGrayscale ? 'grayscale(1)' : undefined}
										></span>
									{/if}
									{#if showTools && topbar === 'in_card'}{@render tools()}{/if}
									{#if !draft.header && !split}{@render brand()}{/if}
									{#if localized && actual}
										<ScreenPreview
											rows={localized.rows}
											settings={localized.settings}
											rowSettings={actual.rowSettings}
											choices={actual.choices}
											legacyYesNo={actual.legacyYesNo}
											wide={actual.canvas === 'wide'}
										/>
									{:else if previews !== undefined}
										<p class="outline__lead">
											{screensLoading ? t('common.loading') : t('sc.list.empty')}
										</p>
									{:else}
										<h3>{title}</h3>
										{#if screen === 'signIn'}
											<!-- This tenant has no password: passkey and email, and an external IdP (mock). -->
											<p class="outline__lead">{tIn(draft.language, 'th.preview.leadSignIn')}</p>
											<span class="outline__button">
												<Icon name="fingerprint" />{tIn(draft.language, 'th.preview.passkey')}
											</span>
											<span class="outline__divider">{tIn(draft.language, 'th.preview.or')}</span>
											<div class="outline__group">
												<span class="outline__label">{tIn(draft.language, 'th.preview.email')}</span
												>
												<span class="outline__field"></span>
											</div>
											<span class="outline__button outline__button--plain"
												>{tIn(draft.language, 'th.preview.continue')}</span
											>
											<span class="outline__button outline__button--plain"
												>{tIn(draft.language, 'th.preview.idp')}</span
											>
										{:else}
											{#if screen === 'signUp'}
												<div class="outline__group">
													<span class="outline__label"
														>{tIn(draft.language, 'th.preview.email')}</span
													>
													<span class="outline__field"></span>
												</div>
											{:else if screen === 'code'}
												<p class="outline__lead">{tIn(draft.language, 'th.preview.leadCode')}</p>
												<div class="outline__group">
													<span class="outline__label">{tIn(draft.language, 'th.screen.code')}</span
													>
													<span class="outline__field"></span>
												</div>
											{:else if screen === 'consent'}
												<p class="outline__lead">{tIn(draft.language, 'th.preview.leadConsent')}</p>
											{:else}
												<p class="outline__lead">{tIn(draft.language, 'th.preview.leadError')}</p>
											{/if}
											<span class="outline__button"
												>{tIn(draft.language, 'th.preview.continue')}</span
											>
										{/if}
										{#if switchLink}<p class="outline__switch">{switchLink}</p>{/if}
									{/if}
								</div>
								{#if showTools && topbar === 'below_card'}{@render tools()}{/if}
							</div>
						</div>
						<!-- Split: along the bottom of the form side alone. -->
						{#if showTools && topbar.startsWith('form_bottom_')}
							<div class="outline__tools outline__tools--bottom" data-at={topbar.slice(12)}>
								{@render tools()}
							</div>
						{/if}
					</div>
					<!-- The main area, between the header and the footer: its corner or its bottom edge. -->
					{#if showTools && topbar === 'top_right'}
						<div class="outline__tools">{@render tools()}</div>
					{:else if showTools && topbar.startsWith('bottom_')}
						<div class="outline__tools outline__tools--bottom" data-at={topbar.slice(7)}>
							{@render tools()}
						</div>
					{/if}
				</div>
				<!-- The footer runs along the bottom of the whole screen, under the brand panel too. -->
				{#if draft.footer}
					<!-- The one part that is not inert: its links work and open in a new window. -->
					<footer class="outline__footer outline__bar">
						{#each BAR_ALIGNS as zone (zone)}
							<div class="outline__zone outline__zone--{zone}">
								{#if draft.footerAlign === zone}
									<p class="outline__footer-text">
										{#each footerParts as part, index (index)}
											{#if 'href' in part}
												<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a
												>
											{:else}
												{part.text}
											{/if}
										{/each}
									</p>
								{/if}
								{#if showTools && barTools?.bar === 'footer' && barTools.side === zone}
									<span class="outline__bar-tools" inert>{@render tools()}</span>
								{/if}
							</div>
						{/each}
					</footer>
				{/if}
			</div>
		</div>
	</div>

	<p class="theme-preview__note">{note ?? t('th.preview.note')}</p>
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
		background-color: var(--ol-bg);
		color: var(--ol-text);
		font-size: var(--preview-fs-body);
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
		/* One row the height of the stage: a taller form must not stretch the row (and the brand panel) over the footer. */
		grid-template-rows: minmax(0, 1fr);
		min-width: 0;
		min-height: 0;
	}

	/* Narrow form: the brand side takes 3/5. "Right" puts the brand side after the form. */
	.outline__stage--split {
		--brand-track: 3fr;
		--form-track: 2fr;
		--form-share: 40%;
		grid-template-columns: minmax(0, var(--brand-track)) minmax(0, var(--form-track));
	}

	.outline__stage--wide {
		--brand-track: 2fr;
		--form-track: 3fr;
		--form-share: 60%;
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
		background: var(--ol-panel);
		box-shadow: var(--shadow-lg);
	}

	/*
	 * A framed split screen over the background image: the image shows inside the frame too, under
	 * a translucent tint of the panel colour (the real screen draws it there at 70%).
	 */
	.outline__stage--card.outline__stage--over-image {
		background: color-mix(in srgb, var(--ol-panel) 70%, transparent);
	}

	.outline__panel {
		position: relative;
		overflow: hidden;
		display: grid;
		align-content: center;
		padding: 48px;
		/*
		 * With no background image the brand side is painted: a fill from the accent colour. Its own
		 * picture, if it has one, is laid over the fill with its opacity; the text on it is the
		 * inverse of the page.
		 */
		background: linear-gradient(
			150deg,
			color-mix(in srgb, var(--ol-accent) 78%, var(--ol-panel)),
			var(--ol-accent)
		);
		--panel-title: var(--text-inverse);
		--panel-copy: color-mix(in srgb, var(--text-inverse) 80%, transparent);
		color: var(--panel-title);
	}

	/*
	 * Over the background image the brand side is see-through, as on the real screen (the image is
	 * shared by both sides): no fill, only a scrim like the real screen's (in a named colour, as the
	 * console allows no literal colours), darker where the content sits. The scrim lies over the
	 * brand side's own picture and under the text, as on the real screen.
	 */
	.outline__panel--over-image {
		/* The real screen's light ink for the brand side, in either mode: the scrim is dark. */
		--panel-title: ghostwhite;
		--panel-copy: color-mix(in srgb, ghostwhite 80%, transparent);
		isolation: isolate;
		background: none;
	}

	.outline__panel--over-image::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
		background: linear-gradient(
			to top,
			color-mix(in srgb, midnightblue 62%, transparent),
			color-mix(in srgb, midnightblue 8%, transparent) 58%,
			transparent
		);
	}

	.outline__panel--over-image[data-position='top']::before {
		background: linear-gradient(
			to bottom,
			color-mix(in srgb, midnightblue 62%, transparent),
			color-mix(in srgb, midnightblue 8%, transparent) 58%,
			transparent
		);
	}

	.outline__panel--over-image[data-position='center']::before {
		background: color-mix(in srgb, midnightblue 38%, transparent);
	}

	.outline__panel--over-image .outline__panel-content {
		z-index: 2;
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
		font-size: var(--preview-fs-hero);
		line-height: var(--preview-lh-hero);
		color: var(--ol-title-own, var(--panel-title));
	}

	.outline__panel p {
		margin: 0;
		line-height: var(--lh-relaxed);
		color: var(--ol-copy-own, var(--panel-copy));
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
		font-size: var(--preview-fs-eyebrow);
		font-weight: var(--fw-semibold);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ol-copy-own, var(--panel-copy));
	}

	/*
	 * The form side over the page's picture: frosted, as the real screen has it. "Brand only" has
	 * no picture behind it, so it is a plain card (or the fill chosen for it).
	 */
	.outline__stage--split .outline__main {
		background: color-mix(in srgb, var(--ol-panel) 72%, transparent);
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

	/*
	 * Split, form frame "Floating card": the brand panel (its fill and its picture) runs behind the
	 * whole stage and the form area floats over it, with no frosted side of its own. The panel's
	 * content keeps to its own side by leaving the form side's share free.
	 */
	.outline__stage--formcard .outline__panel {
		grid-column: 1 / -1;
		grid-row: 1;
		padding-inline-end: calc(var(--form-share) + 48px);
	}

	.outline__stage--formcard.outline__stage--right .outline__panel {
		padding-inline: calc(var(--form-share) + 48px) 48px;
	}

	.outline__stage--formcard .outline__main {
		grid-column: 2;
		grid-row: 1;
		z-index: 1;
		border: 0;
		background: none;
		backdrop-filter: none;
	}

	.outline__stage--formcard.outline__stage--right .outline__main {
		grid-column: 1;
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
		padding: 20px 40px;
		background: var(--ol-header-bg, transparent);
	}

	/* The header and the footer are bars of three zones (start, middle, end), as the Login UI's:
	   what each shows sits in the zone its alignment names, the choices in theirs. */
	.outline__bar {
		display: grid;
		/* The sides keep room for what they hold (the choices); the middle gives way and wraps. The
		   zones are left, middle and right as drawn, in a right-to-left language too. */
		grid-template-columns: minmax(max-content, 1fr) minmax(0, auto) minmax(max-content, 1fr);
		align-items: center;
		gap: 16px;
		direction: ltr;
	}

	.outline[dir='rtl'] .outline__zone > :global(*) {
		direction: rtl;
	}

	/* On a phone the zones that hold something stack, each still at its own side. */
	.screen--mobile .outline__bar {
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
	}

	.screen--mobile .outline__zone:empty {
		display: none;
	}

	.outline__zone {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.outline__zone--left {
		justify-content: flex-start;
		text-align: left;
	}

	.outline__zone--center {
		justify-content: center;
		text-align: center;
	}

	.outline__zone--right {
		justify-content: flex-end;
		text-align: right;
	}

	.outline__header .brand__name {
		color: var(--ol-header-text, var(--ol-title, var(--text-primary)));
	}

	.outline__header .brand__tagline {
		color: var(--ol-header-text, var(--ol-copy, var(--ol-text, var(--text-secondary))));
	}

	/* The link that switches between signing in and signing up: the last line of the card, spaced
	   by the card's own gap. */
	.outline__card .outline__switch {
		margin: 0;
		text-align: center;
		font-size: var(--preview-fs-small);
		font-weight: var(--fw-semibold);
		color: var(--ol-link);
	}

	/* Floating over the stage or over the form side: its top end corner. */
	.outline__tools {
		position: absolute;
		z-index: 2;
		inset-block-start: 16px;
		inset-inline-end: 24px;
	}

	/* Along the bottom edge (of the stage, or of the form side): left, centre or right. */
	.outline__tools--bottom {
		inset-block: auto 16px;
		inset-inline: auto;
	}

	.outline__tools--bottom[data-at='left'] {
		inset-inline-start: 24px;
	}

	.outline__tools--bottom[data-at='center'] {
		inset-inline-start: 50%;
		transform: translateX(-50%);
	}

	.outline__tools--bottom[data-at='right'] {
		inset-inline-end: 24px;
	}

	.tools {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ol-text);
		font-size: var(--preview-fs-small);
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
		/* As the form area: its colour, under the body text colour set to be read on it. */
		background: var(--ol-card);
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
		background: var(--ol-footer-bg, transparent);
		color: var(--ol-footer-text, var(--ol-copy, var(--ol-text, var(--text-secondary))));
		font-size: var(--preview-fs-small);
	}

	.outline__footer-text {
		margin: 0;
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
		/* The font scale sets how roomy the form is (the real screens' compact / comfortable / spacious). */
		gap: calc(16px * var(--ol-density, 1));
		width: 100%;
		padding: calc(32px * var(--ol-density, 1));
		border: 1px solid var(--border);
		border-radius: var(--ol-card-radius, var(--radius-lg));
		background: var(--ol-card);
	}

	/* The palette's shape: its shadow, and frosted glass over the page. */
	.outline[data-shadow='soft'] .outline__card {
		box-shadow:
			0 1px 2px color-mix(in srgb, var(--ol-text) 6%, transparent),
			0 10px 28px color-mix(in srgb, var(--ol-text) 10%, transparent);
	}

	/* Swiss Grid: a ring in ink in place of a shadow. */
	.outline[data-shadow='ring'] .outline__card {
		border-color: var(--ol-text);
		box-shadow: none;
	}

	/* Frosted glass: a light border, one light line along the top, and a soft shadow. */
	.outline[data-shadow='glass'] .outline__card {
		border-color: color-mix(in srgb, white 65%, transparent);
		box-shadow:
			0 8px 32px color-mix(in srgb, var(--ol-text) 12%, transparent),
			inset 0 1px 0 color-mix(in srgb, white 70%, transparent);
	}

	/* Clear glass: a halo, a diagonal reflection, and an iridescent rim (a ring cut out of a filled
	   box), as on the real screens. */
	.outline[data-shadow='clear'] .outline__card {
		border-color: transparent;
		box-shadow:
			0 0 24px color-mix(in srgb, var(--ol-text) 22%, transparent),
			0 12px 32px color-mix(in srgb, var(--ol-text) 10%, transparent);
	}

	.outline[data-shadow='clear'] .outline__card::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		padding: 1.5px;
		pointer-events: none;
		/* The Login UI's iridescent rim, in named colours: cyan, white and grey light. */
		background:
			radial-gradient(at 0% 0%, azure 0, transparent 50%),
			radial-gradient(at 29% 0%, paleturquoise 0, transparent 50%),
			radial-gradient(at 100% 62%, white 0, transparent 50%),
			radial-gradient(at 90% 98%, lightcyan 0, transparent 50%),
			radial-gradient(at 26% 100%, slategray 0, transparent 50%),
			color-mix(in srgb, white 60%, transparent);
		-webkit-mask:
			linear-gradient(black 0 0) content-box,
			linear-gradient(black 0 0);
		-webkit-mask-composite: xor;
		mask:
			linear-gradient(black 0 0) content-box exclude,
			linear-gradient(black 0 0);
		mask-composite: exclude;
	}

	.outline[data-frost='true'] .outline__card {
		background: color-mix(in srgb, var(--ol-card) 55%, transparent);
		backdrop-filter: blur(14px);
	}

	/* Glass: its colour is already translucent (it carries an alpha), so it is drawn as it is.
	   Frosted glass blurs what is behind it; clear glass hardly does, and carries a reflection. */
	.outline[data-shadow='glass'] .outline__card {
		background: var(--ol-card);
		backdrop-filter: blur(24px) saturate(160%);
	}

	.outline[data-shadow='clear'] .outline__card {
		background:
			linear-gradient(120deg, color-mix(in srgb, white 42%, transparent), transparent 46%),
			var(--ol-card);
		backdrop-filter: blur(3px) saturate(115%);
	}

	/* Split, form frame "Full": the form area fills its side, no card around it. */
	.outline__stage--formfull .outline__body {
		padding: 0;
		place-items: stretch;
	}

	.outline__stage--formfull .outline__col {
		grid-template-rows: minmax(0, 1fr) auto;
		width: 100%;
		height: 100%;
	}

	.outline__stage--formfull .outline__card {
		align-content: center;
		height: 100%;
		border: 0;
		border-radius: 0;
	}

	/* The card, with the topbar below it when it sits there. */
	.outline__col {
		display: grid;
		justify-items: center;
		gap: 16px;
		width: min(100%, 420px);
	}

	.outline__col--wide {
		width: min(100%, 720px);
	}

	.outline__card > :global(.tools) {
		justify-self: end;
	}

	/* What the box holds sits over its picture. */
	.outline__card > :global(*:not(.outline__image)) {
		position: relative;
	}

	/* Minimal has no card box: the form sits on the page, whatever the palette's shape. */
	.outline[data-template='minimal'] .outline__card {
		border-color: transparent;
		background: transparent;
		backdrop-filter: none;
		box-shadow: none;
	}

	/* No card box, so no rim either (nor on a split side the form fills). */
	.outline[data-template='minimal'] .outline__card::after,
	.outline__stage--formfull .outline__card::after {
		display: none;
	}

	.outline__card h3 {
		margin: 0;
		font-size: var(--preview-fs-heading);
		color: var(--ol-title, var(--text-primary));
	}

	.outline__card p {
		margin: 0;
		font-size: var(--preview-fs-label);
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
		font-size: var(--preview-fs-small);
	}

	.brand__name {
		font-size: var(--preview-fs-name);
		font-weight: var(--fw-bold);
		color: var(--ol-title, var(--text-primary));
	}

	.outline__group {
		display: grid;
		gap: 6px;
	}

	.outline__label {
		color: var(--ol-text);
		font-size: var(--preview-fs-label);
		font-weight: var(--fw-medium);
	}

	.outline__lead {
		margin: 0;
		color: var(--ol-text);
		font-size: var(--preview-fs-label);
		line-height: var(--lh-relaxed);
	}

	.outline__link {
		color: var(--ol-accent);
		font-size: var(--preview-fs-label);
	}

	.outline__field {
		display: block;
		height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--ol-field-radius, var(--ol-control-radius, var(--radius-sm)));
		background: var(--ol-field, var(--bg-input));
	}

	.outline__button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 44px;
		font-size: var(--preview-fs-label);
		border-radius: var(--ol-button-radius, var(--ol-control-radius, var(--radius-sm)));
		background: var(--ol-accent);
		color: var(--ol-accent-text, var(--text-inverse));
		font-weight: var(--fw-semibold);
		--icon-size: var(--icon-md);
	}

	/* Glass: until an accent is set the main button is glass tinted by the accent (as on the real
	   screens); a set accent fills it. Its label is then the title colour. */
	.outline:is([data-shadow='glass'], [data-shadow='clear'])[data-accent='preset']
		.outline__button:not(.outline__button--plain) {
		border: 1px solid color-mix(in srgb, white 60%, transparent);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--ol-accent) 40%, transparent),
			color-mix(in srgb, var(--ol-accent) 26%, transparent)
		);
		color: var(--ol-title);
	}

	.outline:is([data-shadow='glass'], [data-shadow='clear']) .outline__button--plain {
		border-color: color-mix(in srgb, white 60%, transparent);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, white 45%, transparent),
			color-mix(in srgb, white 14%, transparent)
		);
	}

	/* The other methods: a plain button, the accent kept for the main one. */
	.outline__button--plain {
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--ol-text) 4%, var(--ol-card));
		color: var(--ol-text);
	}

	/* A set secondary button colour, under the palette's sheen (as on the real screens), with the
	   black or white label that reads on it. */
	.outline[data-button2='set'] .outline__button--plain {
		background-color: var(--ol-button2);
		color: var(--ol-button2-text, var(--ol-text));
	}

	/* "or" between the methods, on a line. */
	.outline__divider {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		color: var(--ol-copy);
		font-size: var(--preview-fs-small);
	}

	.outline__divider::before,
	.outline__divider::after {
		content: '';
		height: 1px;
		background: var(--border);
	}
</style>
