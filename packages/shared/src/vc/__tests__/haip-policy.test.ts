/**
 * HAIP Policy Tests
 *
 * Tests for HAIP abstraction layer (Phase 9).
 */

import { describe, it, expect } from 'vitest';
import {
  HaipPolicyEvaluator,
  getHaipPolicy,
  HAIP_DRAFT_06,
  STANDARD_POLICY,
  HAIP_CREDENTIAL_TYPES,
  type HaipPolicy,
  type HaipVerificationInput,
} from '../haip-policy';

describe('HAIP Policy', () => {
  describe('HAIP_DRAFT_06 default policy', () => {
    it('should have strict requirements', () => {
      expect(HAIP_DRAFT_06.requireHolderBinding).toBe(true);
      expect(HAIP_DRAFT_06.requireIssuerTrust).toBe(true);
      expect(HAIP_DRAFT_06.requireStatusCheck).toBe(true);
      expect(HAIP_DRAFT_06.preferDCQL).toBe(true);
      expect(HAIP_DRAFT_06.requireDirectPost).toBe(true);
    });

    it('should allow only EC algorithms', () => {
      expect(HAIP_DRAFT_06.allowedAlgorithms).toEqual(['ES256', 'ES384', 'ES512']);
    });

    it('should allow dc+sd-jwt and mso_mdoc formats', () => {
      expect(HAIP_DRAFT_06.allowedFormats).toEqual(['dc+sd-jwt', 'mso_mdoc']);
    });
  });

  describe('STANDARD_POLICY', () => {
    it('should have relaxed requirements', () => {
      expect(STANDARD_POLICY.requireHolderBinding).toBe(true); // Still recommended
      expect(STANDARD_POLICY.requireIssuerTrust).toBe(false);
      expect(STANDARD_POLICY.requireStatusCheck).toBe(false);
      expect(STANDARD_POLICY.preferDCQL).toBe(false);
      expect(STANDARD_POLICY.requireDirectPost).toBe(false);
    });
  });

  describe('getHaipPolicy', () => {
    it('should return draft-06 policy', () => {
      const policy = getHaipPolicy('draft-06');

      expect(policy.requireHolderBinding).toBe(true);
      expect(policy.requireIssuerTrust).toBe(true);
    });

    it('should return draft-06 for final-1.0 (placeholder)', () => {
      const policy = getHaipPolicy('final-1.0');

      expect(policy).toEqual(HAIP_DRAFT_06);
    });

    it('should return a copy, not the original', () => {
      const policy = getHaipPolicy('draft-06');
      policy.requireHolderBinding = false;

      // Original should be unchanged
      expect(HAIP_DRAFT_06.requireHolderBinding).toBe(true);
    });
  });

  describe('HAIP_CREDENTIAL_TYPES', () => {
    it('should define EU PID credential type', () => {
      const euPid = HAIP_CREDENTIAL_TYPES['eu.europa.ec.eudi.pid.1'];

      expect(euPid).toBeDefined();
      expect(euPid.vct).toBe('eu.europa.ec.eudi.pid.1');
      expect(euPid.requiredClaims).toContain('iss');
      expect(euPid.requiredClaims).toContain('cnf');
      expect(euPid.selectiveDisclosureClaims).toContain('given_name');
      expect(euPid.selectiveDisclosureClaims).toContain('age_over_18');
      expect(euPid.minAssuranceLevel).toBe('high');
    });

    it('should define mDL credential type', () => {
      const mdl = HAIP_CREDENTIAL_TYPES['org.iso.18013.5.1.mDL'];

      expect(mdl).toBeDefined();
      expect(mdl.selectiveDisclosureClaims).toContain('driving_privileges');
      expect(mdl.minAssuranceLevel).toBe('high');
    });

    it('should define age verification credential type', () => {
      const ageVerification = HAIP_CREDENTIAL_TYPES['urn:authrim:age-verification:1'];

      expect(ageVerification).toBeDefined();
      expect(ageVerification.selectiveDisclosureClaims).toContain('age_over_18');
      expect(ageVerification.minAssuranceLevel).toBe('substantial');
    });
  });

  describe('HaipPolicyEvaluator', () => {
    describe('constructor', () => {
      it('should use HAIP_DRAFT_06 by default', () => {
        const evaluator = new HaipPolicyEvaluator();
        const policy = evaluator.getPolicy();

        expect(policy.requireHolderBinding).toBe(true);
        expect(policy.requireIssuerTrust).toBe(true);
      });

      it('should accept custom policy', () => {
        const customPolicy: HaipPolicy = {
          ...HAIP_DRAFT_06,
          requireStatusCheck: false,
        };
        const evaluator = new HaipPolicyEvaluator(customPolicy);
        const policy = evaluator.getPolicy();

        expect(policy.requireStatusCheck).toBe(false);
      });
    });

    describe('isAlgorithmAllowed', () => {
      it('should allow ES256, ES384, ES512', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isAlgorithmAllowed('ES256')).toBe(true);
        expect(evaluator.isAlgorithmAllowed('ES384')).toBe(true);
        expect(evaluator.isAlgorithmAllowed('ES512')).toBe(true);
      });

      it('should reject RS256', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isAlgorithmAllowed('RS256')).toBe(false);
      });

      it('should reject EdDSA', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isAlgorithmAllowed('EdDSA')).toBe(false);
      });
    });

    describe('isFormatAllowed', () => {
      it('should allow dc+sd-jwt', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isFormatAllowed('dc+sd-jwt')).toBe(true);
      });

      it('should allow mso_mdoc', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isFormatAllowed('mso_mdoc')).toBe(true);
      });

      it('should reject jwt_vc_json', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isFormatAllowed('jwt_vc_json')).toBe(false);
      });
    });

    describe('isHolderBindingRequired', () => {
      it('should return true for HAIP policy', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isHolderBindingRequired()).toBe(true);
      });
    });

    describe('isIssuerTrustRequired', () => {
      it('should return true for HAIP policy', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isIssuerTrustRequired()).toBe(true);
      });

      it('should return false for STANDARD policy', () => {
        const evaluator = new HaipPolicyEvaluator(STANDARD_POLICY);

        expect(evaluator.isIssuerTrustRequired()).toBe(false);
      });
    });

    describe('isStatusCheckRequired', () => {
      it('should return true for HAIP policy', () => {
        const evaluator = new HaipPolicyEvaluator();

        expect(evaluator.isStatusCheckRequired()).toBe(true);
      });
    });

    describe('isWithinMaxAge', () => {
      it('should return true when no maxCredentialAge set', () => {
        const evaluator = new HaipPolicyEvaluator();
        const oldTimestamp = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60; // 1 year ago

        expect(evaluator.isWithinMaxAge(oldTimestamp)).toBe(true);
      });

      it('should enforce maxCredentialAge when set', () => {
        const evaluator = new HaipPolicyEvaluator({
          ...HAIP_DRAFT_06,
          maxCredentialAge: 3600, // 1 hour
        });

        const recentTimestamp = Math.floor(Date.now() / 1000) - 1800; // 30 minutes ago
        const oldTimestamp = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago

        expect(evaluator.isWithinMaxAge(recentTimestamp)).toBe(true);
        expect(evaluator.isWithinMaxAge(oldTimestamp)).toBe(false);
      });
    });

    describe('updatePolicy', () => {
      it('should update policy partially', () => {
        const evaluator = new HaipPolicyEvaluator();

        evaluator.updatePolicy({ requireStatusCheck: false });
        const policy = evaluator.getPolicy();

        expect(policy.requireStatusCheck).toBe(false);
        expect(policy.requireHolderBinding).toBe(true); // Unchanged
      });
    });

    describe('validateVerificationResult', () => {
      it('should pass valid HAIP-compliant verification', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'dc+sd-jwt',
          holderBindingVerified: true,
          issuerTrusted: true,
          statusValid: true,
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(true);
        expect(result.haipCompliant).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
      });

      it('should fail for invalid algorithm', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'RS256', // Not allowed
          format: 'dc+sd-jwt',
          holderBindingVerified: true,
          issuerTrusted: true,
          statusValid: true,
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Algorithm'))).toBe(true);
      });

      it('should fail for invalid format', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'jwt_vc_json', // Not allowed
          holderBindingVerified: true,
          issuerTrusted: true,
          statusValid: true,
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Format'))).toBe(true);
      });

      it('should fail when holder binding not verified', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'dc+sd-jwt',
          holderBindingVerified: false, // Required but not verified
          issuerTrusted: true,
          statusValid: true,
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Holder binding'))).toBe(true);
      });

      it('should fail when issuer not trusted', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'dc+sd-jwt',
          holderBindingVerified: true,
          issuerTrusted: false, // Required but not trusted
          statusValid: true,
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Issuer trust'))).toBe(true);
      });

      it('should fail when status not valid', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'dc+sd-jwt',
          holderBindingVerified: true,
          issuerTrusted: true,
          statusValid: false, // Revoked or suspended
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Status check'))).toBe(true);
      });

      it('should warn for old credentials when maxCredentialAge set', () => {
        const evaluator = new HaipPolicyEvaluator({
          ...HAIP_DRAFT_06,
          maxCredentialAge: 3600, // 1 hour
        });
        const input: HaipVerificationInput = {
          algorithm: 'ES256',
          format: 'dc+sd-jwt',
          holderBindingVerified: true,
          issuerTrusted: true,
          statusValid: true,
          issuedAt: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(true); // Still valid
        expect(result.haipCompliant).toBe(false); // But not fully compliant
        expect(result.warnings.some((w) => w.includes('older than max age'))).toBe(true);
      });

      it('should collect multiple errors', () => {
        const evaluator = new HaipPolicyEvaluator();
        const input: HaipVerificationInput = {
          algorithm: 'RS256', // Invalid
          format: 'jwt_vc_json', // Invalid
          holderBindingVerified: false, // Required
          issuerTrusted: false, // Required
          statusValid: false, // Required
        };

        const result = evaluator.validateVerificationResult(input);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(5);
      });
    });

    describe('getPolicy', () => {
      it('should return a copy of the policy', () => {
        const evaluator = new HaipPolicyEvaluator();
        const policy1 = evaluator.getPolicy();
        const policy2 = evaluator.getPolicy();

        expect(policy1).not.toBe(policy2); // Different objects
        expect(policy1).toEqual(policy2); // Same values
      });
    });
  });
});
