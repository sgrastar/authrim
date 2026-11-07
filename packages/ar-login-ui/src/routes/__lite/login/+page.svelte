<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import LiteRelay from '#lib/lite/LiteRelay.svelte';
	import { LITE_PASSKEY_SCRIPT } from '#lib/lite/passkey-ceremony.js';
	import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A constant script, never data: its exact text is what the page's CSP allows by hash.
	const solverTag = '<scr' + `ipt>${LITE_POW_SOLVER_SCRIPT}</scr` + 'ipt>';
	const passkeyTag = '<scr' + `ipt>${LITE_PASSKEY_SCRIPT}</scr` + 'ipt>';

	function isEmailField(field: string): boolean {
		const name = field.trim().toLowerCase();
		return name === 'email' || name.endsWith('.email');
	}

	/** A form's action: the page's own query, then SvelteKit's action key. */
	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}

	type FormError =
		| 'email_invalid'
		| 'code_invalid'
		| 'busy'
		| 'resend_wait'
		| 'retry'
		| 'totp_invalid'
		| 'totp_failed'
		| 'passkey_failed'
		| 'consent_required';
	const formError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? (form.error as FormError) : null
	);
	// The consent choices drawn: a failed post's, for the terms they were made on; else the decision
	// the transaction keeps for them; else none (the defaults).
	const echo = $derived.by(() => {
		const given =
			form && 'consentEcho' in form
				? (form.consentEcho as { key: string; choices: Record<string, string> } | undefined)
				: undefined;
		if (given && 'consentKey' in data && given.key === data.consentKey) return given.choices;
		// Else a decision kept for these terms (taken by an earlier post), else the defaults.
		return 'consentKept' in data ? (data.consentKept ?? null) : null;
	});
	// The step's form carries a proof for its sign-in starts, or for a code sent again.
	const proofHere = $derived(
		'codeEntry' in data && (!data.codeEntry || data.codeEntry.kind === 'mail_otp')
	);
</script>

{#snippet consentPart(
	consent: NonNullable<typeof data.consent>,
	label: string,
	text: string | null
)}
	<!-- The step's consent, in full: its words through the SPA's consent HTML sanitizer. -->
	<fieldset>
		<legend>{label}</legend>
		{#if text}<p>{text}</p>{/if}
		{#if consent.items.length + consent.fields.length > 0}
			<!-- What was shown: a decision is taken only for these terms. -->
			<input type="hidden" name="consent-key" value={data.consentKey} />
		{/if}
		{#each consent.fields as part (part.key)}
			<label class="check">
				<input
					type="checkbox"
					name={`consent-field:${part.key}`}
					value="granted"
					checked={echo ? echo[`consent-field:${part.key}`] === 'granted' : true}
					required={part.required}
				/>
				{part.label}
			</label>
		{/each}
		{#each consent.items as item (item.id)}
			{#if item.kind === 'radio'}
				<fieldset>
					<legend>{item.title}</legend>
					{#each item.options as option (option.value)}
						<label class="check">
							<input
								type="radio"
								name={`consent-value:${item.id}`}
								value={option.value}
								checked={echo?.[`consent-value:${item.id}`] === option.value}
								required={item.required}
							/>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized (runtime-consent-html) -->
							<span>{@html option.html}</span>
						</label>
					{/each}
				</fieldset>
			{:else if item.kind === 'display'}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized (runtime-consent-html) -->
				<div>{@html item.html}</div>
			{:else}
				<label class="check">
					<input
						type="checkbox"
						name={`consent:${item.id}`}
						value="granted"
						checked={echo ? echo[`consent:${item.id}`] === 'granted' : item.defaultChecked}
						required={item.required}
					/>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized (runtime-consent-html) -->
					<span>{@html item.html}</span>
				</label>
			{/if}
			{#if item.documentUrl}<p><a href={item.documentUrl}>{item.documentUrl}</a></p>{/if}
		{/each}
	</fieldset>
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
		{#if (form && 'restart' in form && form.restart) || data.decision.kind === 'unsupported'}
			<h1>{data.text.title}</h1>
			<p role="alert">
				{data.socialStarted ? data.text.socialStarted : data.text.unsupported}
			</p>
			<!-- Back to the start of this request: the transaction is given up, so it starts afresh. -->
			<form method="post" action={actionOf(data.search, 'restart')}>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<button type="submit">{data.text.back}</button>
			</form>
		{:else if data.decision.kind === 'continue'}
			<h1>{data.text.title}</h1>
			{#if formError}<p role="alert">{data.text.errors[formError]}</p>{/if}
			<form method="post" action={actionOf(data.search, data.continueAction ?? 'continue')}>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<input type="hidden" name="op" value={data.op} />
				{#if data.continueChallenge}
					<input type="hidden" name="challenge" value={data.continueChallenge} />
				{/if}
				{#if data.consent}
					<!-- Terms changed since they were accepted: accepted anew with the Continue. -->
					{@render consentPart(
						data.consent,
						data.consentWords?.label || data.consent.title || data.text.consent,
						data.consentWords?.text ?? null
					)}
				{/if}
				<button type="submit">{data.text.continue}</button>
			</form>
			{#if formError}
				<!-- A Continue that failed may not go through again (a spent budget): a way out. -->
				<form method="post" action={actionOf(data.search, 'restart')}>
					<input type="hidden" name="txn" value={data.txnId} />
					<input type="hidden" name="csrf" value={data.csrfToken} />
					<button type="submit">{data.text.restart}</button>
				</form>
			{/if}
		{:else if data.passkey}
			<!-- The passkey ceremony: the fixed script signs the challenge on the button's press. -->
			<h1>{data.text.passkey}</h1>
			<p>{data.text.passkeyPrompt}</p>
			{#if formError}<p role="alert">{data.text.errors[formError]}</p>{/if}
			<form
				method="post"
				action={actionOf(data.search, 'passkey_finish')}
				data-lite-passkey={JSON.stringify(data.passkey.options)}
				data-lite-passkey-unsupported={data.text.passkeyUnsupported}
				data-lite-passkey-error={data.text.passkeyFailed}
			>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<input type="hidden" name="op" value={data.op} />
				<input type="hidden" name="credential" value="" />
				<input type="hidden" name="challenge" value={data.passkey.challenge} />
				<button type="submit">{data.text.passkey}</button>
			</form>
			<form method="post" action={actionOf(data.search, 'restart')}>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<button type="submit">{data.text.restart}</button>
			</form>
			<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
			{@html passkeyTag}
		{:else}
			{#if data.decision.title}<h1>{data.decision.title}</h1>{/if}
			{#if data.decision.description}<p>{data.decision.description}</p>{/if}
			{#if data.codeEntry?.maskedEmail}
				<p>{data.text.codeSentTo} <strong>{data.codeEntry.maskedEmail}</strong></p>
			{/if}
			{#if formError}<p role="alert">{data.text.errors[formError]}</p>{/if}
			<form
				method="post"
				action={actionOf(
					data.search,
					data.codeEntry?.kind === 'totp'
						? 'totp_verify'
						: data.codeEntry
							? 'verify_code'
							: 'send_code'
				)}
				data-lite-pow={data.pow && proofHere ? JSON.stringify(data.pow) : undefined}
				data-lite-pow-error={data.pow && proofHere ? data.text.javascriptRequired : undefined}
			>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<input type="hidden" name="op" value={data.op} />
				{#if data.pow && proofHere}
					<input type="hidden" name="human_verification_response" value="" />
				{/if}
				{#if data.codeEntry?.kind === 'totp'}
					<input type="hidden" name="challenge" value={data.codeEntry.challenge} />
				{/if}
				{#each data.decision.fields as field, index (`${field.blockType}:${field.field}:${index}`)}
					{#if field.blockType === 'heading'}
						<h2>{field.label || field.text}</h2>
						{#if field.label && field.text}<p>{field.text}</p>{/if}
					{:else if field.blockType === 'text'}
						<p>{field.text ?? field.label}</p>
					{:else if field.blockType === 'divider'}
						<!-- `Divider` is the block's internal name, never its words (SPA `dividerLabel`). -->
						{#if field.text && field.text !== 'Divider'}
							<p class="divider">{field.text}</p>
						{:else}
							<hr />
						{/if}
					{:else if field.blockType === 'consent_widget'}
						<!-- Its terms, when the step has any (a screen may have the part with none). -->
						{#if data.consent}
							{@render consentPart(
								data.consent,
								field.label || data.consent.title || data.text.consent,
								field.text
							)}
						{/if}
						{#if data.consentOnly}
							<button type="submit" formaction={actionOf(data.search, 'consent_continue')}
								>{data.text.continue}</button
							>
						{/if}
					{:else if field.blockType === 'link'}
						<p>
							{#if field.href}<a href={field.href}>{field.label}</a>{:else}{field.label}{/if}
						</p>
					{:else if field.blockType === 'identity_field' && field.valueType === 'boolean'}
						<!-- The legacy yes/no keeps its own words on the box (its placeholder) under the
						     label, as the SPA does; otherwise the label is the box's text. -->
						{#if field.placeholder && field.placeholder !== field.label}
							<p class:sr-only={!field.showLabel}>{field.label}</p>
							<label class="check">
								<input type="checkbox" name={field.field} value="true" required={field.required} />
								{field.placeholder}
							</label>
						{:else}
							<label class="check">
								<input type="checkbox" name={field.field} value="true" required={field.required} />
								<span class:sr-only={!field.showLabel}>{field.label}</span>
							</label>
						{/if}
						{#if field.helpText}<p class="muted">{field.helpText}</p>{/if}
					{:else if field.blockType === 'identity_field'}
						<label>
							<span class:sr-only={!field.showLabel}>{field.label || data.text.email}</span>
							<input
								name={field.field}
								type={isEmailField(field.field) ? 'email' : 'text'}
								autocomplete={isEmailField(field.field) ? 'email' : 'off'}
								required={field.required && !data.codeEntry}
								placeholder={field.placeholder ?? undefined}
							/>
						</label>
						{#if field.helpText}<p class="muted">{field.helpText}</p>{/if}
					{:else if field.blockType === 'code_input_widget'}
						<!-- An authenticator code is 6 or 8 digits (ar-auth totp.ts); an emailed one, 6. -->
						<label>
							{field.label || data.text.code}
							<input
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern={data.codeEntry?.kind === 'totp' ? '[0-9]{6}([0-9]{2})?' : '[0-9]{6}'}
								minlength="6"
								maxlength={data.codeEntry?.kind === 'totp' ? 8 : 6}
								required
							/>
						</label>
						{#if data.codeEntry}
							<!-- First of the form's buttons (an Enter in the code checks it), with no proof. -->
							<button type="submit" data-lite-pow-none
								>{data.codeEntry.kind === 'totp' ? data.text.totpVerify : data.text.verify}</button
							>
						{/if}
					{:else if field.blockType === 'auth_widget' && !data.codeEntry}
						{#if field.authMethod === 'passkey'}
							<!-- A passkey needs no address: the button goes without the required fields. -->
							<button
								type="submit"
								formnovalidate
								formaction={actionOf(data.search, 'passkey_start')}
								>{field.label || data.text.passkey}</button
							>
						{:else if field.authMethod === 'external_idp'}
							<!-- A button per provider; a provider needs no address (formnovalidate). -->
							{#each data.providers as provider (provider.id)}
								<button
									type="submit"
									formnovalidate
									formaction={actionOf(data.search, 'social_start')}
									name="provider"
									value={provider.id}>{provider.label}</button
								>
							{/each}
						{:else if field.authMethod === 'totp'}
							<button type="submit" formaction={actionOf(data.search, 'totp_start')}
								>{field.label || data.text.totp}</button
							>
						{:else if field.authMethod === 'mail_otp_totp'}
							<!-- One address, two ways on (the SPA's combined part): each only when it is on. -->
							{#if data.available.mailOtp}
								<button type="submit" formaction={actionOf(data.search, 'send_code')}
									>{data.text.sendCode}</button
								>
							{/if}
							{#if data.available.totp}
								<button type="submit" formaction={actionOf(data.search, 'totp_start')}
									>{data.text.totp}</button
								>
							{/if}
						{:else}
							<button type="submit" formaction={actionOf(data.search, 'send_code')}
								>{field.label || data.text.sendCode}</button
							>
						{/if}
					{:else if field.blockType === 'guest_login_widget' && !data.codeEntry}
						<button type="submit" formnovalidate formaction={actionOf(data.search, 'guest')}
							>{field.label || data.text.guest}</button
						>
					{/if}
				{/each}
				{#if data.codeEntry?.kind === 'mail_otp'}
					<!-- In the code's form: the consent choices drawn with it go with it (kept to draw the
					     page again), the required ones not asked for yet. -->
					{#if data.codeEntry.resendWait > 0}<p class="muted">{data.text.resendWait}</p>{/if}
					<button type="submit" formnovalidate formaction={actionOf(data.search, 'resend')}
						>{data.text.resend}</button
					>
				{/if}
			</form>
			{#if data.codeEntry}
				<form method="post" action={actionOf(data.search, 'restart')}>
					<input type="hidden" name="txn" value={data.txnId} />
					<input type="hidden" name="csrf" value={data.csrfToken} />
					<button type="submit">{data.text.restart}</button>
				</form>
			{/if}
			{#if data.pow}
				<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
				{@html solverTag}
			{/if}
		{/if}
	</LiteShell>
{/if}
