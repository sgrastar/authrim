import { afterEach, describe, expect, it, vi } from 'vitest';
import { guideFact, onGuideFactChange, setGuideFact } from './signals';

afterEach(() => setGuideFact('second-factor.totp', false));

describe('what a page tells the guide about the environment', () => {
	it('holds a fact from the moment a page reports it until it takes it back', () => {
		expect(guideFact('second-factor.totp')).toBe(false);
		setGuideFact('second-factor.totp', true);
		expect(guideFact('second-factor.totp')).toBe(true);
		setGuideFact('second-factor.totp', false);
		expect(guideFact('second-factor.totp')).toBe(false);
	});

	it('tells the guide when a fact changes, and only then', () => {
		const changed = vi.fn();
		const stop = onGuideFactChange(changed);

		setGuideFact('second-factor.totp', false);
		expect(changed).not.toHaveBeenCalled();
		setGuideFact('second-factor.totp', true);
		setGuideFact('second-factor.totp', true);
		expect(changed).toHaveBeenCalledTimes(1);
		setGuideFact('second-factor.totp', false);
		expect(changed).toHaveBeenCalledTimes(2);

		stop();
		setGuideFact('second-factor.totp', true);
		expect(changed).toHaveBeenCalledTimes(2);
	});
});
