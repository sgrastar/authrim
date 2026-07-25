import { beforeAll, describe, expect, it } from 'vitest';

import { i18nObject } from '$i18n/i18n-util';
import { loadAllLocales } from '$i18n/i18n-util.sync';
import { getFlowTemplateText } from './flow-i18n';
import { getNewFlowTemplate, type NewFlowTemplateId } from './new-flow-templates';

const localizedTemplateIds: NewFlowTemplateId[] = [
	'default-registration-no-consent',
	'academic-saml-login',
	'default-login-no-consent',
	'saml-sp-oidc-rp'
];

function requireTemplate(id: NewFlowTemplateId) {
	const template = getNewFlowTemplate(id);
	if (!template) throw new Error(`Missing flow template: ${id}`);
	return template;
}

describe('flow template localization', () => {
	beforeAll(() => loadAllLocales());

	it('does not expose Japanese fallback copy in the English template list', () => {
		const LL = i18nObject('en');

		for (const id of localizedTemplateIds) {
			const text = getFlowTemplateText(LL, requireTemplate(id));
			expect(`${text.subtitle}\n${text.description}`, id).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
		}

		expect(
			getFlowTemplateText(LL, requireTemplate('default-registration-no-consent')).subtitle
		).toBe('Account creation without profile input or registration consent');
		expect(getFlowTemplateText(LL, requireTemplate('default-login-no-consent')).subtitle).toBe(
			'Sign-in without consent confirmation'
		);
		expect(getFlowTemplateText(LL, requireTemplate('saml-sp-oidc-rp')).subtitle).toBe(
			'Sign-in for SAML SPs and OIDC RPs'
		);
	});

	it('uses Japanese copy for the same templates in the Japanese UI', () => {
		const LL = i18nObject('ja');

		expect(
			getFlowTemplateText(LL, requireTemplate('default-registration-no-consent')).subtitle
		).toBe('プロフィール入力と登録同意なしの新規登録');
		expect(getFlowTemplateText(LL, requireTemplate('academic-saml-login')).subtitle).toBe(
			'学術出版社・図書館系SP向けログイン'
		);
		expect(getFlowTemplateText(LL, requireTemplate('default-login-no-consent')).subtitle).toBe(
			'同意確認なしのログイン'
		);
		expect(getFlowTemplateText(LL, requireTemplate('saml-sp-oidc-rp')).subtitle).toBe(
			'SAML SP・OIDC RP向けログイン'
		);
	});
});
