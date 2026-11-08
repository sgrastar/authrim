/**
 * QR codes for the lite pages (an authenticator's setup).
 */
import QRCode from 'qrcode';

/** A QR code as an inline image (an SVG data URI: the lite CSP allows `img-src data:` only). */
export async function qrDataUri(text: string): Promise<string | null> {
	try {
		const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
		return `data:image/svg+xml;base64,${btoa(svg)}`;
	} catch {
		return null;
	}
}
