<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import AuthPageShell from '#lib/components/AuthPageShell.svelte';
	import ConsentView, { type ConsentScreenData } from '#lib/views/ConsentView.svelte';
	import { useLoginUIStores } from '#lib/stores/login-ui-context.js';
	import { LL } from '$i18n/i18n-svelte';
	import { API_BASE_URL, consentAPI, type ConsentSubmission } from '#lib/api/client.js';
	import { loginUiDisplayError, messageForCaughtError } from '#lib/errors/display-error.js';
	import { isValidRedirectUrl } from '#lib/utils/url-validation.js';
	import { releaseSelectedNames } from '#lib/consent-release.js';

	const { brandingStore } = useLoginUIStores();

	// ---------------------------------------------------------------------------
	// Types
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let loading = $state(true);
	let allowLoading = $state(false);
	let denyLoading = $state(false);
	let consentData = $state<ConsentScreenData | null>(null);
	let error = $state('');
	let selectedOrgId = $state<string | null>(null);
	let consentItemDecisions = $state<Record<string, 'granted' | 'denied'>>({});
	// The optional information items the user changed; an unset one starts from its default.
	let releaseChoices = $state<Record<string, boolean>>({});

	const challengeId = $derived(page.url.searchParams.get('challenge_id'));

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		if (!challengeId) {
			error = $LL.error_invalid_request();
			loading = false;
			return;
		}
		await loadConsentData();
	});

	// ---------------------------------------------------------------------------
	// Data
	// ---------------------------------------------------------------------------
	async function loadConsentData() {
		if (!challengeId) return;

		try {
			const { data, error: apiError } = await consentAPI.getData(challengeId);
			if (apiError) {
				throw loginUiDisplayError($LL.error_server_error());
			}

			consentData = data as ConsentScreenData;
			// A reloaded screen starts from its own defaults (what is shown may have changed).
			releaseChoices = {};
			if (consentData) {
				selectedOrgId = consentData.target_org_id || consentData.primary_org?.id || null;
				// Initialize consent item decisions
				if (consentData.consent_items) {
					const decisions: Record<string, 'granted' | 'denied'> = {};
					for (const item of consentData.consent_items) {
						decisions[item.statement_id] =
							item.checkbox_mode === 'none' || item.checkbox_default_checked === true
								? 'granted'
								: 'denied';
					}
					consentItemDecisions = decisions;
				}
			}
			loading = false;
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
			loading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Handlers
	// ---------------------------------------------------------------------------
	async function handleAllow() {
		if (!consentData || allowLoading || denyLoading) return;
		allowLoading = true;

		try {
			const submitPayload: ConsentSubmission = {
				challenge_id: consentData.challenge_id,
				approved: true,
				selected_org_id: selectedOrgId || undefined,
				acting_as_user_id: consentData.acting_as?.id
			};
			// Echo the documents displayed, including optional items omitted from decisions.
			submitPayload.consent_item_versions = Object.fromEntries(
				(consentData.consent_items ?? []).map((item) => [
					item.statement_id,
					{ version_id: item.version_id, content_hash: item.content_hash ?? null }
				])
			);
			// The information release, for what was shown: the optional items kept checked.
			if (consentData.information_release) {
				submitPayload.release_selected = releaseSelectedNames(
					consentData.information_release,
					releaseChoices
				);
				submitPayload.release_presentation_key = consentData.information_release.presentation_key;
			}
			// Include consent item decisions if consent management is enabled
			if (consentData.consent_management_enabled && Object.keys(consentItemDecisions).length > 0) {
				submitPayload.consent_item_decisions = consentItemDecisions;
			}
			const { data, error: apiError } = await consentAPI.submit(submitPayload);

			if (apiError?.error === 'document_changed') {
				const replacement = apiError.error_details?.consent_challenge_id;
				if (typeof replacement === 'string' && replacement) {
					const updated = new URL(window.location.href);
					updated.searchParams.set('challenge_id', replacement);
					window.location.replace(updated.toString());
				} else if (apiError.error_details?.refresh_consent === true) {
					error = '';
					await loadConsentData();
				} else {
					consentData = null;
					error = $LL.error_authorizationRequestExpired();
				}
				return;
			}
			if (apiError) {
				throw loginUiDisplayError($LL.error_server_error());
			}
			if (data?.redirect_url) {
				if (isValidRedirectUrl(data.redirect_url)) {
					window.location.href = data.redirect_url;
				} else {
					error = $LL.device_errorInvalidRedirect();
				}
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			allowLoading = false;
		}
	}

	async function handleDeny() {
		if (!consentData || allowLoading || denyLoading) return;
		denyLoading = true;

		try {
			const { data, error: apiError } = await consentAPI.submit({
				challenge_id: consentData.challenge_id,
				approved: false
			});

			if (apiError) {
				throw loginUiDisplayError($LL.error_server_error());
			}
			if (data?.redirect_url) {
				if (isValidRedirectUrl(data.redirect_url)) {
					window.location.href = data.redirect_url;
				} else {
					error = $LL.device_errorInvalidRedirect();
				}
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.error_unknown());
		} finally {
			denyLoading = false;
		}
	}

	function handleSwitchAccount() {
		// Only preserve challenge_id to prevent parameter injection
		const cid = new URLSearchParams(window.location.search).get('challenge_id');
		const returnPath = cid ? `/consent?challenge_id=${encodeURIComponent(cid)}` : '/consent';
		const returnUrl = new URL(returnPath, window.location.origin).toString();
		window.location.href = `${API_BASE_URL}/logout?redirect_uri=${encodeURIComponent(returnUrl)}`;
	}

	function handleOrgChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		selectedOrgId = target.value || null;
	}
</script>

<svelte:head>
	<title
		>{$LL.consent_title({ clientName: consentData?.client.client_name || '' })} - {brandingStore.brandName ||
			$LL.app_title()}</title
	>
</svelte:head>

<AuthPageShell wide>
	<ConsentView
		{loading}
		{error}
		{consentData}
		{selectedOrgId}
		bind:consentItemDecisions
		bind:releaseChoices
		{allowLoading}
		{denyLoading}
		onOrgChange={handleOrgChange}
		onSwitchAccount={handleSwitchAccount}
		onAllow={handleAllow}
		onDeny={handleDeny}
	/>
</AuthPageShell>
