<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';

	/**
	 * What an account widget looks like on the account page, with sample content (the Login UI
	 * draws the real one from the user's own data): the rows, buttons and tiles it is made of.
	 * Names and addresses are made up.
	 */
	interface Props {
		kind: string;
		/** A launcher slot's launchers by name (sample tiles when not given). */
		launcherNames?: readonly string[];
	}

	let { kind, launcherNames }: Props = $props();

	const tiles = $derived(launcherNames ?? ['Learning portal', 'Library', 'Mail', 'Timetable']);
</script>

{#if kind === 'account_profile_widget'}
	<dl class="rows">
		<div>
			<dt>Name</dt>
			<dd>Hanako Yamada</dd>
		</div>
		<div>
			<dt>Email</dt>
			<dd>hanako@example.com</dd>
		</div>
	</dl>
	<span class="button">{t('ap.sample.edit')}</span>
{:else if kind === 'account_device_list_widget'}
	<ul class="list">
		<li>
			<span>MacBook Air · Safari<small>{t('ap.sample.lastUsed')}</small></span>
			<span class="button button--quiet">{t('ap.sample.remove')}</span>
		</li>
		<li>
			<span>iPhone · Chrome<small>{t('ap.sample.lastUsed')}</small></span>
			<span class="button button--quiet">{t('ap.sample.remove')}</span>
		</li>
	</ul>
{:else if kind === 'account_session_widget'}
	<ul class="list">
		<li>
			<span>MacBook Air · Safari<small>{t('ap.sample.current')}</small></span>
		</li>
		<li>
			<span>Windows · Edge<small>{t('ap.sample.lastUsed')}</small></span>
			<span class="button button--quiet">{t('ap.sample.signOut')}</span>
		</li>
	</ul>
{:else if kind === 'account_passkey_widget'}
	<ul class="list">
		<li>
			<span>Touch ID · MacBook Air<small>{t('ap.sample.lastUsed')}</small></span>
			<span class="button button--quiet">{t('ap.sample.remove')}</span>
		</li>
	</ul>
	<span class="button">{t('ap.sample.add')}</span>
{:else if kind === 'account_totp_widget'}
	<p class="status"><i class="dot"></i>{t('ap.sample.on')}</p>
	<span class="button">{t('ap.sample.add')}</span>
{:else if kind === 'account_consent_widget'}
	<ul class="list">
		<li>
			<span>Example App<small>profile, email</small></span>
			<span class="button button--quiet">{t('ap.sample.withdraw')}</span>
		</li>
	</ul>
{:else if kind === 'account_activity_widget'}
	<ul class="list">
		<li><span>{t('ap.sample.signedIn')}<small>09:12</small></span></li>
		<li><span>{t('ap.sample.signedIn')}<small>Yesterday 18:40</small></span></li>
		<li><span>{t('ap.sample.profileChanged')}<small>Mon 11:05</small></span></li>
	</ul>
{:else if kind === 'account_social_account_widget'}
	<ul class="list">
		<li>
			<span>Google<small>hanako@example.com</small></span>
			<span class="button button--quiet">{t('ap.sample.unlink')}</span>
		</li>
		<li>
			<span>GitHub</span>
			<span class="button button--quiet">{t('ap.sample.link')}</span>
		</li>
	</ul>
{:else if kind === 'account_launcher_widget'}
	{#if tiles.length === 0}
		<p class="status">{t('ap.sample.noLaunchers')}</p>
	{:else}
		<ul class="tiles">
			{#each tiles as name, at (`${at}-${name}`)}
				<li><i class="tile__icon">{name.slice(0, 1)}</i><span>{name}</span></li>
			{/each}
		</ul>
	{/if}
{:else if kind === 'account_upgrade_widget'}
	<div class="upgrade">
		<p>{t('ap.sample.upgrade')}</p>
		<span class="button">{t('ap.sample.register')}</span>
	</div>
{/if}

<style>
	.rows {
		display: grid;
		gap: 8px;
		margin: 0 0 10px;
	}

	.rows div {
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr);
		gap: 8px;
	}

	dt {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	dd {
		margin: 0;
	}

	.list {
		display: grid;
		gap: 0;
		margin: 0 0 10px;
		padding: 0;
		list-style: none;
	}

	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 0;
		border-block-end: 1px solid var(--border-subtle);
	}

	.list li:last-child {
		border-block-end: 0;
	}

	.list span {
		display: grid;
	}

	small {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.button {
		display: inline-flex;
		align-items: center;
		align-self: start;
		padding: 4px 12px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: var(--fs-small);
		white-space: nowrap;
	}

	.button--quiet {
		border-color: var(--border);
		color: var(--text-secondary);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 0 10px;
	}

	.dot {
		inline-size: 8px;
		block-size: 8px;
		border-radius: 50%;
		background: var(--success, var(--primary));
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tiles li {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 12px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		font-size: var(--fs-small);
		text-align: center;
	}

	.tile__icon {
		display: grid;
		place-items: center;
		inline-size: 32px;
		block-size: 32px;
		border-radius: var(--radius-control);
		background: var(--bg-hover);
		font-style: normal;
		font-weight: var(--fw-semibold);
	}

	.upgrade {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.upgrade p {
		margin: 0;
	}
</style>
