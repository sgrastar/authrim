import { describe, expect, it } from 'vitest';
import { environmentBannerData } from './environment-banner';

describe('environmentBannerData', () => {
	it('is null without an answer or without a banner', () => {
		expect(environmentBannerData(null, 'en')).toBeNull();
		expect(environmentBannerData(undefined, 'en')).toBeNull();
		expect(environmentBannerData({}, 'en')).toBeNull();
	});

	it('carries the raw text and languages, the server language and noindex', () => {
		const methods = {
			environmentBanner: {
				text: 'This is the staging environment.',
				textLocalizations: { ja: 'ステージング環境です。' },
				noindex: false
			}
		};
		expect(environmentBannerData(methods, 'ja')).toEqual({
			text: 'This is the staging environment.',
			textLocalizations: { ja: 'ステージング環境です。' },
			noindex: false,
			locale: 'ja'
		});
	});

	it('carries noindex alone, with no text', () => {
		expect(environmentBannerData({ environmentBanner: { noindex: true } }, 'en')).toEqual({
			text: '',
			textLocalizations: {},
			noindex: true,
			locale: 'en'
		});
	});
});
