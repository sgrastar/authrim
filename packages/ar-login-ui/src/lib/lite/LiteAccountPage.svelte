<script lang="ts">
	import LiteAccountWidget from './LiteAccountWidget.svelte';
	import LiteShell from './LiteShell.svelte';
	import type { ActionData, PageData } from '../../routes/__lite/account/$types';

	// The lite account page (lib/server/lite/account.ts): the tenant's placements, in order.
	let { data, form }: { data: PageData; form: ActionData } = $props();

	function actionOf(search: string, name: string): string {
		return `${search || '?'}${search ? '&' : ''}/${name}`;
	}

	const formError = $derived(
		form && 'error' in form && typeof form.error === 'string' ? form.error : null
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

{#if data.page === 'error'}
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
	</LiteShell>
{/if}
