export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarizeProbes(samples, start, end) {
  const groups = {};
  // Include in-flight requests crossing the operation boundary.
  for (const sample of samples.filter((s) => s.startedMs <= end && s.finishedMs >= start)) {
    const key = `${sample.target}/${sample.operation}`;
    (groups[key] ??= []).push(sample);
  }
  return Object.fromEntries(
    Object.entries(groups).map(([key, group]) => [
      key,
      {
        requests: group.length,
        failures: group.filter((s) => !s.ok).length,
        timeouts: group.filter((s) => s.timeout).length,
        p50Ms: percentile(
          group.filter((s) => s.ok).map((s) => s.elapsedMs),
          50
        ),
        p95Ms: percentile(
          group.filter((s) => s.ok).map((s) => s.elapsedMs),
          95
        ),
        maxMs: Math.max(...group.map((s) => s.elapsedMs)),
        maxSqlWallMs: Math.max(0, ...group.map((s) => s.sqlWallMs ?? 0)),
        colos: [...new Set(group.map((s) => s.colo).filter(Boolean))],
      },
    ])
  );
}
