<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import CibaView, { type CibaRequest } from '$lib/views/CibaView.svelte';
	import { cibaAPI } from '$lib/api/client';
	import { cibaApprovalErrorMessage } from '$lib/api/approval-errors';
	import { decideCibaRequest } from './ciba-decision';
	import { messageForCaughtError } from '$lib/errors/display-error';
	import { onMount } from 'svelte';

	const { brandingStore } = useLoginUIStores();

	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');
	let pendingRequests = $state<CibaRequest[]>([]);
	let processingId = $state<string | null>(null);
	/** Now, in epoch seconds, ticking so each request's countdown moves. */
	let now = $state(Math.floor(Date.now() / 1000));

	onMount(() => {
		void loadPendingRequests();
		const tick = setInterval(() => {
			now = Math.floor(Date.now() / 1000);
		}, 1000);
		return () => clearInterval(tick);
	});

	async function loadPendingRequests() {
		loading = true;
		error = '';

		try {
			const { data, error: apiError } = await cibaAPI.getPending();
			if (apiError) {
				error = cibaApprovalErrorMessage($LL, apiError, $LL.ciba_errorLoadPending());
			} else {
				pendingRequests = (data ?? []).map(
					(request): CibaRequest => ({
						auth_req_id: request.auth_req_id,
						client_id: request.client_id,
						client_name: request.client_name,
						client_logo_uri: request.client_logo_uri,
						scope: request.scope,
						binding_message: request.binding_message ?? undefined,
						user_code: request.user_code ?? undefined,
						created_at: request.created_at,
						expires_at: request.expires_at
					})
				);
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.ciba_errorGeneric());
		} finally {
			loading = false;
		}
	}

	async function decide(authReqId: string, decision: 'approve' | 'reject') {
		if (processingId !== null) return;
		const request = pendingRequests.find((r) => r.auth_req_id === authReqId);
		if (!request || isExpired(request.expires_at)) {
			error = $LL.ciba_expired();
			return;
		}
		processingId = authReqId;
		error = '';
		try {
			const outcome = await decideCibaRequest(cibaAPI, authReqId, decision, $LL);
			if (outcome.status === 'decided') {
				successMessage = outcome.message;
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				setTimeout(() => {
					successMessage = '';
				}, 3000);
			} else {
				error = outcome.message;
				if (outcome.dropRequest) {
					pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);
				}
			}
		} catch (err) {
			error = messageForCaughtError(err, $LL.ciba_errorGeneric());
		} finally {
			processingId = null;
		}
	}

	function isExpired(expiresAt: number): boolean {
		return Math.floor(Date.now() / 1000) >= expiresAt;
	}
</script>

<svelte:head>
	<title>{$LL.ciba_title()} - {brandingStore.brandName || $LL.app_title()}</title>
</svelte:head>

<AuthPageShell wide>
	<CibaView
		{loading}
		requests={pendingRequests}
		{now}
		{processingId}
		{error}
		{successMessage}
		onApprove={(id) => decide(id, 'approve')}
		onDeny={(id) => decide(id, 'reject')}
		onRefresh={loadPendingRequests}
		onDismissError={() => (error = '')}
	/>
</AuthPageShell>
