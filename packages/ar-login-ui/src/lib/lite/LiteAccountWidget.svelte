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
	<h2>{title}</h2>
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
		<p class="muted">{data.text.consentDescription}</p>
		{#if data.widgets.consents === null}
			<p role="alert">{data.text.loadFailed}</p>
		{:else if data.widgets.consents.length === 0}
			<p>{data.text.consentEmpty}</p>
		{:else}
			<ul>
				{#each data.widgets.consents as consent, index (index)}
					<li>
						<span class="icon" aria-hidden="true"
							>{consent.kind === 'oauth_client' ? 'A' : 'C'}</span
						>
						<strong>{consent.title}</strong>
						<p class="muted">{consent.subtitle}</p>
						<dl>
							{#each consent.rows as row, rowIndex (rowIndex)}
								<dt>{row.label}</dt>
								<dd>{row.value}</dd>
							{/each}
						</dl>
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
