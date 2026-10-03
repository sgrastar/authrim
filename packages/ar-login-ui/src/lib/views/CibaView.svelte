<script module lang="ts">
	/** A backchannel (CIBA) authentication request waiting for the person's decision. */
	export interface CibaRequest {
		auth_req_id: string;
		client_id: string;
		client_name: string;
		client_logo_uri: string | null;
		scope: string;
		binding_message?: string;
		user_code?: string;
		created_at: number;
		/** Epoch seconds. */
		expires_at: number;
	}
</script>

<script lang="ts">
	/**
	 * The CIBA page, as the person sees it: the requests an application made on their behalf, each
	 * to approve or deny. The route owns the requests and the clock; this view only draws what it is
	 * given (colours from the theme, so every theme and scheme reads alike) and reports decisions.
	 */
	import { Alert, Button, Card } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidImageUrl } from '$lib/utils/url-validation';

	type Props = {
		loading: boolean;
		requests: CibaRequest[];
		/** Now, in epoch seconds: the expiry countdown follows it. */
		now: number;
		/** The request being approved or denied. */
		processingId?: string | null;
		error?: string;
		successMessage?: string;
		onApprove: (authReqId: string) => void;
		onDeny: (authReqId: string) => void;
		onRefresh: () => void;
		onDismissError?: () => void;
	};

	let {
		loading,
		requests,
		now,
		processingId = null,
		error = '',
		successMessage = '',
		onApprove,
		onDeny,
		onRefresh,
		onDismissError
	}: Props = $props();

	function expired(request: CibaRequest): boolean {
		return now >= request.expires_at;
	}

	function remaining(request: CibaRequest): string {
		const seconds = Math.max(0, request.expires_at - now);
		return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
	}
</script>

<div class="space-y-6">
	<div class="text-center">
		<h2 class="auth-section-title">{$LL.ciba_title()}</h2>
		<p class="auth-section-subtitle">{$LL.ciba_subtitle()}</p>
	</div>

	{#if error}
		<Alert variant="error" dismissible={Boolean(onDismissError)} onDismiss={onDismissError}>
			{error}
		</Alert>
	{/if}

	{#if successMessage}
		<Alert variant="success" role="status">{successMessage}</Alert>
	{/if}

	{#if loading}
		<div class="auth-initial-loading" role="status">
			<span class="auth-initial-loading__spinner" aria-hidden="true"></span>
			<span class="sr-only">{$LL.common_loading()}</span>
		</div>
	{:else if requests.length === 0}
		<Card>
			<div class="py-8 text-center">
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle">
						<div class="i-heroicons-check-badge h-9 w-9 auth-icon-badge__icon"></div>
					</div>
				</div>
				<h3 class="auth-section-title">{$LL.ciba_noPendingRequests()}</h3>
				<p class="auth-section-subtitle">{$LL.ciba_noPendingDescription()}</p>
			</div>
		</Card>
	{:else}
		{#each requests as request (request.auth_req_id)}
			{@const isExpired = expired(request)}
			<Card>
				<div class="space-y-4">
					<div class="auth-ciba-request__head">
						{#if request.client_logo_uri && isValidImageUrl(request.client_logo_uri)}
							<img
								src={request.client_logo_uri}
								alt={request.client_name}
								class="auth-ciba-request__logo"
							/>
						{:else}
							<div class="auth-icon-badge__circle auth-ciba-request__logo" aria-hidden="true">
								<div class="i-heroicons-device-phone-mobile h-6 w-6 auth-icon-badge__icon"></div>
							</div>
						{/if}
						<div class="auth-ciba-request__client">
							<h3 class="auth-info-box__value">{request.client_name}</h3>
							<p class="auth-info-box__label">{$LL.ciba_authenticationRequest()}</p>
						</div>
						<div class="auth-ciba-request__expiry">
							<p class="auth-info-box__label">{$LL.ciba_expiresIn()}</p>
							<p class="auth-info-box__value">
								{isExpired ? $LL.ciba_expired() : remaining(request)}
							</p>
						</div>
					</div>

					{#if request.binding_message}
						<div class="auth-binding-message">
							<p class="auth-binding-message__label">{$LL.ciba_bindingMessage()}</p>
							<p class="auth-binding-message__text">{request.binding_message}</p>
						</div>
					{/if}

					{#if request.user_code}
						<div class="auth-info-box">
							<p class="auth-info-box__label">{$LL.ciba_verificationCode()}</p>
							<p class="auth-ciba-request__code">{request.user_code}</p>
						</div>
					{/if}

					<div>
						<p class="auth-info-box__label mb-2">{$LL.ciba_requestedAccess()}</p>
						<ul class="auth-scopes-list">
							{#each request.scope.split(' ').filter(Boolean) as scope (scope)}
								<li>
									<div class="i-heroicons-check-circle h-4 w-4 auth-scopes-list__icon"></div>
									{scope}
								</li>
							{/each}
						</ul>
					</div>

					<div class="auth-actions">
						<Button
							variant="secondary"
							class="flex-1"
							disabled={isExpired || processingId !== null}
							onclick={() => onDeny(request.auth_req_id)}
						>
							{$LL.ciba_rejectButton()}
						</Button>
						<Button
							variant="primary"
							class="flex-1"
							loading={processingId === request.auth_req_id}
							disabled={isExpired ||
								(processingId !== null && processingId !== request.auth_req_id)}
							onclick={() => onApprove(request.auth_req_id)}
						>
							{$LL.ciba_approveButton()}
						</Button>
					</div>
				</div>
			</Card>
		{/each}
	{/if}

	{#if !loading}
		<div class="text-center">
			<Button variant="secondary" onclick={onRefresh}>
				<div class="i-heroicons-arrow-path h-4 w-4" aria-hidden="true"></div>
				{$LL.ciba_refresh()}
			</Button>
		</div>
	{/if}
</div>
