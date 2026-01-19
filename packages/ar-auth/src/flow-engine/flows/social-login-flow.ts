/**
 * Social Login Flow with Decision Node (4-way branching)
 *
 * このフローは、ソーシャルログイン結果に基づいて4つの分岐を実装します：
 * 1. UID一致 → ログイン成功
 * 2. UID不一致 + メール一致 → アカウント紐付け確認
 * 3. 新規ユーザー → 新規登録フロー
 * 4. エラー → エラー画面
 *
 * @see /private/docs/flow-engine-decision-guide.md
 */

import type { GraphDefinition } from '../types.js';

export const socialLoginFlow: GraphDefinition = {
	id: 'social-login-flow-v1',
	flowVersion: '1.0.0',
	name: 'Social Login with Decision Branching',
	description: 'Social login flow with 4-way decision branching based on user match results',
	profileId: 'core.human-basic-login' as any,
	nodes: [
		{
			id: 'start',
			type: 'start',
			position: { x: 50, y: 200 },
			data: {
				label: 'Start',
				intent: 'core.flow_start' as any,
				capabilities: [],
				config: {},
			},
		},
		{
			id: 'social_login',
			type: 'login',
			position: { x: 200, y: 200 },
			data: {
				label: 'Social Login',
				intent: 'core.authenticate' as any,
				capabilities: [],
				config: {
					methods: ['google', 'github', 'facebook'],
					social_providers: ['google', 'github', 'facebook'],
				},
			},
		},
		{
			id: 'decision_social_result',
			type: 'decision',
			position: { x: 400, y: 200 },
			data: {
				label: 'Social Login Result',
				intent: 'core.decision' as any,
				capabilities: [],
				config: {
					branches: [
						{
							id: 'branch_uid_match',
							label: 'UID Match',
							condition: {
								logic: 'and',
								conditions: [
									{ key: 'prevNode.success', operator: 'isTrue' },
									{ key: 'prevNode.result.uid_match', operator: 'isTrue' },
								],
							},
							priority: 1,
						},
						{
							id: 'branch_email_match',
							label: 'Email Match',
							condition: {
								logic: 'and',
								conditions: [
									{ key: 'prevNode.success', operator: 'isTrue' },
									{ key: 'prevNode.result.email_match', operator: 'isTrue' },
									{ key: 'prevNode.result.uid_match', operator: 'isFalse' },
								],
							},
							priority: 2,
						},
						{
							id: 'branch_new_user',
							label: 'New User',
							condition: {
								logic: 'and',
								conditions: [
									{ key: 'prevNode.success', operator: 'isTrue' },
									{ key: 'prevNode.result.new_user', operator: 'isTrue' },
								],
							},
							priority: 3,
						},
						{
							id: 'branch_error',
							label: 'Error',
							condition: {
								key: 'prevNode.success',
								operator: 'isFalse',
							},
							priority: 4,
						},
					],
					defaultBranch: 'branch_default',
				} as any,
			},
		},
		// Branch 1: UID Match → Success
		{
			id: 'uid_match_success',
			type: 'end',
			position: { x: 650, y: 50 },
			data: {
				label: 'Login Success',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					reason: 'uid_matched',
				},
			},
		},
		// Branch 2: Email Match → Account Linking Confirmation
		{
			id: 'email_match_confirm',
			type: 'consent',
			position: { x: 650, y: 150 },
			data: {
				label: 'Link Account?',
				intent: 'core.consent' as any,
				capabilities: [],
				config: {
					consents: ['link_social_account'],
					description: 'This social account email matches your existing account. Link them?',
				},
			},
		},
		{
			id: 'link_account',
			type: 'link_account',
			position: { x: 850, y: 150 },
			data: {
				label: 'Link Social Account',
				intent: 'core.link_account' as any,
				capabilities: [],
				config: {},
			},
		},
		{
			id: 'link_success',
			type: 'end',
			position: { x: 1050, y: 150 },
			data: {
				label: 'Linked & Success',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					reason: 'account_linked',
				},
			},
		},
		// Branch 3: New User → Registration
		{
			id: 'new_user_register',
			type: 'register',
			position: { x: 650, y: 250 },
			data: {
				label: 'Register New User',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					require_email_verification: false,
					social_registration: true,
				},
			},
		},
		{
			id: 'register_success',
			type: 'end',
			position: { x: 850, y: 250 },
			data: {
				label: 'Registration Success',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					reason: 'new_user_registered',
				},
			},
		},
		// Branch 4: Error → Error Screen
		{
			id: 'social_error',
			type: 'error',
			position: { x: 650, y: 350 },
			data: {
				label: 'Social Login Error',
				intent: 'core.error' as any,
				capabilities: [],
				config: {
					reason: 'social_login_failed',
					allow_retry: true,
				},
			},
		},
		// Default Branch (should rarely be hit)
		{
			id: 'default_error',
			type: 'error',
			position: { x: 650, y: 450 },
			data: {
				label: 'Unexpected Error',
				intent: 'core.error' as any,
				capabilities: [],
				config: {
					reason: 'unexpected_branch',
					allow_retry: false,
				},
			},
		},
	],
	edges: [
		{
			id: 'e1',
			source: 'start',
			target: 'social_login',
			type: 'success',
		},
		{
			id: 'e2',
			source: 'social_login',
			target: 'decision_social_result',
			type: 'success',
		},
		// Decision branches
		{
			id: 'e3',
			source: 'decision_social_result',
			target: 'uid_match_success',
			sourceHandle: 'branch_uid_match',
			type: 'conditional',
			data: {
				label: 'UID Match',
			},
		},
		{
			id: 'e4',
			source: 'decision_social_result',
			target: 'email_match_confirm',
			sourceHandle: 'branch_email_match',
			type: 'conditional',
			data: {
				label: 'Email Match',
			},
		},
		{
			id: 'e5',
			source: 'decision_social_result',
			target: 'new_user_register',
			sourceHandle: 'branch_new_user',
			type: 'conditional',
			data: {
				label: 'New User',
			},
		},
		{
			id: 'e6',
			source: 'decision_social_result',
			target: 'social_error',
			sourceHandle: 'branch_error',
			type: 'conditional',
			data: {
				label: 'Error',
			},
		},
		{
			id: 'e7',
			source: 'decision_social_result',
			target: 'default_error',
			sourceHandle: 'branch_default',
			type: 'conditional',
			data: {
				label: 'Default',
			},
		},
		// Email match flow
		{
			id: 'e8',
			source: 'email_match_confirm',
			target: 'link_account',
			type: 'success',
		},
		{
			id: 'e9',
			source: 'link_account',
			target: 'link_success',
			type: 'success',
		},
		// New user registration flow
		{
			id: 'e10',
			source: 'new_user_register',
			target: 'register_success',
			type: 'success',
		},
	],
	metadata: {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		createdBy: 'system',
	},
};
