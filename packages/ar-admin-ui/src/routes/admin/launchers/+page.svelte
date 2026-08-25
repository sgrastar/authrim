<script lang="ts">
	import { onMount } from 'svelte';
	import { getLocale } from '$i18n/i18n-svelte';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import {
		adminLaunchersAPI,
		type ApplicationLauncher,
		type LauncherAttributeOperator,
		type LauncherInput,
		type LauncherOptions
	} from '$lib/api/admin-launchers';
	import { adminUsersAPI, type User } from '$lib/api/admin-users';
	import { adminSAMLAPI, type SAMLProvider } from '$lib/api/admin-saml';
	import { defaultLaunchTypeForApplication } from './launcher-editor';

	let launchers = $state<ApplicationLauncher[]>([]);
	let options = $state<LauncherOptions>({
		oidc_clients: [],
		groups: [],
		attribute_keys: [],
		phosphor_icons: []
	});
	let users = $state<User[]>([]);
	let userSearch = $state('');
	let userSearching = $state(false);
	let samlServiceProviders = $state<SAMLProvider[]>([]);
	let selectedId = $state('');
	let draft = $state<ApplicationLauncher>(blankLauncher());
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let message = $state('');

	function t(ja: string, en: string): string {
		return getLocale() === 'ja' ? ja : en;
	}

	function blankLauncher(): ApplicationLauncher {
		return {
			id: '',
			application_type: 'standalone',
			application_id: null,
			name: '',
			description: null,
			category: null,
			launch_type: 'bookmark',
			launch_url: null,
			deep_link_url: null,
			open_in_new_tab: true,
			icon_type: 'phosphor',
			icon_value: 'rocket-launch',
			icon_color: '#ffffff',
			background_color: '#2563eb',
			grid_width: 2,
			sort_order: launchers.length * 10,
			enabled: true,
			allow_favorite: true,
			visibility: {
				mode: 'everyone',
				attribute_match: 'all',
				user_ids: [],
				group_ids: [],
				attribute_rules: []
			},
			created_at: 0,
			updated_at: 0
		};
	}

	function clone(launcher: ApplicationLauncher): ApplicationLauncher {
		return structuredClone(launcher);
	}

	function payload(launcher: ApplicationLauncher): LauncherInput {
		const { id: _id, created_at: _createdAt, updated_at: _updatedAt, ...input } = launcher;
		return input;
	}

	function selectLauncher(launcher: ApplicationLauncher) {
		selectedId = launcher.id;
		draft = clone(launcher);
		error = '';
		message = '';
	}

	function createLauncher() {
		selectedId = '';
		draft = blankLauncher();
		error = '';
		message = '';
	}

	function selectOidcClient(clientId: string) {
		const client = options.oidc_clients.find((entry) => entry.client_id === clientId);
		draft.application_id = clientId || null;
		if (!client) return;
		if (client.initiate_login_uri) {
			draft.launch_url = client.initiate_login_uri;
			draft.launch_type = 'oidc_third_party_initiated';
		} else {
			draft.launch_url = null;
			draft.launch_type = 'bookmark';
		}
		if (!draft.name) draft.name = client.client_name;
		if (client.logo_uri && draft.icon_type === 'image') draft.icon_value = client.logo_uri;
	}

	function selectSamlServiceProvider(providerId: string) {
		const provider = samlServiceProviders.find((entry) => entry.id === providerId);
		draft.application_id = providerId || null;
		if (provider && !draft.name) draft.name = provider.name;
	}

	function addAttributeRule() {
		draft.visibility.attribute_rules = [
			...draft.visibility.attribute_rules,
			{
				id: crypto.randomUUID(),
				attribute_key: options.attribute_keys[0] ?? 'email',
				operator: 'equals',
				attribute_value: ''
			}
		];
	}

	function updateAttributeRule(
		id: string,
		patch: Partial<{
			attribute_key: string;
			operator: LauncherAttributeOperator;
			attribute_value: string | null;
		}>
	) {
		draft.visibility.attribute_rules = draft.visibility.attribute_rules.map((rule) =>
			rule.id === id ? { ...rule, ...patch } : rule
		);
	}

	function removeAttributeRule(id: string) {
		draft.visibility.attribute_rules = draft.visibility.attribute_rules.filter(
			(rule) => rule.id !== id
		);
	}

	async function searchUsers() {
		const search = userSearch.trim();
		if (!search || userSearching) return;
		userSearching = true;
		error = '';
		try {
			const result = await adminUsersAPI.list({ limit: 100, search });
			const merged = [...users];
			for (const user of result.users) {
				const index = merged.findIndex((entry) => entry.id === user.id);
				if (index >= 0) merged[index] = user;
				else merged.push(user);
			}
			users = merged;
		} catch (searchError) {
			error =
				searchError instanceof Error
					? searchError.message
					: t('ユーザー検索に失敗しました。', 'Failed to search users.');
		} finally {
			userSearching = false;
		}
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const [launcherResult, optionResult, userResult, samlResult] = await Promise.all([
				adminLaunchersAPI.list(),
				adminLaunchersAPI.options(),
				adminUsersAPI
					.list({ limit: 100 })
					.then((result) => result.users)
					.catch(() => [] as User[]),
				adminSAMLAPI
					.listProviders()
					.then((result) => result.providers)
					.catch(() => [] as SAMLProvider[])
			]);
			launchers = launcherResult.launchers;
			options = optionResult;
			users = userResult;
			samlServiceProviders = samlResult.filter(
				(provider) =>
					provider.providerType === 'saml_sp' &&
					provider.enabled &&
					Boolean(provider.config.entityId)
			);
			if (launchers.length > 0) selectLauncher(launchers[0]);
			else createLauncher();
		} catch (loadError) {
			error =
				loadError instanceof Error
					? loadError.message
					: t('読み込みに失敗しました。', 'Failed to load launchers.');
		} finally {
			loading = false;
		}
	}

	async function save() {
		saving = true;
		error = '';
		message = '';
		try {
			const result = selectedId
				? await adminLaunchersAPI.update(selectedId, payload(draft))
				: await adminLaunchersAPI.create(payload(draft));
			const saved = result.launcher;
			launchers = selectedId
				? launchers.map((entry) => (entry.id === saved.id ? saved : entry))
				: [...launchers, saved];
			launchers = [...launchers].sort((a, b) => a.sort_order - b.sort_order);
			selectLauncher(saved);
			message = t('ランチャーを保存しました。', 'Launcher saved.');
		} catch (saveError) {
			error =
				saveError instanceof Error
					? saveError.message
					: t('保存に失敗しました。', 'Failed to save launcher.');
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!selectedId || !confirm(t('このランチャーを削除しますか？', 'Delete this launcher?')))
			return;
		saving = true;
		error = '';
		try {
			await adminLaunchersAPI.delete(selectedId);
			launchers = launchers.filter((entry) => entry.id !== selectedId);
			if (launchers.length > 0) selectLauncher(launchers[0]);
			else createLauncher();
			message = t('ランチャーを削除しました。', 'Launcher deleted.');
		} catch (deleteError) {
			error =
				deleteError instanceof Error
					? deleteError.message
					: t('削除に失敗しました。', 'Failed to delete launcher.');
		} finally {
			saving = false;
		}
	}

	async function move(index: number, offset: number) {
		if (saving) return;
		const target = index + offset;
		if (target < 0 || target >= launchers.length) return;
		const previous = [...launchers];
		const reordered = [...launchers];
		[reordered[index], reordered[target]] = [reordered[target], reordered[index]];
		launchers = reordered;
		saving = true;
		error = '';
		try {
			const result = await adminLaunchersAPI.reorder(reordered.map((launcher) => launcher.id));
			launchers = result.launchers;
			const selected = launchers.find((launcher) => launcher.id === selectedId);
			if (selected) draft = clone(selected);
		} catch (moveError) {
			launchers = previous;
			error =
				moveError instanceof Error
					? moveError.message
					: t('並び替えに失敗しました。', 'Failed to reorder launchers.');
		} finally {
			saving = false;
		}
	}

	onMount(() => void load());
</script>

<svelte:head
	><title>{t('ランチャー - Authrim管理画面', 'Launchers - Authrim Admin')}</title></svelte:head
>

<AdminPageShell>
	<AdminPageHeader
		title={t('ランチャー', 'Launchers')}
		description={t(
			'アカウントページに表示するアプリケーション、起動方法、レイアウト、公開対象を管理します。',
			'Manage applications, launch methods, layout, and audience for the account page.'
		)}
	>
		{#snippet actions()}
			<button class="button secondary" type="button" onclick={createLauncher}>
				<span class="i-ph-plus"></span>{t('ランチャーを作成', 'Create launcher')}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if message}<p class="notice success" role="status">{message}</p>{/if}

	{#if loading}
		<p class="loading">{t('読み込み中...', 'Loading...')}</p>
	{:else}
		<div class="workspace">
			<aside class="launcher-list" aria-label={t('ランチャー一覧', 'Launcher list')}>
				{#if launchers.length === 0}
					<p class="empty">{t('まだランチャーがありません。', 'No launchers yet.')}</p>
				{/if}
				{#each launchers as launcher, index (launcher.id)}
					<div class="list-row" class:selected={selectedId === launcher.id}>
						<button class="list-select" type="button" onclick={() => selectLauncher(launcher)}>
							<span
								class="mini-icon"
								style={`background:${launcher.background_color};color:${launcher.icon_color}`}
							>
								{#if launcher.icon_type === 'image'}<img
										src={launcher.icon_value}
										alt=""
										loading="lazy"
										referrerpolicy="no-referrer"
									/>{:else}<span class={`i-ph-${launcher.icon_value}`}></span>{/if}
							</span>
							<span
								><strong>{launcher.name}</strong><small
									>{launcher.category || t('カテゴリなし', 'No category')}</small
								></span
							>
							{#if !launcher.enabled}<span class="badge">{t('無効', 'Off')}</span>{/if}
						</button>
						<div class="move-actions">
							<button
								type="button"
								aria-label={t('上へ', 'Move up')}
								disabled={saving || index === 0}
								onclick={() => move(index, -1)}><span class="i-ph-caret-up"></span></button
							>
							<button
								type="button"
								aria-label={t('下へ', 'Move down')}
								disabled={saving || index === launchers.length - 1}
								onclick={() => move(index, 1)}><span class="i-ph-caret-down"></span></button
							>
						</div>
					</div>
				{/each}
			</aside>

			<form
				class="editor"
				onsubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<header class="editor-heading">
					<div>
						<span class="eyebrow">{selectedId ? t('編集', 'Edit') : t('新規', 'New')}</span>
						<h2>{draft.name || t('新しいランチャー', 'New launcher')}</h2>
					</div>
					<label class="toggle"
						><input type="checkbox" bind:checked={draft.enabled} /><span
							>{t('有効', 'Enabled')}</span
						></label
					>
				</header>

				<section class="form-section">
					<h3>{t('表示内容', 'Presentation')}</h3>
					<div class="form-grid two">
						<label
							><span>{t('名前', 'Name')}</span><input
								required
								maxlength="120"
								bind:value={draft.name}
							/></label
						>
						<label
							><span>{t('カテゴリ', 'Category')}</span><input
								maxlength="100"
								value={draft.category ?? ''}
								oninput={(e) => (draft.category = e.currentTarget.value || null)}
							/></label
						>
						<label class="wide"
							><span>{t('説明', 'Description')}</span><textarea
								rows="2"
								maxlength="1000"
								value={draft.description ?? ''}
								oninput={(e) => (draft.description = e.currentTarget.value || null)}
							></textarea></label
						>
					</div>

					<div class="icon-layout">
						<div
							class="icon-preview"
							style={`background:${draft.background_color};color:${draft.icon_color}`}
						>
							{#if draft.icon_type === 'image'}<img
									src={draft.icon_value}
									alt=""
									referrerpolicy="no-referrer"
								/>{:else}<span class={`i-ph-${draft.icon_value}`}></span>{/if}
						</div>
						<div class="form-grid icon-fields">
							<label
								><span>{t('アイコン形式', 'Icon type')}</span><select bind:value={draft.icon_type}
									><option value="phosphor">Phosphor</option><option value="image"
										>{t('画像URL', 'Image URL')}</option
									></select
								></label
							>
							{#if draft.icon_type === 'phosphor'}
								<label
									><span>{t('アイコン', 'Icon')}</span><select bind:value={draft.icon_value}
										>{#each options.phosphor_icons as icon (icon)}<option value={icon}
												>{icon}</option
											>{/each}</select
									></label
								>
							{:else}
								<label
									><span>{t('画像URL（HTTPS）', 'Image URL (HTTPS)')}</span><input
										required
										type="url"
										bind:value={draft.icon_value}
									/></label
								>
							{/if}
							<label
								><span>{t('背景色', 'Background')}</span><input
									type="color"
									bind:value={draft.background_color}
								/></label
							>
							<label
								><span>{t('アイコン色', 'Icon color')}</span><input
									type="color"
									bind:value={draft.icon_color}
									disabled={draft.icon_type === 'image'}
								/></label
							>
						</div>
					</div>

					<div class="width-control">
						<label
							><span>{t('グリッド幅', 'Grid width')}</span><input
								type="range"
								min="1"
								max="8"
								step="1"
								bind:value={draft.grid_width}
							/></label
						>
						<strong>{draft.grid_width} / 8</strong>
						<div class="width-preview">
							<span style={`grid-column: span ${draft.grid_width}`}
								>{draft.name || t('プレビュー', 'Preview')}</span
							>
						</div>
					</div>
				</section>

				<section class="form-section">
					<h3>{t('アプリケーションと起動', 'Application and launch')}</h3>
					<div class="form-grid two">
						<label>
							<span>{t('アプリ種別', 'Application type')}</span>
							<select
								bind:value={draft.application_type}
								onchange={(event) => {
									draft.application_id = null;
									draft.launch_url = null;
									draft.deep_link_url = null;
									draft.launch_type = defaultLaunchTypeForApplication(
										event.currentTarget.value as ApplicationLauncher['application_type']
									);
								}}
							>
								<option value="standalone">{t('単独URL', 'Standalone URL')}</option>
								<option value="oidc_client">OIDC Client</option>
								<option value="saml_sp">SAML SP</option>
							</select>
						</label>
						{#if draft.application_type === 'oidc_client'}
							<label>
								<span>OIDC Client</span>
								<select
									value={draft.application_id ?? ''}
									onchange={(event) => selectOidcClient(event.currentTarget.value)}
								>
									<option value="">{t('選択してください', 'Select a client')}</option>
									{#if draft.application_id && !options.oidc_clients.some((client) => client.client_id === draft.application_id)}
										<option value={draft.application_id}>
											{draft.application_id}{t('（利用不可）', ' (unavailable)')}
										</option>
									{/if}
									{#each options.oidc_clients as client (client.client_id)}
										<option value={client.client_id}>
											{client.client_name}{client.initiate_login_uri
												? ''
												: t('（initiate_login_uriなし）', ' (no initiate_login_uri)')}
										</option>
									{/each}
								</select>
							</label>
						{:else if draft.application_type === 'saml_sp'}
							<label>
								<span>SAML SP</span>
								<select
									required
									value={draft.application_id ?? ''}
									onchange={(event) => selectSamlServiceProvider(event.currentTarget.value)}
								>
									<option value="">{t('選択してください', 'Select a service provider')}</option>
									{#if draft.application_id && !samlServiceProviders.some((provider) => provider.id === draft.application_id)}
										<option value={draft.application_id}>
											{draft.application_id}{t('（利用不可）', ' (unavailable)')}
										</option>
									{/if}
									{#each samlServiceProviders as provider (provider.id)}
										<option value={provider.id}>{provider.name}</option>
									{/each}
								</select>
							</label>
						{/if}
						<label>
							<span>{t('起動方式', 'Launch type')}</span>
							<select
								bind:value={draft.launch_type}
								onchange={(event) => {
									if (event.currentTarget.value === 'saml_sp_initiated') {
										draft.deep_link_url = null;
									}
								}}
							>
								<option value="bookmark">Bookmark</option>
								{#if draft.application_type === 'oidc_client'}
									<option
										value="oidc_third_party_initiated"
										disabled={!options.oidc_clients.some(
											(client) =>
												client.client_id === draft.application_id && client.initiate_login_uri
										)}>OIDC Third-Party Initiated</option
									>
								{:else if draft.application_type === 'saml_sp'}
									<option value="saml_sp_initiated">SAML SP-initiated</option>
									<option value="saml_idp_initiated">SAML IdP-initiated (Legacy)</option>
								{/if}
							</select>
						</label>
						<label
							><span
								>{draft.launch_type === 'saml_sp_initiated'
									? t(
											'SPのSSO開始／ディープリンクURL（HTTPS）',
											'SP SSO initiation / deep-link URL (HTTPS)'
										)
									: t('起動URL（HTTPS）', 'Launch URL (HTTPS)')}</span
							><input
								type="url"
								required={draft.launch_type !== 'saml_idp_initiated'}
								disabled={draft.launch_type === 'oidc_third_party_initiated'}
								value={draft.launch_url ?? ''}
								oninput={(e) => (draft.launch_url = e.currentTarget.value || null)}
							/></label
						>
						{#if draft.launch_type === 'saml_sp_initiated'}
							<div class="field wide">
								<span>{t('ディープリンク', 'Deep link')}</span>
								<small
									>{t(
										'目的のページを開くには、そのページ用にSPが提供するSSO開始URLを上の起動URLへ設定してください。',
										'To open a specific page, set the SP-provided SSO initiation URL for that page as the launch URL above.'
									)}</small
								>
							</div>
						{:else}
							<label class="wide"
								><span
									>{draft.launch_type === 'saml_idp_initiated'
										? t('Default RelayState URL（任意）', 'Default RelayState URL (optional)')
										: t('ディープリンクURL（任意）', 'Deep-link URL (optional)')}</span
								><input
									type="url"
									value={draft.deep_link_url ?? ''}
									oninput={(e) => (draft.deep_link_url = e.currentTarget.value || null)}
								/>{#if draft.launch_type === 'saml_idp_initiated'}<small
										>{t(
											'サービスプロバイダーへRelayStateとして送信します。UTF-8で80バイト以内にしてください。',
											'Sent to the service provider as RelayState. Must be at most 80 UTF-8 bytes.'
										)}</small
									>{/if}</label
							>
						{/if}
					</div>
					{#if draft.launch_type === 'saml_idp_initiated'}<p class="warning">
							<span class="i-ph-warning"></span>{t(
								'レガシーモードです。可能な場合はSP起点（SP-initiated）方式を使用してください。IdP起点方式にはSPが生成したリクエストとの対応付けがないため、ログインCSRFへの耐性が低下します。起動時の割り当て再検証は、ランチャーの表示対象を強制するために行われます。',
								'Legacy mode. Prefer SP-initiated SSO where possible. IdP-initiated SSO lacks correlation with an SP-generated request and therefore provides weaker protection against login CSRF. Assignment is rechecked at launch to enforce launcher visibility.'
							)}
						</p>{/if}
					<div class="check-row">
						<label
							><input type="checkbox" bind:checked={draft.open_in_new_tab} />{t(
								'新しいタブで開く',
								'Open in a new tab'
							)}</label
						><label
							><input type="checkbox" bind:checked={draft.allow_favorite} />{t(
								'お気に入りを許可',
								'Allow favorites'
							)}</label
						>
					</div>
				</section>

				<section class="form-section">
					<h3>{t('表示対象', 'Visibility')}</h3>
					<div class="form-grid two">
						<label
							><span>{t('対象', 'Audience')}</span><select bind:value={draft.visibility.mode}
								><option value="everyone">{t('すべてのユーザー', 'Everyone')}</option><option
									value="users">{t('指定ユーザー', 'Selected users')}</option
								><option value="groups">{t('指定グループ', 'Selected groups')}</option><option
									value="attributes">{t('属性ルール', 'Attribute rules')}</option
								></select
							></label
						>
						{#if draft.visibility.mode === 'users'}
							<div class="field">
								<span>{t('ユーザー検索', 'Search users')}</span>
								<div class="search-control">
									<input
										bind:value={userSearch}
										type="search"
										placeholder={t('名前、メール、ユーザーID', 'Name, email, or user ID')}
										onkeydown={(event) => {
											if (event.key !== 'Enter') return;
											event.preventDefault();
											void searchUsers();
										}}
									/>
									<button
										class="button secondary"
										type="button"
										disabled={!userSearch.trim() || userSearching}
										onclick={() => void searchUsers()}
										>{userSearching ? t('検索中...', 'Searching...') : t('検索', 'Search')}</button
									>
								</div>
							</div>
							<label
								><span>{t('ユーザー', 'Users')}</span><select
									multiple
									size="6"
									bind:value={draft.visibility.user_ids}
									>{#each draft.visibility.user_ids.filter((id) => !users.some((user) => user.id === id)) as userId (userId)}<option
											value={userId}>{userId}</option
										>{/each}{#each users as user (user.id)}<option value={user.id}
											>{user.name || user.email || user.id}</option
										>{/each}</select
								></label
							>
						{:else if draft.visibility.mode === 'groups'}
							<label
								><span>{t('グループ', 'Groups')}</span><select
									multiple
									size="6"
									bind:value={draft.visibility.group_ids}
									>{#each options.groups as group (group.id)}<option value={group.id}
											>{group.display_name}</option
										>{/each}</select
								></label
							>
						{:else if draft.visibility.mode === 'attributes'}
							<label
								><span>{t('ルールの結合', 'Rule matching')}</span><select
									bind:value={draft.visibility.attribute_match}
									><option value="all">{t('すべて一致', 'Match all')}</option><option value="any"
										>{t('いずれか一致', 'Match any')}</option
									></select
								></label
							>
						{/if}
					</div>
					{#if draft.visibility.mode === 'attributes'}
						<div class="rules">
							{#each draft.visibility.attribute_rules as rule (rule.id)}
								<div class="rule-row">
									<input
										list="attribute-keys"
										value={rule.attribute_key}
										oninput={(e) =>
											updateAttributeRule(rule.id, { attribute_key: e.currentTarget.value })}
										aria-label={t('属性', 'Attribute')}
									/>
									<select
										value={rule.operator}
										onchange={(e) =>
											updateAttributeRule(rule.id, {
												operator: e.currentTarget.value as LauncherAttributeOperator,
												attribute_value:
													e.currentTarget.value === 'exists' ? null : (rule.attribute_value ?? '')
											})}
										>{#each ['equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'exists'] as operator (operator)}<option
												value={operator}>{operator}</option
											>{/each}</select
									>
									<input
										disabled={rule.operator === 'exists'}
										value={rule.attribute_value ?? ''}
										oninput={(e) =>
											updateAttributeRule(rule.id, { attribute_value: e.currentTarget.value })}
										aria-label={t('値', 'Value')}
									/>
									<button
										class="icon-button"
										type="button"
										aria-label={t('ルールを削除', 'Remove rule')}
										onclick={() => removeAttributeRule(rule.id)}
										><span class="i-ph-trash"></span></button
									>
								</div>
							{/each}
							<button class="button secondary" type="button" onclick={addAttributeRule}
								><span class="i-ph-plus"></span>{t(
									'属性ルールを追加',
									'Add attribute rule'
								)}</button
							>
							<small
								>{t(
									'属性名は直接入力できます。カスタムクレームは「custom.department」、検証済み属性は「verified.country」の形式でも指定できます。',
									'Attribute names can be entered directly. Custom claims may use custom.department and verified attributes may use verified.country.'
								)}</small
							>
						</div>
						<datalist id="attribute-keys"
							>{#each options.attribute_keys as key (key)}<option value={key}
								></option>{/each}</datalist
						>
					{/if}
				</section>

				<footer class="editor-actions">
					{#if selectedId}<button
							class="button danger"
							type="button"
							onclick={remove}
							disabled={saving}><span class="i-ph-trash"></span>{t('削除', 'Delete')}</button
						>{/if}
					<button class="button primary" type="submit" disabled={saving}
						>{saving ? t('保存中...', 'Saving...') : t('保存', 'Save')}</button
					>
				</footer>
			</form>
		</div>
	{/if}
</AdminPageShell>

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-height: 2.5rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.55rem 0.85rem;
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}
	.button.primary {
		border-color: var(--color-primary);
		background: var(--color-primary);
		color: #fff;
	}
	.button.danger {
		margin-right: auto;
		color: var(--color-error);
	}
	.button:disabled,
	.icon-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.notice {
		margin: 0 0 1rem;
		padding: 0.75rem 0.9rem;
		border-radius: 8px;
	}
	.notice.error {
		background: color-mix(in srgb, var(--color-error) 10%, transparent);
		color: var(--color-error);
	}
	.notice.success {
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		color: var(--color-success);
	}
	.loading,
	.empty {
		color: var(--color-text-muted);
	}
	.workspace {
		display: grid;
		grid-template-columns: minmax(230px, 300px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}
	.launcher-list,
	.editor {
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-surface);
	}
	.launcher-list {
		position: sticky;
		top: 16px;
		display: grid;
		max-height: calc(100vh - 180px);
		overflow: auto;
		padding: 6px;
	}
	.empty {
		margin: 0;
		padding: 18px 12px;
	}
	.list-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		border-radius: 8px;
	}
	.list-row.selected {
		background: var(--color-surface-muted);
	}
	.list-select {
		min-width: 0;
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr) auto;
		align-items: center;
		gap: 9px;
		padding: 9px;
		border: 0;
		background: transparent;
		color: var(--color-text);
		text-align: left;
		cursor: pointer;
	}
	.list-select strong,
	.list-select small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.list-select small {
		margin-top: 2px;
		color: var(--color-text-muted);
	}
	.mini-icon {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: 8px;
	}
	.mini-icon img,
	.icon-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.badge {
		padding: 2px 5px;
		border-radius: 4px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.7rem;
	}
	.move-actions {
		display: grid;
		align-content: center;
	}
	.move-actions button {
		width: 27px;
		height: 24px;
		border: 0;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
	}
	.editor {
		padding: 20px;
	}
	.editor-heading {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 12px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--color-border);
	}
	.editor-heading h2 {
		margin: 3px 0 0;
		font-size: 1.25rem;
	}
	.eyebrow {
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}
	.toggle,
	.check-row label {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}
	.form-section {
		padding: 20px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.form-section h3 {
		margin: 0 0 14px;
		font-size: 0.92rem;
	}
	.form-grid {
		display: grid;
		gap: 12px;
	}
	.form-grid.two {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.form-grid .wide {
		grid-column: 1 / -1;
	}
	label > span,
	.field > span {
		display: block;
		margin-bottom: 5px;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		font-weight: 650;
	}
	.search-control {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}
	.search-control .button {
		white-space: nowrap;
	}
	input:not([type='checkbox']):not([type='range']):not([type='color']),
	select,
	textarea {
		width: 100%;
		min-height: 39px;
		border: 1px solid var(--color-border);
		border-radius: 7px;
		padding: 8px 10px;
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
	}
	textarea {
		resize: vertical;
	}
	select[multiple] {
		min-height: 130px;
	}
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
	.icon-layout {
		display: grid;
		grid-template-columns: 76px minmax(0, 1fr);
		gap: 14px;
		align-items: start;
		margin-top: 14px;
	}
	.icon-preview {
		width: 76px;
		height: 76px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: 12px;
		font-size: 30px;
	}
	.icon-fields {
		grid-template-columns: 1fr 1.5fr 0.7fr 0.7fr;
	}
	input[type='color'] {
		width: 100%;
		min-height: 39px;
		border: 1px solid var(--color-border);
		border-radius: 7px;
		padding: 3px;
		background: var(--color-surface);
	}
	.width-control {
		display: grid;
		grid-template-columns: minmax(160px, 1fr) auto;
		gap: 8px 14px;
		align-items: end;
		margin-top: 14px;
	}
	.width-control input {
		width: 100%;
	}
	.width-preview {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: repeat(8, minmax(0, 1fr));
		gap: 4px;
		padding: 7px;
		background: var(--color-surface-muted);
		border-radius: 7px;
	}
	.width-preview span {
		padding: 8px;
		border-radius: 5px;
		background: var(--color-primary);
		color: #fff;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
	}
	.warning {
		display: flex;
		gap: 8px;
		margin: 12px 0 0;
		padding: 10px;
		border-radius: 7px;
		background: #fffbeb;
		color: #92400e;
		font-size: 0.8rem;
	}
	.check-row {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin-top: 12px;
	}
	.rules {
		display: grid;
		gap: 8px;
		margin-top: 12px;
	}
	.rule-row {
		display: grid;
		grid-template-columns: 1fr 0.85fr 1fr auto;
		gap: 7px;
	}
	.icon-button {
		width: 39px;
		height: 39px;
		border: 1px solid var(--color-border);
		border-radius: 7px;
		background: var(--color-surface);
		color: var(--color-error);
		cursor: pointer;
	}
	.editor-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 18px;
	}
	@media (max-width: 980px) {
		.workspace {
			grid-template-columns: 1fr;
		}
		.launcher-list {
			position: static;
			max-height: 300px;
		}
		.icon-fields {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 640px) {
		.form-grid.two,
		.icon-fields {
			grid-template-columns: 1fr;
		}
		.icon-layout {
			grid-template-columns: 1fr;
		}
		.rule-row {
			grid-template-columns: 1fr;
		}
	}
</style>
