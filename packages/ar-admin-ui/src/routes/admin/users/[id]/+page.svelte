<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { adminUsersAPI, type User, type UpdateUserInput } from '$lib/api/admin-users';
	import { adminSessionsAPI, type Session } from '$lib/api/admin-sessions';
	import { adminAuditLogsAPI, type AuditLogEntry } from '$lib/api/admin-audit-logs';
	import {
		adminRolesAPI,
		type Role,
		type RoleAssignment,
		type ScopeType
	} from '$lib/api/admin-roles';
	import {
		adminConsentStatementsAPI,
		type UserConsentRecord,
		type ConsentItemHistory
	} from '$lib/api/admin-consent-statements';
	import OrganizationSelectDialog from '$lib/components/OrganizationSelectDialog.svelte';
	import { Modal, ToggleSwitch } from '$lib/components';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminTabs, { type AdminTabItem } from '$lib/components/admin/AdminTabs.svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import type { OrganizationNode } from '$lib/api/admin-organizations';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { sanitizeText, isValidUUID } from '$lib/utils';
	import { normalizeTimestampMs } from '$lib/utils/timestamp';

	let user: User | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let isEditing = $state(false);
	let saving = $state(false);
	let actionError = $state('');
	let totpResetLoading = $state(false);

	// Edit form state
	let editForm = $state<UpdateUserInput>({});

	type UserSchemaField = {
		key: string;
		label: string;
		type: string;
		value: string | null;
		missingRequired: boolean;
	};

	// Role assignment state
	let userRoles = $state<RoleAssignment[]>([]);
	let availableRoles = $state<Role[]>([]);
	let rolesLoading = $state(false);
	let rolesError = $state('');

	// Assign role dialog state
	let showAssignRoleDialog = $state(false);
	let assignStep = $state<'select-role' | 'select-scope'>('select-role');
	let selectedRoleId = $state('');
	let selectedScope = $state<ScopeType>('global');
	let selectedOrgId = $state<string | null>(null);
	let selectedOrgName = $state<string | null>(null);
	let assignLoading = $state(false);

	// Organization select dialog
	let showOrgSelectDialog = $state(false);

	// Remove role confirmation
	let showRemoveRoleDialog = $state(false);
	let roleToRemove = $state<RoleAssignment | null>(null);
	let removeRoleLoading = $state(false);

	// Confirmation dialog state
	let showConfirmDialog = $state(false);
	let confirmAction = $state<'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions' | null>(
		null
	);
	let confirmLoading = $state(false);
	let revokedSessionsCount = $state<number | null>(null);

	// Tab management
	type TabId =
		| 'overview'
		| 'authentication-methods'
		| 'sessions'
		| 'audit-logs'
		| 'roles'
		| 'consents'
		| 'actions';
	let activeTab = $state<TabId>('overview');
	const USER_TAB_DEFINITIONS: ReadonlyArray<{ id: TabId; icon: string }> = [
		{ id: 'overview', icon: 'i-ph-user' },
		{ id: 'authentication-methods', icon: 'i-ph-fingerprint' },
		{ id: 'sessions', icon: 'i-ph-clock' },
		{ id: 'audit-logs', icon: 'i-ph-file-text' },
		{ id: 'roles', icon: 'i-ph-shield-check' },
		{ id: 'consents', icon: 'i-ph-check-circle' },
		{ id: 'actions', icon: 'i-ph-gear' }
	];
	const userTabItems = $derived<AdminTabItem[]>(
		USER_TAB_DEFINITIONS.map((tab) => ({
			id: tab.id,
			icon: tab.icon,
			label: tabLabel(tab.id),
			panelId: `${tab.id}-panel`
		}))
	);

	// Consent records state
	let consentRecords = $state<UserConsentRecord[]>([]);
	let consentLoading = $state(false);
	let consentError = $state('');

	// User activity tab state
	let userSessions = $state<Session[]>([]);
	let sessionsLoading = $state(false);
	let sessionsError = $state('');
	let auditEntries = $state<AuditLogEntry[]>([]);
	let auditLoading = $state(false);
	let auditError = $state('');

	// Consent history modal
	let showHistoryModal = $state(false);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let selectedStatementForHistory = $state<string | null>(null);
	let consentHistory = $state<ConsentItemHistory[]>([]);
	let historyLoading = $state(false);

	// Withdraw consent modal
	let showWithdrawModal = $state(false);
	let statementToWithdraw = $state<{ id: string; version: string } | null>(null);
	let withdrawLoading = $state(false);
	let loadedTenantId = $state('');

	const userId = $derived($page.params.id ?? '');
	const canWriteUsers = $derived(adminAuth.hasPermission('admin:users:write'));
	const canDeleteUsers = $derived(adminAuth.hasPermission('admin:users:delete'));
	const canManageRoles = $derived(adminAuth.hasPermission('admin:roles:write'));
	const canRevokeSessions = $derived(adminAuth.hasPermission('admin:sessions:revoke'));

	async function loadUser() {
		loading = true;
		error = '';

		try {
			user = await adminUsersAPI.get(userId);
			resetEditForm();
		} catch (err) {
			console.error('Failed to load user:', err);
			error = err instanceof Error ? err.message : $LL.admin_user_detail_error_load();
		} finally {
			loading = false;
		}
	}

	function resetEditForm() {
		if (user) {
			editForm = {
				name: user.name || '',
				given_name: user.given_name || '',
				family_name: user.family_name || '',
				nickname: user.nickname || '',
				preferred_username: user.preferred_username || '',
				phone_number: user.phone_number || '',
				email_verified: user.email_verified,
				phone_number_verified: user.phone_number_verified
			};
			for (const field of userSchemaFieldsFor(user)) {
				editForm[field.key] = fieldValueForForm(field);
			}
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		user = null;
		error = '';
		actionError = '';
		rolesError = '';
		consentError = '';
		sessionsError = '';
		auditError = '';
		consentRecords = [];
		consentHistory = [];
		userSessions = [];
		auditEntries = [];
		showHistoryModal = false;
		showWithdrawModal = false;
		statementToWithdraw = null;
		loadUser();
		loadUserRoles();
		loadAvailableRoles();
		if (activeTab === 'consents') {
			loadConsentRecords();
		}
	});

	// Role management functions
	async function loadUserRoles() {
		rolesLoading = true;
		rolesError = '';
		try {
			const response = await adminRolesAPI.getUserRoles(userId);
			userRoles = response.roles;
		} catch (err) {
			console.error('Failed to load user roles:', err);
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_load_roles();
		} finally {
			rolesLoading = false;
		}
	}

	async function loadAvailableRoles() {
		try {
			const response = await adminRolesAPI.list();
			availableRoles = response.roles;
		} catch (err) {
			console.error('Failed to load available roles:', err);
		}
	}

	function openAssignRoleDialog() {
		if (!canManageRoles) return;
		selectedRoleId = '';
		selectedScope = 'global';
		selectedOrgId = null;
		selectedOrgName = null;
		assignStep = 'select-role';
		showAssignRoleDialog = true;
		rolesError = '';
	}

	function closeAssignRoleDialog() {
		showAssignRoleDialog = false;
	}

	function goToScopeStep() {
		if (selectedRoleId) {
			assignStep = 'select-scope';
		}
	}

	function goBackToRoleStep() {
		assignStep = 'select-role';
	}

	function openOrgSelectDialog() {
		showOrgSelectDialog = true;
	}

	function handleOrgSelect(org: OrganizationNode) {
		selectedOrgId = org.id;
		selectedOrgName = org.display_name || org.name;
		showOrgSelectDialog = false;
	}

	async function assignRole() {
		if (!canManageRoles || !selectedRoleId) return;
		if (selectedScope === 'org' && !selectedOrgId) {
			rolesError = $LL.admin_user_detail_error_select_org();
			return;
		}
		if (selectedScope === 'org' && selectedOrgId && !isValidUUID(selectedOrgId)) {
			rolesError = $LL.admin_user_detail_error_invalid_org();
			return;
		}

		assignLoading = true;
		rolesError = '';

		try {
			await adminRolesAPI.assignRole(userId, {
				role_id: selectedRoleId,
				scope: selectedScope,
				scope_target: selectedScope === 'org' ? selectedOrgId! : undefined
			});
			await loadUserRoles();
			closeAssignRoleDialog();
		} catch (err) {
			console.error('Failed to assign role:', err);
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_assign_role();
		} finally {
			assignLoading = false;
		}
	}

	function confirmRemoveRole(role: RoleAssignment) {
		if (!canManageRoles) return;
		roleToRemove = role;
		showRemoveRoleDialog = true;
	}

	function closeRemoveRoleDialog() {
		showRemoveRoleDialog = false;
		roleToRemove = null;
	}

	async function removeRole() {
		if (!canManageRoles || !roleToRemove) return;

		removeRoleLoading = true;
		rolesError = '';

		try {
			await adminRolesAPI.removeRole(userId, roleToRemove.id);
			await loadUserRoles();
			closeRemoveRoleDialog();
		} catch (err) {
			console.error('Failed to remove role:', err);
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_remove_role();
		} finally {
			removeRoleLoading = false;
		}
	}

	function getScopeBadgeClass(scope: ScopeType): string {
		switch (scope) {
			case 'global':
				return 'badge badge-global';
			case 'org':
				return 'badge badge-org';
			case 'resource':
				return 'badge badge-resource';
			default:
				return 'badge badge-neutral';
		}
	}

	function startEditing() {
		if (!canWriteUsers) return;
		resetEditForm();
		isEditing = true;
		actionError = '';
	}

	function cancelEditing() {
		isEditing = false;
		resetEditForm();
		actionError = '';
	}

	async function saveChanges() {
		if (!user || !canWriteUsers) return;

		saving = true;
		actionError = '';

		try {
			await adminUsersAPI.update(userId, editForm);
			user = await adminUsersAPI.get(userId);
			isEditing = false;
		} catch (err) {
			console.error('Failed to update user:', err);
			actionError = err instanceof Error ? err.message : $LL.admin_user_detail_error_update();
		} finally {
			saving = false;
		}
	}

	async function resetTotpCredentials() {
		if (!user || !canWriteUsers || totpResetLoading) return;
		if (!window.confirm($LL.admin_user_detail_totp_reset_confirm())) return;
		actionError = '';
		totpResetLoading = true;
		try {
			await adminUsersAPI.resetTotp(user.id);
			user = await adminUsersAPI.get(user.id);
		} catch (err) {
			actionError = err instanceof Error ? err.message : $LL.admin_user_detail_error_update();
		} finally {
			totpResetLoading = false;
		}
	}

	function openConfirmDialog(
		action: 'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions'
	) {
		if (
			((action === 'suspend' || action === 'lock' || action === 'activate') && !canWriteUsers) ||
			(action === 'delete' && !canDeleteUsers) ||
			(action === 'revoke-sessions' && !canRevokeSessions)
		) {
			return;
		}
		confirmAction = action;
		showConfirmDialog = true;
		actionError = '';
		revokedSessionsCount = null;
	}

	function closeConfirmDialog() {
		showConfirmDialog = false;
		confirmAction = null;
		revokedSessionsCount = null;
	}

	async function executeAction() {
		if (!confirmAction) return;

		confirmLoading = true;
		actionError = '';

		try {
			switch (confirmAction) {
				case 'suspend':
					await adminUsersAPI.suspend(userId);
					break;
				case 'lock':
					await adminUsersAPI.lock(userId);
					break;
				case 'activate':
					await adminUsersAPI.activate(userId);
					break;
				case 'revoke-sessions': {
					const result = await adminSessionsAPI.revokeAllForUser(userId);
					revokedSessionsCount = result.revokedCount ?? 0;
					await loadUserSessions();
					// Don't close dialog immediately - show success message
					confirmLoading = false;
					return;
				}
				case 'delete':
					await adminUsersAPI.delete(userId);
					goto('/admin/users');
					return;
			}
			await loadUser();
			closeConfirmDialog();
		} catch (err) {
			console.error(`Failed to ${confirmAction} user:`, err);
			actionError = err instanceof Error ? err.message : $LL.admin_user_detail_error_update();
		} finally {
			confirmLoading = false;
		}
	}

	function formatTimestamp(timestamp: number | null): string {
		if (timestamp === null) return '-';
		const date = new Date(normalizeTimestampMs(timestamp));
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatDateValue(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return sanitizeText(value);
		return date.toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function formatIsoDateTime(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return sanitizeText(value);
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function relativeTimeFromIso(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return sanitizeText(value);
		const diffMs = Date.now() - date.getTime();
		const absMs = Math.abs(diffMs);
		const minutes = Math.floor(absMs / 60000);
		const hours = Math.floor(absMs / 3600000);
		const days = Math.floor(absMs / 86400000);
		if (minutes < 1) return $LL.admin_sessions_just_now();
		if (hours < 1) return $LL.admin_sessions_minutes_ago({ count: minutes });
		if (days < 1) return $LL.admin_sessions_hours_ago({ count: hours });
		return $LL.admin_sessions_days_ago({ count: days });
	}

	function timeUntilIso(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return sanitizeText(value);
		const diffMs = date.getTime() - Date.now();
		if (diffMs <= 0) return $LL.admin_sessions_expired();
		const minutes = Math.floor(diffMs / 60000);
		const hours = Math.floor(diffMs / 3600000);
		const days = Math.floor(diffMs / 86400000);
		if (hours < 1) return $LL.admin_sessions_minutes({ count: minutes });
		if (days < 1) return $LL.admin_sessions_hours({ count: hours });
		return $LL.admin_sessions_days({ count: days });
	}

	function formatDateInput(value: unknown): string {
		if (typeof value !== 'string' || !value) return '';
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toISOString().slice(0, 10);
	}

	function humanizeFieldName(value: string): string {
		return value
			.replace(/[_./:-]+/g, ' ')
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.trim()
			.replace(/\s+/g, ' ')
			.replace(/\b\w/g, (char) => char.toUpperCase());
	}

	function userSchemaFieldsFor(target: User): UserSchemaField[] {
		const fields = new SvelteMap<string, UserSchemaField>();
		for (const field of target.customFields ?? []) {
			fields.set(field.field_name, {
				key: field.field_name,
				label: humanizeFieldName(field.field_name),
				type: field.field_type,
				value: field.field_value,
				missingRequired: false
			});
		}
		for (const field of target.missing_required_fields ?? []) {
			if (fields.has(field.field_key)) continue;
			fields.set(field.field_key, {
				key: field.field_key,
				label: field.label || humanizeFieldName(field.field_key),
				type: field.field_type,
				value: null,
				missingRequired: true
			});
		}
		return [...fields.values()];
	}

	function fieldValueForForm(field: UserSchemaField): string | boolean | number | null {
		if (field.value === null) return field.type === 'boolean' ? false : '';
		switch (field.type) {
			case 'boolean':
				return field.value === 'true' || field.value === '1';
			case 'number': {
				const parsed = Number(field.value);
				return Number.isFinite(parsed) ? parsed : '';
			}
			case 'date':
				return formatDateInput(field.value);
			default:
				return field.value;
		}
	}

	function formatSchemaFieldValue(field: UserSchemaField): string {
		if (field.value === null || field.value === '') return '-';
		switch (field.type) {
			case 'boolean':
				return formatYesNo(field.value === 'true' || field.value === '1');
			case 'date':
				return formatDateValue(field.value);
			default:
				return sanitizeText(field.value);
		}
	}

	function updateSchemaField(field: UserSchemaField, value: string | boolean | number | null) {
		editForm = {
			...editForm,
			[field.key]: value
		};
	}

	function updateProfileField(
		field:
			| 'name'
			| 'given_name'
			| 'family_name'
			| 'nickname'
			| 'preferred_username'
			| 'phone_number'
			| 'phone_number_verified',
		value: string | boolean
	) {
		editForm = {
			...editForm,
			[field]: value
		};
	}

	function inputTypeForSchemaField(field: UserSchemaField): string {
		switch (field.type) {
			case 'number':
				return 'number';
			case 'date':
				return 'date';
			default:
				return 'text';
		}
	}

	function roleSummary() {
		return userRoles.map((role) => role.role_display_name || role.role_name).filter(Boolean);
	}

	function mfaSummary(target: User): string {
		const count = target.passkeys?.length ?? 0;
		if (count > 0) {
			return getLocale() === 'ja' ? `有効（Passkey ×${count}）` : `Enabled (Passkey x${count})`;
		}
		return getLocale() === 'ja' ? '未設定' : 'Not configured';
	}

	function parseUserAgent(userAgent: string | null): string {
		if (!userAgent) return '-';

		let browser = String($LL.admin_sessions_unknown());
		let os = String($LL.admin_sessions_unknown());

		if (userAgent.includes('Edg')) browser = 'Edge';
		else if (userAgent.includes('Chrome')) browser = 'Chrome';
		else if (userAgent.includes('Firefox')) browser = 'Firefox';
		else if (userAgent.includes('Safari')) browser = 'Safari';

		if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
		else if (userAgent.includes('Windows')) os = 'Windows';
		else if (userAgent.includes('Mac OS')) os = 'macOS';
		else if (userAgent.includes('Linux')) os = 'Linux';
		else if (userAgent.includes('Android')) os = 'Android';

		return `${browser} / ${os}`;
	}

	function passkeySyncLabel(): string {
		return getLocale() === 'ja' ? '同期型' : 'Synced';
	}

	function passkeyProviderIcon(passkey: NonNullable<User['passkeys']>[number]): string | null {
		return passkey.provider?.icon_light ?? passkey.provider?.icon_dark ?? null;
	}

	function fallbackMethodDescription(target: User): string {
		const email = sanitizeText(target.email || '-');
		return getLocale() === 'ja'
			? `${email} 宛のワンタイムコード。Passkey 紛失時のフォールバックです。`
			: `One-time code sent to ${email}. Used as a fallback if passkeys are unavailable.`;
	}

	function auditActionLabel(action: string): string {
		const ja = getLocale() === 'ja';
		switch (action) {
			case 'account.profile.name_updated':
				return ja ? 'アカウントページ: 名前変更' : 'Account Page: Name changed';
			case 'account.passkey.created':
				return ja ? 'アカウントページ: Passkey追加' : 'Account Page: Passkey added';
			case 'account.passkey.updated':
				return ja ? 'アカウントページ: Passkey名変更' : 'Account Page: Passkey renamed';
			case 'account.passkey.deleted':
				return ja ? 'アカウントページ: Passkey削除' : 'Account Page: Passkey deleted';
			case 'account.session.revoked':
				return ja ? 'アカウントページ: セッションログアウト' : 'Account Page: Session logged out';
		}
		return action
			.split('.')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function auditResourceSummary(entry: AuditLogEntry): string {
		const resource = [entry.resourceType, entry.resourceId].filter(Boolean).join(': ');
		const parts = [
			resource,
			entry.ipAddress ? `ip: ${entry.ipAddress}` : '',
			entry.userAgent ? parseUserAgent(entry.userAgent) : ''
		].filter(Boolean);
		return parts.length ? parts.join(' / ') : '-';
	}

	function auditBadgeClass(action: string): string {
		if (action.includes('failed') || action.includes('delete') || action.includes('revoke')) {
			return 'badge badge-danger';
		}
		if (action.includes('login') || action.includes('create') || action.includes('issue')) {
			return 'badge badge-success';
		}
		if (action.includes('update') || action.includes('refresh')) return 'badge badge-info';
		return 'badge badge-neutral';
	}

	function getStatusBadgeClass(status: string): string {
		switch (status) {
			case 'active':
				return 'status-badge status-active';
			case 'suspended':
				return 'status-badge status-suspended';
			case 'locked':
				return 'status-badge status-locked';
			default:
				return 'status-badge';
		}
	}

	// Tab switching - load tab-specific records on first access
	function switchTab(tab: TabId) {
		activeTab = tab;
		if (tab === 'consents' && consentRecords.length === 0 && !consentLoading) {
			loadConsentRecords();
		}
		if (tab === 'sessions' && userSessions.length === 0 && !sessionsLoading) {
			loadUserSessions();
		}
		if (tab === 'audit-logs' && auditEntries.length === 0 && !auditLoading) {
			loadUserAuditLogs();
		}
	}

	async function loadUserSessions() {
		sessionsLoading = true;
		sessionsError = '';
		try {
			const response = await adminSessionsAPI.list({
				page: 1,
				limit: 10,
				user_id: userId,
				status: 'active'
			});
			userSessions = response.sessions;
		} catch (err) {
			console.error('Failed to load user sessions:', err);
			sessionsError = err instanceof Error ? err.message : $LL.admin_sessions_load_failed();
		} finally {
			sessionsLoading = false;
		}
	}

	async function loadUserAuditLogs() {
		auditLoading = true;
		auditError = '';
		try {
			const response = await adminAuditLogsAPI.list({
				page: 1,
				limit: 10,
				user_id: userId
			});
			auditEntries = response.entries;
		} catch (err) {
			console.error('Failed to load user audit logs:', err);
			auditError = err instanceof Error ? err.message : $LL.admin_audit_logs_load_failed();
		} finally {
			auditLoading = false;
		}
	}

	// Consent records loading
	async function loadConsentRecords() {
		consentLoading = true;
		consentError = '';
		try {
			const response = await adminConsentStatementsAPI.listUserConsentRecords(userId);
			consentRecords = response.records || [];
		} catch (err) {
			console.error('Failed to load consent records:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_load_consents();
		} finally {
			consentLoading = false;
		}
	}

	// Consent history loading
	async function loadConsentHistory(statementId: string) {
		historyLoading = true;
		consentError = '';
		try {
			const response = await adminConsentStatementsAPI.getUserConsentHistory(userId, statementId);
			consentHistory = response.history || [];
			showHistoryModal = true;
		} catch (err) {
			console.error('Failed to load consent history:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_load_history();
		} finally {
			historyLoading = false;
		}
	}

	// Withdraw consent
	async function handleWithdrawConsent() {
		if (!canWriteUsers || !statementToWithdraw) return;

		withdrawLoading = true;
		consentError = '';
		try {
			await adminConsentStatementsAPI.withdrawUserConsent(userId, statementToWithdraw.id);
			await loadConsentRecords();
			showWithdrawModal = false;
			statementToWithdraw = null;
		} catch (err) {
			console.error('Failed to withdraw consent:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_withdraw_consent();
		} finally {
			withdrawLoading = false;
		}
	}

	// Consent status badge helpers
	function getConsentStatusBadgeClass(status: string): string {
		switch (status) {
			case 'granted':
				return 'badge badge-success';
			case 'denied':
				return 'badge badge-danger';
			case 'withdrawn':
				return 'badge badge-warning';
			case 'expired':
				return 'badge badge-neutral';
			default:
				return 'badge badge-neutral';
		}
	}

	function getConsentStatusLabel(status: string): string {
		switch (status) {
			case 'granted':
				return $LL.admin_user_detail_status_granted();
			case 'denied':
				return $LL.admin_user_detail_status_denied();
			case 'withdrawn':
				return $LL.admin_user_detail_status_withdrawn();
			case 'expired':
				return $LL.admin_user_detail_status_expired();
			default:
				return status;
		}
	}

	// History action label helper
	function getActionLabel(action: string): string {
		switch (action) {
			case 'grant':
				return $LL.admin_user_detail_status_granted();
			case 'deny':
				return $LL.admin_user_detail_status_denied();
			case 'withdraw':
				return $LL.admin_user_detail_status_withdrawn();
			case 'version_upgrade':
				return $LL.admin_user_detail_action_version_upgraded();
			default:
				return action;
		}
	}

	function getStatusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_users_status_active();
			case 'suspended':
				return $LL.admin_users_status_suspended();
			case 'locked':
				return $LL.admin_users_status_locked();
			default:
				return status;
		}
	}

	function tabLabel(tab: TabId): string {
		switch (tab) {
			case 'overview':
				return $LL.admin_user_detail_tab_overview();
			case 'authentication-methods':
				return $LL.admin_user_detail_tab_authentication_methods();
			case 'sessions':
				return $LL.admin_user_detail_tab_sessions();
			case 'audit-logs':
				return $LL.admin_user_detail_tab_audit_logs();
			case 'roles':
				return $LL.admin_user_detail_tab_roles();
			case 'consents':
				return $LL.admin_user_detail_tab_consents();
			case 'actions':
				return $LL.admin_user_detail_tab_actions();
		}
	}

	function getScopeLabel(scope: ScopeType): string {
		switch (scope) {
			case 'global':
				return $LL.admin_user_detail_scope_global();
			case 'org':
				return $LL.admin_user_detail_scope_org();
			case 'resource':
			default:
				return scope;
		}
	}

	function formatYesNo(value: boolean): string {
		return value ? $LL.admin_user_detail_yes() : $LL.admin_user_detail_no();
	}

	function getConfirmDialogContent() {
		switch (confirmAction) {
			case 'suspend':
				return {
					title: $LL.admin_user_detail_suspend_user(),
					description: $LL.admin_user_detail_suspend_desc(),
					buttonText: $LL.admin_user_detail_suspend_action(),
					buttonColor: 'var(--color-warning)'
				};
			case 'lock':
				return {
					title: $LL.admin_user_detail_lock_account(),
					description: $LL.admin_user_detail_lock_desc(),
					buttonText: $LL.admin_user_detail_lock_action(),
					buttonColor: 'var(--color-danger)'
				};
			case 'activate':
				return {
					title: $LL.admin_user_detail_activate_user(),
					description: $LL.admin_user_detail_activate_desc(),
					buttonText: $LL.admin_user_detail_activate_action(),
					buttonColor: 'var(--color-success)'
				};
			case 'revoke-sessions':
				return {
					title: $LL.admin_user_detail_revoke_all_sessions(),
					description: $LL.admin_user_detail_revoke_sessions_desc(),
					buttonText: $LL.admin_user_detail_revoke_all_action(),
					buttonColor: 'var(--color-danger)'
				};
			case 'delete':
				return {
					title: $LL.admin_user_detail_deleteUser(),
					description: $LL.admin_user_detail_delete_desc(),
					buttonText: $LL.admin_users_delete(),
					buttonColor: 'var(--color-danger)'
				};
			default:
				return { title: '', description: '', buttonText: '', buttonColor: '' };
		}
	}
</script>

<svelte:head>
	<title
		>{user?.email || $LL.admin_user_detail_page_title_fallback()} - Admin Dashboard - Authrim</title
	>
</svelte:head>

<AdminPageShell>
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_user_detail_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if user}
		{#snippet titleAccessory()}
			{#if user}
				<span class={getStatusBadgeClass(user.status)}>{getStatusLabel(user.status)}</span>
			{/if}
		{/snippet}

		<AdminPageHeader
			title={sanitizeText(user.name || user.email || $LL.admin_user_detail_unknown_user())}
			description={sanitizeText(user.email || '')}
			eyebrow={user.id}
			{titleAccessory}
		/>

		{#if actionError}
			<div class="alert alert-error">{actionError}</div>
		{/if}

		<AdminTabs
			items={userTabItems}
			active={activeTab}
			onChange={(tabId) => switchTab(tabId as TabId)}
			ariaLabel={$LL.admin_user_detail_title()}
		/>

		<!-- Overview Tab -->
		{#if activeTab === 'overview'}
			<!-- Account Information -->
			<AdminSection title={$LL.admin_user_detail_account_information()}>
				<dl class="account-info-list">
					<div class="account-info-row">
						<dt>{$LL.admin_users_email()}</dt>
						<dd class="info-value mono">
							{sanitizeText(user.email || '-')}
							{#if user.email_verified}
								<span class="badge badge-success">{$LL.admin_users_verified()}</span>
							{:else}
								<span class="badge badge-neutral">{$LL.admin_users_unverified()}</span>
							{/if}
						</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_user_id()}</dt>
						<dd class="info-value mono">{user.id}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_tenant()}</dt>
						<dd class="info-value mono">{sanitizeText(user.tenant_id || '-')}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_users_status()}</dt>
						<dd class="info-value">
							<span class={getStatusBadgeClass(user.status)}>{getStatusLabel(user.status)}</span>
						</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_user_type()}</dt>
						<dd class="info-value">{sanitizeText(user.user_type || '-')}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_role()}</dt>
						<dd class="info-value role-chip-list">
							{#each roleSummary() as role (role)}
								<span class="badge badge-neutral">{sanitizeText(role)}</span>
							{:else}
								-
							{/each}
						</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_created_at()}</dt>
						<dd class="info-value mono">{formatTimestamp(user.created_at)}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_updated_at()}</dt>
						<dd class="info-value mono">{formatTimestamp(user.updated_at)}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_last_login_at()}</dt>
						<dd class="info-value mono">{formatTimestamp(user.last_login_at)}</dd>
					</div>
					<div class="account-info-row">
						<dt>{$LL.admin_user_detail_mfa()}</dt>
						<dd class="info-value">{mfaSummary(user)}</dd>
					</div>
					{#if user.suspended_at}
						<div class="account-info-row">
							<dt>{$LL.admin_user_detail_suspended_at()}</dt>
							<dd class="info-value warning mono">{formatTimestamp(user.suspended_at)}</dd>
						</div>
					{/if}
					{#if user.locked_at}
						<div class="account-info-row">
							<dt>{$LL.admin_user_detail_locked_at()}</dt>
							<dd class="info-value danger mono">{formatTimestamp(user.locked_at)}</dd>
						</div>
					{/if}
				</dl>
			</AdminSection>

			<!-- User Information -->
			{#snippet userInfoActions()}
				{#if !isEditing && canWriteUsers}
					<button class="btn btn-primary btn-sm" onclick={startEditing}
						>{$LL.admin_users_edit()}</button
					>
				{/if}
			{/snippet}

			<AdminSection title={$LL.admin_user_detail_user_information()} actions={userInfoActions}>
				{@const schemaFields = userSchemaFieldsFor(user)}
				{#if isEditing}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							saveChanges();
						}}
					>
						<div class="profile-form-grid">
							<div class="form-group">
								<label for="profile-name" class="form-label">{$LL.admin_users_name()}</label>
								<input
									id="profile-name"
									type="text"
									class="form-input"
									value={editForm.name ?? ''}
									oninput={(event) => updateProfileField('name', event.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="profile-given-name" class="form-label"
									>{$LL.admin_users_given_name()}</label
								>
								<input
									id="profile-given-name"
									type="text"
									class="form-input"
									value={editForm.given_name ?? ''}
									oninput={(event) => updateProfileField('given_name', event.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="profile-family-name" class="form-label"
									>{$LL.admin_users_family_name()}</label
								>
								<input
									id="profile-family-name"
									type="text"
									class="form-input"
									value={editForm.family_name ?? ''}
									oninput={(event) => updateProfileField('family_name', event.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="profile-nickname" class="form-label"
									>{$LL.admin_user_detail_nickname()}</label
								>
								<input
									id="profile-nickname"
									type="text"
									class="form-input"
									value={editForm.nickname ?? ''}
									oninput={(event) => updateProfileField('nickname', event.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="profile-preferred-username" class="form-label"
									>{$LL.admin_user_detail_preferred_username()}</label
								>
								<input
									id="profile-preferred-username"
									type="text"
									class="form-input"
									value={editForm.preferred_username ?? ''}
									oninput={(event) =>
										updateProfileField('preferred_username', event.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="profile-phone-number" class="form-label"
									>{$LL.admin_user_detail_phone_number()}</label
								>
								<input
									id="profile-phone-number"
									type="tel"
									class="form-input"
									value={editForm.phone_number ?? ''}
									oninput={(event) => updateProfileField('phone_number', event.currentTarget.value)}
								/>
							</div>
							<div class="profile-verification-field">
								<ToggleSwitch
									checked={Boolean(editForm.phone_number_verified)}
									label={$LL.admin_user_detail_phone_verified()}
									description={$LL.admin_user_detail_phone_verified_desc()}
									onchange={(checked) => updateProfileField('phone_number_verified', checked)}
								/>
							</div>
						</div>

						<div class="user-custom-fields">
							<h3 class="user-detail-subheading">{$LL.admin_user_detail_customFields()}</h3>
							{#if schemaFields.length > 0}
								<div class="schema-form-grid">
									{#each schemaFields as field (field.key)}
										<div class="form-group">
											<label for={`schema-${field.key}`} class="form-label">
												{sanitizeText(field.label)}
												{#if field.missingRequired}
													<span class="required-marker">*</span>
												{/if}
											</label>
											{#if field.type === 'boolean'}
												<ToggleSwitch
													checked={Boolean(editForm[field.key])}
													label={sanitizeText(field.label)}
													description={field.key}
													onchange={(checked) => updateSchemaField(field, checked)}
												/>
											{:else}
												<input
													id={`schema-${field.key}`}
													type={inputTypeForSchemaField(field)}
													class="form-input"
													value={field.type === 'date'
														? formatDateInput(editForm[field.key])
														: (editForm[field.key] ?? '')}
													oninput={(event) => {
														const value = event.currentTarget.value;
														updateSchemaField(
															field,
															field.type === 'number'
																? value === ''
																	? null
																	: Number(value)
																: value
														);
													}}
												/>
											{/if}
											<p class="field-key-hint">{field.key}</p>
										</div>
									{/each}
								</div>
							{:else}
								<div class="empty-state">
									<p class="empty-state-description">
										{$LL.admin_user_detail_no_user_information_fields()}
									</p>
								</div>
							{/if}
						</div>
						<div class="action-buttons user-detail-form-actions">
							<button type="submit" class="btn btn-primary" disabled={saving}>
								{saving ? $LL.admin_client_detail_saving() : $LL.admin_user_detail_save()}
							</button>
							<button
								type="button"
								class="btn btn-secondary"
								onclick={cancelEditing}
								disabled={saving}
							>
								{$LL.dialog_cancel()}
							</button>
						</div>
					</form>
				{:else}
					<dl class="profile-info-grid">
						<div class="info-item">
							<dt>{$LL.admin_users_name()}</dt>
							<dd class="info-value">{sanitizeText(user.name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_given_name()}</dt>
							<dd class="info-value">{sanitizeText(user.given_name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_family_name()}</dt>
							<dd class="info-value">{sanitizeText(user.family_name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_nickname()}</dt>
							<dd class="info-value">{sanitizeText(user.nickname || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_preferred_username()}</dt>
							<dd class="info-value">{sanitizeText(user.preferred_username || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_phone_number()}</dt>
							<dd class="info-value mono">{sanitizeText(user.phone_number || '-')}</dd>
						</div>
					</dl>

					<div class="user-custom-fields">
						<h3 class="user-detail-subheading">{$LL.admin_user_detail_customFields()}</h3>
						{#if schemaFields.length > 0}
							<dl class="schema-info-grid">
								{#each schemaFields as field (field.key)}
									<div class="info-item">
										<dt>
											{sanitizeText(field.label)}
											{#if field.missingRequired}
												<span class="required-marker">*</span>
											{/if}
										</dt>
										<dd class="info-value" class:mono={field.type !== 'boolean'}>
											{formatSchemaFieldValue(field)}
										</dd>
									</div>
								{/each}
							</dl>
						{:else}
							<div class="empty-state">
								<p class="empty-state-description">
									{$LL.admin_user_detail_no_user_information_fields()}
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</AdminSection>
		{/if}

		<!-- Authentication Methods Tab -->
		{#if activeTab === 'authentication-methods'}
			<AdminSection title={$LL.admin_user_detail_passkeys()}>
				{#if user.passkeys && user.passkeys.length > 0}
					<AdminDataTable width="wide">
						<thead>
							<tr>
								<th>{$LL.admin_user_detail_auth_method_name()}</th>
								<th>{$LL.admin_user_detail_auth_method_type()}</th>
								<th>{$LL.admin_user_detail_created_at()}</th>
								<th>{$LL.admin_user_detail_last_used()}</th>
								<th>{$LL.admin_users_status()}</th>
							</tr>
						</thead>
						<tbody>
							{#each user.passkeys as passkey (passkey.id)}
								<tr>
									<td>
										<div class="cell-primary">
											{sanitizeText(passkey.device_name || $LL.admin_user_detail_unnamed_device())}
										</div>
										{#if passkey.provider?.name || passkey.aaguid}
											<div class="passkey-provider">
												{#if passkeyProviderIcon(passkey)}
													<img src={passkeyProviderIcon(passkey) ?? ''} alt="" loading="lazy" />
												{/if}
												<span>{sanitizeText(passkey.provider?.name ?? passkey.aaguid ?? '-')}</span>
											</div>
										{/if}
										<div class="cell-secondary mono">{passkey.id}</div>
									</td>
									<td class="muted">Passkey / WebAuthn</td>
									<td class="muted nowrap">{formatTimestamp(passkey.created_at)}</td>
									<td class="muted nowrap">{formatTimestamp(passkey.last_used_at)}</td>
									<td><span class="badge badge-success">{passkeySyncLabel()}</span></td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_passkeys()}</p>
					</div>
				{/if}
			</AdminSection>

			<AdminSection title={$LL.admin_user_detail_totp()}>
				{#snippet actions()}
					<button
						class="btn btn-danger btn-sm"
						disabled={!canWriteUsers || totpResetLoading || !(user?.totp_credentials?.length ?? 0)}
						onclick={resetTotpCredentials}
					>
						{totpResetLoading
							? $LL.admin_user_detail_totp_resetting()
							: $LL.admin_user_detail_totp_reset()}
					</button>
				{/snippet}
				{#if user.totp_credentials && user.totp_credentials.length > 0}
					<AdminDataTable width="wide">
						<thead>
							<tr>
								<th>{$LL.admin_user_detail_auth_method_name()}</th>
								<th>{$LL.admin_user_detail_auth_method_type()}</th>
								<th>{$LL.admin_user_detail_created_at()}</th>
								<th>{$LL.admin_user_detail_last_used()}</th>
								<th>{$LL.admin_users_status()}</th>
							</tr>
						</thead>
						<tbody>
							{#each user.totp_credentials as credential (credential.id)}
								<tr>
									<td>
										<div class="cell-primary">
											{sanitizeText(credential.label || $LL.admin_user_detail_totp_unnamed())}
										</div>
										<div class="cell-secondary mono">{credential.id}</div>
									</td>
									<td class="muted">
										TOTP / {credential.algorithm} / {credential.digits} / {credential.period}s
									</td>
									<td class="muted nowrap">{formatTimestamp(credential.created_at)}</td>
									<td class="muted nowrap">{formatTimestamp(credential.last_used_at)}</td>
									<td>
										<span
											class={credential.status === 'active'
												? 'badge badge-success'
												: 'badge badge-neutral'}
										>
											{credential.status}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_totp()}</p>
					</div>
				{/if}
			</AdminSection>

			<AdminSection title={$LL.admin_user_detail_other_auth_methods()}>
				<div class="auth-method-list">
					<div class="auth-method-row">
						<div>
							<p class="auth-method-title">{$LL.admin_user_detail_email_otp()}</p>
							<p class="auth-method-description">{fallbackMethodDescription(user)}</p>
						</div>
						<span class={user.email_verified ? 'badge badge-success' : 'badge badge-neutral'}>
							{user.email_verified
								? $LL.admin_user_detail_available()
								: $LL.admin_user_detail_unavailable()}
						</span>
					</div>
					<div class="auth-method-row">
						<div>
							<p class="auth-method-title">{$LL.admin_user_detail_phone_otp()}</p>
							<p class="auth-method-description">{sanitizeText(user.phone_number || '-')}</p>
						</div>
						<span
							class={user.phone_number_verified ? 'badge badge-success' : 'badge badge-neutral'}
						>
							{user.phone_number_verified
								? $LL.admin_user_detail_available()
								: $LL.admin_user_detail_unavailable()}
						</span>
					</div>
				</div>
			</AdminSection>
		{/if}

		<!-- Sessions Tab -->
		{#if activeTab === 'sessions'}
			{#snippet sessionActions()}
				{#if canRevokeSessions}
					<button
						class="btn btn-danger btn-sm"
						onclick={() => openConfirmDialog('revoke-sessions')}
					>
						{$LL.admin_user_detail_revoke_all_sessions()}
					</button>
				{/if}
			{/snippet}

			<AdminSection title={$LL.admin_user_detail_sessions()} actions={sessionActions}>
				{#if sessionsError}
					<div class="alert alert-error">{sessionsError}</div>
				{/if}

				{#if sessionsLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_sessions_loading()}</p>
					</div>
				{:else if userSessions.length > 0}
					<AdminDataTable width="wide">
						<thead>
							<tr>
								<th>{$LL.admin_sessions_user()}</th>
								<th>{$LL.admin_sessions_device()}</th>
								<th>{$LL.admin_sessions_ip_address()}</th>
								<th>{$LL.admin_sessions_last_access()}</th>
								<th>{$LL.admin_sessions_expires()}</th>
								<th>{$LL.admin_sessions_status()}</th>
							</tr>
						</thead>
						<tbody>
							{#each userSessions as session (session.id)}
								<tr>
									<td>
										<div class="cell-primary mono">{session.id}</div>
										<div class="cell-secondary">{sanitizeText(session.user_email || '-')}</div>
									</td>
									<td class="muted">{parseUserAgent(session.user_agent)}</td>
									<td class="muted mono">{session.ip_address || '-'}</td>
									<td class="muted nowrap">
										<span title={formatIsoDateTime(session.last_accessed_at)}>
											{relativeTimeFromIso(session.last_accessed_at)}
										</span>
									</td>
									<td class="muted nowrap">
										<span title={formatIsoDateTime(session.expires_at)}>
											{timeUntilIso(session.expires_at)}
										</span>
									</td>
									<td>
										<span class={session.is_active ? 'badge badge-success' : 'badge badge-neutral'}>
											{session.is_active
												? $LL.admin_sessions_active()
												: $LL.admin_sessions_expired()}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_sessions_empty()}</p>
					</div>
				{/if}
			</AdminSection>
		{/if}

		<!-- Audit Logs Tab -->
		{#if activeTab === 'audit-logs'}
			<AdminSection title={$LL.admin_user_detail_user_events()}>
				{#if auditError}
					<div class="alert alert-error">{auditError}</div>
				{/if}

				{#if auditLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_audit_logs_loading()}</p>
					</div>
				{:else if auditEntries.length > 0}
					<div class="user-audit-list">
						{#each auditEntries as entry (entry.id)}
							<div class="user-audit-row">
								<span class="user-audit-time">{formatIsoDateTime(entry.createdAt)}</span>
								<div class="user-audit-detail">
									<span class="user-detail-strong">{auditActionLabel(entry.action)}</span>
									<span class="muted"> - {auditResourceSummary(entry)}</span>
								</div>
								<span class={auditBadgeClass(entry.action)}>{entry.action}</span>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_audit_logs_empty()}</p>
					</div>
				{/if}
			</AdminSection>
		{/if}

		<!-- Roles Tab -->
		{#if activeTab === 'roles'}
			<!-- Role Assignments -->
			{#snippet roleActions()}
				{#if canManageRoles}
					<button class="btn btn-primary btn-sm" onclick={openAssignRoleDialog}
						>{$LL.admin_user_detail_assign_role()}</button
					>
				{/if}
			{/snippet}

			<AdminSection title={$LL.admin_user_detail_role_assignments()} actions={roleActions}>
				{#if rolesError}
					<div class="alert alert-error">{rolesError}</div>
				{/if}

				{#if rolesLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_user_detail_loading_roles()}</p>
					</div>
				{:else if userRoles.length > 0}
					<AdminDataTable width="wide">
						<thead>
							<tr>
								<th>{$LL.admin_user_detail_role()}</th>
								<th>{$LL.admin_user_detail_scope()}</th>
								<th>{$LL.admin_user_detail_scope_target()}</th>
								<th>{$LL.admin_user_detail_expires()}</th>
								<th class="text-right">{$LL.admin_users_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each userRoles as role (role.id)}
								<tr>
									<td>
										<span class="user-detail-strong">
											{role.role_display_name || role.role_name}
										</span>
										{#if role.is_system_role}
											<span class="badge-system">{$LL.admin_user_detail_system()}</span>
										{/if}
									</td>
									<td>
										<span class={getScopeBadgeClass(role.scope)}>{getScopeLabel(role.scope)}</span>
									</td>
									<td class="muted">{role.scope_target || '-'}</td>
									<td class="muted"
										>{role.expires_at
											? formatTimestamp(role.expires_at)
											: $LL.admin_user_detail_never()}</td
									>
									<td class="text-right">
										{#if canManageRoles}
											<button class="btn btn-danger btn-sm" onclick={() => confirmRemoveRole(role)}>
												{$LL.admin_user_detail_remove()}
											</button>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_roles()}</p>
					</div>
				{/if}
			</AdminSection>
		{/if}

		<!-- Consents Tab -->
		{#if activeTab === 'consents'}
			<AdminSection title={$LL.admin_user_detail_consent_records()}>
				{#if consentError}
					<div class="alert alert-error">{consentError}</div>
				{/if}

				{#if consentLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_user_detail_loading_consent_records()}</p>
					</div>
				{:else if consentRecords.length > 0}
					<AdminDataTable width="xwide">
						<thead>
							<tr>
								<th>{$LL.admin_user_detail_statement()}</th>
								<th>{$LL.admin_user_detail_version()}</th>
								<th>{$LL.admin_users_status()}</th>
								<th>{$LL.admin_user_detail_granted_at()}</th>
								<th>{$LL.admin_user_detail_withdrawn_at()}</th>
								<th>{$LL.admin_user_detail_expires_at()}</th>
								<th class="text-right">{$LL.admin_users_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each consentRecords as record (record.id)}
								<tr>
									<td><span class="user-detail-strong">{record.statement_id}</span></td>
									<td class="muted">{record.version}</td>
									<td>
										<span class={getConsentStatusBadgeClass(record.status)}>
											{getConsentStatusLabel(record.status)}
										</span>
									</td>
									<td class="muted">{formatTimestamp(record.granted_at ?? null)}</td>
									<td class="muted">{formatTimestamp(record.withdrawn_at ?? null)}</td>
									<td class="muted">{formatTimestamp(record.expires_at ?? null)}</td>
									<td class="text-right">
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => {
												selectedStatementForHistory = record.statement_id;
												loadConsentHistory(record.statement_id);
											}}
										>
											{$LL.admin_user_detail_history()}
										</button>
										{#if canWriteUsers && record.status === 'granted'}
											<button
												class="btn btn-danger btn-sm"
												onclick={() => {
													statementToWithdraw = {
														id: record.statement_id,
														version: record.version
													};
													showWithdrawModal = true;
												}}
											>
												{$LL.admin_user_detail_withdraw()}
											</button>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_consent_records()}</p>
					</div>
				{/if}
			</AdminSection>
		{/if}

		<!-- Actions Tab -->
		{#if activeTab === 'actions'}
			<AdminSection title={$LL.admin_user_detail_tab_actions()}>
				<div class="action-buttons">
					{#if canWriteUsers && user.status === 'active'}
						<button class="btn btn-warning" onclick={() => openConfirmDialog('suspend')}>
							{$LL.admin_user_detail_suspend_user()}
						</button>
						<button class="btn btn-danger" onclick={() => openConfirmDialog('lock')}>
							{$LL.admin_user_detail_lock_account()}
						</button>
					{:else if canWriteUsers && (user.status === 'suspended' || user.status === 'locked')}
						<button class="btn btn-success" onclick={() => openConfirmDialog('activate')}>
							{$LL.admin_user_detail_activate_user()}
						</button>
					{/if}
					{#if canRevokeSessions}
						<button class="btn btn-purple" onclick={() => openConfirmDialog('revoke-sessions')}>
							{$LL.admin_user_detail_revoke_all_sessions()}
						</button>
					{/if}
					{#if canDeleteUsers}
						<button class="btn btn-danger" onclick={() => openConfirmDialog('delete')}>
							{$LL.admin_user_detail_deleteUser()}
						</button>
					{/if}
				</div>
			</AdminSection>
		{/if}
	{/if}
</AdminPageShell>

<!-- Confirmation Dialog -->
{#if showConfirmDialog}
	{@const dialogContent = getConfirmDialogContent()}
	<Modal
		open={showConfirmDialog}
		onClose={closeConfirmDialog}
		title={revokedSessionsCount !== null
			? $LL.admin_user_detail_sessions_revoked()
			: dialogContent.title}
		size="sm"
	>
		{#if revokedSessionsCount !== null}
			<!-- Success message for revoke-sessions -->
			<div class="alert alert-success">
				{$LL.admin_user_detail_sessions_revoked_message({
					count: revokedSessionsCount,
					plural: revokedSessionsCount === 1 ? '' : 's'
				})}
				{#if revokedSessionsCount > 0}
					{$LL.admin_user_detail_sessions_expire_naturally()}
				{/if}
			</div>
		{:else}
			<p class="modal-description">{dialogContent.description}</p>
		{/if}
		{#snippet footer()}
			{#if revokedSessionsCount !== null}
				<button class="btn btn-primary" onclick={closeConfirmDialog}>{$LL.dialog_close()}</button>
			{:else}
				<button class="btn btn-secondary" onclick={closeConfirmDialog} disabled={confirmLoading}>
					{$LL.dialog_cancel()}
				</button>
				<button
					class="btn {confirmAction === 'activate'
						? 'btn-success'
						: confirmAction === 'suspend'
							? 'btn-warning'
							: 'btn-danger'}"
					onclick={executeAction}
					disabled={confirmLoading}
				>
					{confirmLoading ? $LL.admin_user_detail_processing() : dialogContent.buttonText}
				</button>
			{/if}
		{/snippet}
	</Modal>
{/if}

<!-- Assign Role Dialog -->
<Modal
	open={showAssignRoleDialog}
	onClose={closeAssignRoleDialog}
	title={$LL.admin_user_detail_assign_role()}
	size="md"
>
	{#if rolesError}
		<div class="alert alert-error">{rolesError}</div>
	{/if}

	{#if assignStep === 'select-role'}
		<!-- Step 1: Select Role -->
		<p class="step-indicator">{$LL.admin_user_detail_assign_step_role()}</p>
		<div class="form-group">
			<label for="role-select" class="form-label">{$LL.admin_user_detail_select_role_label()}</label
			>
			<select id="role-select" class="form-select" bind:value={selectedRoleId}>
				<option value="">{$LL.admin_user_detail_select_role_placeholder()}</option>
				{#each availableRoles as role (role.id)}
					<option value={role.id}>
						{role.display_name || role.name}
						{role.is_system ? `(${$LL.admin_user_detail_system()})` : ''}
					</option>
				{/each}
			</select>
		</div>
	{:else}
		<!-- Step 2: Select Scope -->
		<p class="step-indicator">{$LL.admin_user_detail_assign_step_scope()}</p>
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="form-label">{$LL.admin_user_detail_scope_label()}</label>
			<div class="scope-options">
				<label class="scope-option" class:selected={selectedScope === 'global'}>
					<input type="radio" value="global" bind:group={selectedScope} />
					<div class="scope-option-content">
						<span>{$LL.admin_user_detail_scope_global()}</span>
						<p>{$LL.admin_user_detail_scope_global_desc()}</p>
					</div>
				</label>
				<label class="scope-option" class:selected={selectedScope === 'org'}>
					<input type="radio" value="org" bind:group={selectedScope} />
					<div class="scope-option-content">
						<span>{$LL.admin_user_detail_scope_org()}</span>
						<p>{$LL.admin_user_detail_scope_org_desc()}</p>
					</div>
				</label>
			</div>
		</div>

		{#if selectedScope === 'org'}
			<div class="form-group">
				<!-- svelte-ignore a11y_label_has_associated_control -->
				<label class="form-label">{$LL.admin_user_detail_select_organization()}</label>
				<div class="org-selector">
					{#if selectedOrgName}
						<span class="org-selector-name">{selectedOrgName}</span>
					{:else}
						<span class="org-selector-placeholder">
							{$LL.admin_user_detail_no_organization_selected()}
						</span>
					{/if}
					<button class="btn btn-primary btn-sm" onclick={openOrgSelectDialog}>
						{selectedOrgId ? $LL.admin_user_detail_change() : $LL.admin_user_detail_select()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
	{#snippet footer()}
		{#if assignStep === 'select-role'}
			<button class="btn btn-secondary" onclick={closeAssignRoleDialog}
				>{$LL.dialog_cancel()}</button
			>
			<button class="btn btn-primary" onclick={goToScopeStep} disabled={!selectedRoleId}>
				{$LL.common_next()}
			</button>
		{:else}
			<button class="btn btn-secondary" onclick={goBackToRoleStep} disabled={assignLoading}>
				{$LL.common_previous()}
			</button>
			<button
				class="btn btn-success"
				onclick={assignRole}
				disabled={assignLoading || (selectedScope === 'org' && !selectedOrgId)}
			>
				{assignLoading ? $LL.admin_user_detail_assigning() : $LL.admin_user_detail_assign_role()}
			</button>
		{/if}
	{/snippet}
</Modal>

<!-- Remove Role Confirmation Dialog -->
<Modal
	open={showRemoveRoleDialog && !!roleToRemove}
	onClose={closeRemoveRoleDialog}
	title={$LL.admin_user_detail_remove_role_title()}
	size="sm"
>
	<p class="modal-description">
		{$LL.admin_user_detail_remove_role_desc({
			role: sanitizeText(roleToRemove?.role_display_name || roleToRemove?.role_name || ''),
			scope:
				roleToRemove?.scope !== 'global'
					? $LL.admin_user_detail_remove_role_scope({
							scope: sanitizeText(roleToRemove?.scope_target || '')
						})
					: ''
		})}
	</p>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRemoveRoleDialog} disabled={removeRoleLoading}>
			{$LL.dialog_cancel()}
		</button>
		<button class="btn btn-danger" onclick={removeRole} disabled={removeRoleLoading}>
			{removeRoleLoading
				? $LL.admin_user_detail_removing()
				: $LL.admin_user_detail_remove_role_title()}
		</button>
	{/snippet}
</Modal>

<!-- Organization Select Dialog -->
<OrganizationSelectDialog
	open={showOrgSelectDialog}
	onClose={() => (showOrgSelectDialog = false)}
	onSelect={handleOrgSelect}
	title={$LL.admin_user_detail_select_org_title()}
/>

<!-- Consent History Modal -->
<Modal
	open={showHistoryModal}
	onClose={() => {
		showHistoryModal = false;
		selectedStatementForHistory = null;
		consentHistory = [];
	}}
	title={$LL.admin_user_detail_consent_history()}
	size="lg"
>
	{#if historyLoading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_user_detail_loading_history()}</p>
		</div>
	{:else if consentHistory.length > 0}
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_user_detail_action()}</th>
					<th>{$LL.admin_user_detail_version()}</th>
					<th>{$LL.admin_user_detail_status_change()}</th>
					<th>{$LL.admin_user_detail_timestamp()}</th>
					<th>{$LL.admin_user_detail_client()}</th>
				</tr>
			</thead>
			<tbody>
				{#each consentHistory as item (item.id)}
					<tr>
						<td><span class="user-detail-strong">{getActionLabel(item.action)}</span></td>
						<td class="muted">
							{#if item.version_before !== item.version_after}
								{item.version_before || '-'} → {item.version_after || '-'}
							{:else}
								{item.version_after || '-'}
							{/if}
						</td>
						<td class="muted">
							{#if item.status_before !== item.status_after}
								{item.status_before || '-'} → {item.status_after || '-'}
							{:else}
								{item.status_after || '-'}
							{/if}
						</td>
						<td class="muted">{formatTimestamp(item.created_at)}</td>
						<td class="muted">{item.client_id || '-'}</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	{:else}
		<div class="empty-state">
			<p class="empty-state-description">{$LL.admin_user_detail_no_history()}</p>
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showHistoryModal = false;
				selectedStatementForHistory = null;
				consentHistory = [];
			}}
		>
			{$LL.dialog_close()}
		</button>
	{/snippet}
</Modal>

<!-- Withdraw Consent Confirmation Modal -->
<Modal
	open={showWithdrawModal}
	onClose={() => {
		showWithdrawModal = false;
		statementToWithdraw = null;
	}}
	title={$LL.admin_user_detail_withdraw_consent_title()}
	size="sm"
>
	<p class="modal-description">
		{$LL.admin_user_detail_withdraw_consent_desc({
			statement: statementToWithdraw?.id ?? '',
			version: statementToWithdraw?.version ?? ''
		})}
	</p>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showWithdrawModal = false;
				statementToWithdraw = null;
			}}
			disabled={withdrawLoading || !canWriteUsers}
		>
			{$LL.dialog_cancel()}
		</button>
		<button
			class="btn btn-danger"
			onclick={handleWithdrawConsent}
			disabled={withdrawLoading || !canWriteUsers}
		>
			{withdrawLoading
				? $LL.admin_user_detail_withdrawing()
				: $LL.admin_user_detail_withdraw_consent_title()}
		</button>
	{/snippet}
</Modal>

<style>
	.account-info-list,
	.schema-info-grid {
		margin: 0;
	}

	.account-info-list {
		border-top: var(--user-detail-rule-strong, 1px solid var(--color-border-strong));
	}

	.account-info-row {
		display: grid;
		grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
		gap: 18px;
		align-items: baseline;
		padding: 11px 4px;
		border-bottom: 1px solid var(--color-border);
	}

	.account-info-row dt,
	.schema-info-grid dt {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.12em);
		text-transform: uppercase;
	}

	.account-info-row dd,
	.profile-info-grid dd,
	.schema-info-grid dd {
		margin: 0;
	}

	.role-chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.auth-method-list {
		display: grid;
		gap: 10px;
	}

	.auth-method-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		padding: 14px 4px;
		border-bottom: 1px solid var(--color-border);
	}

	.auth-method-row:last-child {
		border-bottom: none;
	}

	.auth-method-title {
		margin: 0;
		color: var(--color-text);
		font-weight: 650;
	}

	.auth-method-description {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
	}

	.user-audit-list {
		border-top: var(--user-detail-rule-strong, 1px solid var(--color-border-strong));
	}

	.user-audit-row {
		display: grid;
		grid-template-columns: minmax(150px, 210px) minmax(0, 1fr) auto;
		gap: 16px;
		align-items: center;
		padding: 13px 4px;
		border-bottom: 1px solid var(--color-border);
	}

	.user-audit-time {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-mono, monospace));
		font-size: 0.78rem;
	}

	.user-audit-detail {
		min-width: 0;
		word-break: break-word;
	}

	.profile-info-grid,
	.profile-form-grid,
	.schema-info-grid,
	.schema-form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px 44px;
	}

	.profile-info-grid {
		margin: 0;
	}

	.profile-info-grid .info-item,
	.schema-info-grid .info-item {
		min-width: 0;
	}

	.profile-info-grid dt,
	.schema-info-grid dt {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: var(--field-label-size, 0.68rem);
		font-weight: 700;
		letter-spacing: var(--field-label-letter-spacing, 0.12em);
		text-transform: uppercase;
	}

	.profile-info-grid .info-value,
	.schema-info-grid .info-value {
		margin-top: 8px;
		word-break: break-word;
	}

	.user-custom-fields {
		margin-top: 28px;
		padding-top: 22px;
		border-top: 1px solid var(--color-border);
	}

	.user-detail-subheading {
		margin: 0 0 16px;
		color: var(--color-text);
		font-size: 0.9rem;
		font-weight: 650;
	}

	.profile-verification-field {
		display: flex;
		align-items: flex-end;
	}

	.required-marker {
		margin-left: 6px;
		color: var(--color-danger);
	}

	.field-key-hint {
		margin: 6px 0 0;
		color: var(--color-text-subtle);
		font-family: var(--font-meta, var(--font-mono, monospace));
		font-size: 0.72rem;
	}

	.passkey-provider {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.passkey-provider img {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		object-fit: contain;
	}

	.user-detail-form-actions {
		margin-top: 20px;
	}

	.user-detail-strong {
		font-weight: 600;
		color: var(--color-text);
	}

	@media (max-width: 760px) {
		.account-info-row,
		.user-audit-row,
		.profile-info-grid,
		.profile-form-grid,
		.schema-info-grid,
		.schema-form-grid {
			grid-template-columns: 1fr;
		}

		.auth-method-row {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
