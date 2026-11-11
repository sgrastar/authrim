<script lang="ts">
	import type { AuthenticationMethodValues } from '#lib/api/authentication-method-profiles.js';
	import type { DirectoryPasswordStatus } from '#lib/api/directory-password-status.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import NotApplicable from '#lib/ui/patterns/NotApplicable.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import InfoTip from '#lib/ui/primitives/InfoTip.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import { BUILT_IN_METHODS, METHOD_USES, methodKey } from './authentication-method-fields';

	/** Shared profile settings: the page and a service-flow side panel can use the same editor. */
	interface Props {
		values: AuthenticationMethodValues;
		canWrite: boolean;
		/** Null when connector readiness could not be checked. */
		directoryStatus?: DirectoryPasswordStatus | null;
		onchange: (key: string, checked: boolean) => void;
		/** Heading level of the boxes: 3 inside a panel that has its own heading. */
		level?: 2 | 3;
		/** The methods box's description; off where the page around it already says what it is. */
		describe?: boolean;
	}

	let {
		values,
		canWrite,
		directoryStatus = null,
		onchange,
		level = 2,
		describe = true
	}: Props = $props();
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
	<Card
		title={t('am.methods.title')}
		description={describe ? t('am.methods.description') : undefined}
		{level}
		flush
	>
		<div class="method-grid" role="group" aria-label={t('am.methods.title')}>
			<div class="method-grid__header" aria-hidden="true">
				<span>{t('am.methods.method')}</span>
				{#each METHOD_USES as use (use.id)}<span>{t(use.label)}</span>{/each}
			</div>
			{#each BUILT_IN_METHODS as method (method.id)}
				<div class="method-grid__row">
					<div class="method-grid__name">
						<div class="method-grid__name-line">
							<strong>{t(method.label)}</strong>
							<InfoTip
								label={t('am.methods.about', { name: t(method.label) })}
								text={t(method.description)}
							/>
							{#if method.id === 'directory_password' && directoryStatus === 'unconfigured'}
								<Badge>{t('am.methods.notConfigured')}</Badge>
							{:else if method.id === 'directory_password' && directoryStatus === 'disabled'}
								<Badge>{t('am.methods.directoryDisabled')}</Badge>
							{/if}
						</div>
						{#if method.id === 'directory_password'}
							<Link href="/admin/authentication/directory" standalone
								>{t('am.methods.directorySettings')}</Link
							>
						{/if}
					</div>
					{#each METHOD_USES as use (use.id)}
						<div class="method-grid__cell">
							<span class="method-grid__mobile-label">{t(use.label)}</span>
							{#if method.supports.includes(use.id)}
								<Checkbox
									checked={checked(methodKey(method.id, use.id))}
									disabled={!canWrite ||
										(method.id === 'directory_password' &&
											directoryStatus !== null &&
											directoryStatus !== 'ready' &&
											!checked(methodKey(method.id, use.id)))}
									hideLabel
									size="sm"
									onchange={(event) =>
										onchange(methodKey(method.id, use.id), event.currentTarget.checked)}
									>{t(method.label)} / {t(use.label)}</Checkbox
								>
							{:else}
								<NotApplicable />
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</Card>
	<Card title={t('am.guest.title')} {level}>
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
	.method-grid__name,
	.method-grid__cell {
		padding: 12px 16px;
	}
	.method-grid__row {
		border-top: 1px solid var(--border-subtle);
	}
	.method-grid__name {
		min-width: 0;
	}
	.method-grid__name-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
	}
	.method-grid__name strong {
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
		.method-grid__name {
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
