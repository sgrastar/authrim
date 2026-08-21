import { evaluateOpenID4VCMetadata, fetchOpenID4VCMetadata } from './openid4vc-metadata';

const targetOrigin = process.env.OIDF_OPENID4VC_TARGET_ORIGIN?.trim();
if (!targetOrigin) throw new Error('OIDF_OPENID4VC_TARGET_ORIGIN is required');

const metadata = await fetchOpenID4VCMetadata(targetOrigin);
const checks = evaluateOpenID4VCMetadata({ targetOrigin, ...metadata });
for (const entry of checks) {
  console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.profile}: ${entry.requirement}`);
}
console.log(
  JSON.stringify({
    targetOrigin,
    passed: checks.filter((entry) => entry.passed).length,
    failed: checks.filter((entry) => !entry.passed).length,
    checks,
  })
);
