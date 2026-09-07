<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		scopedSettingsAPI,
		adminSettingsAPI,
		SettingsConflictError,
		convertPatchesToAPIRequest,
		type CategoryMetaFull,
		type CategorySettings,
		type ScopeContext,
		type SettingsPatchResult,
		type UIPatch
	} from '$lib/api/admin-settings';
	import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import SanitizedHtmlPreview from '$lib/components/admin/SanitizedHtmlPreview.svelte';
	import {
		DEFAULT_LOGIN_UI_FOOTER_TEXTS,
		DEFAULT_LOGIN_UI_PAGE_TITLES,
		DEFAULT_LOGIN_UI_TAGLINES,
		LOGIN_UI_LOCALE_OPTIONS,
		isLoginUILocale,
		resolveEnabledLoginUILocalesByEnglishName,
		type LoginUILocale
	} from '$lib/login-ui/locales';
	import { sanitizeFooterHtml } from '$lib/login-ui/footer-html';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { createAccordion, melt } from '@melt-ui/svelte';

	const CATEGORY = 'login-ui';
	const LOGIN_UI_PUBLISH_KEYS = [
		'login-ui.theme',
		'login-ui.variant',
		'login-ui.theme_template',
		'login-ui.page_layout',
		'login-ui.font_family',
		'login-ui.font_scale',
		'login-ui.background_color',
		'login-ui.accent_color',
		'login-ui.title_color',
		'login-ui.text_color',
		'login-ui.copy_color',
		'login-ui.brand_name',
		'login-ui.logo_url',
		'login-ui.favicon_url',
		'login-ui.thumbnail_url',
		'login-ui.logo_display',
		'login-ui.logo_layout',
		'login-ui.brand_panel_title',
		'login-ui.brand_panel_text',
		'login-ui.supported_locales',
		'login-ui.background_image_url',
		'login-ui.login_panel_background_image_url',
		'login-ui.custom_css',
		'login-ui.header_enabled',
		'login-ui.subtitle_enabled',
		'login-ui.footer_enabled',
		'login-ui.powered_by_enabled',
		'login-ui.auth_switch_link_enabled',
		'login-ui.topbar_position',
		'login-ui.theme_toggle_enabled',
		'login-ui.language_select_enabled',
		'login-ui.language_switcher_position',
		'login-ui.header_style',
		'login-ui.footer_style',
		'login-ui.split_frame',
		'login-ui.split_panel_side',
		'login-ui.split_panel_width',
		'login-ui.split_background_mode',
		'login-ui.login_panel_background_color',
		'login-ui.login_panel_background_gradient_color',
		'login-ui.login_panel_background_opacity',
		'login-ui.brand_content_mode',
		'login-ui.brand_position',
		'login-ui.brand_align',
		'login-ui.header_text',
		'login-ui.text_localizations',
		'login-ui.footer_text',
		'login-ui.footer_links',
		'login-ui.custom_blocks',
		'login-ui.custom_themes'
	] as const;

	type ThemeTemplateOption = {
		id: 'classic' | 'meridian' | 'split-brand-panel' | 'fullbleed-glass';
		name: string;
		description: string;
		layout: 'centered_card' | 'split_panel' | 'fullbleed_card';
		theme: 'light' | 'dark';
		variant: string;
		backgroundColor: string;
		fontFamily: 'system' | 'rounded' | 'serif' | 'mono';
		swatch: string[];
		topbarPosition?: string;
		headerStyle?: string;
		footerStyle?: string;
		logoLayout?: string;
		splitPanelSide?: string;
		splitPanelWidth?: string;
		splitBackgroundMode?: string;
		brandContentMode?: string;
		brandPosition?: string;
		brandAlign?: string;
		brandPanelTitle?: string;
		brandPanelText?: string;
	};
	type ThemePreviewSurface = 'login' | 'registration' | 'code' | 'consent' | 'account' | 'error';
	type ThemePreviewColorMode = 'light' | 'dark';
	type ThemePreviewViewport = 'desktop' | 'mobile';
	type FooterLinkPreview = {
		label: string;
		href: string;
	};
	type ThemeTextField =
		| 'tagline'
		| 'brandPanelTitle'
		| 'brandPanelText'
		| 'footerText'
		| 'loginTitle'
		| 'registrationTitle'
		| 'accountTitle';
	type ThemeTextLocalizations = Partial<
		Record<LoginUILocale, Partial<Record<ThemeTextField, string>>>
	>;

	const themeTemplateOptions: ThemeTemplateOption[] = [
		{
			id: 'meridian',
			name: 'Meridian',
			description: 'Centered card, cobalt on cool paper, image optional.',
			layout: 'centered_card',
			theme: 'light',
			variant: 'beige',
			backgroundColor: '',
			fontFamily: 'system',
			swatch: ['#eef1f6', '#ffffff', '#2f52c4']
		},
		{
			id: 'split-brand-panel',
			name: 'Split Brand Panel',
			description: 'Two-column page with a brand panel and compact form area.',
			layout: 'split_panel',
			theme: 'light',
			variant: 'beige',
			backgroundColor: '',
			fontFamily: 'system',
			swatch: ['#101a38', '#f7f9fc', '#2f52c4'],
			topbarPosition: 'bottom_right',
			splitPanelSide: 'left',
			splitPanelWidth: 'narrow',
			splitBackgroundMode: 'shared',
			brandContentMode: 'logo_copy',
			brandPosition: 'center',
			brandAlign: 'left',
			brandPanelTitle: 'Welcome to your account.',
			brandPanelText: 'Add supporting guidance or brand messaging for this sign-in experience.'
		},
		{
			id: 'fullbleed-glass',
			name: 'Full-Bleed Glass',
			description: 'Full-bleed visual background with a translucent form surface.',
			layout: 'fullbleed_card',
			theme: 'dark',
			variant: 'brown',
			backgroundColor: '',
			fontFamily: 'system',
			swatch: ['#17100c', '#e8623f', '#f6efe9'],
			topbarPosition: 'below_card',
			headerStyle: 'center',
			footerStyle: 'simple',
			logoLayout: 'stack'
		},
		{
			id: 'classic',
			name: 'Classic',
			description: 'Legacy Authrim look driven by the light/dark color variants.',
			layout: 'centered_card',
			theme: 'light',
			variant: 'beige',
			backgroundColor: '',
			fontFamily: 'system',
			swatch: ['#eeeae3', '#fffdf8', '#2c2724']
		}
	];

	type CustomTheme = {
		id: string;
		name: string;
		base: ThemeTemplateOption['id'];
		created_at: number;
		updated_at: number;
		values: Record<string, unknown>;
		account_page_id?: string | null;
	};
	type CustomThemesDoc = { themes: CustomTheme[]; active: string | null };
	type AssetUrlKey =
		| 'login-ui.logo_url'
		| 'login-ui.background_image_url'
		| 'login-ui.login_panel_background_image_url'
		| 'login-ui.favicon_url'
		| 'login-ui.thumbnail_url';
	type AssetKind = 'logo' | 'background' | 'panel-background' | 'favicon' | 'thumbnail';

	const MAX_CUSTOM_THEMES = 24;
	const THEME_VALUE_KEYS = new Set([
		'login-ui.theme',
		'login-ui.variant',
		'login-ui.page_layout',
		'login-ui.font_family',
		'login-ui.font_scale',
		'login-ui.background_color',
		'login-ui.accent_color',
		'login-ui.title_color',
		'login-ui.text_color',
		'login-ui.copy_color',
		'login-ui.brand_name',
		'login-ui.logo_url',
		'login-ui.background_image_url',
		'login-ui.login_panel_background_image_url',
		'login-ui.favicon_url',
		'login-ui.thumbnail_url',
		'login-ui.logo_display',
		'login-ui.logo_layout',
		'login-ui.brand_panel_title',
		'login-ui.brand_panel_text',
		'login-ui.custom_css',
		'login-ui.header_enabled',
		'login-ui.subtitle_enabled',
		'login-ui.footer_enabled',
		'login-ui.powered_by_enabled',
		'login-ui.auth_switch_link_enabled',
		'login-ui.topbar_position',
		'login-ui.theme_toggle_enabled',
		'login-ui.language_select_enabled',
		'login-ui.language_switcher_position',
		'login-ui.header_style',
		'login-ui.footer_style',
		'login-ui.split_frame',
		'login-ui.split_panel_side',
		'login-ui.split_panel_width',
		'login-ui.split_background_mode',
		'login-ui.login_panel_background_color',
		'login-ui.login_panel_background_gradient_color',
		'login-ui.login_panel_background_opacity',
		'login-ui.brand_content_mode',
		'login-ui.brand_position',
		'login-ui.brand_align',
		'login-ui.header_text',
		'login-ui.text_localizations',
		'login-ui.footer_text',
		'login-ui.footer_links',
		'login-ui.custom_blocks'
	]);

	type Choice = { value: string; label: string };
	const PAGE_LAYOUT_CHOICES: Choice[] = [
		{ value: 'centered_card', label: 'Centered card' },
		{ value: 'split_panel', label: 'Split panel' },
		{ value: 'fullbleed_card', label: 'Full-bleed' }
	];
	const MODE_CHOICES: Choice[] = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];
	const VARIANT_CHOICES: Choice[] = [
		{ value: 'beige', label: 'Beige (light)' },
		{ value: 'blue-gray', label: 'Blue gray (light)' },
		{ value: 'green', label: 'Green (light)' },
		{ value: 'brown', label: 'Brown (dark)' },
		{ value: 'navy', label: 'Navy (dark)' },
		{ value: 'slate', label: 'Slate (dark)' }
	];
	const FONT_FAMILY_CHOICES: Choice[] = [
		{ value: 'system', label: 'System' },
		{ value: 'rounded', label: 'Rounded' },
		{ value: 'serif', label: 'Serif' },
		{ value: 'mono', label: 'Mono' }
	];
	const FONT_SCALE_CHOICES: Choice[] = [
		{ value: 'compact', label: 'Compact' },
		{ value: 'comfortable', label: 'Comfortable' },
		{ value: 'spacious', label: 'Spacious' }
	];
	const HEADER_STYLE_CHOICES: Choice[] = [
		{ value: 'center', label: 'Centered' },
		{ value: 'bar', label: 'Bar' }
	];
	const FOOTER_STYLE_CHOICES: Choice[] = [
		{ value: 'simple', label: 'Simple' },
		{ value: 'bar', label: 'Bar' }
	];
	const LOGO_DISPLAY_CHOICES: Choice[] = [
		{ value: 'auto', label: 'Auto (image, then text)' },
		{ value: 'image', label: 'Image only' },
		{ value: 'text', label: 'Text only' },
		{ value: 'hidden', label: 'Hidden' }
	];
	const LOGO_LAYOUT_CHOICES: Choice[] = [
		{ value: 'stack', label: 'Stacked' },
		{ value: 'row', label: 'Row' }
	];
	const TOPBAR_CHOICES: Choice[] = [
		{ value: 'below_card', label: 'Below card' },
		{ value: 'in_card', label: 'Inside card' },
		{ value: 'top_right', label: 'Top right' },
		{ value: 'bottom_left', label: 'Bottom left' },
		{ value: 'bottom_center', label: 'Bottom center' },
		{ value: 'bottom_right', label: 'Bottom right' },
		{ value: 'hidden', label: 'Hidden' }
	];
	const SPLIT_FRAME_CHOICES: Choice[] = [
		{ value: 'full', label: 'Full page' },
		{ value: 'card', label: 'Floating card' }
	];
	const SPLIT_SIDE_CHOICES: Choice[] = [
		{ value: 'left', label: 'Brand left' },
		{ value: 'right', label: 'Brand right' }
	];
	const SPLIT_WIDTH_CHOICES: Choice[] = [
		{ value: 'narrow', label: 'Narrow form (2/5)' },
		{ value: 'wide', label: 'Wide form (3/5)' }
	];
	const SPLIT_BACKGROUND_MODE_CHOICES: Choice[] = [
		{ value: 'shared', label: 'Shared image' },
		{ value: 'brand', label: 'Brand only' },
		{ value: 'panel', label: 'Panel image' }
	];
	const BRAND_CONTENT_CHOICES: Choice[] = [
		{ value: 'logo_copy', label: 'Logo + copy' },
		{ value: 'logo', label: 'Logo only' },
		{ value: 'none', label: 'None' }
	];
	const BRAND_POSITION_CHOICES: Choice[] = [
		{ value: 'top', label: 'Top' },
		{ value: 'center', label: 'Center' },
		{ value: 'bottom', label: 'Bottom' }
	];
	const BRAND_ALIGN_CHOICES: Choice[] = [
		{ value: 'left', label: 'Left' },
		{ value: 'center', label: 'Center' },
		{ value: 'right', label: 'Right' }
	];

	const {
		elements: {
			root: previewInspectorRoot,
			item: previewInspectorItem,
			trigger: previewInspectorTrigger,
			content: previewInspectorContent,
			heading: previewInspectorHeading
		}
	} = createAccordion({
		multiple: true,
		forceVisible: true,
		defaultValue: ['layout']
	});

	let meta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let publishingTheme = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let assetUploadError = $state('');
	let assetUploading = $state<string | null>(null);
	let assetPreviewOverrides = $state<Partial<Record<AssetKind, string>>>({});
	const assetPreviewObjectUrls: Partial<Record<AssetKind, string>> = {};
	let themePublishError = $state('');
	let pendingPatches = $state<UIPatch[]>([]);
	let view = $state<'list' | 'editor'>('list');
	let editingThemeId = $state<string | null>(null);
	let editorValues = $state<Record<string, unknown>>({});
	let editorName = $state('');
	let editorDirty = $state(false);
	let brandNameValidationError = $state('');
	let applyingTheme = $state(false);
	let previewSurface = $state<ThemePreviewSurface>('login');
	let previewColorMode = $state<ThemePreviewColorMode>('light');
	let previewViewport = $state<ThemePreviewViewport>('desktop');
	let textEditorLocale = $state<LoginUILocale>('en');
	let editorAccountPageId = $state('');
	let selectedPublishThemeId = $state<string | null>(null);

	let scopeContext = $derived(settingsContext.scopeContext as ScopeContext);
	let currentLevel = $derived(settingsContext.currentLevel);
	let canEdit = $derived(settingsContext.canEditAtCurrentScope());
	let canEditLoginUiSettings = $derived(canEdit);
	let hasChanges = $derived(pendingPatches.length > 0);
	let currentThemeTemplate = $derived(
		themeTemplateOptions.find(
			(option) => option.id === getLiveString('login-ui.theme_template', 'meridian')
		) ?? themeTemplateOptions[0]
	);
	let customThemesDoc = $derived(parseCustomThemesDoc(getLiveString('login-ui.custom_themes', '')));
	let publishedAccountPages = $derived.by(() => {
		try {
			const document = JSON.parse(getLiveString('login-ui.account_pages', '')) as {
				pages?: Array<{ id: string; name: string; published?: unknown }>;
			};
			return (document.pages ?? []).filter((page) => Boolean(page.published));
		} catch {
			return [];
		}
	});
	let customThemes = $derived(customThemesDoc.themes);
	let activeCustomThemeId = $derived(
		customThemesDoc.active && customThemesDoc.themes.some((t) => t.id === customThemesDoc.active)
			? customThemesDoc.active
			: null
	);
	let editingBuiltinOption = $derived(
		themeTemplateOptions.find((option) => option.id === editingThemeId) ?? null
	);
	let editingCustomTheme = $derived(customThemes.find((t) => t.id === editingThemeId) ?? null);
	let editingActive = $derived(
		editingCustomTheme
			? activeCustomThemeId === editingCustomTheme.id
			: !activeCustomThemeId && currentThemeTemplate.id === editingThemeId
	);
	let previewTemplate = $derived(
		editingBuiltinOption ??
			(editingCustomTheme
				? (themeTemplateOptions.find((option) => option.id === editingCustomTheme.base) ??
					themeTemplateOptions[0])
				: currentThemeTemplate)
	);
	let publishedThemeVersion = $derived(getNumberSetting('login-ui.published_version', 0));
	let enabledTextEditorLocales = $derived(
		resolveEnabledLoginUILocalesByEnglishName(getCurrentValue('login-ui.supported_locales'))
	);
	let footerLinks = $derived(getPreviewFooterLinks());
	let logoUrl = $derived(
		assetPreviewOverrides.logo ?? getSafePreviewUrl(getThemeAwareValue('login-ui.logo_url'))
	);
	let faviconUrl = $derived(
		assetPreviewOverrides.favicon ?? getSafePreviewUrl(getThemeAwareValue('login-ui.favicon_url'))
	);
	let thumbnailUrl = $derived(
		assetPreviewOverrides.thumbnail ??
			getSafePreviewUrl(getThemeAwareValue('login-ui.thumbnail_url'))
	);
	let backgroundImageUrl = $derived(
		assetPreviewOverrides.background ??
			getSafePreviewUrl(getThemeAwareValue('login-ui.background_image_url'))
	);
	let loginPanelBackgroundImageUrl = $derived(
		assetPreviewOverrides['panel-background'] ??
			getSafePreviewUrl(getThemeAwareValue('login-ui.login_panel_background_image_url'))
	);
	let previewBrandName = $derived(getEditableStringSetting('login-ui.brand_name', 'Authrim'));
	let previewHeaderText = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'tagline',
			getStringSetting('login-ui.header_text', DEFAULT_LOGIN_UI_TAGLINES[textEditorLocale])
		)
	);
	let previewFooterText = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'footerText',
			getStringSetting('login-ui.footer_text', DEFAULT_LOGIN_UI_FOOTER_TEXTS[textEditorLocale])
		)
	);
	let previewFooterHtml = $derived(sanitizeFooterHtml(previewFooterText));
	let previewLoginTitle = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'loginTitle',
			DEFAULT_LOGIN_UI_PAGE_TITLES[textEditorLocale].loginTitle
		)
	);
	let previewRegistrationTitle = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'registrationTitle',
			DEFAULT_LOGIN_UI_PAGE_TITLES[textEditorLocale].registrationTitle
		)
	);
	let previewAccountTitle = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'accountTitle',
			DEFAULT_LOGIN_UI_PAGE_TITLES[textEditorLocale].accountTitle
		)
	);
	let previewHeaderEnabled = $derived(getBooleanSetting('login-ui.header_enabled', true));
	let previewSubtitleEnabled = $derived(getBooleanSetting('login-ui.subtitle_enabled', true));
	let previewFooterEnabled = $derived(getBooleanSetting('login-ui.footer_enabled', true));
	let previewPoweredByEnabled = $derived(getBooleanSetting('login-ui.powered_by_enabled', true));
	let previewAuthSwitchEnabled = $derived(
		getBooleanSetting('login-ui.auth_switch_link_enabled', true)
	);
	let previewThemeToggleEnabled = $derived(
		getBooleanSetting('login-ui.theme_toggle_enabled', true)
	);
	let previewLanguageSelectEnabled = $derived(
		getBooleanSetting('login-ui.language_select_enabled', true)
	);
	let previewPageLayout = $derived(
		readEnum(
			getStringSetting('login-ui.page_layout', previewTemplate.layout),
			['centered_card', 'split_panel', 'fullbleed_card'],
			previewTemplate.layout
		)
	);
	let previewFontFamily = $derived(
		readEnum(
			getStringSetting('login-ui.font_family', previewTemplate.fontFamily),
			['system', 'rounded', 'serif', 'mono'],
			previewTemplate.fontFamily
		)
	);
	let previewFontScale = $derived(
		readEnum(
			getStringSetting('login-ui.font_scale', 'comfortable'),
			['compact', 'comfortable', 'spacious'],
			'comfortable'
		)
	);
	let previewBackgroundColor = $derived(
		getStringSetting('login-ui.background_color', previewTemplate.backgroundColor)
	);
	let previewAccentColor = $derived(getStringSetting('login-ui.accent_color', ''));
	let previewTitleColor = $derived(getStringSetting('login-ui.title_color', ''));
	let previewTextColor = $derived(getStringSetting('login-ui.text_color', ''));
	let previewCopyColor = $derived(getStringSetting('login-ui.copy_color', ''));
	let previewBrandPanelTitle = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'brandPanelTitle',
			getOptionalStringSetting('login-ui.brand_panel_title')
		)
	);
	let previewBrandPanelText = $derived(
		getLocalizedThemeText(
			textEditorLocale,
			'brandPanelText',
			getOptionalStringSetting('login-ui.brand_panel_text')
		)
	);
	let previewLogoDisplay = $derived(
		readEnum(
			getStringSetting('login-ui.logo_display', 'auto'),
			['auto', 'image', 'text', 'hidden'],
			'auto'
		)
	);
	let previewLogoLayout = $derived(
		readEnum(
			getStringSetting('login-ui.logo_layout', previewTemplate.logoLayout ?? 'stack'),
			['stack', 'row'],
			previewTemplate.logoLayout ?? 'stack'
		)
	);
	let previewTopbarPosition = $derived(
		readEnum(
			getStringSetting('login-ui.topbar_position', previewTemplate.topbarPosition ?? 'below_card'),
			[
				'below_card',
				'in_card',
				'top_right',
				'bottom_left',
				'bottom_center',
				'bottom_right',
				'hidden'
			],
			previewTemplate.topbarPosition ?? 'below_card'
		)
	);
	let previewHeaderStyle = $derived(
		readEnum(
			getStringSetting('login-ui.header_style', previewTemplate.headerStyle ?? 'center'),
			['center', 'bar'],
			previewTemplate.headerStyle ?? 'center'
		)
	);
	let previewFooterStyle = $derived(
		readEnum(
			getStringSetting('login-ui.footer_style', previewTemplate.footerStyle ?? 'simple'),
			['simple', 'bar'],
			previewTemplate.footerStyle ?? 'simple'
		)
	);
	let previewSplitFrame = $derived(
		readEnum(getStringSetting('login-ui.split_frame', 'full'), ['full', 'card'], 'full')
	);
	let previewSplitPanelSide = $derived(
		readEnum(
			getStringSetting('login-ui.split_panel_side', previewTemplate.splitPanelSide ?? 'left'),
			['left', 'right'],
			previewTemplate.splitPanelSide ?? 'left'
		)
	);
	let previewSplitPanelWidth = $derived(
		readEnum(
			getStringSetting('login-ui.split_panel_width', previewTemplate.splitPanelWidth ?? 'narrow'),
			['narrow', 'wide'],
			previewTemplate.splitPanelWidth ?? 'narrow'
		)
	);
	let previewSplitBackgroundMode = $derived(
		readEnum(
			getStringSetting(
				'login-ui.split_background_mode',
				previewTemplate.splitBackgroundMode ?? 'shared'
			),
			['shared', 'brand', 'panel'],
			previewTemplate.splitBackgroundMode ?? 'shared'
		)
	);
	let previewLoginPanelBackgroundColor = $derived(
		getStringSetting('login-ui.login_panel_background_color', '')
	);
	let previewLoginPanelBackgroundGradientColor = $derived(
		getStringSetting('login-ui.login_panel_background_gradient_color', '')
	);
	let previewLoginPanelBackgroundOpacity = $derived(
		getThemeNumberSetting('login-ui.login_panel_background_opacity', 70)
	);
	let previewBrandContentMode = $derived(
		readEnum(
			getStringSetting(
				'login-ui.brand_content_mode',
				previewTemplate.brandContentMode ?? 'logo_copy'
			),
			['logo_copy', 'logo', 'none'],
			previewTemplate.brandContentMode ?? 'logo_copy'
		)
	);
	let previewBrandPosition = $derived(
		readEnum(
			getStringSetting('login-ui.brand_position', previewTemplate.brandPosition ?? 'center'),
			['top', 'center', 'bottom'],
			previewTemplate.brandPosition ?? 'center'
		)
	);
	let previewBrandAlign = $derived(
		readEnum(
			getStringSetting('login-ui.brand_align', previewTemplate.brandAlign ?? 'left'),
			['left', 'center', 'right'],
			previewTemplate.brandAlign ?? 'left'
		)
	);
	let previewStyle = $derived(
		[
			previewBackgroundColor ? `--preview-background-color:${previewBackgroundColor}` : '',
			previewAccentColor ? `--preview-primary:${previewAccentColor}` : '',
			previewTitleColor ? `--preview-title-color:${previewTitleColor}` : '',
			previewTextColor ? `--preview-text-color:${previewTextColor}` : '',
			previewCopyColor ? `--preview-copy-color:${previewCopyColor}` : '',
			backgroundImageUrl
				? `--preview-background-image:url("${escapeCssUrl(backgroundImageUrl)}")`
				: '',
			loginPanelBackgroundImageUrl
				? `--preview-login-panel-background-image:url("${escapeCssUrl(loginPanelBackgroundImageUrl)}")`
				: '',
			previewLoginPanelBackgroundColor
				? `--preview-login-panel-background-fill:${
						previewLoginPanelBackgroundGradientColor
							? `linear-gradient(135deg, ${previewLoginPanelBackgroundColor}, ${previewLoginPanelBackgroundGradientColor})`
							: previewLoginPanelBackgroundColor
					}`
				: '',
			`--preview-login-panel-background-opacity:${Math.min(100, Math.max(0, previewLoginPanelBackgroundOpacity)) / 100}`
		]
			.filter(Boolean)
			.join(';')
	);
	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	onMount(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editorDirty && pendingPatches.length === 0 && !assetUploading) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	});

	onDestroy(() => {
		clearAssetPreviewOverrides();
	});

	let prevScopeKey = $state<string | null>(null);

	$effect(() => {
		const scopeKey = `${scopeContext.level}:${scopeContext.tenantId}:${scopeContext.clientId}`;
		if (scopeKey === prevScopeKey) return;
		prevScopeKey = scopeKey;
		if (meta) {
			loadData();
		}
	});

	$effect(() => {
		if (!enabledTextEditorLocales.includes(textEditorLocale)) {
			textEditorLocale = enabledTextEditorLocales[0] ?? 'en';
		}
	});

	$effect(() => {
		if (
			selectedPublishThemeId &&
			customThemes.some((theme) => theme.id === selectedPublishThemeId)
		) {
			return;
		}
		selectedPublishThemeId = activeCustomThemeId;
	});

	async function loadData() {
		loading = true;
		error = '';
		themePublishError = '';
		assetUploadError = '';
		clearAssetPreviewOverrides();
		pendingPatches = [];
		try {
			meta = await adminSettingsAPI.getMeta(CATEGORY);
			try {
				settings = await scopedSettingsAPI.getSettingsForScope(CATEGORY, scopeContext);
			} catch {
				settings = await adminSettingsAPI.getSettings(CATEGORY);
			}
			previewColorMode = readEnum(
				getLiveString('login-ui.theme', currentThemeTemplate.theme),
				['light', 'dark'],
				currentThemeTemplate.theme
			);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_theme_error_load_failed();
		} finally {
			loading = false;
		}
	}

	function getCurrentValue(key: string): unknown {
		const patch = pendingPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
			if (patch.op === 'clear') return settings?.values[key];
		}
		return settings?.values[key];
	}

	function getLiveString(key: string, fallback: string): string {
		const value = getCurrentValue(key);
		return typeof value === 'string' && value.trim() ? value : fallback;
	}

	function getOptionalStringSetting(key: string): string {
		const value = themeSource(key);
		return typeof value === 'string' ? value.trim() : '';
	}

	function builtinPresetValues(option: ThemeTemplateOption): Record<string, unknown> {
		const values: Record<string, unknown> = {
			'login-ui.theme': option.theme,
			'login-ui.variant': option.variant,
			'login-ui.page_layout': option.layout,
			'login-ui.font_family': option.fontFamily,
			'login-ui.background_color': option.backgroundColor,
			'login-ui.accent_color': '',
			'login-ui.title_color': '',
			'login-ui.text_color': '',
			'login-ui.copy_color': ''
		};
		if (option.topbarPosition) values['login-ui.topbar_position'] = option.topbarPosition;
		if (option.headerStyle) values['login-ui.header_style'] = option.headerStyle;
		if (option.footerStyle) values['login-ui.footer_style'] = option.footerStyle;
		if (option.logoLayout) values['login-ui.logo_layout'] = option.logoLayout;
		if (option.splitPanelSide) values['login-ui.split_panel_side'] = option.splitPanelSide;
		if (option.splitPanelWidth) values['login-ui.split_panel_width'] = option.splitPanelWidth;
		if (option.splitBackgroundMode)
			values['login-ui.split_background_mode'] = option.splitBackgroundMode;
		if (option.brandContentMode) values['login-ui.brand_content_mode'] = option.brandContentMode;
		if (option.brandPosition) values['login-ui.brand_position'] = option.brandPosition;
		if (option.brandAlign) values['login-ui.brand_align'] = option.brandAlign;
		if (option.brandPanelTitle) values['login-ui.brand_panel_title'] = option.brandPanelTitle;
		if (option.brandPanelText) values['login-ui.brand_panel_text'] = option.brandPanelText;
		return values;
	}

	function themeSource(key: string): unknown {
		if (view === 'editor') {
			if (editingCustomTheme) return editorValues[key];
			if (editingBuiltinOption) return builtinPresetValues(editingBuiltinOption)[key];
		}
		return getCurrentValue(key);
	}

	function getThemeAwareValue(key: string): unknown {
		return themeSource(key) ?? getCurrentValue(key);
	}

	function getStringSetting(key: string, fallback: string): string {
		const value = themeSource(key);
		return typeof value === 'string' && value.trim() ? value : fallback;
	}

	function getEditableStringSetting(key: string, fallback: string): string {
		const value = themeSource(key);
		return typeof value === 'string' ? value : fallback;
	}

	function parseThemeTextLocalizations(value: unknown): ThemeTextLocalizations {
		try {
			const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
			return Object.fromEntries(
				Object.entries(parsed).flatMap(([locale, localized]) => {
					if (
						!isLoginUILocale(locale) ||
						!localized ||
						typeof localized !== 'object' ||
						Array.isArray(localized)
					) {
						return [];
					}
					const fields = Object.fromEntries(
						Object.entries(localized)
							.filter(
								([field, text]) =>
									(field === 'tagline' ||
										field === 'brandPanelTitle' ||
										field === 'brandPanelText' ||
										field === 'footerText' ||
										field === 'loginTitle' ||
										field === 'registrationTitle' ||
										field === 'accountTitle') &&
									typeof text === 'string'
							)
							.map(([field, text]) => [field, (text as string).trim()])
					);
					return Object.keys(fields).length > 0 ? [[locale, fields]] : [];
				})
			);
		} catch {
			return {};
		}
	}

	function getThemeTextOverride(locale: LoginUILocale, field: ThemeTextField): string | undefined {
		return parseThemeTextLocalizations(getThemeAwareValue('login-ui.text_localizations'))[locale]?.[
			field
		];
	}

	function getLocalizedThemeText(
		locale: LoginUILocale,
		field: ThemeTextField,
		fallback: string
	): string {
		return getThemeTextOverride(locale, field) ?? fallback;
	}

	function themeTextFallback(field: ThemeTextField): string {
		if (field === 'tagline') {
			return getStringSetting('login-ui.header_text', DEFAULT_LOGIN_UI_TAGLINES[textEditorLocale]);
		}
		if (field === 'brandPanelTitle') {
			return getOptionalStringSetting('login-ui.brand_panel_title');
		}
		if (field === 'brandPanelText') {
			return getOptionalStringSetting('login-ui.brand_panel_text');
		}
		if (field === 'footerText') {
			return getStringSetting(
				'login-ui.footer_text',
				DEFAULT_LOGIN_UI_FOOTER_TEXTS[textEditorLocale]
			);
		}
		return DEFAULT_LOGIN_UI_PAGE_TITLES[textEditorLocale][field];
	}

	function updateThemeTextLocalization(field: ThemeTextField, value: string) {
		const localizations = parseThemeTextLocalizations(
			getThemeAwareValue('login-ui.text_localizations')
		);
		const localized = { ...(localizations[textEditorLocale] ?? {}) };
		localized[field] = value.trim() ? value : '';

		const next = { ...localizations };
		next[textEditorLocale] = localized;
		const serialized = Object.keys(next).length > 0 ? JSON.stringify(next) : '';
		if (view === 'editor' && editingCustomTheme) {
			handleEditorChange('login-ui.text_localizations', serialized);
			return;
		}
		handleChange('login-ui.text_localizations', serialized);
	}

	function getBooleanSetting(key: string, fallback: boolean): boolean {
		const value = themeSource(key);
		return typeof value === 'boolean' ? value : fallback;
	}

	function getNumberSetting(key: string, fallback: number): number {
		const value = getCurrentValue(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
			return Number(value);
		return fallback;
	}

	function getThemeNumberSetting(key: string, fallback: number): number {
		const value = themeSource(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
			return Number(value);
		}
		return fallback;
	}

	function readEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
		return allowed.includes(value as T) ? (value as T) : fallback;
	}

	function handleChange(key: string, value: unknown) {
		pendingPatches = pendingPatches.filter((p) => p.key !== key);
		const originalValue = settings?.values[key];
		if (value !== originalValue) {
			pendingPatches = [...pendingPatches, { op: 'set', key, value }];
		}
		if (key === 'login-ui.theme' && (value === 'light' || value === 'dark')) {
			previewColorMode = value;
		}
	}

	function parseCustomThemesDoc(raw: string): CustomThemesDoc {
		if (!raw.trim()) return { themes: [], active: null };
		try {
			const parsed = JSON.parse(raw) as { themes?: unknown; active?: unknown };
			const list = Array.isArray(parsed.themes) ? parsed.themes : [];
			const themes = list
				.map((entry): CustomTheme | null => {
					if (!entry || typeof entry !== 'object') return null;
					const item = entry as Record<string, unknown>;
					const id = typeof item.id === 'string' ? item.id : '';
					const name = typeof item.name === 'string' ? item.name.trim() : '';
					const base = themeTemplateOptions.some((o) => o.id === item.base)
						? (item.base as ThemeTemplateOption['id'])
						: 'meridian';
					if (!id || !name) return null;
					const rawValues =
						item.values && typeof item.values === 'object'
							? (item.values as Record<string, unknown>)
							: {};
					const values: Record<string, unknown> = {};
					for (const [key, value] of Object.entries(rawValues)) {
						if (THEME_VALUE_KEYS.has(key)) values[key] = value;
					}
					return {
						id,
						name: name.slice(0, 80),
						base,
						created_at: typeof item.created_at === 'number' ? item.created_at : 0,
						updated_at: typeof item.updated_at === 'number' ? item.updated_at : 0,
						account_page_id: typeof item.account_page_id === 'string' ? item.account_page_id : null,
						values
					};
				})
				.filter((item): item is CustomTheme => item !== null)
				.slice(0, MAX_CUSTOM_THEMES);
			const active = typeof parsed.active === 'string' ? parsed.active : null;
			return { themes, active };
		} catch {
			return { themes: [], active: null };
		}
	}

	function serializeCustomThemesDoc(doc: CustomThemesDoc): string {
		return JSON.stringify(doc);
	}

	function baseOptionOf(theme: CustomTheme): ThemeTemplateOption {
		return themeTemplateOptions.find((o) => o.id === theme.base) ?? themeTemplateOptions[0];
	}

	function themeSwatch(theme: CustomTheme): string[] {
		const swatch = [...baseOptionOf(theme).swatch];
		const bg = theme.values['login-ui.background_color'];
		if (typeof bg === 'string' && bg.trim()) swatch[0] = bg;
		return swatch;
	}

	function themeTemplateDescription(option: ThemeTemplateOption): string {
		if (option.id === 'meridian') return $LL.admin_theme_template_meridian_description();
		if (option.id === 'split-brand-panel') {
			return $LL.admin_theme_template_split_brand_panel_description();
		}
		if (option.id === 'fullbleed-glass') {
			return $LL.admin_theme_template_fullbleed_glass_description();
		}
		return $LL.admin_theme_template_classic_description();
	}

	function formatThemeTimestamp(value: number): string {
		if (!Number.isFinite(value) || value <= 0) return $LL.admin_theme_date_unknown();
		return new Intl.DateTimeFormat(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(value);
	}

	function themeTimestampIso(value: number): string | undefined {
		return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
	}

	function previewSurfaceLabel(surface: ThemePreviewSurface): string {
		if (surface === 'registration') return $LL.admin_theme_preview_surface_registration();
		if (surface === 'code') return $LL.admin_theme_preview_surface_code();
		if (surface === 'consent') return $LL.admin_theme_preview_surface_consent();
		if (surface === 'account') return $LL.admin_theme_preview_surface_account();
		if (surface === 'error') return $LL.admin_theme_preview_surface_error();
		return $LL.admin_theme_preview_surface_login();
	}

	function previewColorModeLabel(mode: ThemePreviewColorMode): string {
		return mode === 'dark'
			? $LL.admin_theme_preview_mode_dark()
			: $LL.admin_theme_preview_mode_light();
	}

	function previewViewportLabel(viewport: ThemePreviewViewport): string {
		return viewport === 'mobile'
			? $LL.admin_theme_preview_viewport_mobile()
			: $LL.admin_theme_preview_viewport_desktop();
	}

	function choiceLabel(choices: Choice[], value: string): string {
		return choices.find((choice) => choice.value === value)?.label ?? value;
	}

	function rejectedSettingsMessage(result: SettingsPatchResult): string | null {
		const rejected = Object.entries(result.rejected);
		if (rejected.length === 0) return null;
		return `Some theme settings were not applied: ${rejected
			.map(([key, reason]) => `${key} (${reason})`)
			.join(', ')}`;
	}

	async function persistThemeSettings(
		set: Record<string, unknown>,
		okMessage: string
	): Promise<boolean> {
		if (!settings) return false;
		if (!canEditLoginUiSettings) {
			error = $LL.admin_login_ui_error_no_settings_permission();
			return false;
		}
		applyingTheme = true;
		error = '';
		successMessage = '';
		try {
			const pending = convertPatchesToAPIRequest(pendingPatches);
			const result = await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
				ifMatch: settings.version,
				...pending,
				set: { ...(pending.set ?? {}), ...set }
			});
			const rejectedMessage = rejectedSettingsMessage(result);
			if (rejectedMessage) {
				await loadData();
				error = rejectedMessage;
				return false;
			}
			pendingPatches = [];
			successMessage = okMessage;
			await loadData();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
			return true;
		} catch (err) {
			error =
				err instanceof SettingsConflictError
					? $LL.admin_login_ui_settings_conflict()
					: err instanceof Error
						? err.message
						: $LL.admin_theme_error_update_failed();
			return false;
		} finally {
			applyingTheme = false;
		}
	}

	async function duplicateTheme(sourceId: string) {
		if (customThemes.length >= MAX_CUSTOM_THEMES) {
			error = $LL.admin_theme_error_max_custom_themes({ count: MAX_CUSTOM_THEMES });
			return;
		}
		const builtin = themeTemplateOptions.find((o) => o.id === sourceId) ?? null;
		const custom = customThemes.find((t) => t.id === sourceId) ?? null;
		if (!builtin && !custom) return;
		const now = Date.now();
		const newTheme: CustomTheme = builtin
			? {
					id: `custom-${crypto.randomUUID()}`,
					name: `${builtin.name} copy`,
					base: builtin.id,
					created_at: now,
					updated_at: now,
					values: builtinPresetValues(builtin)
				}
			: {
					id: `custom-${crypto.randomUUID()}`,
					name: `${custom!.name} copy`,
					base: custom!.base,
					created_at: now,
					updated_at: now,
					account_page_id: custom!.account_page_id ?? null,
					values: { ...custom!.values }
				};
		const doc: CustomThemesDoc = {
			themes: [...customThemes, newTheme],
			active: customThemesDoc.active
		};
		const ok = await persistThemeSettings(
			{ 'login-ui.custom_themes': serializeCustomThemesDoc(doc) },
			$LL.admin_theme_duplicated_success({ name: newTheme.name })
		);
		if (ok) openEditor(newTheme.id);
	}

	function openEditor(id: string) {
		const custom = customThemes.find((t) => t.id === id) ?? null;
		const builtin = themeTemplateOptions.find((o) => o.id === id) ?? null;
		if (!custom && !builtin) return;
		editingThemeId = id;
		editorValues = custom ? { ...custom.values } : {};
		editorName = custom ? custom.name : (builtin?.name ?? '');
		editorAccountPageId = custom?.account_page_id ?? '';
		editorDirty = false;
		brandNameValidationError = '';
		previewSurface = 'login';
		previewViewport = 'desktop';
		const baseOption = custom
			? (themeTemplateOptions.find((o) => o.id === custom.base) ?? themeTemplateOptions[0])
			: builtin!;
		const mode = custom ? custom.values['login-ui.theme'] : baseOption.theme;
		previewColorMode = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : baseOption.theme;
		view = 'editor';
	}

	function closeEditor() {
		if (editorDirty && !window.confirm($LL.admin_theme_discard_confirm())) return;
		view = 'list';
		editingThemeId = null;
		editorValues = {};
		editorDirty = false;
		brandNameValidationError = '';
		clearAssetPreviewOverrides();
	}

	function handleEditorChange(key: string, value: unknown) {
		editorValues = { ...editorValues, [key]: value };
		editorDirty = true;
		if (key === 'login-ui.theme' && (value === 'light' || value === 'dark')) {
			previewColorMode = value;
		}
	}

	function updateAssetSetting(
		key: string,
		value: string,
		options: { keepPreviewOverride?: boolean } = {}
	) {
		if (!options.keepPreviewOverride) {
			clearAssetPreviewOverride(assetKindFromSettingKey(key));
		}
		if (view === 'editor' && editingCustomTheme) {
			handleEditorChange(key, value);
			return;
		}
		handleChange(key, value);
	}

	function setAssetPreviewHidden(event: Event, hidden: boolean) {
		const image = event.currentTarget as HTMLImageElement | null;
		if (image) image.hidden = hidden;
	}

	async function persistUploadedThemeAsset(key: AssetUrlKey, value: string) {
		if (!settings || !editingCustomTheme) return;
		const updatedTheme: CustomTheme = {
			...editingCustomTheme,
			values: {
				...editingCustomTheme.values,
				[key]: value
			},
			updated_at: Date.now()
		};
		const doc: CustomThemesDoc = {
			themes: customThemes.map((theme) => (theme.id === updatedTheme.id ? updatedTheme : theme)),
			active: customThemesDoc.active
		};
		const set: Record<string, unknown> = {
			'login-ui.custom_themes': serializeCustomThemesDoc(doc)
		};
		const result = await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
			ifMatch: settings.version,
			set
		});
		const rejectedMessage = rejectedSettingsMessage(result);
		if (rejectedMessage) {
			await loadData();
			throw new Error(rejectedMessage);
		}
		settings = {
			...settings,
			version: result.version,
			values: { ...settings.values, ...set }
		};
	}

	function assetKindFromSettingKey(key: string): AssetKind | null {
		if (key === 'login-ui.logo_url') return 'logo';
		if (key === 'login-ui.background_image_url') return 'background';
		if (key === 'login-ui.login_panel_background_image_url') return 'panel-background';
		if (key === 'login-ui.favicon_url') return 'favicon';
		if (key === 'login-ui.thumbnail_url') return 'thumbnail';
		return null;
	}

	function setAssetPreviewOverride(kind: AssetKind, file: File) {
		clearAssetPreviewOverride(kind);
		if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
		const objectUrl = URL.createObjectURL(file);
		assetPreviewObjectUrls[kind] = objectUrl;
		assetPreviewOverrides = { ...assetPreviewOverrides, [kind]: objectUrl };
	}

	function clearAssetPreviewOverride(kind: AssetKind | null) {
		if (!kind) return;
		const objectUrl = assetPreviewObjectUrls[kind];
		if (objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
			URL.revokeObjectURL(objectUrl);
		}
		delete assetPreviewObjectUrls[kind];
		if (assetPreviewOverrides[kind]) {
			const next = { ...assetPreviewOverrides };
			delete next[kind];
			assetPreviewOverrides = next;
		}
	}

	function clearAssetPreviewOverrides() {
		for (const kind of [
			'logo',
			'background',
			'panel-background',
			'favicon',
			'thumbnail'
		] as const) {
			clearAssetPreviewOverride(kind);
		}
	}

	async function saveCustomTheme() {
		if (!editingCustomTheme) return;
		const rawBrandName = editorValues['login-ui.brand_name'];
		const brandName = typeof rawBrandName === 'string' ? rawBrandName.trim() : 'Authrim';
		if (!brandName) {
			brandNameValidationError = $LL.admin_theme_text_brand_name_required();
			error = brandNameValidationError;
			return;
		}
		brandNameValidationError = '';
		if (error === $LL.admin_theme_text_brand_name_required()) error = '';
		const name = editorName.trim() || editingCustomTheme.name;
		const updated: CustomTheme = {
			...editingCustomTheme,
			name: name.slice(0, 80),
			values: { ...editorValues, 'login-ui.brand_name': brandName },
			account_page_id: editorAccountPageId || null,
			updated_at: Date.now()
		};
		const doc: CustomThemesDoc = {
			themes: customThemes.map((t) => (t.id === updated.id ? updated : t)),
			active: customThemesDoc.active
		};
		const customThemesValue = serializeCustomThemesDoc(doc);
		const set: Record<string, unknown> = {
			'login-ui.custom_themes': customThemesValue
		};
		if (activeCustomThemeId === updated.id) {
			Object.assign(
				set,
				buildPublishedThemeSettings(
					updated,
					customThemesValue,
					publishedThemeVersion + 1,
					new Date().toISOString()
				)
			);
		}
		const ok = await persistThemeSettings(
			set,
			$LL.admin_theme_saved_success({ name: updated.name })
		);
		if (ok) editorDirty = false;
	}

	function discardChanges() {
		pendingPatches = [];
		error = '';
		assetUploadError = '';
		themePublishError = '';
		clearAssetPreviewOverrides();
	}

	async function saveChanges() {
		if (!settings || pendingPatches.length === 0) return;
		if (!canEditLoginUiSettings) {
			error = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}

		saving = true;
		error = '';
		successMessage = '';
		try {
			const result = await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
				ifMatch: settings.version,
				...convertPatchesToAPIRequest(pendingPatches)
			});
			const rejectedMessage = rejectedSettingsMessage(result);
			if (rejectedMessage) {
				await loadData();
				error = rejectedMessage;
				return;
			}
			pendingPatches = [];
			successMessage = $LL.admin_login_ui_updated_settings({
				count: result.applied.length + result.cleared.length + result.disabled.length
			});
			await loadData();
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			error =
				err instanceof SettingsConflictError
					? $LL.admin_login_ui_settings_conflict()
					: err instanceof Error
						? err.message
						: $LL.admin_login_ui_error_save_settings();
		} finally {
			saving = false;
		}
	}

	function buildLoginUiSnapshot(overrides: Record<string, unknown>): string {
		const values: Record<string, unknown> = {};
		for (const key of LOGIN_UI_PUBLISH_KEYS) {
			values[key] = Object.prototype.hasOwnProperty.call(overrides, key)
				? overrides[key]
				: settings?.values[key];
		}
		return JSON.stringify({
			schema_version: 'authrim.login_ui.theme_publish.v1',
			captured_at: new Date().toISOString(),
			values
		});
	}

	function resolveThemeValuesForPublish(theme: CustomTheme): Record<string, unknown> {
		const resolved: Record<string, unknown> = {};
		const preset = builtinPresetValues(baseOptionOf(theme));
		for (const key of THEME_VALUE_KEYS) {
			if (Object.prototype.hasOwnProperty.call(theme.values, key)) {
				resolved[key] = theme.values[key];
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(preset, key)) {
				resolved[key] = preset[key];
				continue;
			}
			if (meta?.settings[key]) resolved[key] = meta.settings[key].default;
		}
		return resolved;
	}

	function buildPublishedThemeSettings(
		theme: CustomTheme,
		customThemesValue: string,
		nextVersion: number,
		publishedAt: string
	): Record<string, unknown> {
		const selectedThemeSettings: Record<string, unknown> = {
			...resolveThemeValuesForPublish(theme),
			'login-ui.custom_themes': customThemesValue,
			'login-ui.theme_template': theme.base
		};
		return {
			...selectedThemeSettings,
			'login-ui.published_version': nextVersion,
			'login-ui.published_at': publishedAt,
			'login-ui.published_snapshot': buildLoginUiSnapshot(selectedThemeSettings)
		};
	}

	async function publishSelectedTheme() {
		if (!settings) return;
		if (!canEditLoginUiSettings) {
			themePublishError = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}
		const selectedTheme = customThemes.find((theme) => theme.id === selectedPublishThemeId);
		if (!selectedTheme) {
			themePublishError = $LL.admin_theme_publish_select_required();
			return;
		}
		publishingTheme = true;
		themePublishError = '';
		successMessage = '';
		try {
			const nextVersion = publishedThemeVersion + 1;
			const publishedAt = new Date().toISOString();
			const customThemesValue = serializeCustomThemesDoc({
				themes: customThemes,
				active: selectedTheme.id
			});
			const result = await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
				ifMatch: settings.version,
				set: buildPublishedThemeSettings(selectedTheme, customThemesValue, nextVersion, publishedAt)
			});
			const rejectedMessage = rejectedSettingsMessage(result);
			if (rejectedMessage) {
				await loadData();
				themePublishError = rejectedMessage;
				return;
			}
			pendingPatches = [];
			successMessage = $LL.admin_theme_publish_success({
				name: selectedTheme.name,
				version: nextVersion
			});
			await loadData();
		} catch (err) {
			themePublishError =
				err instanceof SettingsConflictError
					? $LL.admin_login_ui_settings_conflict()
					: err instanceof Error
						? err.message
						: $LL.admin_theme_publish_failed();
		} finally {
			publishingTheme = false;
		}
	}

	async function uploadLoginUiAsset(kind: AssetKind, file: File | null) {
		if (!file) return;
		if (!canEditLoginUiSettings) {
			assetUploadError = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}

		const wasEditorDirty = editorDirty;
		setAssetPreviewOverride(kind, file);
		assetUploading = kind;
		assetUploadError = '';
		const assetKey = assetSettingKey(kind);
		try {
			const formData = new FormData();
			formData.append('kind', kind);
			formData.append('file', file);
			const response = await adminFetch(`${API_BASE_URL}/api/admin/assets/login-ui`, {
				method: 'POST',
				body: formData
			});
			const body = (await response.json()) as { url?: string; error_description?: string };
			if (!response.ok || !body.url) {
				throw new Error(body.error_description || $LL.admin_theme_asset_upload_failed());
			}
			updateAssetSetting(assetKey, body.url, { keepPreviewOverride: true });
			await persistUploadedThemeAsset(assetKey, body.url);
			if (view === 'editor' && editingCustomTheme && !wasEditorDirty) {
				editorDirty = false;
			}
		} catch (err) {
			clearAssetPreviewOverride(kind);
			assetUploadError = err instanceof Error ? err.message : $LL.admin_theme_asset_upload_failed();
		} finally {
			assetUploading = null;
		}
	}

	function assetSettingKey(kind: AssetKind): AssetUrlKey {
		if (kind === 'logo') return 'login-ui.logo_url';
		if (kind === 'background') return 'login-ui.background_image_url';
		if (kind === 'panel-background') return 'login-ui.login_panel_background_image_url';
		if (kind === 'favicon') return 'login-ui.favicon_url';
		return 'login-ui.thumbnail_url';
	}

	function getSafePreviewUrl(value: unknown): string {
		const raw = typeof value === 'string' ? value.trim() : '';
		// eslint-disable-next-line no-control-regex -- intentional control-character check for URL sanitization
		if (!raw || raw.length > 2048 || /[\u0000-\u001f<>"']/u.test(raw)) return '';
		if (raw.startsWith('/api/assets/')) return raw;
		if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(raw)) return raw;
		try {
			const parsed = new URL(raw);
			if (parsed.protocol === 'https:' && parsed.pathname.startsWith('/api/assets/')) {
				return `${parsed.pathname}${parsed.search}`;
			}
			return parsed.protocol === 'https:' ? parsed.href : '';
		} catch {
			return '';
		}
	}

	function escapeCssUrl(value: string): string {
		return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
	}

	function getPreviewFooterLinks(): FooterLinkPreview[] {
		const raw = getStringSetting('login-ui.footer_links', '');
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.map((item): FooterLinkPreview | null => {
					if (!item || typeof item !== 'object') return null;
					const label = typeof item.label === 'string' ? item.label.trim() : '';
					const href = getSafePreviewUrl('url' in item ? item.url : '');
					return label && href ? { label, href } : null;
				})
				.filter((item): item is FooterLinkPreview => item !== null)
				.slice(0, 4);
		} catch {
			return [];
		}
	}

	function settingInputValue(key: string): string {
		const value = getThemeAwareValue(key);
		return value === undefined || value === null ? '' : String(value);
	}

	function assetUrlPlaceholder(key: AssetUrlKey): string {
		if (key === 'login-ui.logo_url') return 'Optional logo HTTPS URL';
		if (key === 'login-ui.background_image_url') return 'Optional background HTTPS URL';
		if (key === 'login-ui.login_panel_background_image_url') {
			return 'Optional login panel background HTTPS URL';
		}
		if (key === 'login-ui.favicon_url') return 'Optional favicon HTTPS URL';
		return 'Optional thumbnail HTTPS URL';
	}
</script>

<svelte:head>
	<title>{$LL.admin_theme_head_title()}</title>
</svelte:head>

{#snippet titleAccessory()}
	<span class="scope-badge {currentLevel}">
		{currentLevel === 'platform'
			? $LL.admin_login_ui_scope_platform()
			: currentLevel === 'tenant'
				? $LL.admin_login_ui_scope_tenant()
				: $LL.admin_login_ui_scope_client()}
	</span>
	{#if !canEditLoginUiSettings}
		<span class="readonly-badge">{$LL.admin_login_ui_readonly()}</span>
	{/if}
{/snippet}

<AdminPageShell>
	<div class="theme-page">
		<AdminPageHeader
			title={$LL.admin_header_theme()}
			description={view === 'list'
				? $LL.admin_theme_page_description_list()
				: $LL.admin_theme_page_description_editor()}
			{titleAccessory}
		/>

		{#if error}
			<div class="alert alert-error">
				{error}
				{#if error === $LL.admin_login_ui_settings_conflict()}
					<button onclick={loadData} class="btn btn-sm btn-danger reload-action">
						{$LL.admin_login_ui_reload()}
					</button>
				{/if}
			</div>
		{/if}

		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}

		{#if loading}
			<div class="loading-state">
				<p class="text-secondary">{$LL.admin_login_ui_loading_settings()}</p>
			</div>
		{:else if meta && settings}
			{#if view === 'list'}
				<section class="settings-form-card custom-theme-card">
					<div class="theme-section-header">
						<div>
							<h2>{$LL.admin_theme_custom_title()}</h2>
							<p>{$LL.admin_theme_custom_description()}</p>
						</div>
						<button
							type="button"
							class="btn btn-primary theme-publish-button"
							disabled={!selectedPublishThemeId ||
								selectedPublishThemeId === activeCustomThemeId ||
								publishingTheme ||
								applyingTheme ||
								!canEditLoginUiSettings}
							onclick={publishSelectedTheme}
						>
							{publishingTheme ? $LL.admin_theme_publishing() : $LL.admin_theme_publish()}
						</button>
					</div>
					{#if themePublishError}
						<div class="alert alert-error theme-publish-error">{themePublishError}</div>
					{/if}
					{#if customThemes.length > 0}
						<div class="custom-theme-list">
							{#each customThemes as theme (theme.id)}
								{@const active = activeCustomThemeId === theme.id}
								{@const publishRadioId = `theme-to-publish-${theme.id}`}
								<div class="custom-theme-row" class:selected={selectedPublishThemeId === theme.id}>
									<input
										id={publishRadioId}
										type="radio"
										name="theme-to-publish"
										value={theme.id}
										checked={selectedPublishThemeId === theme.id}
										disabled={publishingTheme || applyingTheme || !canEditLoginUiSettings}
										aria-label={$LL.admin_theme_select_for_publish({ name: theme.name })}
										onchange={() => {
											selectedPublishThemeId = theme.id;
											themePublishError = '';
										}}
									/>
									<label class="custom-theme-selection" for={publishRadioId}>
										<span class="custom-theme-swatch" aria-hidden="true">
											{#each themeSwatch(theme) as color, index (index)}
												<span style={`background: ${color};`}></span>
											{/each}
										</span>
										<span class="custom-theme-summary">
											<span class="theme-card-head">
												<span class="theme-template-name">{theme.name}</span>
												{#if active}
													<span class="theme-badge active">{$LL.admin_theme_badge_active()}</span>
												{/if}
											</span>
											<span class="theme-template-description">
												{$LL.admin_theme_based_on({ name: baseOptionOf(theme).name })}
											</span>
										</span>
										<span class="custom-theme-timestamps">
											<span>
												<span>{$LL.admin_theme_created_at()}</span>
												<time datetime={themeTimestampIso(theme.created_at)}
													>{formatThemeTimestamp(theme.created_at)}</time
												>
											</span>
											<span>
												<span>{$LL.admin_theme_updated_at()}</span>
												<time datetime={themeTimestampIso(theme.updated_at)}
													>{formatThemeTimestamp(theme.updated_at)}</time
												>
											</span>
										</span>
									</label>
									<button
										type="button"
										class="btn btn-secondary btn-sm custom-theme-edit"
										onclick={() => openEditor(theme.id)}
									>
										{$LL.admin_theme_edit()}
									</button>
								</div>
							{/each}
						</div>
					{:else}
						<p class="custom-theme-empty">{$LL.admin_theme_custom_empty()}</p>
					{/if}
				</section>

				<section class="settings-form-card">
					<div class="theme-section-header">
						<div>
							<h2>{$LL.admin_theme_templates_title()}</h2>
							<p>{$LL.admin_theme_templates_description()}</p>
						</div>
					</div>
					<div class="theme-template-grid">
						{#each themeTemplateOptions as option (option.id)}
							{@const active = !activeCustomThemeId && currentThemeTemplate.id === option.id}
							<div
								class="theme-template-option"
								class:selected={active}
								role="button"
								tabindex="0"
								onclick={() => openEditor(option.id)}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openEditor(option.id);
									}
								}}
							>
								<span class="theme-template-preview">
									{#each option.swatch as color (color)}
										<span style={`background: ${color};`}></span>
									{/each}
								</span>
								<span class="theme-card-head">
									<span class="theme-template-name">{option.name}</span>
									<span class="theme-badge">{$LL.admin_theme_badge_builtin()}</span>
									{#if active}<span class="theme-badge active"
											>{$LL.admin_theme_badge_active()}</span
										>{/if}
								</span>
								<span class="theme-template-description">{themeTemplateDescription(option)}</span>
							</div>
						{/each}
					</div>
				</section>
			{:else}
				<div class="editor-topbar settings-form-card">
					<button type="button" class="btn btn-secondary btn-sm" onclick={closeEditor}>
						&larr; {$LL.admin_theme_back_to_templates()}
					</button>
					<div class="editor-title">
						{#if editingCustomTheme}
							<input
								class="settings-input editor-name-input"
								value={editorName}
								maxlength="80"
								disabled={!canEditLoginUiSettings}
								aria-label={$LL.admin_theme_name_label()}
								oninput={(e) => {
									editorName = e.currentTarget.value;
									editorDirty = true;
								}}
							/>
							<span class="theme-template-description"
								>{$LL.admin_theme_based_on({ name: previewTemplate.name })}</span
							>
							<label class="account-page-association">
								<span>Account page</span>
								<select
									bind:value={editorAccountPageId}
									onchange={() => (editorDirty = true)}
									disabled={!canEditLoginUiSettings}
								>
									<option value="">Use tenant default</option>
									{#each publishedAccountPages as page (page.id)}<option value={page.id}
											>{page.name}</option
										>{/each}
								</select>
							</label>
						{:else}
							<strong class="editor-builtin-name">{previewTemplate.name}</strong>
							<span class="theme-badge">{$LL.admin_theme_badge_builtin()}</span>
						{/if}
						{#if editingActive}<span class="theme-badge active"
								>{$LL.admin_theme_badge_active()}</span
							>{/if}
					</div>
					<div class="editor-actions">
						{#if editingCustomTheme}
							{#if editorDirty}<span class="editor-dirty">{$LL.admin_theme_unsaved_changes()}</span
								>{/if}
							<button
								type="button"
								class="btn btn-primary"
								disabled={applyingTheme || !canEditLoginUiSettings}
								onclick={saveCustomTheme}
							>
								{applyingTheme ? $LL.admin_theme_saving() : $LL.admin_theme_save()}
							</button>
						{:else}
							<button
								type="button"
								class="btn btn-primary"
								disabled={applyingTheme || !canEditLoginUiSettings}
								onclick={() => duplicateTheme(previewTemplate.id)}
							>
								{applyingTheme ? $LL.admin_theme_using_template() : $LL.admin_theme_use_template()}
							</button>
						{/if}
					</div>
				</div>

				<aside class="theme-preview-workbench">
					<div class="theme-preview-toolbar">
						<div class="theme-preview-title">
							<strong>{previewTemplate.name}</strong>
							<span>{themeTemplateDescription(previewTemplate)}</span>
						</div>
						<div class="theme-preview-controls" aria-label={$LL.admin_theme_preview_controls()}>
							<div class="segmented-control" aria-label={$LL.admin_theme_preview_screen()}>
								{#each ['login', 'registration', 'code', 'consent', 'account', 'error'] as surface (surface)}
									<button
										type="button"
										class:active={previewSurface === surface}
										aria-pressed={previewSurface === surface}
										onclick={() => (previewSurface = surface as ThemePreviewSurface)}
									>
										{previewSurfaceLabel(surface as ThemePreviewSurface)}
									</button>
								{/each}
							</div>
							<div class="segmented-control" aria-label={$LL.admin_theme_preview_color_mode()}>
								{#each ['light', 'dark'] as mode (mode)}
									<button
										type="button"
										class:active={previewColorMode === mode}
										aria-pressed={previewColorMode === mode}
										onclick={() => (previewColorMode = mode as ThemePreviewColorMode)}
									>
										{previewColorModeLabel(mode as ThemePreviewColorMode)}
									</button>
								{/each}
							</div>
							<div class="segmented-control" aria-label={$LL.admin_theme_preview_viewport()}>
								{#each ['desktop', 'mobile'] as viewport (viewport)}
									<button
										type="button"
										class:active={previewViewport === viewport}
										aria-pressed={previewViewport === viewport}
										onclick={() => (previewViewport = viewport as ThemePreviewViewport)}
									>
										{previewViewportLabel(viewport as ThemePreviewViewport)}
									</button>
								{/each}
							</div>
						</div>
					</div>
					<div class="theme-preview-layout" class:mobile={previewViewport === 'mobile'}>
						<div class="theme-preview-frame-viewport">
							<div
								class="theme-preview-frame-scale-box"
								class:mobile={previewViewport === 'mobile'}
							>
								<div class="theme-preview-frame-shell" class:mobile={previewViewport === 'mobile'}>
									<div class="preview-browser-bar">
										<span class="preview-browser-dot"></span>
										{#if faviconUrl}
											<img class="preview-browser-favicon" src={faviconUrl} alt="" />
										{/if}
										<span class="preview-browser-url">login.example.test/{previewSurface}</span>
									</div>
									<div
										class="login-preview-page"
										class:split={previewPageLayout === 'split_panel'}
										class:fullbleed={previewPageLayout === 'fullbleed_card'}
										class:dark={previewColorMode === 'dark'}
										class:light={previewColorMode === 'light'}
										class:template-meridian={previewTemplate.id === 'meridian'}
										class:template-split={previewTemplate.id === 'split-brand-panel'}
										class:template-fullbleed={previewTemplate.id === 'fullbleed-glass'}
										class:template-classic={previewTemplate.id === 'classic'}
										class:split-right={previewSplitPanelSide === 'right'}
										class:split-wide={previewSplitPanelWidth === 'wide'}
										class:split-card={previewSplitFrame === 'card'}
										class:topbar-in-card={previewTopbarPosition === 'in_card'}
										class:topbar-top-right={previewTopbarPosition === 'top_right'}
										class:topbar-bottom={previewTopbarPosition.startsWith('bottom_')}
										class:header-bar={previewHeaderStyle === 'bar'}
										class:footer-bar={previewFooterStyle === 'bar'}
										class:logo-row={previewLogoLayout === 'row'}
										class:font-rounded={previewFontFamily === 'rounded'}
										class:font-serif={previewFontFamily === 'serif'}
										class:font-mono={previewFontFamily === 'mono'}
										class:font-compact={previewFontScale === 'compact'}
										class:font-spacious={previewFontScale === 'spacious'}
										class:hasBackgroundImage={!!backgroundImageUrl}
										data-page-layout={previewPageLayout}
										data-font-family={previewFontFamily}
										data-font-scale={previewFontScale}
										data-topbar-position={previewTopbarPosition}
										data-header-style={previewHeaderStyle}
										data-footer-style={previewFooterStyle}
										data-logo-display={previewLogoDisplay}
										data-logo-layout={previewLogoLayout}
										data-split-frame={previewSplitFrame}
										data-split-panel-side={previewSplitPanelSide}
										data-split-panel-width={previewSplitPanelWidth}
										data-split-background-mode={previewSplitBackgroundMode}
										data-has-page-background-image={backgroundImageUrl ? 'true' : 'false'}
										data-has-login-panel-background-image={loginPanelBackgroundImageUrl
											? 'true'
											: 'false'}
										data-brand-content-mode={previewBrandContentMode}
										data-brand-position={previewBrandPosition}
										data-brand-align={previewBrandAlign}
										data-1p-ignore="true"
										data-lpignore="true"
										data-bwignore="true"
										data-form-type="other"
										style={previewStyle}
									>
										<div class="preview-main">
											{#if previewPageLayout === 'split_panel' && previewBrandContentMode !== 'none'}
												<aside class="preview-brand-panel">
													<div class="preview-brand-panel-content">
														{#if logoUrl && previewLogoDisplay !== 'hidden' && previewLogoDisplay !== 'text'}
															<img class="preview-brand-logo" src={logoUrl} alt="" />
														{/if}
														{#if previewBrandContentMode === 'logo_copy'}
															<p class="preview-brand-eyebrow">{previewBrandName}</p>
															{#if previewBrandPanelTitle}
																<h2>{previewBrandPanelTitle}</h2>
															{/if}
															{#if previewBrandPanelText}
																<p>{previewBrandPanelText}</p>
															{/if}
														{:else if previewBrandContentMode === 'logo' && !logoUrl}
															<h2>{previewBrandName}</h2>
														{/if}
													</div>
												</aside>
											{/if}

											<section
												class="preview-auth-container"
												class:wide={previewSurface === 'consent' || previewSurface === 'account'}
											>
												{#if previewHeaderEnabled}
													<header class="preview-auth-header">
														{#if previewLogoDisplay !== 'hidden' && logoUrl && previewLogoDisplay !== 'text'}
															<img class="preview-auth-logo" src={logoUrl} alt={previewBrandName} />
														{:else if previewLogoDisplay !== 'hidden' && previewLogoDisplay !== 'image'}
															<div class="preview-auth-mark">A</div>
														{/if}
														{#if previewLogoDisplay !== 'hidden' && previewLogoDisplay !== 'image'}
															<h1>{previewBrandName}</h1>
														{/if}
														{#if previewSubtitleEnabled}
															<p>{previewHeaderText}</p>
														{/if}
													</header>
												{/if}

												{#if previewTopbarPosition === 'in_card'}
													<div class="preview-topbar">
														{#if previewThemeToggleEnabled}<button type="button">☼</button>{/if}
														{#if previewLanguageSelectEnabled}<select
																><option>English</option><option>日本語</option></select
															>{/if}
													</div>
												{/if}

												<div class="preview-card">
													<div class="preview-card-body">
														{#if previewSurface === 'registration'}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>{previewRegistrationTitle}</h2>
																	<p>Register with the tenant default no-consent screen.</p>
																</div>
																<button class="auth-method-button" type="button">
																	⌘ Create account with Passkey
																</button>
																<p class="runtime-screen-text">
																	Email, name, authenticator app, profile input, and registration
																	consent are not included.
																</p>
															</div>
														{:else if previewSurface === 'code'}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>Enter verification code</h2>
																	<p>Use the code sent by the selected method.</p>
																</div>
																<div class="pin-row" aria-hidden="true">
																	<span>2</span><span>8</span><span>4</span><span>9</span><span
																		>1</span
																	><span>6</span>
																</div>
																<div class="preview-actions">
																	<button class="preview-btn secondary" type="button">Back</button>
																	<button class="preview-btn primary" type="button">Verify</button>
																</div>
															</div>
														{:else if previewSurface === 'consent'}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>Review access</h2>
																	<p>
																		Example consent screen for checking card width, spacing, and
																		links.
																	</p>
																</div>
																<div class="consent-item">
																	<strong>Basic profile</strong>
																	<span>Name, email address, and profile identifier.</span>
																</div>
																<div class="consent-item">
																	<strong>Application access</strong>
																	<span>Allow this client to complete the sign-in request.</span>
																</div>
																<div class="preview-actions">
																	<button class="preview-btn secondary" type="button">Deny</button>
																	<button class="preview-btn primary" type="button">Allow</button>
																</div>
															</div>
														{:else if previewSurface === 'account'}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>{previewAccountTitle}</h2>
																	<p>Profile and security settings use the same theme tokens.</p>
																</div>
																<div class="consent-item">
																	<strong>User profile</strong>
																	<span>Name, verified email address, and save states.</span>
																</div>
																<label class="runtime-screen-field">
																	<span>Display name</span>
																	<input value="Aoi Tanaka" readonly tabindex="-1" />
																</label>
																<div class="preview-actions">
																	<button class="preview-btn secondary" type="button">Cancel</button
																	>
																	<button class="preview-btn primary" type="button">Save</button>
																</div>
															</div>
														{:else if previewSurface === 'error'}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>Something went wrong</h2>
																	<p>
																		The page shell should remain readable for errors and empty
																		states.
																	</p>
																</div>
																<div class="status-box">
																	The request could not be completed. Try again or contact your
																	administrator.
																</div>
																<button class="preview-btn primary" type="button"
																	>Return to login</button
																>
															</div>
														{:else}
															<div class="runtime-screen">
																<div class="runtime-screen-heading">
																	<h2>{previewLoginTitle}</h2>
																	<p>Use one of the available methods for this tenant.</p>
																</div>
																<button class="auth-method-button" type="button">
																	⌘ Sign in with Passkey
																</button>
																<button class="auth-method-button secondary" type="button">
																	Continue with External IdP
																</button>
																<div class="runtime-screen-divider"><span>or</span></div>
																<button class="auth-method-button secondary" type="button">
																	Sign in with directory password
																</button>
																<label class="runtime-screen-field">
																	<span>Email address</span>
																	<input
																		name="authrim-preview-ignore"
																		value="demo@example.com"
																		readonly
																		tabindex="-1"
																		autocomplete="off"
																		autocapitalize="none"
																		spellcheck="false"
																		data-1p-ignore="true"
																		data-lpignore="true"
																		data-bwignore="true"
																		data-form-type="other"
																	/>
																	<small>Shown here as a runtime screen field example.</small>
																</label>
																<div class="preview-actions">
																	<button class="preview-btn secondary" type="button">Back</button>
																	<button class="preview-btn primary" type="button">Continue</button
																	>
																</div>
															</div>
														{/if}
													</div>
												</div>

												{#if previewAuthSwitchEnabled && (previewSurface === 'login' || previewSurface === 'registration')}
													<p class="preview-bottom-link">
														{previewSurface === 'registration'
															? 'Already have an account? Sign in'
															: "Don't have an account? Create one"}
													</p>
												{/if}
											</section>

											{#if previewTopbarPosition !== 'hidden' && previewTopbarPosition !== 'in_card'}
												<div
													class="preview-topbar"
													class:floating={previewTopbarPosition !== 'below_card'}
												>
													{#if previewThemeToggleEnabled}<button type="button">☼</button>{/if}
													{#if previewLanguageSelectEnabled}<select
															><option>English</option><option>日本語</option></select
														>{/if}
												</div>
											{/if}
										</div>

										{#if previewFooterEnabled}
											<footer class="preview-footer preview-page-footer">
												{#if footerLinks.length}
													<div class="preview-footer-links">
														{#each footerLinks as link (link.href)}
															<a href={link.href}>{link.label}</a>
														{/each}
													</div>
												{/if}
												{#if previewPoweredByEnabled}
													<div><SanitizedHtmlPreview html={previewFooterHtml} /></div>
												{/if}
											</footer>
										{/if}
									</div>
								</div>
							</div>
						</div>
						<aside class="theme-preview-inspector" aria-label={$LL.admin_theme_preview_inspector()}>
							<div class="theme-preview-inspector-header">
								<strong>{$LL.admin_theme_preview_inspector()}</strong>
								<span>{$LL.admin_theme_preview_inspector_description()}</span>
							</div>
							<div use:melt={$previewInspectorRoot} class="preview-accordion">
								{#if editingCustomTheme}
									<div use:melt={$previewInspectorItem('layout')} class="preview-accordion-item">
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('layout')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>Layout</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('layout')}
											class="preview-accordion-content"
										>
											<div class="inspector-fields">
												<div class="inspector-field">
													<span class="inspector-field-label">Page</span>
													<div class="inspector-segmented">
														{#each PAGE_LAYOUT_CHOICES as choice (choice.value)}
															<button
																type="button"
																class:active={previewPageLayout === choice.value}
																disabled={!canEditLoginUiSettings}
																onclick={() =>
																	handleEditorChange('login-ui.page_layout', choice.value)}
															>
																{choice.label}
															</button>
														{/each}
													</div>
												</div>
												<div class="inspector-field two-column">
													<label>
														<span class="inspector-field-label">Mode</span>
														<select
															value={getStringSetting('login-ui.theme', previewTemplate.theme)}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.theme', e.currentTarget.value)}
														>
															{#each MODE_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
													<label>
														<span class="inspector-field-label">Font scale</span>
														<select
															value={previewFontScale}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.font_scale', e.currentTarget.value)}
														>
															{#each FONT_SCALE_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
												</div>
											</div>
										</div>
									</div>

									{#if previewPageLayout === 'split_panel'}
										<div use:melt={$previewInspectorItem('split')} class="preview-accordion-item">
											<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
												<button
													use:melt={$previewInspectorTrigger('split')}
													type="button"
													class="preview-accordion-trigger"
												>
													<span>Split panel</span>
													<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
												</button>
											</h3>
											<div
												use:melt={$previewInspectorContent('split')}
												class="preview-accordion-content"
											>
												<div class="inspector-fields">
													<div class="inspector-field two-column">
														<label>
															<span class="inspector-field-label">Frame</span>
															<select
																value={previewSplitFrame}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange('login-ui.split_frame', e.currentTarget.value)}
															>
																{#each SPLIT_FRAME_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
														<label>
															<span class="inspector-field-label">Side</span>
															<select
																value={previewSplitPanelSide}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange(
																		'login-ui.split_panel_side',
																		e.currentTarget.value
																	)}
															>
																{#each SPLIT_SIDE_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
													</div>
													<div class="inspector-field two-column">
														<label>
															<span class="inspector-field-label">Width</span>
															<select
																value={previewSplitPanelWidth}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange(
																		'login-ui.split_panel_width',
																		e.currentTarget.value
																	)}
															>
																{#each SPLIT_WIDTH_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
														<label>
															<span class="inspector-field-label">Background</span>
															<select
																value={previewSplitBackgroundMode}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange(
																		'login-ui.split_background_mode',
																		e.currentTarget.value
																	)}
															>
																{#each SPLIT_BACKGROUND_MODE_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
													</div>
													{#if previewSplitBackgroundMode === 'panel'}
														<label class="inspector-field">
															<span class="inspector-field-label"
																>Panel image opacity: {Math.round(
																	previewLoginPanelBackgroundOpacity
																)}%</span
															>
															<input
																type="range"
																min="0"
																max="100"
																step="1"
																value={previewLoginPanelBackgroundOpacity}
																disabled={!canEditLoginUiSettings}
																oninput={(e) =>
																	handleEditorChange(
																		'login-ui.login_panel_background_opacity',
																		Number(e.currentTarget.value)
																	)}
															/>
														</label>
													{/if}
													{#if previewSplitBackgroundMode === 'brand'}
														{#each [{ label: 'Panel color', key: 'login-ui.login_panel_background_color', fallback: previewColorMode === 'dark' ? '#131a2a' : '#ffffff' }, { label: 'Panel gradient', key: 'login-ui.login_panel_background_gradient_color', fallback: previewColorMode === 'dark' ? '#1a2336' : '#eef1f6' }] as field (field.key)}
															<div class="inspector-color-row">
																<span class="inspector-field-label">{field.label}</span>
																<input
																	type="color"
																	value={getStringSetting(field.key, '') || field.fallback}
																	disabled={!canEditLoginUiSettings}
																	aria-label={field.label}
																	oninput={(e) =>
																		handleEditorChange(field.key, e.currentTarget.value)}
																/>
																<input
																	type="text"
																	value={getStringSetting(field.key, '')}
																	placeholder="Default"
																	disabled={!canEditLoginUiSettings}
																	oninput={(e) =>
																		handleEditorChange(field.key, e.currentTarget.value.trim())}
																/>
															</div>
														{/each}
													{/if}
													<div class="inspector-field two-column">
														<label>
															<span class="inspector-field-label">Content</span>
															<select
																value={previewBrandContentMode}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange(
																		'login-ui.brand_content_mode',
																		e.currentTarget.value
																	)}
															>
																{#each BRAND_CONTENT_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
														<label>
															<span class="inspector-field-label">Position</span>
															<select
																value={previewBrandPosition}
																disabled={!canEditLoginUiSettings}
																onchange={(e) =>
																	handleEditorChange(
																		'login-ui.brand_position',
																		e.currentTarget.value
																	)}
															>
																{#each BRAND_POSITION_CHOICES as choice (choice.value)}
																	<option value={choice.value}>{choice.label}</option>
																{/each}
															</select>
														</label>
													</div>
													<div class="inspector-field">
														<span class="inspector-field-label">Alignment</span>
														<div class="inspector-segmented">
															{#each BRAND_ALIGN_CHOICES as choice (choice.value)}
																<button
																	type="button"
																	class:active={previewBrandAlign === choice.value}
																	disabled={!canEditLoginUiSettings}
																	onclick={() =>
																		handleEditorChange('login-ui.brand_align', choice.value)}
																>
																	{choice.label}
																</button>
															{/each}
														</div>
													</div>
												</div>
											</div>
										</div>
									{/if}

									<div use:melt={$previewInspectorItem('colors')} class="preview-accordion-item">
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('colors')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>Colors</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('colors')}
											class="preview-accordion-content"
										>
											<div class="inspector-fields">
												{#if previewTemplate.id === 'classic'}
													<label class="inspector-field">
														<span class="inspector-field-label">Variant</span>
														<select
															value={getStringSetting('login-ui.variant', previewTemplate.variant)}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.variant', e.currentTarget.value)}
														>
															{#each VARIANT_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
												{/if}
												{#each [{ label: 'Background', key: 'login-ui.background_color', fallback: previewColorMode === 'dark' ? '#0b0e16' : '#eef1f6' }, { label: 'Accent', key: 'login-ui.accent_color', fallback: previewTemplate.id === 'fullbleed-glass' ? (previewColorMode === 'dark' ? '#e8623f' : '#c93a22') : previewColorMode === 'dark' ? '#93aef2' : '#2f52c4' }, { label: 'Title', key: 'login-ui.title_color', fallback: previewColorMode === 'dark' ? '#eef2fa' : '#182238' }, { label: 'Text', key: 'login-ui.text_color', fallback: previewColorMode === 'dark' ? '#eef2fa' : '#182238' }, { label: 'Copy', key: 'login-ui.copy_color', fallback: previewColorMode === 'dark' ? '#aeb9d0' : '#55617c' }] as field (field.key)}
													<div class="inspector-color-row">
														<span class="inspector-field-label">{field.label}</span>
														<input
															type="color"
															value={getStringSetting(field.key, '') || field.fallback}
															disabled={!canEditLoginUiSettings}
															aria-label={field.label}
															oninput={(e) => handleEditorChange(field.key, e.currentTarget.value)}
														/>
														<input
															type="text"
															value={getStringSetting(field.key, '')}
															placeholder="Default"
															disabled={!canEditLoginUiSettings}
															oninput={(e) =>
																handleEditorChange(field.key, e.currentTarget.value.trim())}
														/>
														<button
															type="button"
															disabled={!canEditLoginUiSettings || !getStringSetting(field.key, '')}
															onclick={() => handleEditorChange(field.key, '')}
														>
															Reset
														</button>
													</div>
												{/each}
											</div>
										</div>
									</div>

									<div
										use:melt={$previewInspectorItem('typography')}
										class="preview-accordion-item"
									>
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('typography')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>Typography</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('typography')}
											class="preview-accordion-content"
										>
											<div class="inspector-fields">
												<div class="inspector-field">
													<span class="inspector-field-label">Font family</span>
													<div class="inspector-segmented">
														{#each FONT_FAMILY_CHOICES as choice (choice.value)}
															<button
																type="button"
																class:active={previewFontFamily === choice.value}
																disabled={!canEditLoginUiSettings}
																onclick={() =>
																	handleEditorChange('login-ui.font_family', choice.value)}
															>
																{choice.label}
															</button>
														{/each}
													</div>
												</div>
												<div class="inspector-field">
													<span class="inspector-field-label">Font scale</span>
													<div class="inspector-segmented">
														{#each FONT_SCALE_CHOICES as choice (choice.value)}
															<button
																type="button"
																class:active={previewFontScale === choice.value}
																disabled={!canEditLoginUiSettings}
																onclick={() =>
																	handleEditorChange('login-ui.font_scale', choice.value)}
															>
																{choice.label}
															</button>
														{/each}
													</div>
												</div>
											</div>
										</div>
									</div>

									<div
										use:melt={$previewInspectorItem('header-footer')}
										class="preview-accordion-item"
									>
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('header-footer')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>Header & footer</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('header-footer')}
											class="preview-accordion-content"
										>
											<div class="inspector-fields">
												<div class="inspector-switch-grid">
													<label
														><input
															type="checkbox"
															checked={previewHeaderEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.header_enabled',
																	e.currentTarget.checked
																)}
														/> Header</label
													>
													<label
														><input
															type="checkbox"
															checked={previewSubtitleEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.subtitle_enabled',
																	e.currentTarget.checked
																)}
														/> Subtitle</label
													>
													<label
														><input
															type="checkbox"
															checked={previewFooterEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.footer_enabled',
																	e.currentTarget.checked
																)}
														/> Footer</label
													>
													<label
														><input
															type="checkbox"
															checked={previewPoweredByEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.powered_by_enabled',
																	e.currentTarget.checked
																)}
														/> Powered-by</label
													>
													<label
														><input
															type="checkbox"
															checked={previewAuthSwitchEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.auth_switch_link_enabled',
																	e.currentTarget.checked
																)}
														/> Auth switch</label
													>
												</div>
												<div class="inspector-field two-column">
													<label>
														<span class="inspector-field-label">Header style</span>
														<select
															value={previewHeaderStyle}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.header_style', e.currentTarget.value)}
														>
															{#each HEADER_STYLE_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
													<label>
														<span class="inspector-field-label">Footer style</span>
														<select
															value={previewFooterStyle}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.footer_style', e.currentTarget.value)}
														>
															{#each FOOTER_STYLE_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
												</div>
											</div>
										</div>
									</div>

									<div
										use:melt={$previewInspectorItem('logo-topbar')}
										class="preview-accordion-item"
									>
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('logo-topbar')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>Logo & topbar</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('logo-topbar')}
											class="preview-accordion-content"
										>
											<div class="inspector-fields">
												<div class="inspector-field two-column">
													<label>
														<span class="inspector-field-label">Logo</span>
														<select
															value={previewLogoDisplay}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.logo_display', e.currentTarget.value)}
														>
															{#each LOGO_DISPLAY_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
													<label>
														<span class="inspector-field-label">Layout</span>
														<select
															value={previewLogoLayout}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange('login-ui.logo_layout', e.currentTarget.value)}
														>
															{#each LOGO_LAYOUT_CHOICES as choice (choice.value)}
																<option value={choice.value}>{choice.label}</option>
															{/each}
														</select>
													</label>
												</div>
												<label class="inspector-field">
													<span class="inspector-field-label">Topbar</span>
													<select
														value={previewTopbarPosition}
														disabled={!canEditLoginUiSettings}
														onchange={(e) =>
															handleEditorChange('login-ui.topbar_position', e.currentTarget.value)}
													>
														{#each TOPBAR_CHOICES as choice (choice.value)}
															<option value={choice.value}>{choice.label}</option>
														{/each}
													</select>
												</label>
												<div class="inspector-switch-grid">
													<label
														><input
															type="checkbox"
															checked={previewThemeToggleEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.theme_toggle_enabled',
																	e.currentTarget.checked
																)}
														/> Theme toggle</label
													>
													<label
														><input
															type="checkbox"
															checked={previewLanguageSelectEnabled}
															disabled={!canEditLoginUiSettings}
															onchange={(e) =>
																handleEditorChange(
																	'login-ui.language_select_enabled',
																	e.currentTarget.checked
																)}
														/> Language</label
													>
												</div>
											</div>
										</div>
									</div>
								{:else}
									<div use:melt={$previewInspectorItem('layout')} class="preview-accordion-item">
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('layout')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>{$LL.admin_theme_preview_inspector_layout()}</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('layout')}
											class="preview-accordion-content"
										>
											<dl class="preview-inspector-list">
												<div>
													<dt>{$LL.admin_theme_preview_inspector_page()}</dt>
													<dd>{choiceLabel(PAGE_LAYOUT_CHOICES, previewPageLayout)}</dd>
												</div>
												<div>
													<dt>{$LL.admin_theme_preview_inspector_topbar()}</dt>
													<dd>{choiceLabel(TOPBAR_CHOICES, previewTopbarPosition)}</dd>
												</div>
												<div>
													<dt>{$LL.admin_theme_preview_inspector_footer()}</dt>
													<dd>{choiceLabel(FOOTER_STYLE_CHOICES, previewFooterStyle)}</dd>
												</div>
											</dl>
										</div>
									</div>

									<div use:melt={$previewInspectorItem('assets')} class="preview-accordion-item">
										<h3 use:melt={$previewInspectorHeading(3)} class="preview-accordion-heading">
											<button
												use:melt={$previewInspectorTrigger('assets')}
												type="button"
												class="preview-accordion-trigger"
											>
												<span>{$LL.admin_theme_preview_inspector_assets()}</span>
												<span class="preview-accordion-chevron" aria-hidden="true">⌄</span>
											</button>
										</h3>
										<div
											use:melt={$previewInspectorContent('assets')}
											class="preview-accordion-content"
										>
											<div class="preview-inspector-chips">
												<span
													>{logoUrl
														? $LL.admin_theme_preview_inspector_logo_set()
														: $LL.admin_theme_preview_inspector_logo_default()}</span
												>
												<span
													>{backgroundImageUrl
														? $LL.admin_theme_preview_inspector_background_set()
														: $LL.admin_theme_preview_inspector_background_default()}</span
												>
												<span
													>{faviconUrl
														? $LL.admin_theme_preview_inspector_favicon_set()
														: $LL.admin_theme_preview_inspector_favicon_default()}</span
												>
											</div>
										</div>
									</div>
								{/if}
							</div>
						</aside>
					</div>
					<p class="theme-preview-note">
						Preview uses the theme being edited. Runtime behavior still comes from Screens and Flow
						assignments.
					</p>
				</aside>

				<section class="settings-form-card text-card">
					<div class="theme-section-header text-section-header">
						<div>
							<h2>{$LL.admin_theme_text_title()}</h2>
							<p>{$LL.admin_theme_text_description()}</p>
						</div>
						<label class="text-locale-control">
							<span>{$LL.admin_theme_text_language()}</span>
							<select
								class="settings-input"
								value={textEditorLocale}
								disabled={!canEditLoginUiSettings}
								onchange={(event) => {
									if (isLoginUILocale(event.currentTarget.value)) {
										textEditorLocale = event.currentTarget.value;
									}
								}}
							>
								{#each enabledTextEditorLocales as locale (locale)}
									<option value={locale}>
										{LOGIN_UI_LOCALE_OPTIONS.find((option) => option.code === locale)?.label ??
											locale}
									</option>
								{/each}
							</select>
						</label>
					</div>
					<div class="text-editor-grid">
						<label class="editor-field">
							<span class="editor-field-label">{$LL.admin_theme_text_brand_name()}</span>
							<input
								type="text"
								class="settings-input"
								dir="auto"
								maxlength="128"
								value={getEditableStringSetting('login-ui.brand_name', 'Authrim')}
								class:form-input-error={Boolean(brandNameValidationError)}
								aria-invalid={Boolean(brandNameValidationError)}
								aria-describedby={brandNameValidationError ? 'brand-name-error' : undefined}
								disabled={!canEditLoginUiSettings}
								oninput={(event) => {
									handleEditorChange('login-ui.brand_name', event.currentTarget.value);
									if (event.currentTarget.value.trim()) {
										if (error === brandNameValidationError) error = '';
										brandNameValidationError = '';
									}
								}}
							/>
							{#if brandNameValidationError}
								<span id="brand-name-error" class="field-error">{brandNameValidationError}</span>
							{/if}
						</label>
						<label class="editor-field">
							<span class="editor-field-label">{$LL.admin_theme_text_tagline()}</span>
							<input
								type="text"
								class="settings-input"
								dir="auto"
								maxlength="256"
								value={getLocalizedThemeText(
									textEditorLocale,
									'tagline',
									themeTextFallback('tagline')
								)}
								disabled={!canEditLoginUiSettings}
								oninput={(event) =>
									updateThemeTextLocalization('tagline', event.currentTarget.value)}
							/>
						</label>
						<label class="editor-field">
							<span class="editor-field-label">{$LL.admin_theme_text_brand_panel_title()}</span>
							<input
								type="text"
								class="settings-input"
								dir="auto"
								maxlength="256"
								value={getLocalizedThemeText(
									textEditorLocale,
									'brandPanelTitle',
									themeTextFallback('brandPanelTitle')
								)}
								disabled={!canEditLoginUiSettings}
								oninput={(event) =>
									updateThemeTextLocalization('brandPanelTitle', event.currentTarget.value)}
							/>
						</label>
						<label class="editor-field text-editor-wide">
							<span class="editor-field-label">{$LL.admin_theme_text_brand_panel_text()}</span>
							<textarea
								rows="3"
								class="settings-textarea compact"
								dir="auto"
								maxlength="256"
								value={getLocalizedThemeText(
									textEditorLocale,
									'brandPanelText',
									themeTextFallback('brandPanelText')
								)}
								disabled={!canEditLoginUiSettings}
								oninput={(event) =>
									updateThemeTextLocalization('brandPanelText', event.currentTarget.value)}
							></textarea>
						</label>
						<label class="editor-field">
							<span class="editor-field-label">{$LL.admin_theme_text_footer()}</span>
							<input
								type="text"
								class="settings-input"
								dir="auto"
								maxlength="256"
								value={getLocalizedThemeText(
									textEditorLocale,
									'footerText',
									themeTextFallback('footerText')
								)}
								disabled={!canEditLoginUiSettings}
								oninput={(event) =>
									updateThemeTextLocalization('footerText', event.currentTarget.value)}
							/>
							<small class="editor-field-note">{$LL.admin_theme_text_footer_help()}</small>
						</label>
					</div>
					<p class="text-editor-help">{$LL.admin_theme_text_help()}</p>
				</section>

				<section class="settings-form-card page-title-card">
					<div class="theme-section-header text-section-header">
						<div>
							<h2>{$LL.admin_theme_page_titles_title()}</h2>
							<p>{$LL.admin_theme_page_titles_description()}</p>
						</div>
						<label class="text-locale-control">
							<span>{$LL.admin_theme_text_language()}</span>
							<select
								class="settings-input"
								value={textEditorLocale}
								disabled={!canEditLoginUiSettings}
								onchange={(event) => {
									if (isLoginUILocale(event.currentTarget.value)) {
										textEditorLocale = event.currentTarget.value;
									}
								}}
							>
								{#each enabledTextEditorLocales as locale (locale)}
									<option value={locale}>
										{LOGIN_UI_LOCALE_OPTIONS.find((option) => option.code === locale)?.label ??
											locale}
									</option>
								{/each}
							</select>
						</label>
					</div>
					<div class="page-title-fields">
						{#each [{ field: 'loginTitle', label: $LL.admin_theme_page_titles_login() }, { field: 'registrationTitle', label: $LL.admin_theme_page_titles_registration() }, { field: 'accountTitle', label: $LL.admin_theme_page_titles_account() }] as titleField (titleField.field)}
							<label class="editor-field">
								<span class="editor-field-label">{titleField.label}</span>
								<input
									type="text"
									class="settings-input"
									dir="auto"
									maxlength="128"
									value={getLocalizedThemeText(
										textEditorLocale,
										titleField.field as ThemeTextField,
										themeTextFallback(titleField.field as ThemeTextField)
									)}
									disabled={!canEditLoginUiSettings}
									oninput={(event) =>
										updateThemeTextLocalization(
											titleField.field as ThemeTextField,
											event.currentTarget.value
										)}
								/>
							</label>
						{/each}
					</div>
					<p class="text-editor-help">{$LL.admin_theme_page_titles_help()}</p>
				</section>

				<section class="settings-form-card asset-card">
					<div class="theme-section-header">
						<div>
							<h2>Image assets</h2>
							<p>Upload files or paste HTTPS URLs for tenant-scoped Login UI assets.</p>
						</div>
					</div>
					{#if assetUploadError}
						<div class="alert alert-error">{assetUploadError}</div>
					{/if}
					<div class="asset-grid">
						{#each [{ kind: 'logo', label: 'Logo', key: 'login-ui.logo_url', preview: logoUrl }, { kind: 'background', label: 'Page / brand background', key: 'login-ui.background_image_url', preview: backgroundImageUrl }, { kind: 'panel-background', label: 'Login panel background', key: 'login-ui.login_panel_background_image_url', preview: loginPanelBackgroundImageUrl }, { kind: 'favicon', label: 'Favicon', key: 'login-ui.favicon_url', preview: faviconUrl }, { kind: 'thumbnail', label: 'Thumbnail', key: 'login-ui.thumbnail_url', preview: thumbnailUrl }] as const as asset (asset.key)}
							<div class="asset-item">
								<div class="asset-label-row">
									<span>{asset.label}</span>
									{#if asset.preview}
										<img
											src={asset.preview}
											alt=""
											loading="lazy"
											decoding="async"
											onload={(e) => setAssetPreviewHidden(e, false)}
											onerror={(e) => setAssetPreviewHidden(e, true)}
										/>
									{/if}
								</div>
								<input
									type="file"
									accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon"
									disabled={assetUploading !== null || !canEditLoginUiSettings}
									onchange={(e) =>
										uploadLoginUiAsset(asset.kind, (e.currentTarget.files ?? [])[0] ?? null)}
								/>
								<input
									type="url"
									value={settingInputValue(asset.key)}
									disabled={!canEditLoginUiSettings}
									placeholder={assetUrlPlaceholder(asset.key)}
									class="settings-input"
									oninput={(e) => updateAssetSetting(asset.key, e.currentTarget.value.trim())}
								/>
								<small>
									{assetUploading === asset.kind
										? 'Uploading...'
										: 'PNG, JPG, GIF, WebP, ICO or HTTPS URL'}
								</small>
							</div>
						{/each}
					</div>
				</section>

				{#if editingCustomTheme}
					<section class="settings-form-card">
						<div class="theme-section-header">
							<div>
								<h2>Advanced</h2>
								<p>Custom CSS and JSON-driven footer links / content blocks.</p>
							</div>
						</div>
						<div class="editor-fields advanced">
							<div class="editor-field">
								<span class="editor-field-label">Custom CSS</span>
								<textarea
									rows="8"
									class="settings-textarea compact"
									value={getStringSetting('login-ui.custom_css', '')}
									disabled={!canEditLoginUiSettings}
									oninput={(e) => handleEditorChange('login-ui.custom_css', e.currentTarget.value)}
								></textarea>
							</div>
							<div class="editor-field">
								<span class="editor-field-label"> Footer links (JSON array of label / url) </span>
								<textarea
									rows="4"
									class="settings-textarea compact"
									value={getStringSetting('login-ui.footer_links', '')}
									disabled={!canEditLoginUiSettings}
									oninput={(e) =>
										handleEditorChange('login-ui.footer_links', e.currentTarget.value)}
								></textarea>
							</div>
							<div class="editor-field">
								<span class="editor-field-label">Custom blocks (JSON)</span>
								<textarea
									rows="4"
									class="settings-textarea compact"
									value={getStringSetting('login-ui.custom_blocks', '')}
									disabled={!canEditLoginUiSettings}
									oninput={(e) =>
										handleEditorChange('login-ui.custom_blocks', e.currentTarget.value)}
								></textarea>
							</div>
						</div>
					</section>
				{:else}
					<section class="settings-form-card">
						<div class="theme-section-header">
							<div>
								<h2>{$LL.admin_theme_builtin_template_title()}</h2>
								<p>{$LL.admin_theme_builtin_template_description()}</p>
							</div>
						</div>
					</section>
				{/if}

				{#if hasChanges}
					<div class="settings-actions">
						<span class="cache-notice">{$LL.admin_login_ui_cache_notice()}</span>
						<button
							onclick={discardChanges}
							disabled={!hasChanges || saving || !canEditLoginUiSettings}
							class="btn btn-secondary"
						>
							{$LL.admin_login_ui_discard_changes()}
						</button>
						<button
							onclick={saveChanges}
							disabled={!hasChanges || saving || !canEditLoginUiSettings}
							class="btn btn-primary"
						>
							{saving
								? $LL.admin_login_ui_saving()
								: `${$LL.admin_login_ui_save_changes()}${hasChanges ? ` (${pendingPatches.length})` : ''}`}
						</button>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</AdminPageShell>

<style>
	.theme-page {
		display: grid;
		gap: 16px;
		align-content: start;
	}

	.scope-badge,
	.readonly-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 9px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.scope-badge {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.scope-badge.tenant {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.scope-badge.client {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.readonly-badge {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.settings-form-card {
		padding: 20px;
	}

	.theme-section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.theme-section-header h2 {
		margin: 0 0 4px;
		font-size: 1rem;
		color: var(--color-text);
	}

	.theme-section-header p {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.theme-template-grid,
	.asset-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 12px;
	}

	.custom-theme-list {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
	}

	.custom-theme-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 14px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.custom-theme-row:hover,
	.custom-theme-row.selected,
	.custom-theme-row:focus-within {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.custom-theme-row > input[type='radio'] {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--color-accent);
	}

	.custom-theme-selection {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr) minmax(210px, auto);
		align-items: center;
		gap: 14px;
		min-width: 0;
		cursor: pointer;
	}

	.custom-theme-swatch {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		width: 48px;
		height: 48px;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.custom-theme-summary {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.custom-theme-summary .theme-template-name,
	.custom-theme-summary .theme-template-description {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.custom-theme-timestamps {
		display: grid;
		gap: 4px;
		min-width: 210px;
		font-variant-numeric: tabular-nums;
	}

	.custom-theme-timestamps > span {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px;
		align-items: baseline;
	}

	.custom-theme-timestamps span > span {
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.custom-theme-timestamps time {
		text-align: right;
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.custom-theme-edit,
	.theme-publish-button {
		white-space: nowrap;
	}

	.custom-theme-empty {
		margin: 0;
		padding: 16px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.theme-template-option,
	.asset-item {
		display: grid;
		gap: 8px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.theme-template-option:hover,
	.theme-template-option.selected {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.theme-template-preview {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		height: 40px;
		overflow: hidden;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
	}

	.theme-template-name,
	.asset-label-row span {
		font-weight: 700;
	}

	.theme-template-description,
	.asset-item small,
	.theme-preview-note {
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.asset-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.asset-label-row img {
		width: 42px;
		height: 30px;
		object-fit: contain;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
	}

	.asset-item input[type='file'] {
		width: 100%;
		min-width: 0;
		font-size: 0;
		color: transparent;
	}

	.asset-item input[type='file']::file-selector-button {
		max-width: 100%;
		margin-right: 0;
		padding: 7px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.settings-textarea.compact {
		min-height: auto;
		font-family: var(--font-mono, monospace);
		font-size: 0.8125rem;
	}

	.theme-preview-workbench {
		display: grid;
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface-muted);
	}

	.theme-preview-toolbar {
		display: grid;
		gap: 12px;
	}

	.theme-preview-title {
		display: grid;
		gap: 3px;
	}

	.theme-preview-title strong {
		color: var(--color-text);
		font-size: 0.95rem;
		line-height: 1.3;
	}

	.theme-preview-title span {
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.theme-preview-controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.segmented-control {
		display: inline-flex;
		align-items: center;
		padding: 3px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
	}

	.segmented-control button {
		min-height: 30px;
		padding: 5px 9px;
		border: 0;
		border-radius: calc(var(--radius-control, 8px) - 3px);
		background: transparent;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.segmented-control button:hover,
	.segmented-control button.active {
		background: var(--color-accent-muted);
		color: var(--color-text);
	}

	.theme-preview-layout {
		--preview-layout-scale: 0.7;
		--preview-layout-height: 800px;
		width: 100%;
		display: grid;
		grid-template-columns: max-content minmax(132px, 1fr);
		align-items: start;
		gap: 16px;
		overflow: auto;
	}

	.theme-preview-layout.mobile {
		--preview-layout-height: 694px;
	}

	.theme-preview-frame-viewport {
		width: 100%;
		display: grid;
		justify-items: start;
		overflow: visible;
	}

	.theme-preview-inspector {
		position: sticky;
		top: 12px;
		min-width: 0;
		max-width: 320px;
		max-height: calc(var(--preview-layout-height) * var(--preview-layout-scale));
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		box-shadow: var(--shadow-sm);
	}

	.theme-preview-inspector-header {
		display: grid;
		gap: 4px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.theme-preview-inspector-header strong {
		font-size: 0.875rem;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.theme-preview-inspector-header span {
		color: var(--color-text-muted);
		font-size: 0.7rem;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.preview-accordion {
		display: grid;
	}

	.preview-accordion-item + .preview-accordion-item {
		border-top: 1px solid var(--color-border);
	}

	.preview-accordion-heading {
		margin: 0;
	}

	.preview-accordion-trigger {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--color-text);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 800;
		text-align: left;
	}

	.preview-accordion-trigger:hover {
		background: var(--color-surface-muted);
	}

	.preview-accordion-chevron {
		color: var(--color-text-muted);
		transition: transform 120ms ease;
	}

	.preview-accordion-trigger[data-state='open'] .preview-accordion-chevron {
		transform: rotate(180deg);
	}

	.preview-accordion-content {
		display: grid;
		grid-template-rows: 0fr;
		overflow: hidden;
		padding: 0 12px;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		line-height: 1.45;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		transition:
			grid-template-rows 180ms ease,
			opacity 140ms ease,
			padding-bottom 180ms ease,
			visibility 0s linear 180ms;
	}

	.preview-accordion-content[data-state='open'] {
		grid-template-rows: 1fr;
		padding-bottom: 12px;
		opacity: 1;
		visibility: visible;
		pointer-events: auto;
		transition:
			grid-template-rows 180ms ease,
			opacity 140ms ease,
			padding-bottom 180ms ease;
	}

	.preview-accordion-content > * {
		min-height: 0;
	}

	.inspector-fields {
		display: grid;
		gap: 9px;
	}

	.inspector-field,
	.inspector-field label {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.inspector-field.two-column {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.inspector-field-label {
		color: var(--color-text-muted);
		font-size: 0.66rem;
		font-weight: 800;
		line-height: 1.2;
		text-transform: uppercase;
	}

	.inspector-field input[type='text'],
	.inspector-field select,
	.inspector-color-row input[type='text'],
	.inspector-color-row select {
		width: 100%;
		min-width: 0;
		height: 28px;
		padding: 0 7px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-size: 0.72rem;
	}

	.inspector-segmented {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(58px, 1fr));
		gap: 3px;
		padding: 3px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface-muted);
	}

	.inspector-segmented button {
		min-height: 25px;
		padding: 3px 5px;
		border: 0;
		border-radius: calc(var(--radius-control, 8px) - 3px);
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		font-size: 0.68rem;
		font-weight: 800;
		line-height: 1.15;
	}

	.inspector-segmented button:hover,
	.inspector-segmented button.active {
		background: var(--color-accent-muted);
		color: var(--color-text);
	}

	.inspector-color-row {
		display: grid;
		grid-template-columns: 62px 28px minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.inspector-color-row input[type='color'] {
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: transparent;
	}

	.inspector-color-row button {
		min-height: 28px;
		padding: 0 7px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface-muted);
		color: var(--color-text);
		font: inherit;
		font-size: 0.68rem;
		font-weight: 800;
	}

	.inspector-color-row button:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.inspector-switch-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 8px;
	}

	.inspector-switch-grid label {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		color: var(--color-text);
		font-size: 0.72rem;
		font-weight: 700;
		line-height: 1.25;
	}

	.inspector-switch-grid input {
		width: 13px;
		height: 13px;
		margin: 0;
		flex: 0 0 auto;
	}

	.preview-inspector-list {
		display: grid;
		gap: 9px;
		margin: 0;
	}

	.preview-inspector-list div {
		display: grid;
		gap: 2px;
	}

	.preview-inspector-list dt {
		color: var(--color-text-muted);
	}

	.preview-inspector-list dd {
		margin: 0;
		color: var(--color-text);
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.preview-inspector-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.preview-inspector-chips span {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 3px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-muted);
		color: var(--color-text);
		font-size: 0.7rem;
		font-weight: 700;
	}

	@media (max-width: 1180px) {
		.theme-preview-layout {
			grid-template-columns: 1fr;
		}

		.theme-preview-inspector {
			position: static;
			max-width: none;
		}
	}

	.theme-preview-frame-scale-box {
		--preview-frame-scale: 0.7;
		--preview-frame-width: 1200px;
		--preview-frame-height: 800px;
		position: relative;
		width: calc(var(--preview-frame-width) * var(--preview-frame-scale));
		height: calc(var(--preview-frame-height) * var(--preview-frame-scale));
		min-width: 0;
	}

	.theme-preview-frame-scale-box.mobile {
		--preview-frame-width: 390px;
		--preview-frame-height: 694px;
	}

	.theme-preview-frame-shell {
		width: var(--preview-frame-width);
		height: var(--preview-frame-height);
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: #0e1118;
		box-shadow: var(--shadow-sm);
		transform: scale(var(--preview-frame-scale, 1));
		transform-origin: top left;
	}

	.theme-preview-frame-shell.mobile {
		width: var(--preview-frame-width);
		height: var(--preview-frame-height);
	}

	.preview-browser-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 12px;
		background: #141924;
		color: #aeb7c8;
		font-size: 0.75rem;
	}

	.preview-browser-dot {
		width: 9px;
		height: 9px;
		border-radius: 999px;
		background: #e8623f;
		box-shadow:
			14px 0 #f4bf4f,
			28px 0 #54c56a;
		margin-right: 26px;
	}

	.preview-browser-favicon {
		width: 16px;
		height: 16px;
		object-fit: contain;
	}

	.preview-browser-url {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.login-preview-page {
		--preview-bg-page: #eef1f6;
		--preview-bg-card: #ffffff;
		--preview-bg-glass: #f7f9fc;
		--preview-bg-input: #f7f9fc;
		--preview-text: #182238;
		--preview-text-secondary: #55617c;
		--preview-text-muted: #8a94ab;
		--preview-border: rgba(24, 34, 56, 0.14);
		--preview-primary: #2f52c4;
		--preview-primary-text: #ffffff;
		--preview-card-radius: 20px;
		--preview-card-padding: 20px;
		--preview-control-radius: 12px;
		--preview-screen-gap: 0.875rem;
		--preview-copy-size: 0.8125rem;
		--preview-label-size: 0.8125rem;
		--preview-heading-size: 1.25rem;
		--preview-header-title-size: 1.75rem;
		--preview-header-margin-bottom: 24px;
		--preview-field-gap: 0.375rem;
		--preview-control-height: 44px;
		--preview-control-padding-x: 0.875rem;
		--preview-control-font-size: 0.875rem;
		--preview-pin-cell-height: 48px;
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		justify-content: safe center;
		height: calc(100% - 34px);
		min-height: 0;
		padding: 48px 20px;
		overflow: auto;
		background-color: var(--preview-background-color, var(--preview-bg-page));
		background-image:
			radial-gradient(1100px 460px at 50% -140px, rgba(47, 82, 196, 0.1), transparent 68%),
			var(--preview-background-image, none);
		background-position: center;
		background-size: cover;
		color: var(--preview-text-color, var(--preview-text));
		font-family: Inter, ui-sans-serif, system-ui, sans-serif;
		line-height: 1.5;
	}

	.login-preview-page.dark {
		--preview-bg-page: #0b0e16;
		--preview-bg-card: #131a2a;
		--preview-bg-glass: #1a2336;
		--preview-bg-input: #1a2336;
		--preview-text: #eef2fa;
		--preview-text-secondary: #aeb9d0;
		--preview-text-muted: #7683a0;
		--preview-border: rgba(147, 174, 242, 0.18);
		--preview-primary: #93aef2;
		--preview-primary-text: #0c1327;
	}

	.login-preview-page.template-classic.light {
		--preview-bg-page: #eeeae3;
		--preview-bg-card: rgba(254, 253, 250, 0.94);
		--preview-text: #333333;
		--preview-text-secondary: #666666;
		--preview-primary: #2c2724;
	}

	.login-preview-page.template-fullbleed {
		--preview-bg-page: #0d0908;
		--preview-bg-card: rgba(14, 10, 9, 0.58);
		--preview-bg-glass: rgba(14, 10, 9, 0.45);
		--preview-bg-input: rgba(255, 255, 255, 0.08);
		--preview-text: #f6efe9;
		--preview-text-secondary: #cfc3ba;
		--preview-text-muted: #99897f;
		--preview-border: rgba(255, 255, 255, 0.2);
		--preview-primary: #e8623f;
		--preview-primary-text: #1c0d08;
		--preview-card-radius: 0;
		--preview-control-radius: 0;
		background-image:
			linear-gradient(to top, rgba(10, 7, 6, 0.55), rgba(10, 7, 6, 0.1) 30%, transparent 48%),
			var(
				--preview-background-image,
				linear-gradient(160deg, #3a2018 0%, #17100c 60%, #0d0908 100%)
			);
	}

	.login-preview-page.font-rounded {
		font-family: 'Nunito Sans', Inter, ui-sans-serif, system-ui, sans-serif;
	}

	.login-preview-page.font-serif {
		font-family: Georgia, 'Times New Roman', serif;
	}

	.login-preview-page.font-mono {
		font-family: 'JetBrains Mono', Consolas, monospace;
	}

	.login-preview-page.font-compact {
		--preview-card-padding: 18px;
		--preview-screen-gap: 0.75rem;
		font-size: 0.875rem;
	}

	.login-preview-page.font-spacious {
		--preview-card-padding: 24px;
		--preview-screen-gap: 1rem;
		font-size: 1.05rem;
	}

	.preview-auth-container {
		order: 1;
		width: 100%;
		max-width: 420px;
		z-index: 1;
	}

	.preview-main {
		display: contents;
	}

	.preview-auth-container.wide {
		max-width: 560px;
	}

	.preview-card {
		overflow: hidden;
		border: 1px solid var(--preview-border);
		border-radius: var(--preview-card-radius);
		background: var(--preview-bg-card);
		box-shadow: 0 24px 72px rgba(0, 0, 0, 0.18);
		backdrop-filter: blur(18px) saturate(140%);
	}

	.preview-card-body {
		padding: var(--preview-card-padding);
	}

	.preview-auth-header {
		margin-bottom: var(--preview-header-margin-bottom);
		text-align: center;
	}

	.preview-auth-mark {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		margin: 0 auto 12px;
		border-radius: 16px;
		background: var(--preview-primary);
		color: var(--preview-primary-text);
		font-weight: 900;
	}

	.preview-auth-logo {
		display: block;
		max-width: 200px;
		max-height: 52px;
		margin: 0 auto 12px;
		object-fit: contain;
	}

	.preview-auth-header h1,
	.preview-brand-panel h2 {
		margin: 0;
		color: var(--preview-title-color, var(--preview-text));
		letter-spacing: 0;
	}

	.preview-auth-header h1 {
		font-size: var(--preview-header-title-size);
		font-weight: 800;
	}

	.preview-auth-header p {
		margin: 6px 0 0;
		color: var(--preview-copy-color, var(--preview-text-secondary));
		font-size: var(--preview-copy-size);
	}

	.login-preview-page.header-bar .preview-auth-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		margin-bottom: 20px;
		border: 1px solid var(--preview-border);
		border-radius: 16px;
		background: var(--preview-bg-glass);
		text-align: left;
	}

	.login-preview-page.logo-row .preview-auth-header {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
	}

	.login-preview-page.logo-row .preview-auth-logo,
	.login-preview-page.logo-row .preview-auth-header h1,
	.login-preview-page.logo-row .preview-auth-mark {
		margin: 0;
	}

	.runtime-screen {
		display: grid;
		gap: var(--preview-screen-gap);
	}

	.runtime-screen-heading h2 {
		margin: 0;
		color: var(--preview-title-color, var(--preview-text));
		font-size: var(--preview-heading-size);
		line-height: 1.25;
	}

	.runtime-screen-heading p,
	.runtime-screen-text,
	.runtime-screen-field small,
	.consent-item span {
		margin: 0.28rem 0 0;
		color: var(--preview-copy-color, var(--preview-text-secondary));
		font-size: var(--preview-copy-size);
		line-height: 1.5;
	}

	.auth-method-button,
	.preview-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		min-height: var(--preview-control-height);
		border: 1px solid transparent;
		border-radius: var(--preview-control-radius);
		background: var(--preview-primary);
		color: var(--preview-primary-text);
		font: inherit;
		font-size: var(--preview-control-font-size);
		font-weight: 600;
		text-decoration: none;
	}

	.auth-method-button {
		width: 100%;
		padding: 0 var(--preview-control-padding-x);
	}

	.auth-method-button.secondary,
	.preview-btn.secondary {
		border-color: var(--preview-border);
		background: var(--preview-bg-glass);
		color: var(--preview-text-color, var(--preview-text));
	}

	.preview-btn {
		padding: 0 var(--preview-control-padding-x);
	}

	.preview-actions {
		display: flex;
		gap: 0.75rem;
	}

	.runtime-screen-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--preview-text-secondary);
		font-size: var(--preview-copy-size);
	}

	.runtime-screen-divider::before,
	.runtime-screen-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--preview-border);
	}

	.runtime-screen-field {
		display: grid;
		gap: var(--preview-field-gap);
		font-size: var(--preview-label-size);
		font-weight: 700;
	}

	.runtime-screen-field input {
		width: 100%;
		min-height: var(--preview-control-height);
		border: 1px solid var(--preview-border);
		border-radius: var(--preview-control-radius);
		background: var(--preview-bg-input);
		color: var(--preview-text-color, var(--preview-text));
		padding: 0 var(--preview-control-padding-x);
		font: inherit;
	}

	.pin-row {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 0.5rem;
	}

	.pin-row span {
		display: grid;
		place-items: center;
		height: var(--preview-pin-cell-height);
		border: 1px solid var(--preview-border);
		border-radius: var(--preview-control-radius);
		background: var(--preview-bg-input);
		font-size: 1.125rem;
		font-weight: 900;
	}

	.consent-item,
	.status-box {
		padding: 0.8rem;
		border: 1px solid var(--preview-border);
		border-radius: 14px;
		background: var(--preview-bg-glass);
	}

	.consent-item strong {
		display: block;
		margin-bottom: 0.25rem;
	}

	.preview-bottom-link {
		margin: 16px 0 0;
		text-align: center;
		color: var(--preview-copy-color, var(--preview-text-secondary));
		font-size: 0.875rem;
	}

	.preview-topbar {
		order: 2;
		display: flex;
		gap: 8px;
		margin-top: 22px;
		z-index: 2;
	}

	.preview-topbar button,
	.preview-topbar select {
		height: 36px;
		border: 1px solid var(--preview-border);
		border-radius: 8px;
		background: var(--preview-bg-glass);
		color: var(--preview-text-color, var(--preview-text));
	}

	.preview-topbar button {
		width: 36px;
	}

	.preview-topbar select {
		padding: 0 10px;
	}

	.preview-topbar.floating {
		position: absolute;
	}

	.login-preview-page.topbar-top-right .preview-topbar.floating {
		top: 20px;
		right: 20px;
		margin-top: 0;
	}

	.login-preview-page[data-topbar-position='bottom_left'] .preview-topbar.floating,
	.login-preview-page[data-topbar-position='bottom_center'] .preview-topbar.floating,
	.login-preview-page[data-topbar-position='bottom_right'] .preview-topbar.floating {
		bottom: 20px;
		margin-top: 0;
	}

	.login-preview-page[data-topbar-position='bottom_left'] .preview-topbar.floating {
		left: 20px;
	}

	.login-preview-page[data-topbar-position='bottom_center'] .preview-topbar.floating {
		left: 50%;
		transform: translateX(-50%);
	}

	.login-preview-page[data-topbar-position='bottom_right'] .preview-topbar.floating {
		right: 20px;
	}

	.preview-footer {
		order: 3;
		z-index: 1;
		margin-top: 14px;
		text-align: center;
		color: var(--preview-copy-color, var(--preview-text-muted));
		font-size: 0.75rem;
	}

	.preview-footer-links {
		display: flex;
		justify-content: center;
		gap: 14px;
		margin-bottom: 6px;
	}

	.preview-footer-links a {
		color: var(--preview-copy-color, var(--preview-text-secondary));
		font-weight: 700;
	}

	.preview-footer > div a {
		color: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}

	.login-preview-page.footer-bar .preview-footer {
		width: min(100%, 420px);
		padding: 12px 16px;
		border: 1px solid var(--preview-border);
		border-radius: 16px;
		background: var(--preview-bg-glass);
	}

	.login-preview-page.split {
		display: grid;
		--preview-split-brand-track: minmax(0, 60%);
		--preview-split-auth-track: minmax(320px, 40%);
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr) auto;
		gap: 0;
		align-items: stretch;
		justify-items: stretch;
		padding: 0;
		overflow: hidden;
	}

	.login-preview-page.split .preview-main {
		display: grid;
		grid-row: 1;
		grid-template-columns: var(--preview-split-brand-track) var(--preview-split-auth-track);
		grid-template-rows: minmax(0, 1fr);
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.login-preview-page.split[data-split-background-mode='brand'] {
		background-image: radial-gradient(
			1100px 460px at 50% -140px,
			rgba(47, 82, 196, 0.1),
			transparent 68%
		);
	}

	.login-preview-page.split .preview-main > .preview-brand-panel,
	.login-preview-page.split .preview-main > .preview-auth-container {
		grid-row: 1;
		min-width: 0;
	}

	.login-preview-page.split .preview-main > .preview-brand-panel {
		grid-column: 1;
	}

	.login-preview-page.split .preview-main > .preview-auth-container {
		grid-column: 2;
	}

	.login-preview-page.split.split-wide {
		--preview-split-brand-track: minmax(0, 40%);
		--preview-split-auth-track: minmax(320px, 60%);
	}

	.login-preview-page.split.split-right .preview-main {
		grid-template-columns: var(--preview-split-auth-track) var(--preview-split-brand-track);
	}

	.login-preview-page.split.split-right .preview-main > .preview-brand-panel {
		grid-column: 2;
	}

	.login-preview-page.split.split-right .preview-main > .preview-auth-container {
		grid-column: 1;
	}

	.login-preview-page.split[data-brand-content-mode='none'] .preview-main {
		grid-template-columns: minmax(0, 1fr);
	}

	.login-preview-page.split[data-brand-content-mode='none']
		.preview-main
		> .preview-auth-container {
		grid-column: 1;
	}

	.preview-brand-panel {
		--preview-brand-panel-title-color: #f4f7ff;
		--preview-brand-panel-copy-color: #c7d2eb;

		display: flex;
		align-items: center;
		justify-content: flex-start;
		min-height: 100%;
		padding: 42px;
		position: relative;
		overflow: hidden;
		background-image: linear-gradient(150deg, #22346e 0%, #101a38 55%, #0b1226 100%);
		background-position: center;
		background-size: cover;
		color: #ffffff;
	}

	.login-preview-page[data-has-page-background-image='true'][data-split-background-mode='shared']
		.preview-brand-panel,
	.login-preview-page[data-has-page-background-image='true'][data-split-background-mode='panel']
		.preview-brand-panel {
		background-image: none;
	}

	.login-preview-page[data-has-page-background-image='true'][data-split-background-mode='brand']
		.preview-brand-panel {
		background-image: var(--preview-background-image);
	}

	.preview-brand-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		background: linear-gradient(
			to top,
			rgba(9, 13, 30, 0.62),
			rgba(9, 13, 30, 0.08) 58%,
			transparent
		);
	}

	.login-preview-page[data-brand-position='top'] .preview-brand-panel::before {
		background: linear-gradient(
			to bottom,
			rgba(9, 13, 30, 0.62),
			rgba(9, 13, 30, 0.08) 58%,
			transparent
		);
	}

	.login-preview-page[data-brand-position='center'] .preview-brand-panel::before {
		background: rgba(9, 13, 30, 0.38);
	}

	.login-preview-page.split-right .preview-brand-panel {
		order: 2;
	}

	.preview-brand-panel-content {
		position: relative;
		z-index: 1;
		max-width: 520px;
	}

	.preview-brand-logo {
		display: block;
		max-width: min(260px, 100%);
		max-height: 92px;
		object-fit: contain;
		margin-bottom: 24px;
	}

	.preview-brand-eyebrow {
		margin: 0 0 16px;
		color: var(--preview-brand-panel-copy-color);
		font-size: 0.82rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.preview-brand-panel h2 {
		color: var(--preview-brand-panel-title-color);
		font-size: 2.5rem;
		line-height: 1.05;
	}

	.preview-brand-panel p:last-child {
		margin: 18px 0 0;
		color: var(--preview-brand-panel-copy-color);
		font-size: 1rem;
		line-height: 1.7;
	}

	.login-preview-page[data-brand-position='top'] .preview-main > .preview-brand-panel {
		align-items: flex-start;
	}

	.login-preview-page[data-brand-position='center'] .preview-main > .preview-brand-panel {
		align-items: center;
	}

	.login-preview-page[data-brand-position='bottom'] .preview-main > .preview-brand-panel {
		align-items: flex-end;
	}

	.login-preview-page[data-brand-align='left'] .preview-main > .preview-brand-panel {
		justify-content: flex-start;
	}

	.login-preview-page[data-brand-align='left'] .preview-brand-panel-content {
		text-align: left;
	}

	.login-preview-page[data-brand-align='left'] .preview-brand-logo {
		margin-right: auto;
		margin-left: 0;
	}

	.login-preview-page[data-brand-align='center'] .preview-brand-panel-content {
		text-align: center;
	}

	.login-preview-page[data-brand-align='center'] .preview-main > .preview-brand-panel {
		justify-content: center;
	}

	.login-preview-page[data-brand-align='center'] .preview-brand-logo {
		margin-right: auto;
		margin-left: auto;
	}

	.login-preview-page[data-brand-align='right'] .preview-brand-panel-content {
		text-align: right;
	}

	.login-preview-page[data-brand-align='right'] .preview-main > .preview-brand-panel {
		justify-content: flex-end;
	}

	.login-preview-page[data-brand-align='right'] .preview-brand-logo {
		margin-right: 0;
		margin-left: auto;
	}

	.login-preview-page.split .preview-auth-container {
		display: flex;
		flex-direction: column;
		justify-content: center;
		max-width: none;
		min-height: 0;
		height: 100%;
		position: relative;
		overflow: auto;
		padding: 32px 42px 64px;
		background: var(--preview-bg-card);
		isolation: isolate;
	}

	.login-preview-page.split .preview-auth-container::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 0;
		display: none;
		pointer-events: none;
		background-image: var(--preview-login-panel-background-image, none);
		background-position: center;
		background-size: cover;
		opacity: var(--preview-login-panel-background-opacity, 0.7);
	}

	.login-preview-page.split .preview-auth-container > * {
		position: relative;
		z-index: 1;
	}

	.login-preview-page.split[data-split-background-mode='shared'] .preview-auth-container,
	.login-preview-page.split[data-split-background-mode='panel'] .preview-auth-container {
		background: color-mix(in srgb, var(--preview-bg-glass) 72%, transparent);
		backdrop-filter: blur(26px) saturate(160%);
	}

	.login-preview-page.split[data-split-background-mode='brand'] .preview-auth-container {
		background: var(--preview-login-panel-background-fill, var(--preview-bg-card));
		backdrop-filter: none;
	}

	.login-preview-page.split[data-split-background-mode='panel'][data-has-login-panel-background-image='true']
		.preview-auth-container::before {
		display: block;
	}

	.login-preview-page.split .preview-card {
		width: 100%;
		max-width: 400px;
		margin-inline: auto;
		overflow: visible;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		backdrop-filter: none;
	}

	.login-preview-page.split .preview-card-body {
		padding: 0;
	}

	.login-preview-page.split .preview-auth-header {
		margin-bottom: 18px;
	}

	.login-preview-page.split .preview-auth-mark {
		width: 42px;
		height: 42px;
		margin-bottom: 8px;
	}

	.login-preview-page.split .preview-auth-header h1 {
		font-size: 1.65rem;
	}

	.login-preview-page.split .runtime-screen {
		gap: var(--preview-screen-gap);
	}

	.login-preview-page.split .runtime-screen-heading h2 {
		font-size: var(--preview-heading-size);
	}

	.login-preview-page.split .runtime-screen-heading p,
	.login-preview-page.split .runtime-screen-text,
	.login-preview-page.split .runtime-screen-field small,
	.login-preview-page.split .consent-item span {
		font-size: var(--preview-copy-size);
	}

	.login-preview-page.split .auth-method-button,
	.login-preview-page.split .preview-btn {
		min-height: var(--preview-control-height);
	}

	.login-preview-page.split .runtime-screen-field input {
		min-height: var(--preview-control-height);
		padding: 0 var(--preview-control-padding-x);
	}

	.login-preview-page.split .preview-bottom-link {
		margin-top: 12px;
	}

	.login-preview-page.split .preview-main > .preview-topbar {
		position: absolute;
		margin: 0;
		z-index: 4;
	}

	.login-preview-page.split[data-topbar-position='below_card'] .preview-main > .preview-topbar {
		position: static;
		grid-row: 1;
		grid-column: 2;
		align-self: end;
		justify-self: center;
		margin-bottom: 42px;
	}

	.login-preview-page.split.split-right[data-topbar-position='below_card']
		.preview-main
		> .preview-topbar,
	.login-preview-page.split[data-brand-content-mode='none'][data-topbar-position='below_card']
		.preview-main
		> .preview-topbar {
		grid-column: 1;
	}

	.login-preview-page.split .preview-auth-container > .preview-topbar {
		position: static;
		order: 0;
		align-self: center;
		margin: 0 0 12px;
	}

	.login-preview-page.split > .preview-page-footer {
		position: static;
		grid-row: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-height: 0;
		margin: 0;
		padding: 7px 16px;
		border-top: 1px solid var(--preview-border);
		border-right: 0;
		border-bottom: 0;
		border-left: 0;
		border-radius: 0;
		background: var(--preview-bg-page);
		z-index: 3;
	}

	.login-preview-page.split-card {
		padding: 0;
	}

	.login-preview-page.split-card .preview-main {
		width: calc(100% - 48px);
		height: calc(100% - 48px);
		margin: auto;
		border: 1px solid var(--preview-border);
		border-radius: 28px;
		box-shadow: 0 24px 72px rgba(0, 0, 0, 0.24);
	}

	.theme-preview-frame-shell.mobile .login-preview-page,
	.theme-preview-frame-shell.mobile .login-preview-page.split {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: flex-start;
		min-height: calc(100% - 34px);
		padding: 0;
		overflow: hidden;
	}

	.theme-preview-frame-shell.mobile .login-preview-page.split .preview-main {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		width: 100%;
		height: auto;
		min-height: 0;
		margin: 0;
		border: 0;
		border-radius: 0;
		box-shadow: none;
	}

	.theme-preview-frame-shell.mobile .preview-brand-panel {
		display: none;
	}

	.theme-preview-frame-shell.mobile .login-preview-page.split .preview-auth-container {
		min-height: 0;
		padding: 28px 18px;
		border: 0;
	}

	.theme-preview-frame-shell.mobile .preview-auth-container,
	.theme-preview-frame-shell.mobile .preview-card {
		width: 100%;
		max-width: 100%;
	}

	.theme-preview-frame-shell.mobile .preview-card {
		margin-inline: 0;
	}

	.theme-preview-frame-shell.mobile .preview-actions {
		flex-wrap: wrap;
	}

	.theme-preview-frame-shell.mobile .preview-topbar.floating {
		position: static;
		align-self: center;
		margin-top: 18px;
	}

	.theme-preview-frame-shell.mobile .login-preview-page.split .preview-main > .preview-topbar {
		position: static;
		align-self: center;
		margin-top: 18px;
	}

	.theme-preview-frame-shell.mobile .login-preview-page.split > .preview-page-footer {
		position: static;
		width: 100%;
		min-height: auto;
		margin-top: 14px;
		padding: 0;
		background: transparent;
	}

	.login-preview-page.fullbleed .preview-auth-header h1 {
		color: var(--preview-title-color, #ffffff);
		font-size: var(--preview-header-title-size);
		text-shadow: 0 2px 28px rgba(0, 0, 0, 0.5);
	}

	.login-preview-page.fullbleed {
		padding-block: 30px 22px;
	}

	.login-preview-page.fullbleed .preview-auth-header {
		margin-bottom: 18px;
	}

	.login-preview-page.fullbleed .preview-auth-mark {
		width: 44px;
		height: 44px;
		margin-bottom: 8px;
	}

	.login-preview-page.fullbleed .preview-card-body {
		padding: var(--preview-card-padding);
	}

	.login-preview-page.fullbleed .runtime-screen {
		gap: var(--preview-screen-gap);
	}

	.login-preview-page.fullbleed .auth-method-button,
	.login-preview-page.fullbleed .preview-btn {
		min-height: var(--preview-control-height);
	}

	.login-preview-page.fullbleed .runtime-screen-field input {
		min-height: var(--preview-control-height);
		padding: 0 var(--preview-control-padding-x);
	}

	.login-preview-page.fullbleed .preview-auth-header p,
	.login-preview-page.fullbleed .preview-footer,
	.login-preview-page.fullbleed .preview-bottom-link {
		color: var(--preview-copy-color, rgba(255, 255, 255, 0.82));
		text-shadow: 0 1px 16px rgba(0, 0, 0, 0.5);
	}

	.theme-publish-error {
		margin-bottom: 12px;
	}

	.settings-actions {
		position: sticky;
		bottom: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
		padding: 14px 0 0;
		background: var(--color-bg-page);
	}

	@media (max-width: 720px) {
		.theme-section-header {
			align-items: center;
		}

		.custom-theme-card .theme-section-header {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-items: start;
		}

		.custom-theme-card .theme-publish-button {
			width: 100%;
		}

		.custom-theme-row {
			grid-template-columns: 18px minmax(0, 1fr) auto;
			gap: 10px;
		}

		.custom-theme-selection {
			grid-template-columns: 42px minmax(0, 1fr);
			gap: 10px;
		}

		.custom-theme-swatch {
			width: 42px;
			height: 42px;
		}

		.custom-theme-timestamps {
			grid-column: 1 / -1;
			min-width: 0;
		}

		.custom-theme-timestamps time {
			white-space: normal;
		}

		.login-preview-page,
		.login-preview-page.split {
			display: flex;
			padding: 28px 16px;
		}

		.preview-brand-panel {
			display: none;
		}

		.login-preview-page.split .preview-auth-container {
			padding: 0;
			background: transparent;
		}
	}
	.theme-template-option {
		cursor: pointer;
	}

	.theme-template-option:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.theme-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.theme-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.6875rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.theme-badge.active {
		border-color: color-mix(in srgb, var(--color-success) 40%, transparent);
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.editor-topbar {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
	}

	.editor-title {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 220px;
		flex-wrap: wrap;
	}

	.editor-builtin-name {
		color: var(--color-text);
		font-size: 1.05rem;
	}

	.editor-name-input {
		max-width: 320px;
		font-weight: 700;
	}

	.editor-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.editor-dirty {
		color: var(--color-warning);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.editor-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 16px 20px;
		align-items: start;
	}

	.editor-fields.advanced {
		grid-template-columns: 1fr;
	}

	.editor-field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.editor-field.toggle {
		grid-template-columns: 1fr auto;
		align-items: center;
	}

	.editor-field-label {
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.editor-field .segmented-control {
		flex-wrap: wrap;
		justify-self: start;
	}

	.text-section-header {
		align-items: end;
	}

	.text-locale-control {
		display: grid;
		gap: 6px;
		min-width: min(100%, 240px);
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.text-editor-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px 20px;
	}

	.page-title-fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	.editor-field-note {
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 400;
		line-height: 1.5;
	}

	.text-editor-wide {
		grid-column: 1 / -1;
	}

	.text-editor-help {
		margin: 14px 0 0;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		line-height: 1.5;
	}

	.color-field {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.color-field input[type='color'] {
		width: 42px;
		height: 34px;
		padding: 2px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
	}

	.color-field input[type='text'] {
		flex: 1;
		min-width: 0;
	}

	@media (max-width: 720px) {
		.text-section-header {
			align-items: stretch;
			flex-direction: column;
		}

		.text-locale-control {
			width: 100%;
		}

		.text-editor-grid {
			grid-template-columns: 1fr;
		}

		.text-editor-wide {
			grid-column: auto;
		}
	}
</style>
