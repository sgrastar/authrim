import { expect, it } from 'vitest';
import { hashTenantBackupFile, TenantBackupSha256 } from './tenant-backup-sha256';

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

it.each([
	['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
	['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
	['a'.repeat(1000), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3']
])('matches the SHA-256 vector for a chunked input', (value, expected) => {
	const bytes = new TextEncoder().encode(value);
	const hash = new TenantBackupSha256();
	for (let offset = 0; offset < bytes.length; offset += 7)
		hash.update(bytes.slice(offset, offset + 7));
	expect(hex(hash.digest())).toBe(expected);
});

it('hashes a Blob in bounded slices', async () => {
	const bytes = new TextEncoder().encode('chunked browser file');
	const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	await expect(hashTenantBackupFile(new Blob([bytes]), 64)).resolves.toEqual(expected);
});

it('does not allow reuse after finalization', () => {
	const hash = new TenantBackupSha256();
	hash.digest();
	expect(() => hash.update(new Uint8Array([1]))).toThrow('Invalid SHA-256 state');
	expect(() => hash.digest()).toThrow('Invalid SHA-256 state');
});
