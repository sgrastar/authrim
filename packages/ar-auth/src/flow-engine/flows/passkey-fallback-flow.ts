/**
 * Passkey Authentication with Fallback (5-way Decision Branching)
 *
 * このフローは、Passkey認証結果に基づいて5つの分岐を実装します：
 * 1. 認証成功 → ログイン完了
 * 2. Passkey未登録 → Passkey登録画面
 * 3. デバイス非対応 → パスワードログインへフォールバック
 * 4. ユーザーキャンセル → 再試行 or パスワードログイン
 * 5. その他エラー → エラー画面
 *
 * @see /private/docs/flow-engine-decision-guide.md
 */

import type { GraphDefinition } from '../types.js';

export const passkeyFallbackFlow: GraphDefinition = {
	id: 'passkey-fallback-flow-v1',
	flowVersion: '1.0.0',
	name: 'Passkey Authentication with Fallback',
	description: 'Passkey auth flow with 5-way decision branching for error handling and fallback',
	profileId: 'core.human-basic-login' as any,
	nodes: [
		{
			id: 'start',
			type: 'start',
			position: { x: 50, y: 300 },
			data: {
				label: 'Start',
				intent: 'core.flow_start' as any,
				capabilities: [],
				config: {},
			},
		},
		{
			id: 'identifier_input',
			type: 'identifier',
			position: { x: 200, y: 300 },
			data: {
				label: 'Enter Email',
				intent: 'core.identifier_input' as any,
				capabilities: [],
				config: {
					type: 'email',
				},
			},
		},
		{
			id: 'passkey_auth',
			type: 'passkey_auth' as any,
			position: { x: 350, y: 300 },
			data: {
				label: 'Passkey Authentication',
				intent: 'core.passkey_authenticate' as any,
				capabilities: [],
				config: {
					mode: 'authenticate',
				},
			},
		},
		{
			id: 'decision_passkey_result',
			type: 'decision',
			position: { x: 550, y: 300 },
			data: {
				label: 'Passkey Result',
				intent: 'core.decision' as any,
				capabilities: [],
				config: {
					branches: [
						{
							id: 'branch_success',
							label: 'Success',
							condition: {
								key: 'prevNode.success',
								operator: 'isTrue',
							},
							priority: 1,
						},
						{
							id: 'branch_not_registered',
							label: 'Not Registered',
							condition: {
								key: 'prevNode.errorCode',
								operator: 'equals',
								value: 'PASSKEY_NOT_REGISTERED',
							},
							priority: 2,
						},
						{
							id: 'branch_device_not_supported',
							label: 'Device Not Supported',
							condition: {
								key: 'prevNode.errorCode',
								operator: 'in',
								value: ['DEVICE_NOT_SUPPORTED', 'BROWSER_NOT_SUPPORTED'],
							},
							priority: 3,
						},
						{
							id: 'branch_user_cancelled',
							label: 'User Cancelled',
							condition: {
								key: 'prevNode.errorCode',
								operator: 'equals',
								value: 'USER_CANCELLED',
							},
							priority: 4,
						},
						{
							id: 'branch_error',
							label: 'Other Error',
							condition: {
								key: 'prevNode.success',
								operator: 'isFalse',
							},
							priority: 5,
						},
					],
					defaultBranch: 'branch_default',
				} as any,
			},
		},
		// Branch 1: Success → Login Complete
		{
			id: 'auth_success',
			type: 'end',
			position: { x: 800, y: 50 },
			data: {
				label: 'Login Success',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					method: 'passkey',
				},
			},
		},
		// Branch 2: Not Registered → Passkey Registration
		{
			id: 'passkey_register_prompt',
			type: 'information',
			position: { x: 800, y: 150 },
			data: {
				label: 'Register Passkey',
				intent: 'core.display_info' as any,
				capabilities: [],
				config: {
					message: 'No passkey found for this account. Would you like to register one?',
					severity: 'info',
				},
			},
		},
		{
			id: 'passkey_register',
			type: 'passkey_auth' as any,
			position: { x: 1000, y: 150 },
			data: {
				label: 'Register Passkey',
				intent: 'core.passkey_register' as any,
				capabilities: [],
				config: {
					mode: 'register',
				},
			},
		},
		{
			id: 'register_success',
			type: 'end',
			position: { x: 1200, y: 150 },
			data: {
				label: 'Passkey Registered',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					method: 'passkey',
					passkey_registered: true,
				},
			},
		},
		// Branch 3: Device Not Supported → Password Login Fallback
		{
			id: 'device_not_supported_info',
			type: 'information',
			position: { x: 800, y: 250 },
			data: {
				label: 'Passkey Not Available',
				intent: 'core.display_info' as any,
				capabilities: [],
				config: {
					message: 'Your device does not support passkeys. Please use password login.',
					severity: 'warning',
				},
			},
		},
		{
			id: 'password_fallback',
			type: 'login',
			position: { x: 1000, y: 250 },
			data: {
				label: 'Password Login',
				intent: 'core.authenticate' as any,
				capabilities: [],
				config: {
					methods: ['password'],
				},
			},
		},
		{
			id: 'password_success',
			type: 'end',
			position: { x: 1200, y: 250 },
			data: {
				label: 'Login Success (Password)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					method: 'password',
					passkey_fallback: true,
				},
			},
		},
		// Branch 4: User Cancelled → Retry or Password
		{
			id: 'user_cancelled_prompt',
			type: 'information',
			position: { x: 800, y: 450 },
			data: {
				label: 'Passkey Cancelled',
				intent: 'core.display_info' as any,
				capabilities: [],
				config: {
					message: 'Passkey authentication was cancelled. Please try again or use password.',
					severity: 'info',
				},
			},
		},
		{
			id: 'cancelled_password_login',
			type: 'login',
			position: { x: 1000, y: 450 },
			data: {
				label: 'Password Login',
				intent: 'core.authenticate' as any,
				capabilities: [],
				config: {
					methods: ['password'],
				},
			},
		},
		{
			id: 'cancelled_success',
			type: 'end',
			position: { x: 1200, y: 450 },
			data: {
				label: 'Login Success',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					method: 'password',
				},
			},
		},
		// Branch 5: Other Error → Error Screen
		{
			id: 'passkey_error',
			type: 'error',
			position: { x: 800, y: 550 },
			data: {
				label: 'Passkey Error',
				intent: 'core.error' as any,
				capabilities: [],
				config: {
					reason: 'passkey_auth_failed',
					allow_retry: true,
				},
			},
		},
		// Default Branch
		{
			id: 'default_error',
			type: 'error',
			position: { x: 800, y: 650 },
			data: {
				label: 'Unexpected Error',
				intent: 'core.error' as any,
				capabilities: [],
				config: {
					reason: 'unexpected_passkey_error',
					allow_retry: false,
				},
			},
		},
	],
	edges: [
		{
			id: 'e1',
			source: 'start',
			target: 'identifier_input',
			type: 'success',
		},
		{
			id: 'e2',
			source: 'identifier_input',
			target: 'passkey_auth',
			type: 'success',
		},
		{
			id: 'e3',
			source: 'passkey_auth',
			target: 'decision_passkey_result',
			type: 'success',
		},
		// Decision branches
		{
			id: 'e4',
			source: 'decision_passkey_result',
			target: 'auth_success',
			sourceHandle: 'branch_success',
			type: 'conditional',
			data: {
				label: 'Success',
			},
		},
		{
			id: 'e5',
			source: 'decision_passkey_result',
			target: 'passkey_register_prompt',
			sourceHandle: 'branch_not_registered',
			type: 'conditional',
			data: {
				label: 'Not Registered',
			},
		},
		{
			id: 'e6',
			source: 'decision_passkey_result',
			target: 'device_not_supported_info',
			sourceHandle: 'branch_device_not_supported',
			type: 'conditional',
			data: {
				label: 'Device Not Supported',
			},
		},
		{
			id: 'e7',
			source: 'decision_passkey_result',
			target: 'user_cancelled_prompt',
			sourceHandle: 'branch_user_cancelled',
			type: 'conditional',
			data: {
				label: 'User Cancelled',
			},
		},
		{
			id: 'e8',
			source: 'decision_passkey_result',
			target: 'passkey_error',
			sourceHandle: 'branch_error',
			type: 'conditional',
			data: {
				label: 'Other Error',
			},
		},
		{
			id: 'e9',
			source: 'decision_passkey_result',
			target: 'default_error',
			sourceHandle: 'branch_default',
			type: 'conditional',
			data: {
				label: 'Default',
			},
		},
		// Not Registered path
		{
			id: 'e10',
			source: 'passkey_register_prompt',
			target: 'passkey_register',
			type: 'success',
		},
		{
			id: 'e11',
			source: 'passkey_register',
			target: 'register_success',
			type: 'success',
		},
		// Device Not Supported path
		{
			id: 'e12',
			source: 'device_not_supported_info',
			target: 'password_fallback',
			type: 'success',
		},
		{
			id: 'e13',
			source: 'password_fallback',
			target: 'password_success',
			type: 'success',
		},
		// User Cancelled path
		{
			id: 'e14',
			source: 'user_cancelled_prompt',
			target: 'cancelled_password_login',
			type: 'success',
		},
		{
			id: 'e15',
			source: 'cancelled_password_login',
			target: 'cancelled_success',
			type: 'success',
		},
	],
	metadata: {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		createdBy: 'system',
	},
};
