<script lang="ts">
	/**
	 * Renders its children the way `src/routes/+layout.svelte` does: Login UI stores in context
	 * and a `.login-ui-theme-boundary` carrying the data-* attributes that app.css keys on.
	 *
	 * The boundary is repeated here instead of imported because the layout owns it inline; the
	 * `frame-parity` test fails when the two attribute lists drift apart.
	 */
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import type { AuthenticationMethodsResponse } from '#lib/api/authentication-methods.js';
	import { toDocumentDirection } from '#lib/i18n/locales.js';
	import { applyAuthenticationMethodsToLoginUI } from '#lib/stores/login-ui-configuration.js';
	import { initializeLoginUIStores } from '#lib/stores/login-ui-context.js';
	import { buildLoginUIConfig, type LoginUIOverrides } from './config';
	import { sbGlobals, type Scheme, type ThemeTemplate } from './globals.svelte';
	import type { PaletteId, TemplateId } from '#lib/palettes.js';

	type Props = {
		children: Snippet;
		/** `page` fills the viewport like a route; `cell` fits a fixed box; `surface` is for parts. */
		fit?: 'page' | 'cell' | 'surface';
		/** Cell height in px when `fit` is `cell`. */
		height?: number;
		/** Explicit values pin a frame; omitted values follow the toolbar. */
		template?: TemplateId;
		palette?: PaletteId;
		/** One of the four pre-palette names: pins both template and palette (the older gallery cells). */
		theme?: ThemeTemplate;
		scheme?: Scheme;
		/** What the Admin console would save for this tenant, on top of the theme's defaults. */
		ui?: LoginUIOverrides;
	};

	let {
		children,
		fit = 'surface',
		height = 640,
		theme,
		template,
		palette,
		scheme,
		ui
	}: Props = $props();

	const stores = initializeLoginUIStores();
	const { brandingStore, loginUIPageStore, themeStore } = stores;

	// A part is shown on a centred page whatever the theme's own layout is: a split panel grid
	// around a single button says nothing about the button.
	const effectiveUi = $derived<LoginUIOverrides | undefined>(
		fit === 'surface'
			? { ...ui, pageTemplate: { layout: 'centered_card', ...ui?.pageTemplate } }
			: ui
	);

	const response = $derived<AuthenticationMethodsResponse>({
		methods: {} as AuthenticationMethodsResponse['methods'],
		ui: buildLoginUIConfig(
			theme
				? { theme, scheme: scheme ?? sbGlobals.scheme }
				: {
						template: template ?? sbGlobals.template,
						palette: palette ?? sbGlobals.palette,
						scheme: scheme ?? sbGlobals.scheme
					},
			effectiveUi
		),
		meta: { cacheTTL: 0, revision: 'storybook' }
	});

	// Applied once during setup so the first paint is already themed, then on every change.
	applyAuthenticationMethodsToLoginUI(
		untrack(() => response),
		stores
	);
	$effect.pre(() => {
		const next = response;
		untrack(() => applyAuthenticationMethodsToLoginUI(next, stores));
	});

	const direction = $derived.by(() => {
		void $LL;
		return toDocumentDirection(getLocale());
	});
</script>

<div
	class="login-ui-theme-boundary"
	data-theme={themeStore.mode}
	data-login-theme={loginUIPageStore.themeTemplate}
	data-login-template={loginUIPageStore.template}
	data-login-palette={loginUIPageStore.palette}
	data-form-frame={loginUIPageStore.formFrame}
	data-page-layout={loginUIPageStore.layout}
	data-font-family={loginUIPageStore.fontFamily}
	data-font-scale={loginUIPageStore.fontScale}
	data-language-switcher-position={loginUIPageStore.languageSwitcherPosition}
	data-topbar-position={loginUIPageStore.topbarPosition}
	data-header-style={loginUIPageStore.headerStyle}
	data-footer-style={loginUIPageStore.footerStyle}
	data-logo-layout={loginUIPageStore.logoLayout}
	data-split-frame={loginUIPageStore.splitFrame}
	data-split-panel-side={loginUIPageStore.splitPanelSide}
	data-split-panel-width={loginUIPageStore.splitPanelWidth}
	data-split-background-mode={loginUIPageStore.splitBackgroundMode}
	data-has-page-background-image={loginUIPageStore.backgroundImageUrl ? 'true' : 'false'}
	data-has-login-panel-background-image={loginUIPageStore.loginPanelBackgroundImageUrl
		? 'true'
		: 'false'}
	data-brand-content-mode={loginUIPageStore.brandContentMode}
	data-brand-position={loginUIPageStore.brandPosition}
	data-brand-align={loginUIPageStore.brandAlign}
	data-logo-display={loginUIPageStore.logoDisplay}
	data-brand-panel-logo-display={loginUIPageStore.brandPanelLogoDisplay}
	data-has-brand-panel-image={loginUIPageStore.brandPanelImageUrl ? 'true' : 'false'}
	data-has-form-area-color={loginUIPageStore.formAreaColor ? 'true' : 'false'}
	data-has-accent-color={loginUIPageStore.accentColor ? 'true' : 'false'}
	data-branding-loaded={brandingStore.isLoaded ? '' : undefined}
	style:--login-page-background-color={loginUIPageStore.backgroundColor || undefined}
	style:--login-accent-color={loginUIPageStore.accentColor || undefined}
	style:--login-accent-text={loginUIPageStore.accentTextColor || undefined}
	style:--login-title-color={loginUIPageStore.titleColor || undefined}
	style:--login-text-color={loginUIPageStore.textColor || undefined}
	style:--login-copy-color={loginUIPageStore.copyColor || undefined}
	style:--login-page-background-layer={loginUIPageStore.backgroundImageLayer ?? undefined}
	style:--login-panel-background-layer={loginUIPageStore.loginPanelBackgroundLayer ?? undefined}
	style:--login-panel-background-fill={loginUIPageStore.loginPanelBackgroundColor
		? loginUIPageStore.loginPanelBackgroundGradientColor
			? `linear-gradient(135deg, ${loginUIPageStore.loginPanelBackgroundColor}, ${loginUIPageStore.loginPanelBackgroundGradientColor})`
			: loginUIPageStore.loginPanelBackgroundColor
		: undefined}
	style:--login-panel-background-opacity={String(
		loginUIPageStore.loginPanelBackgroundOpacity / 100
	)}
	style:--login-form-area-color={loginUIPageStore.formAreaColor || undefined}
	style:--login-page-background-opacity={String(loginUIPageStore.backgroundImageOpacity / 100)}
	style:--login-brand-panel-image-layer={loginUIPageStore.brandPanelImageLayer ?? undefined}
	style:--login-brand-panel-image-opacity={String(loginUIPageStore.brandPanelImageOpacity / 100)}
>
	<div class="sb-box" data-fit={fit} style:--sb-cell-height={`${height}px`} dir={direction}>
		{#if fit === 'surface'}
			<!-- .auth-page defines the control, type and spacing variables the parts are sized by. -->
			<div class="auth-page sb-surface">
				{@render children()}
			</div>
		{:else}
			{@render children()}
		{/if}
	</div>
</div>

<style>
	.login-ui-theme-boundary {
		display: contents;
	}

	.sb-box[data-fit='page'] {
		display: contents;
	}

	/* A part on the page background, the way it sits behind a card on a real page. */
	.sb-box[data-fit='surface'] :global(.sb-surface) {
		min-height: 0;
		padding: 24px;
		align-items: stretch;
		justify-content: flex-start;
		border-radius: var(--radius-lg);
	}

	/* A whole page in a fixed box, so several themes can be compared side by side. */
	.sb-box[data-fit='cell'] {
		height: var(--sb-cell-height);
		overflow: auto;
		position: relative;
		isolation: isolate;
		border: 1px solid var(--border, rgba(128, 128, 128, 0.3));
		border-radius: var(--radius-lg);
		/* `fixed` and viewport units inside a cell must resolve against the cell. */
		transform: translateZ(0);
	}

	.sb-box[data-fit='cell'] :global(.auth-page) {
		min-height: 100%;
	}

	/* The split layout is a fixed-height grid (it scrolls inside), so it needs the box height. */
	.sb-box[data-fit='cell'] :global([data-page-layout='split_panel'] .auth-page) {
		height: 100%;
	}
</style>
