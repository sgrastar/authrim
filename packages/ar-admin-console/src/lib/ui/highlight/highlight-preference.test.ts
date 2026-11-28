import { beforeEach, describe, expect, it } from 'vitest';
import { highlightPreference } from './highlight-preference.svelte';

describe('personal change highlighting', () => {
	beforeEach(() => {
		localStorage.clear();
		highlightPreference.loadFor('alice');
	});
	it('starts off and isolates each administrator’s stored choices', () => {
		expect(highlightPreference.enabled).toBe(false);
		highlightPreference.setEnabled(true);
		highlightPreference.setColor('purple');
		highlightPreference.loadFor('bob');
		expect(highlightPreference.enabled).toBe(false);
		expect(highlightPreference.color).toBe('default');
		highlightPreference.loadFor('alice');
		expect(highlightPreference.enabled).toBe(true);
		expect(highlightPreference.color).toBe('purple');
	});
	it('retains the custom color when toggled off and restores the theme default', () => {
		highlightPreference.setColor('custom');
		highlightPreference.setCustom('#123abc');
		highlightPreference.setEnabled(true);
		expect(document.documentElement.style.getPropertyValue('--changed')).toBe('#123abc');
		highlightPreference.setEnabled(false);
		highlightPreference.loadFor('alice');
		expect(highlightPreference.custom).toBe('#123abc');
		expect(document.documentElement.dataset.changeHighlight).toBe('off');
		highlightPreference.setColor('default');
		expect(document.documentElement.style.getPropertyValue('--changed')).toBe('');
	});
	it('recovers from malformed storage and rejects invalid custom colors', () => {
		localStorage.setItem('authrim-console-highlight:alice', '{broken');
		highlightPreference.loadFor('alice');
		expect(highlightPreference.enabled).toBe(false);
		highlightPreference.setCustom('red; color: black');
		expect(highlightPreference.custom).toBe('#5796e6');
	});
});
