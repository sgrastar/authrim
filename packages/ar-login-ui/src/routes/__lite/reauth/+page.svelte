<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import LiteRelay from '#lib/lite/LiteRelay.svelte';
	import { LITE_PASSKEY_SCRIPT } from '#lib/lite/passkey-ceremony.js';
	import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';
	import type { ActionData, PageData } from './$types';

	// The lite re-authentication page (lib/server/lite/reauth.ts).
	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Constant scripts, never data: their exact text is what the page's CSP allows by hash.
	const solverTag = '<scr' + `ipt>${LITE_POW_SOLVER_SCRIPT}</scr` + 'ipt>';
	const passkeyTag = '<scr' + `ipt>${LITE_PASSKEY_SCRIPT}</scr` + 'ipt>';

	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}

	type FormError =
		| 'email_invalid'
		| 'code_invalid'
		| 'totp_invalid'
		| 'passkey_failed'
		| 'busy'
		| 'retry'
		| 'session_changed';
	const formError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? (form.error as FormError) : null
	);
	const restart = $derived(Boolean(form && 'restart' in form && form.restart));
</script>

{#snippet hidden(txnId: string, csrf: string, op: string)}
	<input type="hidden" name="txn" value={txnId} />
	<input type="hidden" name="csrf" value={csrf} />
	<input type="hidden" name="op" value={op} />
{/snippet}

{#if data.page === 'error'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.title}</h1>
		<p>{data.message}</p>
		<p><a href={data.backHref}>{data.back}</a></p>
	</LiteShell>
{:else if data.page === 'relay'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<LiteRelay target={data.relay} continueLabel={data.continueLabel} />
	</LiteShell>
{:else}
	<LiteShell title={data.text.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.text.title}</h1>
		<p>{data.text.subtitle}</p>
		{#if data.clientName}<p><strong>{data.clientName}</strong></p>{/if}
		{#if restart}
			<p role="alert">{data.text.errors.retry}</p>
		{:else if formError}
			<p role="alert">{data.text.errors[formError]}</p>
		{/if}
		{#if data.code}
			<!-- The code sent to the address given. -->
			{#if data.code.maskedEmail}
				<p>{data.text.codeSentTo} <strong>{data.code.maskedEmail}</strong></p>
			{/if}
			<form method="post" action={actionOf(data.search, 'reauth_verify')}>
				{@render hidden(data.txnId, data.csrfToken, data.op)}
				<input type="hidden" name="attempt" value={data.code.attempt} />
				<input type="hidden" name="check" value={data.code.check} />
				<label>
					{data.text.code}
					<input
						name="code"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={'[0-9]{6}'}
						minlength="6"
						maxlength="6"
						required
					/>
				</label>
				<button type="submit">{data.text.verify}</button>
			</form>
		{:else if data.totp}
			<form method="post" action={actionOf(data.search, 'reauth_totp_verify')}>
				{@render hidden(data.txnId, data.csrfToken, data.op)}
				<input type="hidden" name="challenge" value={data.totp.challenge} />
				<label>
					{data.text.totpCode}
					<input
						name="code"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern={'[0-9]{6,8}'}
						minlength="6"
						maxlength="8"
						required
					/>
				</label>
				<button type="submit">{data.text.verify}</button>
			</form>
		{:else if data.passkey}
			<!-- The passkey ceremony: the fixed script signs the challenge on the button's press. -->
			<p>{data.text.passkeyPrompt}</p>
			<form
				method="post"
				action={actionOf(data.search, 'reauth_passkey_finish')}
				data-lite-passkey={JSON.stringify(data.passkey.options)}
				data-lite-passkey-unsupported={data.text.passkeyUnsupported}
				data-lite-passkey-error={data.text.passkeyFailed}
			>
				{@render hidden(data.txnId, data.csrfToken, data.op)}
				<input type="hidden" name="credential" value="" />
				<input type="hidden" name="challenge" value={data.passkey.challenge} />
				<button type="submit">{data.text.passkey}</button>
			</form>
			<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
			{@html passkeyTag}
		{:else if !data.methods.emailCode && !data.methods.totp && !data.methods.passkey}
			<p role="alert">{data.text.noMethod}</p>
		{:else}
			<!-- The methods the tenant allows for re-authentication; each start posts a proof. -->
			{#if data.methods.emailCode}
				<form
					method="post"
					action={actionOf(data.search, 'reauth_send')}
					data-lite-pow={data.pow ? JSON.stringify(data.pow) : undefined}
					data-lite-pow-error={data.pow ? data.text.javascriptRequired : undefined}
				>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					{#if data.pow}<input type="hidden" name="human_verification_response" value="" />{/if}
					<label>
						{data.text.email}
						<input name="email" type="email" autocomplete="email" maxlength="320" required />
					</label>
					<button type="submit">{data.text.sendCode}</button>
				</form>
			{/if}
			{#if data.methods.totp}
				<form
					method="post"
					action={actionOf(data.search, 'reauth_totp_start')}
					data-lite-pow={data.pow ? JSON.stringify(data.pow) : undefined}
					data-lite-pow-error={data.pow ? data.text.javascriptRequired : undefined}
				>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					{#if data.pow}<input type="hidden" name="human_verification_response" value="" />{/if}
					<button type="submit">{data.text.totp}</button>
				</form>
			{/if}
			{#if data.methods.passkey}
				<form
					method="post"
					action={actionOf(data.search, 'reauth_passkey_start')}
					data-lite-pow={data.pow ? JSON.stringify(data.pow) : undefined}
					data-lite-pow-error={data.pow ? data.text.javascriptRequired : undefined}
				>
					{@render hidden(data.txnId, data.csrfToken, data.op)}
					{#if data.pow}<input type="hidden" name="human_verification_response" value="" />{/if}
					<button type="submit">{data.text.passkey}</button>
				</form>
			{/if}
			{#if data.pow}
				<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
				{@html solverTag}
			{/if}
		{/if}
		{#if data.underway}
			<!-- Another way: the method under way (this one) is given up. -->
			<form method="post" action={actionOf(data.search, 'reauth_back')}>
				<input type="hidden" name="target" value={data.underway} />
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<button type="submit">{data.text.another}</button>
			</form>
		{/if}
	</LiteShell>
{/if}
