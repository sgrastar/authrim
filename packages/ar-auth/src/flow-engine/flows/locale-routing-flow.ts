/**
 * Locale-Based Routing Flow with Switch Node
 *
 * このフローは、ユーザーのlocale設定に基づいて異なる登録フローにルーティングします：
 * - ja, ja-JP → 日本語登録フロー（追加の日本特有項目収集）
 * - en, en-US, en-GB → 英語登録フロー（標準）
 * - de, de-DE → ドイツ語登録フロー（GDPR同意追加）
 * - zh, zh-CN, zh-TW → 中国語登録フロー
 * - その他 → デフォルト（英語）フロー
 *
 * @see /private/docs/flow-engine-decision-guide.md
 */

import type { GraphDefinition } from '../types.js';

export const localeRoutingFlow: GraphDefinition = {
	id: 'locale-routing-flow-v1',
	flowVersion: '1.0.0',
	name: 'Locale-Based Registration Routing',
	description: 'Registration flow with locale-based routing using Switch node',
	profileId: 'core.human-basic-registration' as any,
	nodes: [
		{
			id: 'start',
			type: 'start',
			position: { x: 50, y: 250 },
			data: {
				label: 'Start',
				intent: 'core.flow_start' as any,
				capabilities: [],
				config: {},
			},
		},
		{
			id: 'detect_locale',
			type: 'detect_locale' as any,
			position: { x: 200, y: 250 },
			data: {
				label: 'Detect User Locale',
				intent: 'core.detect_locale' as any,
				capabilities: [],
				config: {
					fallback: 'en',
				},
			},
		},
		{
			id: 'switch_locale',
			type: 'switch',
			position: { x: 400, y: 250 },
			data: {
				label: 'Locale Router',
				intent: 'core.decision' as any,
				capabilities: [],
				config: {
					switchKey: 'user.locale',
					cases: [
						{
							id: 'case_ja',
							label: 'Japanese',
							values: ['ja', 'ja-JP'],
						},
						{
							id: 'case_en',
							label: 'English',
							values: ['en', 'en-US', 'en-GB'],
						},
						{
							id: 'case_de',
							label: 'German',
							values: ['de', 'de-DE'],
						},
						{
							id: 'case_zh',
							label: 'Chinese',
							values: ['zh', 'zh-CN', 'zh-TW'],
						},
					],
					defaultCase: 'case_default',
				} as any,
			},
		},
		// Case 1: Japanese → Additional Fields (e.g., Furigana)
		{
			id: 'ja_register_form',
			type: 'user_input',
			position: { x: 650, y: 50 },
			data: {
				label: 'Japanese Registration',
				intent: 'core.collect_input' as any,
				capabilities: [],
				config: {
					fields: [
						{ name: 'email', type: 'email', required: true },
						{ name: 'password', type: 'password', required: true },
						{ name: 'name', type: 'text', required: true },
						{ name: 'name_kana', type: 'text', required: true, label: 'フリガナ' },
						{ name: 'phone', type: 'phone', required: false },
					],
				},
			},
		},
		{
			id: 'ja_register',
			type: 'register',
			position: { x: 850, y: 50 },
			data: {
				label: 'Register (JA)',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					locale: 'ja',
				},
			},
		},
		{
			id: 'ja_success',
			type: 'end',
			position: { x: 1050, y: 50 },
			data: {
				label: 'Success (JA)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					locale: 'ja',
				},
			},
		},
		// Case 2: English → Standard Registration
		{
			id: 'en_register_form',
			type: 'user_input',
			position: { x: 650, y: 150 },
			data: {
				label: 'English Registration',
				intent: 'core.collect_input' as any,
				capabilities: [],
				config: {
					fields: [
						{ name: 'email', type: 'email', required: true },
						{ name: 'password', type: 'password', required: true },
						{ name: 'name', type: 'text', required: true },
					],
				},
			},
		},
		{
			id: 'en_register',
			type: 'register',
			position: { x: 850, y: 150 },
			data: {
				label: 'Register (EN)',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					locale: 'en',
				},
			},
		},
		{
			id: 'en_success',
			type: 'end',
			position: { x: 1050, y: 150 },
			data: {
				label: 'Success (EN)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					locale: 'en',
				},
			},
		},
		// Case 3: German → GDPR Consent
		{
			id: 'de_gdpr_consent',
			type: 'consent',
			position: { x: 650, y: 250 },
			data: {
				label: 'GDPR Consent',
				intent: 'core.consent' as any,
				capabilities: [],
				config: {
					consents: ['gdpr_data_processing', 'terms'],
				},
			},
		},
		{
			id: 'de_register_form',
			type: 'user_input',
			position: { x: 850, y: 250 },
			data: {
				label: 'German Registration',
				intent: 'core.collect_input' as any,
				capabilities: [],
				config: {
					fields: [
						{ name: 'email', type: 'email', required: true },
						{ name: 'password', type: 'password', required: true },
						{ name: 'name', type: 'text', required: true },
					],
				},
			},
		},
		{
			id: 'de_register',
			type: 'register',
			position: { x: 1050, y: 250 },
			data: {
				label: 'Register (DE)',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					locale: 'de',
					gdpr_compliant: true,
				},
			},
		},
		{
			id: 'de_success',
			type: 'end',
			position: { x: 1250, y: 250 },
			data: {
				label: 'Success (DE)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					locale: 'de',
				},
			},
		},
		// Case 4: Chinese → Localized Form
		{
			id: 'zh_register_form',
			type: 'user_input',
			position: { x: 650, y: 350 },
			data: {
				label: 'Chinese Registration',
				intent: 'core.collect_input' as any,
				capabilities: [],
				config: {
					fields: [
						{ name: 'email', type: 'email', required: true },
						{ name: 'password', type: 'password', required: true },
						{ name: 'name', type: 'text', required: true },
						{ name: 'phone', type: 'phone', required: true },
					],
				},
			},
		},
		{
			id: 'zh_register',
			type: 'register',
			position: { x: 850, y: 350 },
			data: {
				label: 'Register (ZH)',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					locale: 'zh',
				},
			},
		},
		{
			id: 'zh_success',
			type: 'end',
			position: { x: 1050, y: 350 },
			data: {
				label: 'Success (ZH)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					locale: 'zh',
				},
			},
		},
		// Default Case → English (fallback)
		{
			id: 'default_register_form',
			type: 'user_input',
			position: { x: 650, y: 450 },
			data: {
				label: 'Default Registration',
				intent: 'core.collect_input' as any,
				capabilities: [],
				config: {
					fields: [
						{ name: 'email', type: 'email', required: true },
						{ name: 'password', type: 'password', required: true },
						{ name: 'name', type: 'text', required: true },
					],
				},
			},
		},
		{
			id: 'default_register',
			type: 'register',
			position: { x: 850, y: 450 },
			data: {
				label: 'Register (Default)',
				intent: 'core.register' as any,
				capabilities: [],
				config: {
					auto_login: true,
					locale: 'en',
				},
			},
		},
		{
			id: 'default_success',
			type: 'end',
			position: { x: 1050, y: 450 },
			data: {
				label: 'Success (Default)',
				intent: 'core.flow_end' as any,
				capabilities: [],
				config: {
					success: true,
					locale: 'en',
				},
			},
		},
	],
	edges: [
		{
			id: 'e1',
			source: 'start',
			target: 'detect_locale',
			type: 'success',
		},
		{
			id: 'e2',
			source: 'detect_locale',
			target: 'switch_locale',
			type: 'success',
		},
		// Switch cases
		{
			id: 'e3',
			source: 'switch_locale',
			target: 'ja_register_form',
			sourceHandle: 'case_ja',
			type: 'conditional',
			data: {
				label: 'Japanese',
			},
		},
		{
			id: 'e4',
			source: 'switch_locale',
			target: 'en_register_form',
			sourceHandle: 'case_en',
			type: 'conditional',
			data: {
				label: 'English',
			},
		},
		{
			id: 'e5',
			source: 'switch_locale',
			target: 'de_gdpr_consent',
			sourceHandle: 'case_de',
			type: 'conditional',
			data: {
				label: 'German',
			},
		},
		{
			id: 'e6',
			source: 'switch_locale',
			target: 'zh_register_form',
			sourceHandle: 'case_zh',
			type: 'conditional',
			data: {
				label: 'Chinese',
			},
		},
		{
			id: 'e7',
			source: 'switch_locale',
			target: 'default_register_form',
			sourceHandle: 'case_default',
			type: 'conditional',
			data: {
				label: 'Default',
			},
		},
		// Japanese path
		{
			id: 'e8',
			source: 'ja_register_form',
			target: 'ja_register',
			type: 'success',
		},
		{
			id: 'e9',
			source: 'ja_register',
			target: 'ja_success',
			type: 'success',
		},
		// English path
		{
			id: 'e10',
			source: 'en_register_form',
			target: 'en_register',
			type: 'success',
		},
		{
			id: 'e11',
			source: 'en_register',
			target: 'en_success',
			type: 'success',
		},
		// German path
		{
			id: 'e12',
			source: 'de_gdpr_consent',
			target: 'de_register_form',
			type: 'success',
		},
		{
			id: 'e13',
			source: 'de_register_form',
			target: 'de_register',
			type: 'success',
		},
		{
			id: 'e14',
			source: 'de_register',
			target: 'de_success',
			type: 'success',
		},
		// Chinese path
		{
			id: 'e15',
			source: 'zh_register_form',
			target: 'zh_register',
			type: 'success',
		},
		{
			id: 'e16',
			source: 'zh_register',
			target: 'zh_success',
			type: 'success',
		},
		// Default path
		{
			id: 'e17',
			source: 'default_register_form',
			target: 'default_register',
			type: 'success',
		},
		{
			id: 'e18',
			source: 'default_register',
			target: 'default_success',
			type: 'success',
		},
	],
	metadata: {
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		createdBy: 'system',
	},
};
