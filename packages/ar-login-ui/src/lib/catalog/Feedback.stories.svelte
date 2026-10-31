<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Alert from '$lib/components/Alert.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Catalog from '$lib/storybook/Catalog.svelte';
	import Specimen from '$lib/storybook/Specimen.svelte';

	const { Story } = defineMeta({
		title: 'Catalog/Feedback',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Messages, progress and status: alerts, spinners, loading placeholders, the icon badge that opens a status page, and the info panels of consent, device and reauth.'
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="Alerts">
	{#snippet template()}
		<Catalog>
			{#each ['error', 'warning', 'success', 'info'] as variant (variant)}
				<Specimen
					name={variant}
					source="<Alert variant='{variant}'>"
					where={variant === 'error'
						? 'Failed sign-in, missing methods, network errors.'
						: variant === 'warning'
							? 'External IdP problems.'
							: variant === 'success'
								? 'Code resent, email verified, device approved.'
								: 'Directory migration notice, step fallback.'}
					card
				>
					<Alert variant={variant as 'error' | 'warning' | 'success' | 'info'}
						>{$LL.common_loading()}</Alert
					>
					<Alert
						variant={variant as 'error' | 'warning' | 'success' | 'info'}
						title="Title"
						dismissible>Message with a title that can be dismissed.</Alert
					>
				</Specimen>
			{/each}
		</Catalog>
	{/snippet}
</Story>

<Story name="Progress and loading">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Spinner"
				source="<Spinner size color>"
				where="consent and callback while loading."
			>
				<Spinner size="sm" />
				<Spinner />
				<Spinner size="lg" />
				<Spinner size="xl" />
			</Specimen>
			<Specimen
				name="Button spinner"
				source="i.spinner.i-ph-circle-notch"
				where="Inside a loading Button."
			>
				<i class="spinner i-ph-circle-notch" style="font-size:20px"></i>
			</Specimen>
			<Specimen
				name="Status line"
				source="div.auth-progress > span.auth-progress__spinner"
				where="login and signup while a passkey or email code is being handled; verify-email-code for the sent-to line."
				card
			>
				<div class="auth-progress" role="status">
					<span class="auth-progress__spinner" aria-hidden="true"></span>
					<span>{$LL.common_loading()}</span>
				</div>
			</Specimen>
			<Specimen
				name="Initial loading"
				source="div.auth-initial-loading > span.auth-initial-loading__spinner"
				where="login and signup while the methods and the screen are fetched; keeps the area from jumping."
				card
			>
				<div class="auth-initial-loading" role="status">
					<span class="auth-initial-loading__spinner" aria-hidden="true"></span>
					<span class="sr-only">{$LL.common_loading()}</span>
				</div>
			</Specimen>
			<Specimen
				name="Skeleton"
				source="<Skeleton>"
				where="Placeholder while the client's name and logo are fetched."
			>
				<div style="width:100%;max-width:400px;display:grid;gap:8px">
					<Skeleton width="40%" height="0.75rem" />
					<Skeleton width="70%" height="1rem" />
				</div>
			</Specimen>
			<Specimen
				name="Client card placeholder"
				source=".auth-client-card.animate-pulse"
				where="login, while client information loads."
				card
			>
				<div class="auth-client-card animate-pulse">
					<div class="auth-client-card__row">
						<div
							class="flex-shrink-0 h-12 w-12 rounded-lg"
							style="background:var(--bg-subtle)"
						></div>
						<div class="flex-1">
							<div class="h-3 rounded w-20 mb-2" style="background:var(--bg-subtle)"></div>
							<div class="h-4 rounded w-32" style="background:var(--bg-subtle)"></div>
						</div>
					</div>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Status page icons">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Default"
				source=".auth-icon-badge__circle"
				where="Success states: logout complete, callback success, device, verify-email-code."
				card
			>
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle">
						<div class="i-ph-check-circle h-9 w-9 auth-icon-badge__icon"></div>
					</div>
				</div>
			</Specimen>
			<Specimen name="Warning" source=".auth-icon-badge__circle--warning" where="reauth." card>
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle auth-icon-badge__circle--warning">
						<div class="i-ph-shield-warning h-9 w-9 auth-icon-badge__icon"></div>
					</div>
				</div>
			</Specimen>
			<Specimen
				name="Danger"
				source=".auth-icon-badge__circle--danger"
				where="error page, callback error."
				card
			>
				<div class="auth-icon-badge">
					<div class="auth-icon-badge__circle auth-icon-badge__circle--danger">
						<div class="i-ph-warning-circle h-9 w-9 auth-icon-badge__icon"></div>
					</div>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Consent and device panels">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Trusted client badge"
				source="span.auth-badge--trusted"
				where="consent, for clients marked trusted."
			>
				<span class="auth-badge--trusted"
					><span class="i-ph-shield-check h-3 w-3"></span>{$LL.consent_trustedClient()}</span
				>
			</Specimen>
			<Specimen
				name="Delegated access warning"
				source=".auth-warning-banner"
				where="consent, when acting on behalf of another user and the feature is on."
				card
			>
				<div class="auth-warning-banner">
					<div class="i-ph-warning h-5 w-5"></div>
					<div>
						<h3 class="auth-warning-banner__title">{$LL.consent_delegatedAccess()}</h3>
						<p class="auth-warning-banner__text">
							{$LL.consent_actingOnBehalfOf({ name: 'Ada Lovelace' })}
						</p>
					</div>
				</div>
			</Specimen>
			<Specimen
				name="Requested scopes"
				source="ul.auth-scopes-list"
				where="consent and device: what the client will be able to do."
				card
			>
				<ul class="auth-scopes-list">
					<li>
						<div class="i-ph-check-circle h-5 w-5 auth-scopes-list__icon"></div>
						<span>Read your profile</span>
					</li>
					<li>
						<div class="i-ph-check-circle h-5 w-5 auth-scopes-list__icon"></div>
						<span>Read your email address</span>
					</li>
				</ul>
			</Specimen>
			<Specimen
				name="Signed-in user"
				source=".auth-info-box > .auth-user-info"
				where="consent."
				card
			>
				<div class="auth-info-box">
					<p class="auth-info-box__label mb-2">{$LL.consent_userInfo()}</p>
					<div class="auth-user-info">
						<div class="auth-user-info__avatar-placeholder">
							<div class="i-ph-user h-5 w-5" style="color:var(--primary)"></div>
						</div>
						<div>
							<p class="auth-user-info__name">Ada Lovelace</p>
							<p class="auth-user-info__email">ada@example.com</p>
						</div>
					</div>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Status badge">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Status badge"
				source="<StatusBadge status>"
				where="Component set only; no login page uses it today."
			>
				{#each ['active', 'inactive', 'success', 'warning', 'danger', 'info', 'neutral'] as status (status)}
					<StatusBadge status={status as 'active'} label={status} />
				{/each}
			</Specimen>
		</Catalog>
	{/snippet}
</Story>
