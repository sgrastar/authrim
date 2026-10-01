<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import IconButton from '$lib/ui/primitives/IconButton.svelte';
	import AccountMenu from './AccountMenu.svelte';
	import DisplayMenu from './DisplayMenu.svelte';
	import LanguageSwitch from './LanguageSwitch.svelte';
	import ScopeSwitcher, { type ScopeOption } from './ScopeSwitcher.svelte';

	interface Props {
		scopes: readonly ScopeOption[];
		currentScopeId: string;
		onscope: (option: ScopeOption) => void;
		account: { name: string; email?: string; initials: string };
		onsignout: () => void;
		onmenu: () => void;
	}

	let { scopes, currentScopeId, onscope, account, onsignout, onmenu }: Props = $props();
</script>

<header class="topbar">
	<span class="topbar__menu">
		<IconButton icon="list" label={t('app.menu')} onclick={onmenu} />
	</span>
	<a class="brand" href="/admin">
		<span class="brand__mark"><Icon name="sparkle" /></span>
		<span class="brand__name">{t('app.brand')}</span>
		<span class="brand__sub">{t('app.adminLabel')}</span>
	</a>
	<span class="topbar__divider" aria-hidden="true"></span>
	<ScopeSwitcher options={scopes} currentId={currentScopeId} onselect={onscope} />
	<span class="topbar__spacer"></span>
	<span class="topbar__lang"><LanguageSwitch /></span>
	<DisplayMenu />
	<AccountMenu {...account} {onsignout} />
</header>

<style>
	.topbar {
		position: sticky;
		top: 0;
		z-index: var(--z-header);
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
		height: var(--header-h);
		padding: 0 18px;
		border-bottom: var(--shell-rule) solid var(--border);
		background: var(--shell-bg);
		-webkit-backdrop-filter: var(--shell-backdrop);
		backdrop-filter: var(--shell-backdrop);
	}

	.topbar > :global(*) {
		flex-shrink: 0;
	}

	.topbar > :global(.popover:first-of-type) {
		flex-shrink: 1;
	}

	.topbar__menu {
		display: none;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
		font-weight: var(--fw-semibold);
		letter-spacing: -0.01em;
		white-space: nowrap;
	}

	.brand__mark {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: min(7px, var(--radius-control));
		background: var(--primary);
		color: var(--text-inverse);
		--icon-size: var(--icon-md);
	}

	.brand__name {
		font-family: var(--font-brand);
	}

	.brand__sub {
		color: var(--text-muted);
		font-weight: var(--fw-medium);
	}

	.topbar__divider {
		width: 1px;
		height: 22px;
		background: var(--border);
	}

	.topbar__spacer {
		flex: 1;
	}

	@media (max-width: 1024px) {
		.brand__sub {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.topbar {
			gap: 7px;
			padding: 0 12px;
		}
		.topbar__menu {
			display: inline-flex;
		}
		/* Keep only "which scope", display settings and the account; the rest moves into the
		   drawer. The brand mark alone identifies the product next to the menu button. */
		.brand__name,
		.topbar__divider,
		.topbar__lang {
			display: none;
		}
	}
</style>
