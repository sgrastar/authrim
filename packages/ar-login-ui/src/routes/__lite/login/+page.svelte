<script lang="ts">
	import LiteShell from '#lib/lite/LiteShell.svelte';
	import LiteRelay from '#lib/lite/LiteRelay.svelte';
	import { LITE_POW_SOLVER_SCRIPT } from '#lib/lite/pow-solver.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// A constant script, never data: its exact text is what the page's CSP allows by hash.
	const solverTag = '<scr' + `ipt>${LITE_POW_SOLVER_SCRIPT}</scr` + 'ipt>';

	function isEmailField(field: string): boolean {
		const name = field.trim().toLowerCase();
		return name === 'email' || name.endsWith('.email');
	}
</script>

{#if data.page === 'error'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<h1>{data.title}</h1>
		<p>{data.message}</p>
		<p><a href="/login">{data.back}</a></p>
	</LiteShell>
{:else if data.page === 'relay'}
	<LiteShell title={data.title} brandName={data.brandName} logo={data.logo}>
		<LiteRelay target={data.relay} continueLabel={data.continueLabel} />
	</LiteShell>
{:else}
	<LiteShell title={data.text.title} brandName={data.brandName} logo={data.logo}>
		{#if form && 'restart' in form && form.restart}
			<p role="alert">{data.text.unsupported}</p>
			<p><a href="/login">{data.text.back}</a></p>
		{:else if data.decision.kind === 'unsupported'}
			<h1>{data.text.title}</h1>
			<p role="alert">{data.text.unsupported}</p>
			<p><a href="/login">{data.text.back}</a></p>
		{:else if data.decision.kind === 'continue'}
			<h1>{data.text.title}</h1>
			<form method="post" action={`${data.search || '?'}${data.search ? '&' : ''}/continue`}>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				<button type="submit">{data.text.continue}</button>
			</form>
		{:else}
			{#if data.decision.title}<h1>{data.decision.title}</h1>{/if}
			{#if data.decision.description}<p>{data.decision.description}</p>{/if}
			<form
				method="post"
				action={`${data.search || '?'}${data.search ? '&' : ''}/send_code`}
				data-lite-pow={data.pow ? JSON.stringify(data.pow) : undefined}
				data-lite-pow-error={data.pow ? data.text.javascriptRequired : undefined}
			>
				<input type="hidden" name="txn" value={data.txnId} />
				<input type="hidden" name="csrf" value={data.csrfToken} />
				{#if data.pow}
					<input type="hidden" name="human_verification_response" value="" />
				{/if}
				{#each data.decision.fields as field, index (`${field.blockType}:${field.field}:${index}`)}
					{#if field.blockType === 'heading'}
						<h2>{field.label || field.text}</h2>
						{#if field.label && field.text}<p>{field.text}</p>{/if}
					{:else if field.blockType === 'text'}
						<p>{field.text ?? field.label}</p>
					{:else if field.blockType === 'divider'}
						<hr />
					{:else if field.blockType === 'link'}
						<p>
							{#if field.href}<a href={field.href}>{field.label}</a>{:else}{field.label}{/if}
						</p>
					{:else if field.blockType === 'identity_field'}
						<label>
							{field.label || data.text.email}
							<input
								name={field.field}
								type={isEmailField(field.field) ? 'email' : 'text'}
								autocomplete={isEmailField(field.field) ? 'email' : 'off'}
								required={field.required}
								placeholder={field.placeholder ?? undefined}
							/>
						</label>
						{#if field.helpText}<p class="muted">{field.helpText}</p>{/if}
					{:else if field.blockType === 'code_input_widget'}
						<label>
							{field.label}
							<input
								name="code"
								inputmode="numeric"
								autocomplete="one-time-code"
								pattern="[0-9]*"
								maxlength="8"
							/>
						</label>
					{:else if field.blockType === 'auth_widget'}
						<button
							type="submit"
							formaction={`${data.search || '?'}${data.search ? '&' : ''}/send_code`}
							>{field.label || data.text.sendCode}</button
						>
					{:else if field.blockType === 'guest_login_widget'}
						<button
							type="submit"
							formnovalidate
							formaction={`${data.search || '?'}${data.search ? '&' : ''}/guest`}
							>{field.label || data.text.guest}</button
						>
					{/if}
				{/each}
			</form>
			{#if data.pow}
				<noscript><p role="alert">{data.text.javascriptRequired}</p></noscript>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
				{@html solverTag}
			{/if}
		{/if}
	</LiteShell>
{/if}
