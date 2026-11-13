<script lang="ts">
	import type { PageData, ActionData } from '../../routes/__lite/account/$types';

	// One widget of the lite account page (lib/server/lite/account-widgets.ts), its forms posting
	// the page's actions.
	type AccountData = Extract<PageData, { page: 'account' }>;
	let {
		data,
		form,
		widget,
		title
	}: { data: AccountData; form: ActionData; widget: string; title: string } = $props();

	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}
	const mine = (name: string) =>
		Boolean(form && 'widget' in form && (form as { widget?: unknown }).widget === name);
	const notice = (name: string) =>
		mine(name) && form && 'notice' in form ? String((form as { notice?: unknown }).notice) : null;
	const failed = (name: string) =>
		mine(name) && form && 'error' in form ? String((form as { error?: unknown }).error) : null;
</script>

{#snippet hidden()}
	<input type="hidden" name="txn" value={data.txnId} />
	<input type="hidden" name="csrf" value={data.csrfToken} />
	<input type="hidden" name="op" value={data.op} />
{/snippet}

<section class="account-widget" data-widget={widget}>
	<h2>
		{title}
		{#if widget === 'account_launcher_widget' && data.widgets.launcher && data.widgets.launcher.total > 0}
			<span class="tag">{data.widgets.launcher.total}</span>
		{/if}
	</h2>
	{#if widget === 'account_profile_widget'}
		{@const profile = data.widgets.profile}
		<dl>
			<dt>{data.text.name}</dt>
			<dd>{profile.name ?? '-'}</dd>
			<dt>{data.text.email}</dt>
			<dd>
				{profile.email ?? '-'}
				{#if profile.emailVerified}<span class="tag">{data.text.verified}</span>{/if}
			</dd>
		</dl>
		{#if notice('profile') === 'saved'}<p role="status">{data.text.saved}</p>{/if}
		{#if failed('profile')}<p role="alert">{data.text.saveFailed}</p>{/if}
		<form method="post" action={actionOf(data.search, 'profile_save')}>
			{@render hidden()}
			<label>
				{data.text.editName}
				<input name="name" maxlength="100" autocomplete="name" value={profile.name ?? ''} />
			</label>
			<button type="submit">{data.text.save}</button>
		</form>
		{@const change = data.widgets.emailChange}
		{#if failed('profile') === 'code_invalid'}
			<p role="alert">{data.text.codeInvalid}</p>
		{:else if failed('profile') === 'busy'}
			<p role="alert">{data.text.busy}</p>
		{:else if failed('profile') && failed('profile') !== 'save_failed'}
			<p role="alert">{data.text.actionFailed}</p>
		{/if}
		{#if notice('profile') === 'email_changed' || change?.stage === 'completed'}
			<p role="status">{data.text.emailChanged}</p>
		{:else if change?.stage === 'failed'}
			<p role="alert">{data.text.actionFailed}</p>
		{:else if change?.stage === 'processing'}
			<!-- Under way at ar-management: the page is drawn again until it ends (LiteAccountPage). -->
			<p role="status">{data.text.emailProcessing}</p>
		{:else if change?.stage === 'challenge'}
			<p>{data.text.emailCodeSent}</p>
			<form method="post" action={actionOf(data.search, 'email_change_complete')}>
				{@render hidden()}
				<input type="hidden" name="challenge" value={change.challengeId} />
				<label>
					{data.text.emailCode}
					<input
						name="code"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={'[0-9]{6}'}
						maxlength="6"
						required
					/>
				</label>
				<button type="submit">{data.text.emailVerify}</button>
			</form>
			<form method="post" action={actionOf(data.search, 'email_change_cancel')}>
				{@render hidden()}
				<input type="hidden" name="challenge" value={change.challengeId} />
				<button type="submit">{data.text.cancel}</button>
			</form>
		{:else}
			<details>
				<summary>{data.text.manage}</summary>
				<form method="post" action={actionOf(data.search, 'email_change_start')}>
					{@render hidden()}
					<label>
						{data.text.newEmail}
						<input name="email" type="email" autocomplete="email" maxlength="254" required />
					</label>
					<button type="submit">{data.text.continue}</button>
				</form>
			</details>
		{/if}
	{:else if widget === 'account_session_widget'}
		<p class="muted">{data.text.sessionsDescription}</p>
		{#if failed('sessions')}<p role="alert">{data.text.actionFailed}</p>{/if}
		{#if data.widgets.sessions === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.sessions.length === 0}
			<p>{data.text.empty}</p>
		{:else}
			<ul>
				{#each data.widgets.sessions as session (session.id)}
					<li>
						<strong>{session.title}</strong>
						{#if session.current}<span class="tag">{data.text.currentSession}</span>{/if}
						<p class="muted">
							{#if session.location}{session.location} /
							{/if}{session.signedInAt}
						</p>
						<form method="post" action={actionOf(data.search, 'session_revoke')}>
							{@render hidden()}
							<input type="hidden" name="session" value={session.id} />
							<button type="submit">
								{session.current ? data.text.signOut : data.text.logoutSession}
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if widget === 'account_passkey_widget'}
		{#if failed('passkeys') === 'remaining_method'}
			<p role="alert">{data.text.remainingMethod}</p>
		{:else if failed('passkeys') === 'passkey_failed'}
			<p role="alert">{data.text.passkeyFailed}</p>
		{:else if failed('passkeys')}
			<p role="alert">{data.text.actionFailed}</p>
		{/if}
		{#if !data.widgets.passkeyCreate}
			<form method="post" action={actionOf(data.search, 'passkey_add')}>
				{@render hidden()}
				<label>
					{data.text.passkeyName}
					<input name="device_name" maxlength="100" />
				</label>
				<button type="submit">{data.text.addPasskey}</button>
			</form>
		{/if}
		{#if data.widgets.passkeys === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.passkeys.length === 0}
			<p>{data.text.empty}</p>
		{:else}
			<ul>
				{#each data.widgets.passkeys as passkey (passkey.id)}
					<li>
						<strong>{passkey.name}</strong>
						<p class="muted">{passkey.createdAt}</p>
						<form method="post" action={actionOf(data.search, 'passkey_delete')}>
							{@render hidden()}
							<input type="hidden" name="passkey" value={passkey.id} />
							<button type="submit">{data.text.deletePasskey}</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if widget === 'account_totp_widget'}
		{@const totp = data.widgets.totp}
		{@const enroll = data.widgets.totpEnroll}
		{@const shownCodes =
			mine('totp') && form && 'backupCodes' in form && Array.isArray(form.backupCodes)
				? (form.backupCodes as string[])
				: []}
		{#if failed('totp') === 'remaining_method'}
			<p role="alert">{data.text.remainingMethod}</p>
		{:else if failed('totp') === 'code_invalid'}
			<p role="alert">{data.text.codeInvalid}</p>
		{:else if failed('totp') === 'busy'}
			<p role="alert">{data.text.busy}</p>
		{:else if failed('totp')}
			<p role="alert">{data.text.actionFailed}</p>
		{/if}
		{#if shownCodes.length > 0}
			<!-- Shown once: the action's answer only (never kept for the page drawn again). -->
			<h3>{data.text.totpBackupCodes}</h3>
			<ul class="backup-codes">
				{#each shownCodes as code (code)}
					<li><code>{code}</code></li>
				{/each}
			</ul>
		{/if}
		{#if enroll}
			<h3>{data.text.totpSetupTitle}</h3>
			{#if enroll.qr}<img src={enroll.qr} alt={data.text.totpQrAlt} width="200" height="200" />{/if}
			<p>{data.text.totpManualKey}: <code>{enroll.secret}</code></p>
			<form method="post" action={actionOf(data.search, 'totp_activate')}>
				{@render hidden()}
				<input type="hidden" name="credential" value={enroll.credentialId} />
				<label>
					{data.text.totpActivationCode}
					<input
						name="code"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={'[0-9 ]{6,9}'}
						maxlength="9"
						required
					/>
				</label>
				<button type="submit">{data.text.totpActivate}</button>
			</form>
			<form method="post" action={actionOf(data.search, 'totp_cancel')}>
				{@render hidden()}
				<input type="hidden" name="credential" value={enroll.credentialId} />
				<button type="submit">{data.text.cancel}</button>
			</form>
		{:else if data.widgets.totpAddEnabled}
			<form method="post" action={actionOf(data.search, 'totp_add')}>
				{@render hidden()}
				<label>
					{data.text.totpName}
					<input name="label" maxlength="100" />
				</label>
				<button type="submit">{data.text.addTotp}</button>
			</form>
		{/if}
		{#if totp === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else}
			{#if totp.active}
				<p>{data.text.totpBackupCodesRemaining}</p>
				<form method="post" action={actionOf(data.search, 'totp_regenerate')}>
					{@render hidden()}
					<label>
						{data.text.totpCurrentCode}
						<input
							name="code"
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern={'[0-9 ]{6,9}'}
							maxlength="9"
						/>
					</label>
					<button type="submit">{data.text.totpRegenerate}</button>
				</form>
			{/if}
			{#if totp.credentials.length === 0}
				<p>{data.text.empty}</p>
			{:else}
				<ul>
					{#each totp.credentials as credential (credential.id)}
						<li>
							<strong>{credential.name}</strong>
							{#if credential.pending}<span class="tag">{data.text.totpPending}</span>{/if}
							<p class="muted">{credential.meta} / {credential.used}</p>
							<form method="post" action={actionOf(data.search, 'totp_delete')}>
								{@render hidden()}
								<input type="hidden" name="totp" value={credential.id} />
								{#if !credential.pending}
									<label>
										{data.text.totpDeleteCode}
										<input name="proof" maxlength="32" autocomplete="one-time-code" />
									</label>
								{/if}
								<button type="submit">{data.text.deleteTotp}</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{:else if widget === 'account_social_account_widget'}
		{@const social = data.widgets.social}
		{@const confirming =
			mine('social') && form && 'confirmUnlink' in form ? String(form.confirmUnlink) : null}
		{#if data.widgets.socialOutcome}
			<p role={data.widgets.socialOutcome.kind === 'error' ? 'alert' : 'status'}>
				{data.widgets.socialOutcome.message}
			</p>
		{/if}
		{#if notice('social') === 'social_unlinked'}
			<p role="status">{data.text.socialUnlinked}</p>
		{/if}
		{#if failed('social') === 'already_linked_here'}
			<p role="alert">{data.text.socialAlreadyLinkedHere}</p>
		{:else if failed('social') === 'remaining_login_method_required'}
			<p role="alert">{data.text.socialLastMethod}</p>
		{:else if failed('social') === 'operation_in_progress'}
			<p role="alert">{data.text.socialInProgress}</p>
		{:else if failed('social')}
			<p role="alert">{data.text.socialFailed}</p>
		{/if}
		{#if social === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else}
			{#if social.identities.length === 0}
				<p class="muted">{data.text.socialEmpty}</p>
			{:else}
				<ul>
					{#each social.identities as identity (identity.id)}
						<li>
							<strong>{identity.name}</strong>
							{#if identity.email}<span>{identity.email}</span>{/if}
							<p class="muted">{identity.meta}</p>
							<form method="post" action={actionOf(data.search, 'social_unlink')}>
								{@render hidden()}
								<input type="hidden" name="identity" value={identity.id} />
								{#if confirming === identity.id}
									<p>{identity.confirm}</p>
									<input type="hidden" name="confirm" value="1" />
									<button type="submit">{identity.confirmAction}</button>
									<a href={data.search || '?'}>{data.text.cancel}</a>
								{:else}
									<button type="submit">{data.text.socialUnlink}</button>
								{/if}
							</form>
						</li>
					{/each}
				</ul>
			{/if}
			<h3>{data.text.socialLinkHeading}</h3>
			{#if social.linkable.length === 0}
				<p class="muted">{data.text.socialNoProviders}</p>
			{:else}
				{#each social.linkable as provider (provider.id)}
					<form method="post" action={actionOf(data.search, 'social_link')}>
						{@render hidden()}
						<input type="hidden" name="provider" value={provider.id} />
						<button type="submit">{provider.label}</button>
					</form>
				{/each}
			{/if}
		{/if}
	{:else if widget === 'account_launcher_widget'}
		{@const launcher = data.widgets.launcher}
		<p class="muted">{data.text.launcherDescription}</p>
		{#if failed('launcher')}<p role="alert">{data.text.launcherFavoriteFailed}</p>{/if}
		{#if launcher === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if launcher.total === 0}
			<p>{data.text.launcherEmpty}</p>
		{:else}
			<!-- The SPA's filters, as a form the page is drawn again with (no script). -->
			<form method="get" action={data.launcherAction}>
				{#each data.launcherKeep as [name, value] (name)}
					<input type="hidden" {name} {value} />
				{/each}
				<label>
					{data.text.launcherSearch}
					<input type="search" name="launcher_q" value={launcher.filters.q} maxlength="200" />
				</label>
				{#if launcher.categories.length > 0}
					<label>
						{data.text.launcherAllCategories}
						<select name="launcher_category">
							<option value="">{data.text.launcherAllCategories}</option>
							{#each launcher.categories as category (category)}
								<option value={category} selected={category === launcher.filters.category}
									>{category}</option
								>
							{/each}
						</select>
					</label>
				{/if}
				<label>
					<input
						type="checkbox"
						name="launcher_favorites"
						value="1"
						checked={launcher.filters.favorites}
					/>
					{data.text.launcherFavorites}
				</label>
				<button type="submit">{data.text.launcherSearch}</button>
			</form>
			{#if launcher.launchers.length === 0}
				<p>{data.text.launcherNoMatches}</p>
			{:else}
				<ul class="launcher-grid">
					{#each launcher.launchers as item (item.id)}
						<li>
							<a
								href={item.href}
								target={item.newTab ? '_blank' : undefined}
								rel={item.newTab ? 'noopener noreferrer' : undefined}
							>
								<span class="icon" aria-hidden="true">{item.initial}</span>
								<strong>{item.name}</strong>
							</a>
							{#if item.description}<p class="muted">{item.description}</p>{/if}
							{#if item.category}<p class="muted">{item.category}</p>{/if}
							{#if item.allowFavorite}
								<form method="post" action={actionOf(data.search, 'launcher_favorite')}>
									{@render hidden()}
									<input type="hidden" name="launcher" value={item.id} />
									<input type="hidden" name="favorite" value={item.favorite ? '0' : '1'} />
									<button type="submit" aria-pressed={item.favorite}>
										{item.favorite ? data.text.launcherUnfavorite : data.text.launcherFavorite}
									</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{:else if widget === 'account_upgrade_widget'}
		{@const guest = data.widgets.guest}
		{@const attempt = data.widgets.guestAttempt}
		{#if notice('guest') === 'guest_registered' || data.widgets.guestRecovered}
			<p role="status">{data.text.guestRegistered}</p>
		{:else if guest === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if guest.guest}
			<p class="muted">{data.text.guestDescription}</p>
			<p class="muted">{guest.due}</p>
			{#if mine('guest') && form && 'confirmExistingLogin' in form}
				<!-- A guest signed out cannot come back to this account: asked first. -->
				<p role="alert">{data.text.guestSignOutWarning}</p>
				<form method="post" action={actionOf(data.search, 'guest_existing_login')}>
					{@render hidden()}
					<input type="hidden" name="confirm" value="guest" />
					<button type="submit">{data.text.guestExistingLogin}</button>
					<a href={data.search || '?'}>{data.text.cancel}</a>
				</form>
			{:else if failed('guest') === 'guest_collision'}
				<p role="alert">{data.text.guestCollision}</p>
				{#if form && 'existingLogin' in form && form.existingLogin}
					<form method="post" action={actionOf(data.search, 'guest_existing_login')}>
						{@render hidden()}
						<button type="submit">{data.text.guestExistingLogin}</button>
					</form>
				{/if}
			{:else if failed('guest') === 'busy'}
				<p role="alert">{data.text.busy}</p>
			{:else if failed('guest') === 'code_invalid'}
				<p role="alert">{data.text.codeInvalid}</p>
			{:else if failed('guest')}
				<p role="alert">{data.text.guestError}</p>
			{/if}
			{#if notice('guest') === 'guest_pending' || guest.inProgress || attempt?.spent}
				<p role="status">{data.text.guestPending}</p>
				<p><a href={data.search || '?'}>{data.text.guestRetry}</a></p>
				{#if attempt && !guest.inProgress}
					<!-- Not under way at ar-management (its proof never reached it): given up here. -->
					<form method="post" action={actionOf(data.search, 'guest_reset')}>
						{@render hidden()}
						<input type="hidden" name="operation" value={attempt.operationId} />
						<button type="submit">{data.text.guestChangeMethod}</button>
					</form>
				{/if}
			{:else if attempt}
				{#if attempt.method === 'email'}
					<form method="post" action={actionOf(data.search, 'guest_confirm')}>
						{@render hidden()}
						<input type="hidden" name="operation" value={attempt.operationId} />
						<label>
							{data.text.guestCode}
							<input
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={'[0-9]{6}'}
								maxlength="6"
								required
							/>
						</label>
						<button type="submit">{data.text.guestConfirm}</button>
					</form>
				{/if}
				<form method="post" action={actionOf(data.search, 'guest_reset')}>
					{@render hidden()}
					<input type="hidden" name="operation" value={attempt.operationId} />
					<button type="submit">{data.text.guestChangeMethod}</button>
				</form>
			{:else if guest.eligible}
				{#if guest.methods.email}
					<form method="post" action={actionOf(data.search, 'guest_start')}>
						{@render hidden()}
						<input type="hidden" name="method" value="email" />
						<label>
							{data.text.guestEmail}
							<input name="email" type="email" autocomplete="email" maxlength="254" required />
						</label>
						<button type="submit">{data.text.guestSend}</button>
					</form>
				{/if}
				{#if guest.methods.passkey}
					<form method="post" action={actionOf(data.search, 'guest_start')}>
						{@render hidden()}
						<input type="hidden" name="method" value="passkey" />
						<button type="submit">{data.text.guestPasskey}</button>
					</form>
				{/if}
			{/if}
		{/if}
	{:else if widget === 'account_device_list_widget'}
		<p class="muted">{data.text.devicesDescription}</p>
		{#if data.widgets.devices === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.devices.length === 0}
			<p>{data.text.noDevices}</p>
		{:else}
			<ul>
				{#each data.widgets.devices as device, index (index)}
					<li>
						<strong>{device.title}</strong>
						{#if device.current}<span class="tag">{data.text.currentDevice}</span>{/if}
						<p class="muted">{device.meta}</p>
					</li>
				{/each}
			</ul>
		{/if}
	{:else if widget === 'account_consent_widget'}
		{@const confirmingConsent =
			mine('consent') && form && 'confirmWithdraw' in form ? String(form.confirmWithdraw) : null}
		<p class="muted">{data.text.consentDescription}</p>
		{#if notice('consent') === 'consent_withdrawn'}
			<p role="status">{data.text.consentWithdrawn}</p>
		{:else if notice('consent') === 'consent_gone'}
			<p role="alert">{data.text.consentGone}</p>
		{/if}
		{#if failed('consent')}<p role="alert">{data.text.consentWithdrawFailed}</p>{/if}
		{#if data.widgets.consents === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.consents.length === 0}
			<p>{data.text.consentEmpty}</p>
		{:else}
			<ul>
				{#each data.widgets.consents as consent, index (index)}
					<li>
						<span class="icon" aria-hidden="true">{consent.kind === 'statement' ? 'C' : 'A'}</span>
						<strong>{consent.title}</strong>
						<p class="muted">{consent.subtitle}</p>
						<dl>
							{#each consent.rows as row, rowIndex (rowIndex)}
								<dt>{row.label}</dt>
								<dd>{row.value}</dd>
							{/each}
						</dl>
						{#if consent.withdraw}
							<form method="post" action={actionOf(data.search, 'consent_withdraw')}>
								{@render hidden()}
								<input type="hidden" name="kind" value={consent.withdraw.kind} />
								<input type="hidden" name="target" value={consent.withdraw.target} />
								{#if confirmingConsent === consent.withdraw.key}
									<p>{consent.withdraw.confirm}</p>
									<input type="hidden" name="confirm" value="1" />
									<button type="submit" aria-label={consent.withdraw.label}>
										{data.text.consentWithdraw}
									</button>
									<a href={data.search || '?'}>{data.text.cancel}</a>
								{:else}
									<button type="submit" aria-label={consent.withdraw.label}>
										{data.text.consentWithdraw}
									</button>
								{/if}
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if widget === 'account_activity_widget'}
		{#if data.widgets.activityIncomplete}
			<p role="alert">{data.text.activityIncomplete}</p>
		{:else if data.widgets.activity === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.activity.items.length === 0}
			<p>{data.text.empty}</p>
		{:else}
			<ul>
				{#each data.widgets.activity.items as item (item.id)}
					<li>
						<time datetime={item.iso ?? undefined}>{item.at}</time>
						<strong>{item.label}</strong>
					</li>
				{/each}
			</ul>
			{#if data.widgets.activityNextHref}
				<!-- The next page of the activity (a link: no state is kept for it). -->
				<p><a href={data.widgets.activityNextHref}>{data.text.activityMore}</a></p>
			{/if}
		{/if}
	{/if}
</section>
