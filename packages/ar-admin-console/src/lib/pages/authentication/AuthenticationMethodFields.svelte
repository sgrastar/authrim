<script lang="ts">
	import type { AuthenticationMethodValues } from '#lib/api/authentication-method-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import { BUILT_IN_METHODS, METHOD_USES, methodKey } from './authentication-method-fields';

	/** Shared profile settings: the page and a service-flow side panel can use the same editor. */
	interface Props {
		values: AuthenticationMethodValues;
		canWrite: boolean;
		onchange: (key: string, checked: boolean) => void;
	}

	let { values, canWrite, onchange }: Props = $props();
	const checked = (key: string) => values[key] === true;
	const guests = [
		{ key: 'authentication-methods.guest.login_enabled', label: 'am.guest.login' },
		{
			key: 'authentication-methods.passkey.guest_upgrade_enabled',
			label: 'am.guest.passkeyUpgrade'
		},
		{
			key: 'authentication-methods.email_otp.guest_upgrade_enabled',
			label: 'am.guest.emailUpgrade'
		}
	] as const;
</script>

<div class="method-fields">
	<Card title={t('am.methods.title')} description={t('am.methods.description')} flush>
		<div class="method-grid" role="group" aria-label={t('am.methods.title')}>
			<div class="method-grid__header" aria-hidden="true">
				<span>{t('am.methods.method')}</span>
				{#each METHOD_USES as use (use.id)}<span>{t(use.label)}</span>{/each}
			</div>
			{#each BUILT_IN_METHODS as method (method.id)}
				<div class="method-grid__row">
					<strong>{t(method.label)}</strong>
					{#each METHOD_USES as use (use.id)}
						<div class="method-grid__cell">
							<span class="method-grid__mobile-label">{t(use.label)}</span>
							<Checkbox
								checked={checked(methodKey(method.id, use.id))}
								disabled={!canWrite}
								hideLabel
								size="sm"
								onchange={(event) =>
									onchange(methodKey(method.id, use.id), event.currentTarget.checked)}
								>{t(method.label)} / {t(use.label)}</Checkbox
							>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</Card>
	<Card title={t('am.guest.title')}>
		<div class="guest-options">
			{#each guests as guest (guest.key)}
				<Checkbox
					checked={checked(guest.key)}
					disabled={!canWrite}
					onchange={(event) => onchange(guest.key, event.currentTarget.checked)}
					>{t(guest.label)}</Checkbox
				>
			{/each}
		</div>
	</Card>
</div>

<style>
	.method-fields {
		display: grid;
		gap: var(--space-section);
		container-type: inline-size;
	}
	.method-grid__header,
	.method-grid__row {
		display: grid;
		grid-template-columns: minmax(150px, 1.5fr) repeat(4, minmax(110px, 1fr));
		align-items: center;
	}
	.method-grid__header {
		color: var(--text-muted);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		background: var(--bg-subtle);
	}
	.method-grid__header > span,
	.method-grid__row > strong,
	.method-grid__cell {
		padding: 12px 16px;
	}
	.method-grid__row {
		border-top: 1px solid var(--border-subtle);
	}
	.method-grid__row > strong {
		font-size: var(--fs-body);
	}
	.method-grid__cell {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.method-grid__mobile-label {
		display: none;
	}
	.guest-options {
		display: grid;
		gap: 14px;
	}
	@container (max-width: 760px) {
		.method-grid__header {
			display: none;
		}
		.method-grid__row {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			padding: 12px 16px;
			gap: 10px;
		}
		.method-grid__row > strong {
			grid-column: 1 / -1;
			padding: 0 0 3px;
		}
		.method-grid__cell {
			justify-content: space-between;
			padding: 8px 0;
			gap: 8px;
		}
		.method-grid__mobile-label {
			display: inline;
			font-size: var(--fs-small);
		}
	}
	@container (max-width: 360px) {
		.method-grid__row {
			grid-template-columns: 1fr;
		}
	}
</style>
