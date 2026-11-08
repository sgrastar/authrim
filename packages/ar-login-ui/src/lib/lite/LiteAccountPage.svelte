<script lang="ts">
	import LiteAccountWidget from './LiteAccountWidget.svelte';
	import LiteRelay from './LiteRelay.svelte';
	import LiteShell from './LiteShell.svelte';
	import { LITE_PASSKEY_SCRIPT } from './passkey-ceremony.js';
	import type { ActionData, PageData } from '../../routes/__lite/account/$types';

	// The lite account page (lib/server/lite/account.ts): the tenant's placements, in order.
	let { data, form }: { data: PageData; form: ActionData } = $props();

	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}

	const formError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
	);
	// A constant script, never data: its exact text is what the page's CSP allows by hash.
	const passkeyTag = '<scr' + `ipt>${LITE_PASSKEY_SCRIPT}</scr` + 'ipt>';
	const stepUpError = $derived(
		form &&
			'widget' in form &&
			(form as { widget?: unknown }).widget === 'account' &&
			'error' in form
			? String((form as { error?: unknown }).error)
			: null
	);
	const confirmGuest = $derived(
		Boolean(form && 'confirmGuestSignOut' in form && form.confirmGuestSignOut)
	);
</script>

{#snippet hidden(txnId: string, csrf: string, op: string)}
	<input type="hidden" name="txn" value={txnId} />
	<input type="hidden" name="csrf" value={csrf} />
	<input type="hidden" name="op" value={op} />
{/snippet}

{#if data.page === 'relay'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<LiteRelay target={data.relay} continueLabel={data.continueLabel} />
	</LiteShell>
{:else if data.page === 'error'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.title}</h1>
		<p>{data.message}</p>
		<p><a href={data.backHref}>{data.back}</a></p>
	</LiteShell>
{:else}
	<LiteShell title={data.text.title} brandName={data.brandName} logo={data.logo}>
		<header class="account-header">
			<h1>{data.text.title}</h1>
			{#if data.text.description}<p>{data.text.description}</p>{/if}
			{#if confirmGuest}
				<!-- A guest's account cannot be come back to once signed out: asked first. -->
				<p role="alert">{data.text.guestSignOutWarning}</p>
				<form method="post" action={actionOf(data.search, 'sign_out')}>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					<input type="hidden" name="confirm" value="guest" />
					<button type="submit">{data.text.confirmSignOut}</button>
					<a href={data.search || '?'}>{data.text.cancel}</a>
				</form>
			{:else}
				<form method="post" action={actionOf(data.search, 'sign_out')}>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					<button type="submit">{data.text.signOut}</button>
				</form>
			{/if}
		</header>
		{#if data.stepUp}
			<!-- A change held for a step-up: the person proves it is them, then it is made. -->
			<section class="account-widget" id="step-up">
				<h2>{data.text.stepUpTitle}</h2>
				<p>{data.text.stepUpDescription}</p>
				{#if stepUpError === 'code_invalid'}
					<p role="alert">{data.text.codeInvalid}</p>
				{:else if stepUpError === 'busy'}
					<p role="alert">{data.text.busy}</p>
				{:else if stepUpError}
					<p role="alert">{data.text.stepUpFailed}</p>
				{/if}
				{#if data.stepUp.passkey}
					<form
						method="post"
						action={actionOf(data.search, 'stepup_passkey_finish')}
						data-lite-passkey={JSON.stringify(data.stepUp.passkey.options)}
						data-lite-passkey-unsupported={data.text.passkeyUnsupported}
						data-lite-passkey-error={data.text.passkeyCeremonyFailed}
					>
						{@render hidden(data.txnId, data.csrfToken, data.op)}
						<input type="hidden" name="step_up" value={data.stepUp.at} />
						<input type="hidden" name="challenge" value={data.stepUp.passkey.challenge} />
						<input type="hidden" name="credential" value="" />
						<button type="submit">{data.text.stepUpPasskey}</button>
					</form>
				{:else if data.stepUp.email}
					<p>{data.text.stepUpEmailSent}</p>
					<form method="post" action={actionOf(data.search, 'stepup_email_verify')}>
						{@render hidden(data.txnId, data.csrfToken, data.op)}
						<input type="hidden" name="step_up" value={data.stepUp.at} />
						<input type="hidden" name="challenge" value={data.stepUp.email.challenge} />
						<label>
							{data.text.stepUpCode}
							<input
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={'[0-9]{6}'}
								maxlength="6"
								required
							/>
						</label>
						<button type="submit">{data.text.stepUpVerify}</button>
					</form>
				{:else if !data.stepUp.methods.passkey && !data.stepUp.methods.email && !data.stepUp.methods.totp}
					<p role="alert">{data.text.stepUpNoMethods}</p>
				{:else}
					{#if data.stepUp.methods.passkey}
						<form method="post" action={actionOf(data.search, 'stepup_passkey_start')}>
							{@render hidden(data.txnId, data.csrfToken, data.op)}
							<input type="hidden" name="step_up" value={data.stepUp.at} />
							<button type="submit">{data.text.stepUpPasskey}</button>
						</form>
					{/if}
					{#if data.stepUp.methods.email}
						<form method="post" action={actionOf(data.search, 'stepup_email_send')}>
							{@render hidden(data.txnId, data.csrfToken, data.op)}
							<input type="hidden" name="step_up" value={data.stepUp.at} />
							<button type="submit">{data.text.stepUpEmail}</button>
						</form>
					{/if}
					{#if data.stepUp.methods.totp}
						<form method="post" action={actionOf(data.search, 'stepup_totp')}>
							{@render hidden(data.txnId, data.csrfToken, data.op)}
							<input type="hidden" name="step_up" value={data.stepUp.at} />
							<label>
								{data.text.stepUpTotpCode}
								<input
									name="code"
									inputmode="numeric"
									autocomplete="one-time-code"
									pattern={'[0-9]{6,8}'}
									maxlength="8"
									required
								/>
							</label>
							<button type="submit">{data.text.stepUpTotp}</button>
						</form>
					{/if}
				{/if}
				{#if data.stepUp.passkey || data.stepUp.email}
					<!-- Another way: the method chosen given up, the change still held. -->
					<form method="post" action={actionOf(data.search, 'stepup_switch')}>
						{@render hidden(data.txnId, data.csrfToken, data.op)}
						<input type="hidden" name="step_up" value={data.stepUp.at} />
						<button type="submit">{data.text.anotherWay}</button>
					</form>
				{/if}
				<form method="post" action={actionOf(data.search, 'stepup_cancel')}>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					<input type="hidden" name="step_up" value={data.stepUp.at} />
					<button type="submit">{data.text.cancel}</button>
				</form>
			</section>
		{/if}
		{#if data.widgets.passkeyCreate}
			<!-- The new passkey's ceremony, once on the page (whatever the widgets placed): the fixed
			     script creates it on the button's press. -->
			<section class="account-widget" id="passkey-create">
				<h2>{data.text.addPasskey}</h2>
				<form
					method="post"
					action={actionOf(data.search, 'passkey_add_finish')}
					data-lite-passkey-create={JSON.stringify(data.widgets.passkeyCreate.registration)}
					data-lite-passkey-unsupported={data.text.passkeyUnsupported}
					data-lite-passkey-error={data.text.passkeyCeremonyFailed}
				>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					<input type="hidden" name="challenge" value={data.widgets.passkeyCreate.challenge} />
					<input type="hidden" name="credential" value="" />
					<button type="submit">{data.text.addPasskey}</button>
				</form>
			</section>
		{/if}
		{#if formError === 'session_changed'}
			<p role="alert">{data.text.sessionChanged}</p>
		{:else if formError}
			<p role="alert">{data.text.actionFailed}</p>
		{/if}
		<div class="account-grid">
			{#each data.placements as placement (placement.id)}
				<section
					id={placement.id}
					class="account-screen"
					class:full={placement.width === 'full'}
					class:overview={placement.overview}
				>
					{#each placement.blocks as block, index (index)}
						<div class="account-block" data-column={block.column ?? undefined}>
							{#if block.kind === 'heading'}
								<header>
									<h2>{block.label}</h2>
									{#if block.text}<p>{block.text}</p>{/if}
								</header>
							{:else if block.kind === 'text'}
								<p>{block.text}</p>
							{:else if block.kind === 'link'}
								<a href={block.href}>{block.label}</a>
							{:else if block.kind === 'divider'}
								<hr />
								{#if block.text}<p class="muted">{block.text}</p>{/if}
							{:else}
								<LiteAccountWidget {data} {form} widget={block.widget} title={block.title} />
							{/if}
						</div>
					{/each}
				</section>
			{/each}
		</div>
		{#if data.stepUp?.passkey || data.widgets.passkeyCreate}
			<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
			{@html passkeyTag}
		{/if}
	</LiteShell>
{/if}
