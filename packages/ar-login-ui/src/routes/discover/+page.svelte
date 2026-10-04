<script lang="ts">
	import { getDefaultDiscoveryMode, getInteractiveDiscoveryMethods } from '$lib/discovery-ui';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import DiscoverView, { type DiscoveryCandidate } from '$lib/views/DiscoverView.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl } from '$lib/utils/url-validation';
	import { onMount } from 'svelte';

	const { themeStore } = useLoginUIStores();

	interface PageData {
		config: {
			config: {
				mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
				discovery_methods: string[];
				email_resolution_policy: 'exact_email_only' | 'disabled';
				selection_policy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
				allow_manual_tenant_entry: boolean;
				require_common_discovery_before_login: boolean;
				redirect_tenant_discover_to_common_entry: boolean;
			};
			ui: {
				theme: string;
				brand_name: string;
				logo_url: string | null;
				page_title: string;
				kicker_text: string;
				title_text: string;
				subtitle_text: string;
			};
			is_common_entry_host: boolean;
			single_tenant_mode: boolean;
			wayf_candidates?: DiscoveryCandidate[];
		};
		rememberedCandidate: DiscoveryCandidate | null;
		inviteToken?: string | null;
		inviteErrorCode?: string | null;
		expectedTenantId?: string | null;
		returnTo?: string | null;
		loginHint?: string | null;
	}

	interface ActionData {
		mode?: string;
		value?: string;
		loginHint?: string;
		emailChallengeId?: string;
		emailExpiresIn?: number;
		errorCode?: string;
		candidates?: DiscoveryCandidate[];
		result?: 'email_code_sent' | 'multiple' | 'manual_required' | 'not_found';
	}

	let { data, form }: { data: PageData; form?: ActionData } = $props();

	const methods = $derived(data.config.config.discovery_methods);
	const interactiveMethods = $derived(
		getInteractiveDiscoveryMethods(methods, data.config.config.selection_policy)
	);
	const wayfCandidates = $derived(data.config.wayf_candidates || []);
	const wayfOnly = $derived(interactiveMethods.length === 1 && interactiveMethods[0] === 'wayf');
	const ui = $derived(data.config.ui);
	const rememberedCandidate = $derived(data.rememberedCandidate);
	const submittedMode = $derived(form?.mode);
	const submittedValue = $derived(form?.value || '');
	const emailChallengeId = $derived(form?.emailChallengeId || '');
	const showTenantChooser = $derived(
		!(data.config.is_common_entry_host && data.config.config.mode === 'tenant_only')
	);

	let selectedMode = $derived(submittedMode || getDefaultDiscoveryMode(interactiveMethods));
	let value = $derived(submittedValue);

	const candidates = $derived(form?.candidates || []);
	const loginHint = $derived(form?.loginHint || data.loginHint || '');
	const errorCode = $derived(form?.errorCode || data.inviteErrorCode || '');
	const errorMessage = $derived(errorCode ? getErrorMessage(errorCode) : '');
	const pageTitle = $derived(ui.page_title || $LL.discover_pageTitle());
	const kickerText = $derived(ui.kicker_text || $LL.discover_kicker());
	const titleText = $derived(ui.title_text || $LL.discover_title());
	const subtitleText = $derived(ui.subtitle_text || $LL.discover_subtitle());

	// The common entry host (as this page resolved it, the common discovery URL included) loads no
	// tenant branding: the shell shows the discovery page's own brand, known as the page renders.
	const discoveryBrand = $derived(
		data.config.is_common_entry_host && !data.config.single_tenant_mode
			? {
					name: data.config.ui.brand_name || '',
					logoUrl:
						data.config.ui.logo_url && isValidImageUrl(data.config.ui.logo_url)
							? data.config.ui.logo_url
							: null
				}
			: undefined
	);

	let discoverySubmitting = $state(false);

	onMount(() => {
		themeStore.setTenantDefaults(ui.theme);
	});

	function getErrorMessage(code: string): string {
		switch (code) {
			case 'email_not_found':
				return $LL.discover_error_emailNotFound();
			case 'invalid_or_expired_code':
				return $LL.emailCode_errorInvalid();
			case 'rate_limited':
			case 'discovery_unavailable':
				return $LL.error_temporarily_unavailable();
			case 'discovery_disabled':
				return $LL.discover_error_manualRequired();
			case 'tenant_code_not_found':
				return $LL.discover_error_tenantCodeNotFound();
			case 'tenant_slug_not_found':
				return $LL.discover_error_tenantSlugNotFound();
			case 'invitation_not_found':
				return $LL.discover_error_invitationNotFound();
			case 'app_hint_not_found':
				return $LL.discover_error_appHintNotFound();
			case 'value_required':
				return $LL.discover_error_valueRequired();
			case 'manual_required':
				return $LL.discover_error_manualRequired();
			case 'invitation_unresolved':
				return $LL.discover_error_invitationUnresolved();
			case 'resolve_failed':
				return $LL.discover_error_resolveFailed();
			default:
				return $LL.discover_error_notFound();
		}
	}

	function handleDiscoverySubmit() {
		discoverySubmitting = true;
	}
</script>

<svelte:head>
	<title>{pageTitle}</title>
</svelte:head>

<AuthPageShell brand={discoveryBrand}>
	<DiscoverView
		{kickerText}
		{titleText}
		{subtitleText}
		tenantOnly={data.config.config.mode === 'tenant_only'}
		manualOnly={data.config.config.selection_policy === 'manual_only'}
		{errorMessage}
		{showTenantChooser}
		{interactiveMethods}
		{wayfOnly}
		{wayfCandidates}
		{rememberedCandidate}
		{candidates}
		postSelections={data.config.is_common_entry_host}
		hidden={{
			inviteToken: data.inviteToken,
			expectedTenantId: data.expectedTenantId,
			returnTo: data.returnTo,
			loginHint,
			emailChallengeId
		}}
		bind:selectedMode
		bind:value
		submitting={discoverySubmitting}
		onSubmit={handleDiscoverySubmit}
	/>
</AuthPageShell>
