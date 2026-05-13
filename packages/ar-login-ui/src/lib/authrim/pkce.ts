import { PKCEHelper, base64urlEncode, type CryptoProvider, type PKCEPair } from '@authrim/core';

class LoginUiBrowserCryptoProvider implements CryptoProvider {
	private requireCrypto(): Crypto {
		if (typeof crypto === 'undefined' || !crypto.getRandomValues || !crypto.subtle) {
			throw new Error('Web Crypto API is not available');
		}
		return crypto;
	}

	async randomBytes(length: number): Promise<Uint8Array> {
		const bytes = new Uint8Array(length);
		this.requireCrypto().getRandomValues(bytes);
		return bytes;
	}

	async sha256(data: string): Promise<Uint8Array> {
		const encoder = new TextEncoder();
		const bytes = encoder.encode(data);
		const hash = await this.requireCrypto().subtle.digest('SHA-256', bytes);
		return new Uint8Array(hash);
	}

	async generateCodeVerifier(): Promise<string> {
		return base64urlEncode(await this.randomBytes(32));
	}

	async generateCodeChallenge(verifier: string): Promise<string> {
		return base64urlEncode(await this.sha256(verifier));
	}
}

const pkceHelper = new PKCEHelper(new LoginUiBrowserCryptoProvider());

export async function generateLoginUiPKCE(): Promise<PKCEPair> {
	return pkceHelper.generatePKCE();
}
