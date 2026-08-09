<script lang="ts">
	import { Button, Card, Input } from '$lib/components';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import { isTotpDeleteProofReady } from '$lib/account/totp-proof';
	import type {
		AccountDevice,
		AccountPasskey,
		AccountSession,
		AccountTotpCredential
	} from '$lib/api/account';
	import { formatTimestamp } from '$lib/utils/date';

	let {
		devices = [],
		sessions = [],
		passkeys = [],
		totpCredentials = [],
		totpBackupCodes = { total: 0, remaining: 0 },
		totpEnrollment = null,
		loading = false,
		actionLoading = '',
		error = '',
		reauthNeeded = false,
		passkeySupported = false,
		totpManagementEnabled = false,
		areas = ['devices', 'sessions', 'passkeys', 'totp', 'social'],
		title = '',
		showSectionHeadings = true,
		onRefresh,
		onRevokeSession,
		onAddPasskey,
		onDeletePasskey,
		onStartTotpEnrollment,
		onActivateTotpEnrollment,
		onDeleteTotpCredential,
		onRegenerateTotpBackupCodes,
		onClearTotpEnrollment,
		onReauth
	} = $props<{
		devices?: AccountDevice[];
		sessions?: AccountSession[];
		passkeys?: AccountPasskey[];
		totpCredentials?: AccountTotpCredential[];
		totpBackupCodes?: { total: number; remaining: number };
		totpEnrollment?: {
			credentialId: string;
			secret: string;
			otpauthUri: string;
			backupCodes: string[];
		} | null;
		loading?: boolean;
		actionLoading?: string;
		error?: string;
		reauthNeeded?: boolean;
		passkeySupported?: boolean;
		totpManagementEnabled?: boolean;
		areas?: Array<'devices' | 'sessions' | 'passkeys' | 'totp' | 'social'>;
		title?: string;
		showSectionHeadings?: boolean;
		onRefresh: () => void;
		onRevokeSession: (id: string) => void;
		onAddPasskey: (deviceName: string) => void;
		onDeletePasskey: (id: string) => void;
		onStartTotpEnrollment: (label: string) => void;
		onActivateTotpEnrollment: (code: string) => void;
		onDeleteTotpCredential: (id: string, code: string) => void;
		onRegenerateTotpBackupCodes: (code: string) => void;
		onClearTotpEnrollment: () => void;
		onReauth: () => void;
	}>();

	function shows(area: 'devices' | 'sessions' | 'passkeys' | 'totp' | 'social'): boolean {
		return areas.includes(area);
	}

	function sessionTitle(session: AccountSession): string {
		return [session.browser, session.os].filter(Boolean).join(' / ') || $LL.account_unknownDevice();
	}

	function formatCountry(countryCode: string | null): string | null {
		if (!countryCode) return null;
		try {
			return new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ?? countryCode;
		} catch {
			return countryCode;
		}
	}

	let newPasskeyName = $state('');
	let newTotpLabel = $state('');
	let totpActivationCode = $state('');
	let totpRegenerateCode = $state('');
	let totpDeleteCodes = $state<Record<string, string>>({});
	let totpQrDataUrl = $state('');
	const activeTotpCredentials = $derived(
		totpCredentials.filter((credential: AccountTotpCredential) => credential.status === 'active')
	);

	function addPasskey() {
		onAddPasskey(newPasskeyName);
		newPasskeyName = '';
	}

	function startTotpEnrollment() {
		onStartTotpEnrollment(newTotpLabel);
		newTotpLabel = '';
	}

	function activateTotpEnrollment() {
		onActivateTotpEnrollment(totpActivationCode);
		totpActivationCode = '';
	}

	function deleteTotpCredential(id: string) {
		onDeleteTotpCredential(id, totpDeleteCodes[id] ?? '');
		totpDeleteCodes = { ...totpDeleteCodes, [id]: '' };
	}

	function updateTotpDeleteCode(id: string, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		totpDeleteCodes = { ...totpDeleteCodes, [id]: input.value };
	}

	function regenerateTotpBackupCodes() {
		onRegenerateTotpBackupCodes(totpRegenerateCode);
		totpRegenerateCode = '';
	}

	$effect(() => {
		const uri = totpEnrollment?.otpauthUri;
		if (!uri) {
			totpQrDataUrl = '';
			return;
		}
		import('qrcode')
			.then(({ toDataURL }) => toDataURL(uri, { margin: 1, width: 192 }))
			.then((value) => {
				if (totpEnrollment?.otpauthUri === uri) {
					totpQrDataUrl = value;
				}
			})
			.catch(() => {
				if (totpEnrollment?.otpauthUri === uri) {
					totpQrDataUrl = '';
				}
			});
	});
</script>

<Card>
	<div class="account-panel">
		<div class="panel-heading">
			<h2>{title || $LL.account_securityTitle()}</h2>
			<Button variant="ghost" size="sm" {loading} onclick={onRefresh}>
				{$LL.account_refresh()}
			</Button>
		</div>

		{#if error}
			<p class="panel-error">{error}</p>
			{#if reauthNeeded}
				<Button variant="secondary" size="sm" onclick={onReauth}>{$LL.account_reauth()}</Button>
			{/if}
		{/if}

		{#if shows('devices')}
			<section class="security-block">
				{#if showSectionHeadings}<h3>{$LL.account_devices()}</h3>{/if}
				<p class="section-description">{$LL.account_connectedDevicesDescription()}</p>
				{#if devices.length === 0}
					<p class="empty-text">{$LL.account_noConnectedDevices()}</p>
				{:else}
					<ul class="item-list">
						{#each devices as device (device.id)}
							<li>
								<div>
									<strong>
										{device.display_name || device.fallback_display_name || device.id}
										{#if device.current}
											<span class="inline-tag">{$LL.account_currentDevice()}</span>
										{/if}
									</strong>
									<span
										>{device.platform} / {formatTimestamp(
											device.last_seen_at_unix,
											getLocale()
										)}</span
									>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		{#if shows('sessions')}
			<section class="security-block">
				{#if showSectionHeadings}<h3>{$LL.account_sessions()}</h3>{/if}
				<p class="section-description">{$LL.account_sessionsDescription()}</p>
				{#if sessions.length === 0}
					<p class="empty-text">{$LL.account_empty()}</p>
				{:else}
					<ul class="item-list">
						{#each sessions as session (session.id)}
							{@const country = formatCountry(session.country_code)}
							{@const signedInAt = formatTimestamp(session.created_at, getLocale())}
							<li class="session-row">
								<div class="session-summary">
									<strong class="session-title">
										{sessionTitle(session)}
										{#if session.current}
											<span class="inline-tag">{$LL.account_currentSession()}</span>
										{/if}
									</strong>
									<div class="session-meta">
										{#if country}
											<span aria-label={$LL.account_sessionLocation({ country })}>{country}</span>
										{/if}
										<span aria-label={$LL.account_signedInAt({ time: signedInAt })}
											>{signedInAt}</span
										>
									</div>
								</div>
								<Button
									variant={session.current ? 'danger' : 'secondary'}
									size="sm"
									loading={actionLoading === `session:${session.id}`}
									onclick={() => onRevokeSession(session.id)}
								>
									{session.current ? $LL.header_logout() : $LL.account_logoutSession()}
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		{#if shows('passkeys')}
			<section class="security-block">
				{#if showSectionHeadings}<h3>{$LL.account_passkeys()}</h3>{/if}
				<form
					class="add-passkey"
					onsubmit={(event) => {
						event.preventDefault();
						addPasskey();
					}}
				>
					<Input
						label={$LL.account_passkeyName()}
						bind:value={newPasskeyName}
						disabled={!passkeySupported || actionLoading === 'passkey:add'}
						maxlength={100}
					/>
					<Button
						variant="primary"
						type="submit"
						loading={actionLoading === 'passkey:add'}
						disabled={!passkeySupported}
					>
						{$LL.account_addPasskey()}
					</Button>
				</form>
				{#if !passkeySupported}
					<p class="muted">{$LL.account_passkeyUnsupported()}</p>
				{/if}

				{#if passkeys.length === 0}
					<p class="empty-text">{$LL.account_empty()}</p>
				{:else}
					<ul class="item-list">
						{#each passkeys as passkey (passkey.id)}
							<li>
								<div>
									<strong>{passkey.device_name ?? passkey.id}</strong>
									{#if passkey.provider?.name || passkey.aaguid}
										<span class="passkey-provider">
											{#if passkey.provider?.icon_light}
												<img src={passkey.provider.icon_light} alt="" loading="lazy" />
											{/if}
											{passkey.provider?.name ?? passkey.aaguid}
										</span>
									{/if}
									<span
										>{formatTimestamp(
											passkey.last_used_at ?? passkey.created_at,
											getLocale()
										)}</span
									>
								</div>
								<Button
									variant="danger"
									size="sm"
									loading={actionLoading === `passkey:${passkey.id}`}
									onclick={() => onDeletePasskey(passkey.id)}
								>
									{$LL.account_delete()}
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		{#if shows('totp') && (totpManagementEnabled || totpCredentials.length > 0 || totpEnrollment)}
			<section class="security-block">
				{#if showSectionHeadings}<h3>{$LL.account_totp()}</h3>{/if}
				{#if totpManagementEnabled}
					<form
						class="add-passkey"
						onsubmit={(event) => {
							event.preventDefault();
							startTotpEnrollment();
						}}
					>
						<Input
							label={$LL.account_totpName()}
							bind:value={newTotpLabel}
							disabled={actionLoading === 'totp:add'}
							maxlength={100}
						/>
						<Button variant="primary" type="submit" loading={actionLoading === 'totp:add'}>
							{$LL.account_addTotp()}
						</Button>
					</form>
				{/if}

				{#if totpEnrollment}
					<div class="totp-enrollment">
						{#if totpEnrollment.backupCodes.length > 0}
							<h4>{$LL.account_totpBackupCodes()}</h4>
							<ul class="backup-code-list">
								{#each totpEnrollment.backupCodes as backupCode (backupCode)}
									<li><code>{backupCode}</code></li>
								{/each}
							</ul>
							<Button variant="secondary" size="sm" onclick={onClearTotpEnrollment}>
								{$LL.account_totpDone()}
							</Button>
						{:else}
							<h4>{$LL.account_totpSetupTitle()}</h4>
							{#if totpQrDataUrl}
								<img class="totp-qr" src={totpQrDataUrl} alt={$LL.account_totpQrAlt()} />
							{/if}
							<div class="manual-key">
								<span>{$LL.account_totpManualKey()}</span>
								<code>{totpEnrollment.secret}</code>
							</div>
							<div class="totp-inline-action">
								<input
									class="totp-code-input"
									autocomplete="one-time-code"
									inputmode="numeric"
									maxlength={8}
									placeholder={$LL.account_totpActivationCode()}
									bind:value={totpActivationCode}
								/>
								<Button
									variant="primary"
									size="sm"
									loading={actionLoading === `totp:activate:${totpEnrollment.credentialId}`}
									disabled={!/^\d{6}$|^\d{8}$/.test(totpActivationCode.trim())}
									onclick={activateTotpEnrollment}
								>
									{$LL.account_totpActivate()}
								</Button>
								<Button variant="secondary" size="sm" onclick={onClearTotpEnrollment}>
									{$LL.dialog_cancel()}
								</Button>
							</div>
						{/if}
					</div>
				{/if}

				{#if activeTotpCredentials.length > 0}
					<p class="muted">
						{$LL.account_totpBackupCodesRemaining({
							remaining: totpBackupCodes.remaining,
							total: totpBackupCodes.total
						})}
					</p>
					<div class="totp-inline-action">
						<input
							class="totp-code-input"
							autocomplete="one-time-code"
							inputmode="numeric"
							maxlength={8}
							placeholder={$LL.account_totpCurrentCode()}
							bind:value={totpRegenerateCode}
						/>
						<Button
							variant="secondary"
							size="sm"
							loading={actionLoading === 'totp:backup-codes'}
							disabled={!/^\d{6}$|^\d{8}$/.test(totpRegenerateCode.trim())}
							onclick={regenerateTotpBackupCodes}
						>
							{$LL.account_totpRegenerateBackupCodes()}
						</Button>
					</div>
				{/if}

				{#if totpCredentials.length === 0}
					<p class="empty-text">{$LL.account_empty()}</p>
				{:else}
					<ul class="item-list">
						{#each totpCredentials as credential (credential.id)}
							<li class="totp-list-item">
								<div>
									<strong>{credential.label || $LL.account_totpDefaultName()}</strong>
									<span>
										{credential.algorithm} / {credential.digits} / {credential.period}s
										{#if credential.status !== 'active'}
											<span class="inline-tag">{$LL.account_totpPending()}</span>
										{/if}
									</span>
									<span>
										{credential.last_used_at
											? $LL.account_totpLastUsed({
													time: formatTimestamp(credential.last_used_at, getLocale())
												})
											: formatTimestamp(credential.created_at, getLocale())}
									</span>
								</div>
								<div class="totp-delete">
									<input
										class="totp-code-input"
										autocomplete="one-time-code"
										inputmode="text"
										maxlength={32}
										placeholder={$LL.account_totpDeleteCode()}
										value={totpDeleteCodes[credential.id] ?? ''}
										oninput={(event) => updateTotpDeleteCode(credential.id, event)}
									/>
									<Button
										variant="danger"
										size="sm"
										loading={actionLoading === `totp:${credential.id}`}
										disabled={!isTotpDeleteProofReady(totpDeleteCodes[credential.id] ?? '')}
										onclick={() => deleteTotpCredential(credential.id)}
									>
										{$LL.account_delete()}
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		{#if shows('social')}
			<section class="security-block planned">
				{#if showSectionHeadings}<h3>{$LL.account_socialAccounts()}</h3>{/if}
				<p class="muted">{$LL.account_planned()}</p>
			</section>
		{/if}
	</div>
</Card>

<style>
	.account-panel {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	h3 {
		margin: 0 0 10px;
		font-size: 0.9375rem;
	}

	.security-block {
		display: grid;
		gap: 10px;
		padding-top: 4px;
	}

	.add-passkey {
		display: grid;
		gap: 8px;
	}

	.totp-enrollment {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface) 92%, var(--primary) 8%);
	}

	.totp-enrollment h4 {
		margin: 0;
		font-size: 0.875rem;
	}

	.totp-qr {
		width: 192px;
		max-width: 100%;
		height: auto;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: #ffffff;
		padding: 8px;
	}

	.manual-key,
	.totp-inline-action,
	.totp-delete {
		display: grid;
		gap: 8px;
	}

	.manual-key span {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.manual-key code,
	.backup-code-list code {
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.backup-code-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 8px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.backup-code-list li {
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
	}

	.totp-code-input {
		width: 100%;
		min-height: 38px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text-primary);
		font: inherit;
		letter-spacing: 0.08em;
		padding: 0 10px;
	}

	.totp-code-input:focus {
		outline: none;
		border-color: var(--primary);
	}

	.totp-list-item {
		align-items: flex-start !important;
	}

	.item-list {
		display: grid;
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.item-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}

	.item-list strong,
	.item-list span {
		display: block;
		overflow-wrap: anywhere;
	}

	.item-list strong {
		font-size: 0.875rem;
	}

	.item-list span,
	.muted,
	.empty-text,
	.section-description {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.section-description,
	.empty-text {
		margin: 0;
	}

	.session-summary {
		display: contents;
	}

	.session-title {
		display: flex !important;
		align-items: center;
		flex-wrap: nowrap;
		gap: 6px;
		min-width: 0;
	}

	.session-meta {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 8px;
		margin-top: 2px;
	}

	.session-meta span + span::before {
		content: '·';
		margin-inline-end: 8px;
		color: var(--text-muted);
	}

	.item-list .session-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
	}

	.session-row > :global(button) {
		grid-column: 2;
		grid-row: 1;
		flex: 0 0 auto;
	}

	.session-title .inline-tag {
		margin-inline-start: 0;
		white-space: nowrap;
	}

	.passkey-provider {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 3px;
	}

	.passkey-provider img {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		object-fit: contain;
	}

	.panel-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.inline-tag {
		display: inline-flex;
		margin-inline-start: 8px;
		font-size: 0.75rem;
		color: var(--success);
	}

	.planned {
		opacity: 0.75;
	}

	@media (min-width: 640px) {
		.totp-inline-action {
			grid-template-columns: minmax(0, 1fr) auto auto;
			align-items: center;
		}

		.totp-delete {
			width: min(240px, 40vw);
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
		}
	}
</style>
