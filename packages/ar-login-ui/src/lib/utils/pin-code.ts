export function normalizePinCodeLength(raw: number): number {
	if (!Number.isFinite(raw)) return 6;
	return Math.max(1, Math.min(12, Math.trunc(raw)));
}

export function normalizePinCode(raw: string, length: number): string {
	return raw.replace(/\D/g, '').slice(0, normalizePinCodeLength(length));
}
