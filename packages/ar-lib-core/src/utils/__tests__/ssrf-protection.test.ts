/**
 * SSRF Protection Utilities Tests
 *
 * Tests for URL validation and SSRF prevention.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';
import { validateUrlForSSRF, validateWebhookUrl, sanitizeUrlForLogging } from '../ssrf-protection';

describe('validateUrlForSSRF', () => {
  describe('scheme validation', () => {
    it('should accept https URLs', () => {
      const result = validateUrlForSSRF('https://example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('should accept http URLs', () => {
      const result = validateUrlForSSRF('http://example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('should reject file:// URLs', () => {
      const result = validateUrlForSSRF('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid scheme');
    });

    it('should reject ftp:// URLs', () => {
      const result = validateUrlForSSRF('ftp://example.com/file');
      expect(result.valid).toBe(false);
    });

    it('should reject data: URLs', () => {
      const result = validateUrlForSSRF('data:text/plain,hello');
      expect(result.valid).toBe(false);
    });
  });

  describe('IPv4 blocking', () => {
    it('should block loopback addresses (127.0.0.0/8)', () => {
      expect(validateUrlForSSRF('http://127.0.0.1/').valid).toBe(false);
      expect(validateUrlForSSRF('http://127.0.0.1:8080/').valid).toBe(false);
      expect(validateUrlForSSRF('http://127.1.2.3/').valid).toBe(false);
    });

    it('should block private 10.x.x.x addresses', () => {
      expect(validateUrlForSSRF('http://10.0.0.1/').valid).toBe(false);
      expect(validateUrlForSSRF('http://10.255.255.255/').valid).toBe(false);
    });

    it('should block private 172.16.x.x - 172.31.x.x addresses', () => {
      expect(validateUrlForSSRF('http://172.16.0.1/').valid).toBe(false);
      expect(validateUrlForSSRF('http://172.20.0.1/').valid).toBe(false);
      expect(validateUrlForSSRF('http://172.31.255.255/').valid).toBe(false);
    });

    it('should allow 172.32.x.x (not in private range)', () => {
      expect(validateUrlForSSRF('http://172.32.0.1/').valid).toBe(true);
    });

    it('should block private 192.168.x.x addresses', () => {
      expect(validateUrlForSSRF('http://192.168.0.1/').valid).toBe(false);
      expect(validateUrlForSSRF('http://192.168.1.1/').valid).toBe(false);
    });

    it('should block link-local 169.254.x.x addresses', () => {
      expect(validateUrlForSSRF('http://169.254.0.1/').valid).toBe(false);
    });

    it('should block cloud metadata endpoint 169.254.169.254', () => {
      const result = validateUrlForSSRF('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('metadata');
    });

    it('should block AWS ECS metadata 169.254.170.2', () => {
      const result = validateUrlForSSRF('http://169.254.170.2/');
      expect(result.valid).toBe(false);
    });

    it('should block Azure wireserver 168.63.129.16', () => {
      const result = validateUrlForSSRF('http://168.63.129.16/');
      expect(result.valid).toBe(false);
    });

    it('should allow public IP addresses', () => {
      expect(validateUrlForSSRF('http://8.8.8.8/').valid).toBe(true);
      expect(validateUrlForSSRF('http://1.1.1.1/').valid).toBe(true);
      expect(validateUrlForSSRF('http://93.184.216.34/').valid).toBe(true);
    });
  });

  describe('IPv6 blocking', () => {
    it('should block IPv6 loopback (::1)', () => {
      const result = validateUrlForSSRF('http://[::1]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('loopback');
    });

    it('should block IPv6 unspecified (::)', () => {
      const result = validateUrlForSSRF('http://[::]/');
      expect(result.valid).toBe(false);
    });

    it('should block unique local addresses (fc00::/7)', () => {
      expect(validateUrlForSSRF('http://[fc00::1]/').valid).toBe(false);
      expect(validateUrlForSSRF('http://[fd00::1]/').valid).toBe(false);
    });

    it('should block link-local addresses (fe80::/10)', () => {
      expect(validateUrlForSSRF('http://[fe80::1]/').valid).toBe(false);
      expect(validateUrlForSSRF('http://[feb0::1]/').valid).toBe(false);
    });

    it('should block IPv4-mapped IPv6 with private addresses', () => {
      // ::ffff:127.0.0.1
      const result = validateUrlForSSRF('http://[::ffff:127.0.0.1]/');
      expect(result.valid).toBe(false);
    });
  });

  describe('hostname blocking', () => {
    it('should block localhost', () => {
      expect(validateUrlForSSRF('http://localhost/').valid).toBe(false);
      expect(validateUrlForSSRF('http://LOCALHOST/').valid).toBe(false); // Case insensitive
    });

    it('should block localhost.localdomain', () => {
      expect(validateUrlForSSRF('http://localhost.localdomain/').valid).toBe(false);
    });

    it('should block *.local domains', () => {
      expect(validateUrlForSSRF('http://myserver.local/').valid).toBe(false);
      expect(validateUrlForSSRF('http://test.local/').valid).toBe(false);
    });

    it('should block *.internal domains', () => {
      expect(validateUrlForSSRF('http://service.internal/').valid).toBe(false);
      expect(validateUrlForSSRF('http://api.internal/').valid).toBe(false);
    });

    it('should block metadata.google.internal', () => {
      expect(validateUrlForSSRF('http://metadata.google.internal/').valid).toBe(false);
    });

    it('should block Kubernetes internal domains', () => {
      expect(validateUrlForSSRF('http://service.default.svc.cluster.local/').valid).toBe(false);
      expect(validateUrlForSSRF('http://app.pod.cluster.local/').valid).toBe(false);
    });

    it('should block AWS internal domains', () => {
      expect(validateUrlForSSRF('http://ip-10-0-0-1.ec2.internal/').valid).toBe(false);
    });

    it('should allow public domains', () => {
      expect(validateUrlForSSRF('http://example.com/').valid).toBe(true);
      expect(validateUrlForSSRF('http://api.example.com/').valid).toBe(true);
      expect(validateUrlForSSRF('https://webhook.site/abc123').valid).toBe(true);
    });
  });

  describe('allowLocalhost option', () => {
    it('should allow localhost when configured', () => {
      const result = validateUrlForSSRF('http://localhost:3000/', { allowLocalhost: true });
      expect(result.valid).toBe(true);
    });

    it('should allow 127.0.0.1 when configured', () => {
      const result = validateUrlForSSRF('http://127.0.0.1:3000/', { allowLocalhost: true });
      expect(result.valid).toBe(true);
    });

    it('should allow ::1 when configured', () => {
      const result = validateUrlForSSRF('http://[::1]:3000/', { allowLocalhost: true });
      expect(result.valid).toBe(true);
    });

    it('should still block other private IPs even with allowLocalhost', () => {
      const result = validateUrlForSSRF('http://10.0.0.1/', { allowLocalhost: true });
      expect(result.valid).toBe(false);
    });
  });

  describe('allowedHostnames option', () => {
    it('should allow specific hostnames that override blocks', () => {
      const result = validateUrlForSSRF('http://myserver.local/', {
        allowedHostnames: ['myserver.local'],
      });
      expect(result.valid).toBe(true);
    });

    it('should allow wildcard patterns', () => {
      const result = validateUrlForSSRF('http://trusted.internal/', {
        allowedHostnames: ['*.internal'],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('additionalBlockedHostnames option', () => {
    it('should block additional hostnames', () => {
      const result = validateUrlForSSRF('http://blocked.example.com/', {
        additionalBlockedHostnames: ['blocked.example.com'],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid URLs', () => {
    it('should reject invalid URL format', () => {
      expect(validateUrlForSSRF('not-a-url').valid).toBe(false);
      expect(validateUrlForSSRF('').valid).toBe(false);
    });
  });
});

describe('validateWebhookUrl', () => {
  describe('HTTPS requirement', () => {
    it('should accept HTTPS URLs', () => {
      const result = validateWebhookUrl('https://example.com/webhook');
      expect(result.valid).toBe(true);
    });

    it('should reject HTTP URLs', () => {
      const result = validateWebhookUrl('http://example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('HTTPS');
    });

    it('should allow http://localhost when allowLocalhostHttp is true', () => {
      const result = validateWebhookUrl('http://localhost:3000/webhook', true);
      expect(result.valid).toBe(true);
    });

    it('should allow http://127.0.0.1 when allowLocalhostHttp is true', () => {
      const result = validateWebhookUrl('http://127.0.0.1:3000/webhook', true);
      expect(result.valid).toBe(true);
    });

    it('should require HTTPS for non-localhost even with allowLocalhostHttp', () => {
      const result = validateWebhookUrl('http://example.com/webhook', true);
      expect(result.valid).toBe(false);
    });
  });

  describe('fragment identifiers', () => {
    it('should reject URLs with fragments', () => {
      const result = validateWebhookUrl('https://example.com/webhook#section');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Fragment');
    });

    it('should accept URLs without fragments', () => {
      const result = validateWebhookUrl('https://example.com/webhook?query=1');
      expect(result.valid).toBe(true);
    });
  });

  describe('SSRF protection', () => {
    it('should block private IPs', () => {
      const result = validateWebhookUrl('https://192.168.1.1/webhook');
      expect(result.valid).toBe(false);
    });

    it('should block internal hostnames', () => {
      const result = validateWebhookUrl('https://service.internal/webhook');
      expect(result.valid).toBe(false);
    });
  });
});

describe('sanitizeUrlForLogging', () => {
  it('should remove credentials from URL', () => {
    const result = sanitizeUrlForLogging('https://user:password@example.com/path');
    expect(result).toBe('https://example.com/path');
    expect(result).not.toContain('user');
    expect(result).not.toContain('password');
  });

  it('should preserve other URL components', () => {
    const result = sanitizeUrlForLogging('https://example.com:8080/path?query=1');
    expect(result).toBe('https://example.com:8080/path?query=1');
  });

  it('should handle invalid URLs gracefully', () => {
    const result = sanitizeUrlForLogging('not-a-valid-url');
    expect(result).toBe('[invalid-url]');
  });

  it('should handle empty string', () => {
    const result = sanitizeUrlForLogging('');
    expect(result).toBe('[invalid-url]');
  });
});
