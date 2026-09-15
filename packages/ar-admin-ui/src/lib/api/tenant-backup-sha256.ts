const INITIAL = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);
const ROUND = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotate(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

/** Browser-side incremental SHA-256 keeps large backup files chunked in memory. */
export class TenantBackupSha256 {
	private readonly state = new Uint32Array(INITIAL);
	private readonly buffer = new Uint8Array(64);
	private readonly words = new Uint32Array(64);
	private buffered = 0;
	private bytes = 0;
	private finalized = false;

	update(input: Uint8Array): this {
		if (this.finalized || !input || typeof input.byteLength !== 'number')
			throw new Error('Invalid SHA-256 state');
		this.bytes += input.byteLength;
		if (!Number.isSafeInteger(this.bytes)) throw new Error('Backup file is too large');
		let offset = 0;
		if (this.buffered > 0) {
			const take = Math.min(64 - this.buffered, input.length);
			this.buffer.set(input.subarray(0, take), this.buffered);
			this.buffered += take;
			offset = take;
			if (this.buffered === 64) {
				this.compress(this.buffer, 0);
				this.buffered = 0;
			}
		}
		while (offset + 64 <= input.length) {
			this.compress(input, offset);
			offset += 64;
		}
		if (offset < input.length) {
			this.buffer.set(input.subarray(offset), 0);
			this.buffered = input.length - offset;
		}
		return this;
	}

	digest(): Uint8Array {
		if (this.finalized) throw new Error('Invalid SHA-256 state');
		this.finalized = true;
		const tail = new Uint8Array(this.buffered < 56 ? 64 : 128);
		tail.set(this.buffer.subarray(0, this.buffered));
		tail[this.buffered] = 0x80;
		const view = new DataView(tail.buffer);
		view.setUint32(tail.length - 8, Math.floor(this.bytes / 0x20000000));
		view.setUint32(tail.length - 4, (this.bytes * 8) >>> 0);
		for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);
		const output = new Uint8Array(32);
		const outputView = new DataView(output.buffer);
		for (let index = 0; index < this.state.length; index += 1)
			outputView.setUint32(index * 4, this.state[index] ?? 0);
		return output;
	}

	private compress(input: Uint8Array, offset: number): void {
		const view = new DataView(input.buffer, input.byteOffset + offset, 64);
		for (let index = 0; index < 16; index += 1) this.words[index] = view.getUint32(index * 4);
		for (let index = 16; index < 64; index += 1) {
			const a = this.words[index - 15] ?? 0;
			const b = this.words[index - 2] ?? 0;
			const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
			const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
			this.words[index] =
				((this.words[index - 16] ?? 0) + s0 + (this.words[index - 7] ?? 0) + s1) >>> 0;
		}
		let a = this.state[0] ?? 0;
		let b = this.state[1] ?? 0;
		let c = this.state[2] ?? 0;
		let d = this.state[3] ?? 0;
		let e = this.state[4] ?? 0;
		let f = this.state[5] ?? 0;
		let g = this.state[6] ?? 0;
		let h = this.state[7] ?? 0;
		for (let index = 0; index < 64; index += 1) {
			const upper = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
			const choose = (e & f) ^ (~e & g);
			const first = (h + upper + choose + (ROUND[index] ?? 0) + (this.words[index] ?? 0)) >>> 0;
			const lower = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const second = (lower + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + first) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (first + second) >>> 0;
		}
		this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
		this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
		this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
		this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
		this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
		this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
		this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
		this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
	}
}

export async function hashTenantBackupFile(file: Blob, chunkBytes = 8 * 1024 * 1024) {
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64)
		throw new Error('Invalid hash chunk size');
	const hash = new TenantBackupSha256();
	for (let offset = 0; offset < file.size; offset += chunkBytes) {
		const part = await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer();
		hash.update(new Uint8Array(part));
	}
	return hash.digest();
}
