import {
  collectProfileEvidence,
  isCertificationAcceptableEvidence,
  parsePlanArgument,
  profilesForArgument,
} from './oidf-conformance';

const argv = process.argv.slice(2);
const failedOnly = argv.includes('--failed-only');
const profiles = profilesForArgument(parsePlanArgument(argv));
const evidence = (
  await Promise.all(profiles.map((profile) => collectProfileEvidence(profile)))
).flat();

const selected = failedOnly
  ? evidence.filter((entry) => !isCertificationAcceptableEvidence(entry))
  : evidence;

if (selected.length === 0) {
  console.log(failedOnly ? 'No failed OIDF conformance modules.' : 'No module evidence found.');
} else {
  console.table(
    selected.map((entry) => ({
      profile: entry.profile,
      module: entry.moduleName,
      module_id: entry.moduleId,
      status: entry.status,
      result: entry.result,
    }))
  );
}
