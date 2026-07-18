import {
  assertPassingEvidence,
  collectProfileEvidence,
  parsePlanArgument,
  profilesForArgument,
} from './oidf-conformance';

const profiles = profilesForArgument(parsePlanArgument(process.argv.slice(2)));
const evidence = (
  await Promise.all(profiles.map((profile) => collectProfileEvidence(profile)))
).flat();

assertPassingEvidence(evidence);

for (const profile of profiles) {
  const entries = evidence.filter((entry) => entry.profile === profile);
  const plan = entries[0];
  console.log(
    `${profile}: PASS (${entries.length} modules, plan ${plan.planId}, ${plan.planName})`
  );
}
