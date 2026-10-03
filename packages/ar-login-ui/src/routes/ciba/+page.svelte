<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import CibaView, { type CibaRequest } from '$lib/views/CibaView.svelte';
	import { cibaAPI } from '$lib/api/client';
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
				error = $LL.ciba_errorLoadPending();
			} else {
				pendingRequests = (data as CibaRequest[]) || [];
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
		try {
			const { error: apiError } =
				decision === 'approve' ? await cibaAPI.approve(authReqId) : await cibaAPI.reject(authReqId);

			if (apiError) {
				error = decision === 'approve' ? $LL.ciba_errorApproveFailed() : $LL.ciba_errorDenyFailed();
			} else {
				successMessage =
					decision === 'approve' ? $LL.ciba_approvedSuccess() : $LL.ciba_rejectedSuccess();
				pendingRequests = pendingRequests.filter((r) => r.auth_req_id !== authReqId);

				setTimeout(() => {
					successMessage = '';
				}, 3000);
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
