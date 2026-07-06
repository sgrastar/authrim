export type AccountTotpDeleteProof = {
	code?: string;
	backup_code?: string;
};

const TOTP_CODE_PATTERN = /^\d{6}$|^\d{8}$/;
const BACKUP_CODE_PATTERN = /^[A-Z0-9]{12}$/;

export function normalizeTotpBackupCodeInput(value: string): string {
	return value
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

export function isTotpDeleteProofReady(value: string): boolean {
	const trimmed = value.trim();
	return (
		TOTP_CODE_PATTERN.test(trimmed) || BACKUP_CODE_PATTERN.test(normalizeTotpBackupCodeInput(value))
	);
}

export function buildTotpDeleteProof(value: string): AccountTotpDeleteProof {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	if (TOTP_CODE_PATTERN.test(trimmed)) {
		return { code: trimmed };
	}
	return { backup_code: trimmed };
}
