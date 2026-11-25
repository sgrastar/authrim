import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBgPresets, type BgPreset, type BgPresetSource } from './bg-presets';

const preset: BgPreset = {
	id: 'paper/indigo-washi',
	category: 'paper',
	name: 'indigo-washi',
	url: '/assets/indigo-washi.webp'
};

afterEach(() => vi.useRealTimers());

describe('loadBgPresets', () => {
	it('asks once for any number of callers and keeps the answer', async () => {
		const source = vi.fn<BgPresetSource>(async () => [preset]);
		const [a, b] = await Promise.all([loadBgPresets(source), loadBgPresets(source)]);
		expect(a).toEqual([preset]);
		expect(b).toBe(a);
		await loadBgPresets(source);
		expect(source).toHaveBeenCalledTimes(1);
	});

	it('does not keep a failure: the next call asks again', async () => {
		const source = vi
			.fn<BgPresetSource>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce([preset]);
		await expect(loadBgPresets(source)).rejects.toThrow('offline');
		await expect(loadBgPresets(source)).resolves.toEqual([preset]);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it('does not keep an empty list: presets may be installed afterwards', async () => {
		const source = vi
			.fn<BgPresetSource>()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([preset]);
		await expect(loadBgPresets(source)).resolves.toEqual([]);
		await expect(loadBgPresets(source)).resolves.toEqual([preset]);
	});

	it('gives up on an answer that does not come, and asks again afterwards', async () => {
		vi.useFakeTimers();
		const source = vi
			.fn<BgPresetSource>()
			.mockImplementationOnce(() => new Promise(() => undefined))
			.mockResolvedValueOnce([preset]);
		const waiting = loadBgPresets(source, { timeoutMs: 1000 });
		const failed = expect(waiting).rejects.toThrow('bg_presets_timeout');
		await vi.advanceTimersByTimeAsync(1000);
		await failed;
		await expect(loadBgPresets(source, { timeoutMs: 1000 })).resolves.toEqual([preset]);
	});

	it('asks again when told to, even while an earlier ask is still out', async () => {
		let release: (list: BgPreset[]) => void = () => undefined;
		const source = vi
			.fn<BgPresetSource>()
			.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
			.mockResolvedValueOnce([preset]);
		const first = loadBgPresets(source);
		await expect(loadBgPresets(source, { fresh: true })).resolves.toEqual([preset]);
		release([]);
		await first;
		// The late, empty answer of the earlier ask must not take the newer answer away.
		await expect(loadBgPresets(source)).resolves.toEqual([preset]);
		expect(source).toHaveBeenCalledTimes(2);
	});
});
