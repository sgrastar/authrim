<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Popover from '$lib/ui/patterns/Popover.svelte';

	/** Entry point for personal settings and sign-out. */
	interface Props {
		name: string;
		email?: string;
		initials: string;
		onsignout: () => void;
	}

	let { name, email, initials, onsignout }: Props = $props();
</script>

<Popover label={t('account.menu')} align="end">
	{#snippet trigger()}<span class="avatar">{initials}</span>{/snippet}
	<div class="who">
		<span class="who__label">{t('account.signedInAs')}</span>
		<span class="who__name">{name}</span>
		{#if email && email !== name}<span class="who__email">{email}</span>{/if}
	</div>
	<div class="actions">
		<Button variant="ghost" icon="gear" block href="/admin/me">{t('account.settings')}</Button>
		<Button variant="ghost" icon="logout" block onclick={onsignout}>{t('account.signOut')}</Button>
	</div>
</Popover>

<style>
	.avatar {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--accent-platform);
		color: var(--on-accent);
		font-size: var(--fs-caption);
		font-weight: var(--fw-bold);
	}

	.who {
		display: grid;
		gap: 1px;
		padding: 8px 8px 10px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.who__label {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.who__name {
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
		overflow-wrap: anywhere;
	}

	.who__email {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		overflow-wrap: anywhere;
	}

	.actions {
		display: grid;
		gap: 2px;
		padding-top: 6px;
	}

	/* Menu entries read as a list: start-aligned, not centred like standalone buttons. */
	.actions :global(.btn) {
		justify-content: flex-start;
	}
</style>
