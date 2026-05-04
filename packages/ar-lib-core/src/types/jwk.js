/**
 * JSON Web Key (JWK) Type Definitions
 *
 * Implements RFC 7517: JSON Web Key (JWK)
 * @see https://datatracker.ietf.org/doc/html/rfc7517
 *
 * These types provide type-safe handling of JWK structures used throughout
 * the Authrim OIDC/OAuth2 implementation for:
 * - Client JWKS validation (RFC 9126)
 * - JARM encryption (JWT-Secured Authorization Response Mode)
 * - Request Object signing/encryption (RFC 9101)
 * - DPoP proof validation (RFC 9449)
 */
// =============================================================================
// Type Guards
// =============================================================================
/**
 * Check if a JWK is an RSA key
 */
export function isRSAJWK(jwk) {
    return jwk.kty === 'RSA';
}
/**
 * Check if a JWK is an EC key
 */
export function isECJWK(jwk) {
    return jwk.kty === 'EC';
}
/**
 * Check if a JWK is an OKP key
 */
export function isOKPJWK(jwk) {
    return jwk.kty === 'OKP';
}
/**
 * Check if a JWK is a symmetric key
 */
export function isSymmetricJWK(jwk) {
    return jwk.kty === 'oct';
}
/**
 * Check if a JWK has a private key component
 */
export function isPrivateJWK(jwk) {
    return 'd' in jwk && jwk.d !== undefined;
}
/**
 * Check if a JWK is for signing (use=sig or key_ops includes sign/verify)
 */
export function isSigningJWK(jwk) {
    if (jwk.use === 'sig')
        return true;
    if (jwk.key_ops) {
        return jwk.key_ops.includes('sign') || jwk.key_ops.includes('verify');
    }
    // If neither use nor key_ops is specified, assume it can be used for signing
    return jwk.use === undefined && jwk.key_ops === undefined;
}
/**
 * Check if a JWK is for encryption (use=enc or key_ops includes encrypt/decrypt)
 */
export function isEncryptionJWK(jwk) {
    if (jwk.use === 'enc')
        return true;
    if (jwk.key_ops) {
        return (jwk.key_ops.includes('encrypt') ||
            jwk.key_ops.includes('decrypt') ||
            jwk.key_ops.includes('wrapKey') ||
            jwk.key_ops.includes('unwrapKey'));
    }
    // If neither use nor key_ops is specified, assume it can be used for encryption
    return jwk.use === undefined && jwk.key_ops === undefined;
}
