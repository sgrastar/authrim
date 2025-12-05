#!/usr/bin/env node
/**
 * Cloudflare Workers Analytics Fetcher (Enhanced)
 *
 * Cloudflare GraphQL APIを使用して包括的なWorkers Analyticsを取得します。
 * Workers, Durable Objects, D1, KV のメトリクスを統合して取得。
 *
 * 必要な環境変数:
 *   CF_API_TOKEN: Cloudflare API Token (Analytics read権限が必要)
 *   CF_ACCOUNT_ID: Cloudflare Account ID (optional, default: REDACTED_ACCOUNT_ID)
 *
 * 使用方法:
 *   node scripts/fetch-cf-analytics.js --start "2025-11-30T10:20:00Z" --end "2025-11-30T10:35:00Z"
 *   node scripts/fetch-cf-analytics.js --minutes 10  # 過去10分間
 *   node scripts/fetch-cf-analytics.js --minutes 10 --json  # JSON形式で出力
 */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || 'REDACTED_ACCOUNT_ID';
const API_TOKEN = process.env.CF_API_TOKEN;

// Conformance環境のWorker名
const WORKER_SCRIPTS = [
  'conformance-authrim-op-token',
  'conformance-authrim-op-auth',
  'conformance-authrim-shared',
  'conformance-authrim-router',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { minutes: 10, json: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      result.start = args[i + 1];
      i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      result.end = args[i + 1];
      i++;
    } else if (args[i] === '--minutes' && args[i + 1]) {
      result.minutes = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--help') {
      console.log(`
Cloudflare Workers Analytics Fetcher (Enhanced)

Usage:
  node scripts/fetch-cf-analytics.js [options]

Options:
  --start <datetime>   Start time in ISO 8601 format
  --end <datetime>     End time in ISO 8601 format
  --minutes <n>        Fetch last n minutes (default: 10)
  --json               Output in JSON format (for programmatic use)
  --help               Show this help

Environment Variables:
  CF_API_TOKEN         Cloudflare API Token (required)
  CF_ACCOUNT_ID        Cloudflare Account ID (optional)

Collected Metrics:
  📗 Worker Metrics:
     - duration (p50/p90/p99)
     - cpu_time (p50/p90/p99)
     - worker_errors (5xx)
     - requests_by_status

  📙 Durable Objects Metrics:
     - do_duration (p50/p90/p99) - wallTime
     - do_requests_total
     - do_errors

  📕 D1 Metrics:
     - d1_read_count / d1_write_count
     - rows_read / rows_written

  📒 KV Metrics:
     - kv_reads_total / kv_writes_total

Examples:
  node scripts/fetch-cf-analytics.js --minutes 15
  node scripts/fetch-cf-analytics.js --start "2025-11-30T10:20:00Z" --end "2025-11-30T10:35:00Z"
  node scripts/fetch-cf-analytics.js --minutes 10 --json > metrics.json
`);
      process.exit(0);
    }
  }

  return result;
}

// Worker Analytics クエリ
async function fetchWorkersAnalytics(startTime, endTime) {
  if (!API_TOKEN) {
    throw new Error('CF_API_TOKEN environment variable is required');
  }

  const query = `
    query GetWorkersAnalytics($accountTag: String!, $datetimeStart: Time!, $datetimeEnd: Time!, $scriptNames: [String!]) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workersInvocationsAdaptive(
            filter: {
              datetime_geq: $datetimeStart
              datetime_leq: $datetimeEnd
              scriptName_in: $scriptNames
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP50
              cpuTimeP75
              cpuTimeP90
              cpuTimeP99
              cpuTimeP999
              durationP50
              durationP75
              durationP90
              durationP99
              durationP999
            }
            dimensions {
              scriptName
              status
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: ACCOUNT_ID,
        datetimeStart: startTime,
        datetimeEnd: endTime,
        scriptNames: WORKER_SCRIPTS,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL request failed: ${response.status} - ${text}`);
  }

  const result = await response.json();

  if (result.errors) {
    console.warn(`⚠️  GraphQL warnings: ${JSON.stringify(result.errors.map(e => e.message), null, 2)}`);
  }

  return result.data;
}

// Durable Objects Analytics クエリ
async function fetchDurableObjectsAnalytics(startTime, endTime) {
  if (!API_TOKEN) {
    throw new Error('CF_API_TOKEN environment variable is required');
  }

  const startDate = startTime.split('T')[0];

  const query = `
    query GetDurableObjectsAnalytics($accountTag: String!, $datetimeStart: Time!, $datetimeEnd: Time!, $startDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          durableObjectsInvocationsAdaptiveGroups(
            filter: {
              datetime_geq: $datetimeStart
              datetime_leq: $datetimeEnd
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              responseBodySize
              wallTime
            }
            quantiles {
              wallTimeP50
              wallTimeP75
              wallTimeP90
              wallTimeP99
              wallTimeP999
            }
            dimensions {
              scriptName
            }
          }
          durableObjectsStorageGroups(
            filter: {
              date_geq: $startDate
            }
            limit: 1000
          ) {
            max {
              storedBytes
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: ACCOUNT_ID,
          datetimeStart: startTime,
          datetimeEnd: endTime,
          startDate: startDate,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`DO Analytics request failed: ${response.status} - ${text}`);
      return null;
    }

    const result = await response.json();

    if (result.errors) {
      console.warn(`⚠️  DO GraphQL warnings: ${JSON.stringify(result.errors.map(e => e.message), null, 2)}`);
    }

    return result.data;
  } catch (error) {
    console.warn(`⚠️  DO Analytics fetch failed: ${error.message}`);
    return null;
  }
}

// D1 Analytics クエリ
async function fetchD1Analytics(startTime) {
  if (!API_TOKEN) {
    throw new Error('CF_API_TOKEN environment variable is required');
  }

  const startDate = startTime.split('T')[0];

  const query = `
    query GetD1Analytics($accountTag: String!, $startDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          d1AnalyticsAdaptiveGroups(
            filter: {
              date_geq: $startDate
            }
            limit: 10000
          ) {
            sum {
              readQueries
              writeQueries
              rowsRead
              rowsWritten
            }
            dimensions {
              databaseId
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: ACCOUNT_ID,
          startDate: startDate,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`D1 Analytics request failed: ${response.status} - ${text}`);
      return null;
    }

    const result = await response.json();

    if (result.errors) {
      console.warn(`⚠️  D1 GraphQL warnings: ${JSON.stringify(result.errors.map(e => e.message), null, 2)}`);
    }

    return result.data;
  } catch (error) {
    console.warn(`⚠️  D1 Analytics fetch failed: ${error.message}`);
    return null;
  }
}

// KV Analytics クエリ（利用可能なフィールドを確認後に実装）
async function fetchKVAnalytics() {
  // KV Analyticsは現在のスキーマでは利用可能なフィールドが限定的
  // 将来的に拡張予定
  return null;
}

// すべてのメトリクスを集約して構造化
function aggregateMetrics(workersData, doData, d1Data, kvData, startTime, endTime) {
  const metrics = {
    period: { start: startTime, end: endTime },
    worker: {
      duration: { p50: 0, p75: 0, p90: 0, p99: 0, p999: 0 },
      cpu_time: { p50: 0, p75: 0, p90: 0, p99: 0, p999: 0 },
      worker_errors: 0,
      total_requests: 0,
      total_subrequests: 0,
      requests_by_status: {},
      requests_by_script: {},
    },
    durable_objects: {
      wall_time: { p50: 0, p75: 0, p90: 0, p99: 0, p999: 0 },
      requests_total: 0,
      errors: 0,
      response_body_size: 0,
      total_wall_time: 0,
      storage_bytes: 0,
      by_script: {},
    },
    d1: {
      read_count: 0,
      write_count: 0,
      rows: { read: 0, written: 0 },
      by_database: {},
    },
    kv: {
      reads_total: 0,
      writes_total: 0,
    },
  };

  // Worker metrics
  if (workersData?.viewer?.accounts?.[0]) {
    const account = workersData.viewer.accounts[0];
    const invocations = account.workersInvocationsAdaptive || [];

    for (const inv of invocations) {
      const scriptName = inv.dimensions?.scriptName || 'unknown';
      const status = inv.dimensions?.status || 'unknown';
      const requests = inv.sum?.requests || 0;

      metrics.worker.total_requests += requests;
      metrics.worker.total_subrequests += inv.sum?.subrequests || 0;
      metrics.worker.worker_errors += inv.sum?.errors || 0;

      // Status別カウント
      if (status.startsWith('5') || status === 'error') {
        metrics.worker.requests_by_status['5xx/error'] = (metrics.worker.requests_by_status['5xx/error'] || 0) + requests;
      } else if (status.startsWith('4')) {
        metrics.worker.requests_by_status['4xx'] = (metrics.worker.requests_by_status['4xx'] || 0) + requests;
      } else if (status === 'success' || status.startsWith('2')) {
        metrics.worker.requests_by_status['success/2xx'] = (metrics.worker.requests_by_status['success/2xx'] || 0) + requests;
      } else {
        metrics.worker.requests_by_status[status] = (metrics.worker.requests_by_status[status] || 0) + requests;
      }

      // Script別
      if (!metrics.worker.requests_by_script[scriptName]) {
        metrics.worker.requests_by_script[scriptName] = { requests: 0, errors: 0, subrequests: 0 };
      }
      metrics.worker.requests_by_script[scriptName].requests += requests;
      metrics.worker.requests_by_script[scriptName].errors += inv.sum?.errors || 0;
      metrics.worker.requests_by_script[scriptName].subrequests += inv.sum?.subrequests || 0;

      // Quantiles (take max for percentiles)
      if (inv.quantiles) {
        // Duration (単位は秒、msに変換)
        metrics.worker.duration.p50 = Math.max(metrics.worker.duration.p50, (inv.quantiles.durationP50 || 0) * 1000);
        metrics.worker.duration.p75 = Math.max(metrics.worker.duration.p75, (inv.quantiles.durationP75 || 0) * 1000);
        metrics.worker.duration.p90 = Math.max(metrics.worker.duration.p90, (inv.quantiles.durationP90 || 0) * 1000);
        metrics.worker.duration.p99 = Math.max(metrics.worker.duration.p99, (inv.quantiles.durationP99 || 0) * 1000);
        metrics.worker.duration.p999 = Math.max(metrics.worker.duration.p999, (inv.quantiles.durationP999 || 0) * 1000);

        // CPU Time (単位はマイクロ秒、msに変換)
        metrics.worker.cpu_time.p50 = Math.max(metrics.worker.cpu_time.p50, (inv.quantiles.cpuTimeP50 || 0) / 1000);
        metrics.worker.cpu_time.p75 = Math.max(metrics.worker.cpu_time.p75, (inv.quantiles.cpuTimeP75 || 0) / 1000);
        metrics.worker.cpu_time.p90 = Math.max(metrics.worker.cpu_time.p90, (inv.quantiles.cpuTimeP90 || 0) / 1000);
        metrics.worker.cpu_time.p99 = Math.max(metrics.worker.cpu_time.p99, (inv.quantiles.cpuTimeP99 || 0) / 1000);
        metrics.worker.cpu_time.p999 = Math.max(metrics.worker.cpu_time.p999, (inv.quantiles.cpuTimeP999 || 0) / 1000);
      }
    }
  }

  // Durable Objects metrics
  if (doData?.viewer?.accounts?.[0]) {
    const account = doData.viewer.accounts[0];

    const doGroups = account.durableObjectsInvocationsAdaptiveGroups || [];
    for (const dg of doGroups) {
      const scriptName = dg.dimensions?.scriptName || 'unknown';
      const requests = dg.sum?.requests || 0;

      metrics.durable_objects.requests_total += requests;
      metrics.durable_objects.errors += dg.sum?.errors || 0;
      metrics.durable_objects.response_body_size += dg.sum?.responseBodySize || 0;
      metrics.durable_objects.total_wall_time += dg.sum?.wallTime || 0;

      // By script
      if (!metrics.durable_objects.by_script[scriptName]) {
        metrics.durable_objects.by_script[scriptName] = { requests: 0, errors: 0 };
      }
      metrics.durable_objects.by_script[scriptName].requests += requests;
      metrics.durable_objects.by_script[scriptName].errors += dg.sum?.errors || 0;

      // Quantiles (wallTime in microseconds -> ms)
      if (dg.quantiles) {
        metrics.durable_objects.wall_time.p50 = Math.max(metrics.durable_objects.wall_time.p50, (dg.quantiles.wallTimeP50 || 0) / 1000);
        metrics.durable_objects.wall_time.p75 = Math.max(metrics.durable_objects.wall_time.p75, (dg.quantiles.wallTimeP75 || 0) / 1000);
        metrics.durable_objects.wall_time.p90 = Math.max(metrics.durable_objects.wall_time.p90, (dg.quantiles.wallTimeP90 || 0) / 1000);
        metrics.durable_objects.wall_time.p99 = Math.max(metrics.durable_objects.wall_time.p99, (dg.quantiles.wallTimeP99 || 0) / 1000);
        metrics.durable_objects.wall_time.p999 = Math.max(metrics.durable_objects.wall_time.p999, (dg.quantiles.wallTimeP999 || 0) / 1000);
      }
    }

    // DO Storage
    const storageGroups = account.durableObjectsStorageGroups || [];
    for (const sg of storageGroups) {
      metrics.durable_objects.storage_bytes = Math.max(metrics.durable_objects.storage_bytes, sg.max?.storedBytes || 0);
    }
  }

  // D1 metrics
  if (d1Data?.viewer?.accounts?.[0]) {
    const account = d1Data.viewer.accounts[0];

    const d1Groups = account.d1AnalyticsAdaptiveGroups || [];
    for (const dg of d1Groups) {
      const dbId = dg.dimensions?.databaseId || 'unknown';

      metrics.d1.read_count += dg.sum?.readQueries || 0;
      metrics.d1.write_count += dg.sum?.writeQueries || 0;
      metrics.d1.rows.read += dg.sum?.rowsRead || 0;
      metrics.d1.rows.written += dg.sum?.rowsWritten || 0;

      // By database
      if (!metrics.d1.by_database[dbId]) {
        metrics.d1.by_database[dbId] = { reads: 0, writes: 0, rows_read: 0, rows_written: 0 };
      }
      metrics.d1.by_database[dbId].reads += dg.sum?.readQueries || 0;
      metrics.d1.by_database[dbId].writes += dg.sum?.writeQueries || 0;
      metrics.d1.by_database[dbId].rows_read += dg.sum?.rowsRead || 0;
      metrics.d1.by_database[dbId].rows_written += dg.sum?.rowsWritten || 0;
    }
  }

  return metrics;
}

// レポートをフォーマット
function formatReport(metrics) {
  let output = '\n';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += '  📊 Cloudflare Workers Analytics Report\n';
  output += '═══════════════════════════════════════════════════════════════════════════════\n';
  output += `  期間: ${metrics.period.start} ~ ${metrics.period.end}\n`;
  output += '───────────────────────────────────────────────────────────────────────────────\n\n';

  // Worker Metrics
  output += '📗 Worker メトリクス\n';
  output += '─────────────────────────────────────────────────────────────────────────────\n';
  output += `  総リクエスト数:        ${metrics.worker.total_requests.toLocaleString()}\n`;
  output += `  サブリクエスト数:      ${metrics.worker.total_subrequests.toLocaleString()}\n`;
  output += `  エラー数:              ${metrics.worker.worker_errors.toLocaleString()}\n`;
  output += `  エラー率:              ${metrics.worker.total_requests > 0 ? ((metrics.worker.worker_errors / metrics.worker.total_requests) * 100).toFixed(4) : 0}%\n\n`;

  output += `  Duration (Worker実行時間):\n`;
  output += `    p50:  ${metrics.worker.duration.p50.toFixed(2)} ms\n`;
  output += `    p75:  ${metrics.worker.duration.p75.toFixed(2)} ms\n`;
  output += `    p90:  ${metrics.worker.duration.p90.toFixed(2)} ms\n`;
  output += `    p99:  ${metrics.worker.duration.p99.toFixed(2)} ms\n`;
  output += `    p999: ${metrics.worker.duration.p999.toFixed(2)} ms\n\n`;

  output += `  CPU Time:\n`;
  output += `    p50:  ${metrics.worker.cpu_time.p50.toFixed(2)} ms\n`;
  output += `    p75:  ${metrics.worker.cpu_time.p75.toFixed(2)} ms\n`;
  output += `    p90:  ${metrics.worker.cpu_time.p90.toFixed(2)} ms\n`;
  output += `    p99:  ${metrics.worker.cpu_time.p99.toFixed(2)} ms\n`;
  output += `    p999: ${metrics.worker.cpu_time.p999.toFixed(2)} ms\n\n`;

  output += `  ステータス別リクエスト:\n`;
  for (const [status, count] of Object.entries(metrics.worker.requests_by_status).sort()) {
    output += `    ${status}: ${count.toLocaleString()}\n`;
  }
  output += '\n';

  output += `  Worker別リクエスト:\n`;
  for (const [script, stats] of Object.entries(metrics.worker.requests_by_script)) {
    const shortName = script.replace('conformance-authrim-', '');
    output += `    ${shortName}: ${stats.requests.toLocaleString()} (errors: ${stats.errors}, subreqs: ${stats.subrequests.toLocaleString()})\n`;
  }
  output += '\n';

  // Durable Objects Metrics
  output += '📙 Durable Objects メトリクス\n';
  output += '─────────────────────────────────────────────────────────────────────────────\n';
  output += `  総リクエスト数:        ${metrics.durable_objects.requests_total.toLocaleString()}\n`;
  output += `  エラー数:              ${metrics.durable_objects.errors.toLocaleString()}\n`;
  output += `  Response Body Size:    ${(metrics.durable_objects.response_body_size / 1024 / 1024).toFixed(2)} MB\n`;
  output += `  Total Wall Time:       ${(metrics.durable_objects.total_wall_time / 1000 / 1000).toFixed(2)} s\n`;
  output += `  Storage:               ${(metrics.durable_objects.storage_bytes / 1024).toFixed(2)} KB\n\n`;

  output += `  Wall Time (DO実行時間):\n`;
  output += `    p50:  ${metrics.durable_objects.wall_time.p50.toFixed(2)} ms\n`;
  output += `    p75:  ${metrics.durable_objects.wall_time.p75.toFixed(2)} ms\n`;
  output += `    p90:  ${metrics.durable_objects.wall_time.p90.toFixed(2)} ms\n`;
  output += `    p99:  ${metrics.durable_objects.wall_time.p99.toFixed(2)} ms\n`;
  output += `    p999: ${metrics.durable_objects.wall_time.p999.toFixed(2)} ms\n\n`;

  if (Object.keys(metrics.durable_objects.by_script).length > 0) {
    output += `  Script別:\n`;
    for (const [ns, stats] of Object.entries(metrics.durable_objects.by_script)) {
      const shortName = ns.replace('conformance-authrim-', '');
      output += `    ${shortName}: ${stats.requests.toLocaleString()} requests (errors: ${stats.errors})\n`;
    }
    output += '\n';
  }

  // D1 Metrics
  output += '📕 D1 データベース メトリクス\n';
  output += '─────────────────────────────────────────────────────────────────────────────\n';
  output += `  Read Queries:          ${metrics.d1.read_count.toLocaleString()}\n`;
  output += `  Write Queries:         ${metrics.d1.write_count.toLocaleString()}\n`;
  output += `  Rows Read:             ${metrics.d1.rows.read.toLocaleString()}\n`;
  output += `  Rows Written:          ${metrics.d1.rows.written.toLocaleString()}\n\n`;

  if (Object.keys(metrics.d1.by_database).length > 0) {
    output += `  Database別:\n`;
    for (const [dbId, stats] of Object.entries(metrics.d1.by_database)) {
      const shortId = dbId.substring(0, 8) + '...';
      output += `    ${shortId}: reads=${stats.reads}, writes=${stats.writes}, rows_r=${stats.rows_read}, rows_w=${stats.rows_written}\n`;
    }
    output += '\n';
  }

  // KV Metrics (現在は限定的)
  output += '📒 KV メトリクス\n';
  output += '─────────────────────────────────────────────────────────────────────────────\n';
  output += `  (KV詳細メトリクスはDashboardで確認してください)\n\n`;

  output += '═══════════════════════════════════════════════════════════════════════════════\n';

  return output;
}

async function main() {
  const args = parseArgs();

  let startTime, endTime;

  if (args.start && args.end) {
    startTime = args.start;
    endTime = args.end;
  } else {
    const now = new Date();
    const start = new Date(now.getTime() - args.minutes * 60 * 1000);
    startTime = start.toISOString();
    endTime = now.toISOString();
  }

  if (!args.json) {
    console.log(`\n🔍 Fetching Cloudflare Analytics...`);
    console.log(`   Period: ${startTime} ~ ${endTime}`);
    console.log(`   Account: ${ACCOUNT_ID}`);
    console.log(`   Workers: ${WORKER_SCRIPTS.join(', ')}\n`);
  }

  try {
    // 並列でデータを取得
    const [workersData, doData, d1Data, kvData] = await Promise.all([
      fetchWorkersAnalytics(startTime, endTime),
      fetchDurableObjectsAnalytics(startTime, endTime),
      fetchD1Analytics(startTime),
      fetchKVAnalytics(),
    ]);

    // メトリクスを集約
    const metrics = aggregateMetrics(workersData, doData, d1Data, kvData, startTime, endTime);

    if (args.json) {
      // JSON形式で出力
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      // レポート形式で出力
      const report = formatReport(metrics);
      console.log(report);

      // JSONも保存
      const fs = await import('fs');
      const path = await import('path');
      const __dirname = path.dirname(new URL(import.meta.url).pathname);
      const resultsDir = process.env.RESULTS_DIR || path.join(__dirname, '..', 'results');
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];

      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }

      const jsonPath = path.join(resultsDir, `cf-analytics_${timestamp}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify({
        metrics,
        raw: {
          workers: workersData,
          durable_objects: doData,
          d1: d1Data,
          kv: kvData,
        },
      }, null, 2));
      console.log(`\n📁 Raw data saved to: ${jsonPath}`);
    }

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
