import { describe, expect, it } from 'vitest';
import {
	formatStatementVersion,
	statementEmbedHref,
	statementPageHref,
	statementPresentation
} from './statement-display';

const ITEM = {
	slug: 'terms',
	title: 'Terms',
	version: '20261113',
	document_url: null,
	inline_content: '<p>Text</p>'
};

describe('statementPresentation', () => {
	it('frames the statement page of the version asked for a text kept in Authrim', () => {
		expect(statementPresentation(ITEM)).toEqual({
			kind: 'embedded',
			src: '/statements/terms/embed?version=20261113',
			pageHref: '/statements/terms?version=20261113'
		});
	});

	it('links an external document, and shows nothing else without a text', () => {
		expect(
			statementPresentation({ ...ITEM, inline_content: null, document_url: 'https://d.example/t' })
		).toEqual({ kind: 'external', href: 'https://d.example/t' });
		expect(
			statementPresentation({ ...ITEM, inline_content: null, document_url: 'javascript:alert(1)' })
		).toEqual({ kind: 'plain' });
		expect(statementPresentation({ ...ITEM, inline_content: null })).toEqual({ kind: 'plain' });
	});

	it('carries the language of the consent step to the frame and the page', () => {
		expect(statementPresentation(ITEM, 'ja')).toMatchObject({
			src: '/statements/terms/embed?version=20261113&lang=ja',
			pageHref: '/statements/terms?version=20261113&lang=ja'
		});
		expect(statementPresentation(ITEM, 'x y')).toMatchObject({
			src: '/statements/terms/embed?version=20261113'
		});
	});

	it('shows the text itself for a key that cannot be a page path', () => {
		for (const slug of ['', 'terms/v1', 'a b', '..', '.']) {
			expect(statementPresentation({ ...ITEM, slug }), slug).toEqual({
				kind: 'inline',
				content: '<p>Text</p>'
			});
		}
	});
});

describe('statement links', () => {
	it('encode the slug and keep only a YYYYMMDD version', () => {
		expect(statementPageHref('a/b?c')).toBe('/statements/a%2Fb%3Fc');
		expect(statementEmbedHref('terms', '1')).toBe('/statements/terms/embed');
		expect(statementPageHref('terms', '20260101')).toBe('/statements/terms?version=20260101');
	});

	it('shows a version as a date in the reader language', () => {
		expect(formatStatementVersion('20261113', 'en')).toBe('November 13, 2026');
		expect(formatStatementVersion('20261113', 'ja')).toBe('2026年11月13日');
		expect(formatStatementVersion('v1', 'en')).toBe('v1');
	});
});
