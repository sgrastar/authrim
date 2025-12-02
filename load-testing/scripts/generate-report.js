#!/usr/bin/env node

/**
 * 負荷テストレポート生成スクリプト
 *
 * k6 の JSON 出力から以下を生成:
 * - HTML レポート（グラフ付き）
 * - Markdown サマリー（README 用）
 * - CSV エクスポート
 *
 * 環境変数:
 *   RESULTS_DIR      結果ディレクトリ (default: ../results)
 *   OUTPUT_DIR       出力ディレクトリ (default: ../results/reports)
 *   REPORT_NAME      レポート名 (default: performance-report)
 *
 * 使い方:
 *   node scripts/generate-report.js
 *   node scripts/generate-report.js --input=results/test4-mau-100k_2024-01-01.json
 *   node scripts/generate-report.js --all
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(SCRIPT_DIR, '..', 'results');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(RESULTS_DIR, 'reports');
const REPORT_NAME = process.env.REPORT_NAME || 'performance-report';

// MAU プリセット情報（参照用）
const MAU_PRESETS = {
  'mau-100k': { mau: 100000, description: 'MAU 100K - Startup scale' },
  'mau-500k': { mau: 500000, description: 'MAU 500K - Mid-size SaaS' },
  'mau-1m': { mau: 1000000, description: 'MAU 1M - Large SaaS' },
  'mau-2m': { mau: 2000000, description: 'MAU 2M - Enterprise scale' },
};

/**
 * 結果 JSON ファイルからテストデータを抽出
 * @param {string} jsonPath JSON ファイルパス
 * @returns {Object} 抽出されたデータ
 */
function extractTestData(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(raw);
  const metrics = data.metrics;

  // ファイル名からプリセット名を抽出
  const fileName = path.basename(jsonPath);
  const presetMatch = fileName.match(/test\d+-(mau-\d+[km])/i);
  const preset = presetMatch ? presetMatch[1].toLowerCase() : 'unknown';
  const presetInfo = MAU_PRESETS[preset] || { mau: 0, description: 'Unknown' };

  return {
    fileName,
    preset,
    presetInfo,
    timestamp: data.state?.testRunDurationMs
      ? new Date(Date.now() - data.state.testRunDurationMs).toISOString()
      : new Date().toISOString(),

    // リクエスト統計
    totalRequests: metrics.http_reqs?.values?.count || 0,
    failedRequests: metrics.http_req_failed?.values?.passes || 0,
    successRate: 1 - (metrics.http_req_failed?.values?.rate || 0),
    errorRate: (metrics.http_req_failed?.values?.rate || 0) * 100,

    // レスポンスタイム
    avgLatency: metrics.http_req_duration?.values?.avg || 0,
    p50Latency: metrics.http_req_duration?.values?.['p(50)'] || 0,
    p90Latency: metrics.http_req_duration?.values?.['p(90)'] || 0,
    p95Latency: metrics.http_req_duration?.values?.['p(95)'] || 0,
    p99Latency: metrics.http_req_duration?.values?.['p(99)'] || 0,
    maxLatency: metrics.http_req_duration?.values?.max || 0,

    // Token Rotation
    rotationSuccessRate: (metrics.token_rotation_success?.values?.rate || 0) * 100,
    rotationSuccessCount: metrics.token_rotation_success?.values?.passes || 0,
    rotationFailCount: metrics.token_rotation_success?.values?.fails || 0,

    // エラー
    serverErrors: metrics.server_errors?.values?.count || 0,

    // スループット
    rps: metrics.http_reqs?.values?.rate || 0,

    // 負荷レベル別（存在する場合）
    highLoadP95: metrics.high_load_request_duration?.values?.['p(95)'] || null,
    mediumLoadP95: metrics.medium_load_request_duration?.values?.['p(95)'] || null,
    lowLoadP95: metrics.low_load_request_duration?.values?.['p(95)'] || null,
  };
}

/**
 * 複数のテスト結果を集約
 * @param {string[]} jsonPaths JSON ファイルパスリスト
 * @returns {Object[]} 集約されたデータ
 */
function aggregateResults(jsonPaths) {
  const results = [];

  for (const jsonPath of jsonPaths) {
    try {
      const data = extractTestData(jsonPath);
      results.push(data);
    } catch (err) {
      console.error(`⚠️  Failed to parse ${jsonPath}: ${err.message}`);
    }
  }

  // プリセット順にソート
  const presetOrder = ['mau-100k', 'mau-500k', 'mau-1m', 'mau-2m'];
  results.sort((a, b) => {
    const aIndex = presetOrder.indexOf(a.preset);
    const bIndex = presetOrder.indexOf(b.preset);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });

  return results;
}

/**
 * Markdown サマリーを生成（README 用）
 * @param {Object[]} results テスト結果リスト
 * @returns {string} Markdown 文字列
 */
function generateMarkdownSummary(results) {
  const timestamp = new Date().toISOString().split('T')[0];

  let md = `## Performance Benchmarks

> Last updated: ${timestamp}
> Tested with distributed load across multiple OAuth clients (realistic multi-tenant simulation)

### MAU Capacity

| Target MAU | Peak RPS | Clients | p95 Latency | p99 Latency | Success Rate | Token Rotation |
|------------|----------|---------|-------------|-------------|--------------|----------------|
`;

  for (const result of results) {
    const mauDisplay =
      result.presetInfo.mau >= 1000000
        ? `${(result.presetInfo.mau / 1000000).toFixed(0)}M`
        : `${(result.presetInfo.mau / 1000).toFixed(0)}K`;

    md += `| ${mauDisplay} | ${result.rps.toFixed(0)} RPS | - | ${result.p95Latency.toFixed(0)}ms | ${result.p99Latency.toFixed(0)}ms | ${(result.successRate * 100).toFixed(2)}% | ${result.rotationSuccessRate.toFixed(1)}% |\n`;
  }

  md += `
### Key Metrics Explained

- **Peak RPS**: Requests per second during peak load (refresh token operations)
- **p95/p99 Latency**: 95th/99th percentile response time
- **Success Rate**: Percentage of successful requests (>99.9% target)
- **Token Rotation**: Successful refresh token rotation rate (>99% target)

### Test Methodology

- **Load Distribution**: Weighted distribution across multiple OAuth clients
  - High load clients (45% of traffic): Large enterprise tenants
  - Medium load clients (35% of traffic): Mid-size tenants
  - Low load clients (20% of traffic): Small tenants
- **Test Duration**: 5-10 minutes sustained load per MAU tier
- **Token Operations**: Refresh token rotation with family tracking

### MAU to RPS Conversion

\`\`\`
RPS_peak = (MAU × 0.2 × 14.1) / (8 × 3600) × 2.0 ≈ MAU / 5,000
\`\`\`

Parameters:
- DAU/MAU ratio: 20%
- Requests per DAU: 14.1 (logins + refreshes)
- Active hours: 8
- Peak factor: 2.0x
`;

  return md;
}

/**
 * HTML レポートを生成
 * @param {Object[]} results テスト結果リスト
 * @returns {string} HTML 文字列
 */
function generateHtmlReport(results) {
  const timestamp = new Date().toISOString();

  // データをChart.js用に整形
  const labels = results.map((r) => {
    const mau = r.presetInfo.mau;
    return mau >= 1000000 ? `${(mau / 1000000).toFixed(0)}M MAU` : `${(mau / 1000).toFixed(0)}K MAU`;
  });
  const p95Data = results.map((r) => r.p95Latency.toFixed(1));
  const p99Data = results.map((r) => r.p99Latency.toFixed(1));
  const rpsData = results.map((r) => r.rps.toFixed(1));
  const successData = results.map((r) => (r.successRate * 100).toFixed(2));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authrim Load Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #1a1a2e; margin-bottom: 10px; }
    h2 { color: #16213e; margin: 30px 0 15px; border-bottom: 2px solid #0f3460; padding-bottom: 5px; }
    h3 { color: #0f3460; margin: 20px 0 10px; }
    .timestamp { color: #666; font-size: 0.9em; margin-bottom: 30px; }
    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .metric {
      text-align: center;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-radius: 8px;
    }
    .metric .value { font-size: 2.5em; font-weight: bold; }
    .metric .label { font-size: 0.9em; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; font-weight: 600; }
    tr:hover { background: #f8f9fa; }
    .pass { color: #28a745; font-weight: bold; }
    .fail { color: #dc3545; font-weight: bold; }
    .chart-container { position: relative; height: 300px; margin: 20px 0; }
    .methodology { background: #e8f4fd; padding: 15px; border-radius: 8px; border-left: 4px solid #0d6efd; }
    code { background: #f1f1f1; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
  </style>
</head>
<body>
  <h1>Authrim Load Test Report</h1>
  <p class="timestamp">Generated: ${timestamp}</p>

  <div class="card">
    <h2>Executive Summary</h2>
    <div class="grid">
      <div class="metric">
        <div class="value">${results.length > 0 ? Math.max(...results.map((r) => r.presetInfo.mau / 1000000)).toFixed(0) : 0}M</div>
        <div class="label">Max Tested MAU</div>
      </div>
      <div class="metric" style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);">
        <div class="value">${results.length > 0 ? Math.max(...results.map((r) => r.rps)).toFixed(0) : 0}</div>
        <div class="label">Peak RPS Achieved</div>
      </div>
      <div class="metric" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
        <div class="value">${results.length > 0 ? Math.min(...results.map((r) => r.p95Latency)).toFixed(0) : 0}ms</div>
        <div class="label">Best p95 Latency</div>
      </div>
      <div class="metric" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">
        <div class="value">${results.length > 0 ? (Math.min(...results.map((r) => r.successRate)) * 100).toFixed(2) : 0}%</div>
        <div class="label">Min Success Rate</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>MAU Capacity Results</h2>
    <table>
      <thead>
        <tr>
          <th>MAU Tier</th>
          <th>Target RPS</th>
          <th>Actual RPS</th>
          <th>p95 Latency</th>
          <th>p99 Latency</th>
          <th>Success Rate</th>
          <th>Token Rotation</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${results
          .map((r) => {
            const mauDisplay =
              r.presetInfo.mau >= 1000000
                ? `${(r.presetInfo.mau / 1000000).toFixed(0)}M`
                : `${(r.presetInfo.mau / 1000).toFixed(0)}K`;
            const pass = r.successRate >= 0.999 && r.rotationSuccessRate >= 99;
            return `
          <tr>
            <td><strong>${mauDisplay}</strong></td>
            <td>${MAU_PRESETS[r.preset]?.targetRPS || '-'} RPS</td>
            <td>${r.rps.toFixed(1)} RPS</td>
            <td>${r.p95Latency.toFixed(1)}ms</td>
            <td>${r.p99Latency.toFixed(1)}ms</td>
            <td>${(r.successRate * 100).toFixed(2)}%</td>
            <td>${r.rotationSuccessRate.toFixed(1)}%</td>
            <td class="${pass ? 'pass' : 'fail'}">${pass ? '✅ PASS' : '❌ FAIL'}</td>
          </tr>
        `;
          })
          .join('')}
      </tbody>
    </table>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Latency by MAU Tier</h3>
      <div class="chart-container">
        <canvas id="latencyChart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3>RPS by MAU Tier</h3>
      <div class="chart-container">
        <canvas id="rpsChart"></canvas>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Success Rate by MAU Tier</h3>
    <div class="chart-container" style="height: 250px;">
      <canvas id="successChart"></canvas>
    </div>
  </div>

  <div class="card">
    <h2>Test Methodology</h2>
    <div class="methodology">
      <h3>Load Distribution</h3>
      <p>Tests simulate realistic multi-tenant environments with weighted client distribution:</p>
      <ul>
        <li><strong>High load clients (45%)</strong>: Large enterprise tenants</li>
        <li><strong>Medium load clients (35%)</strong>: Mid-size business tenants</li>
        <li><strong>Low load clients (20%)</strong>: Small/individual tenants</li>
      </ul>

      <h3>MAU to RPS Conversion</h3>
      <p><code>RPS_peak = (MAU × 0.2 × 14.1) / (8 × 3600) × 2.0 ≈ MAU / 5,000</code></p>

      <h3>Test Configuration</h3>
      <ul>
        <li>Duration: 5-10 minutes sustained load</li>
        <li>Token Rotation: Enabled for all tests</li>
        <li>Infrastructure: Cloudflare Workers + D1 + Durable Objects</li>
      </ul>
    </div>
  </div>

  <script>
    // Latency Chart
    new Chart(document.getElementById('latencyChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          {
            label: 'p95 Latency (ms)',
            data: ${JSON.stringify(p95Data)},
            backgroundColor: 'rgba(102, 126, 234, 0.8)',
            borderColor: 'rgba(102, 126, 234, 1)',
            borderWidth: 1
          },
          {
            label: 'p99 Latency (ms)',
            data: ${JSON.stringify(p99Data)},
            backgroundColor: 'rgba(118, 75, 162, 0.8)',
            borderColor: 'rgba(118, 75, 162, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'Latency (ms)' } }
        }
      }
    });

    // RPS Chart
    new Chart(document.getElementById('rpsChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [{
          label: 'Requests per Second',
          data: ${JSON.stringify(rpsData)},
          borderColor: 'rgba(17, 153, 142, 1)',
          backgroundColor: 'rgba(17, 153, 142, 0.1)',
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'RPS' } }
        }
      }
    });

    // Success Rate Chart
    new Chart(document.getElementById('successChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [{
          label: 'Success Rate (%)',
          data: ${JSON.stringify(successData)},
          backgroundColor: successData.map(v => parseFloat(v) >= 99.9 ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)'),
          borderColor: successData.map(v => parseFloat(v) >= 99.9 ? 'rgba(40, 167, 69, 1)' : 'rgba(220, 53, 69, 1)'),
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 99, max: 100, title: { display: true, text: 'Success Rate (%)' } }
        }
      }
    });
  </script>
</body>
</html>`;
}

/**
 * CSV を生成
 * @param {Object[]} results テスト結果リスト
 * @returns {string} CSV 文字列
 */
function generateCsv(results) {
  const headers = [
    'preset',
    'mau',
    'total_requests',
    'rps',
    'avg_latency_ms',
    'p50_latency_ms',
    'p90_latency_ms',
    'p95_latency_ms',
    'p99_latency_ms',
    'max_latency_ms',
    'success_rate',
    'error_rate',
    'rotation_success_rate',
    'server_errors',
  ];

  const rows = results.map((r) =>
    [
      r.preset,
      r.presetInfo.mau,
      r.totalRequests,
      r.rps.toFixed(2),
      r.avgLatency.toFixed(2),
      r.p50Latency.toFixed(2),
      r.p90Latency.toFixed(2),
      r.p95Latency.toFixed(2),
      r.p99Latency.toFixed(2),
      r.maxLatency.toFixed(2),
      (r.successRate * 100).toFixed(4),
      r.errorRate.toFixed(4),
      r.rotationSuccessRate.toFixed(2),
      r.serverErrors,
    ].join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

/**
 * メイン処理
 */
async function main() {
  const args = process.argv.slice(2);

  console.log(`📊 Authrim Load Test Report Generator`);
  console.log(`   RESULTS_DIR: ${RESULTS_DIR}`);
  console.log(`   OUTPUT_DIR:  ${OUTPUT_DIR}`);
  console.log('');

  // 出力ディレクトリ作成
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 入力ファイルを特定
  let jsonFiles = [];

  const inputArg = args.find((a) => a.startsWith('--input='));
  const allArg = args.includes('--all');

  if (inputArg) {
    // 単一ファイル指定
    const inputPath = inputArg.split('=')[1];
    jsonFiles = [path.resolve(inputPath)];
  } else if (allArg || args.length === 0) {
    // 全ファイル（test4 結果を優先）
    if (fs.existsSync(RESULTS_DIR)) {
      const files = fs.readdirSync(RESULTS_DIR);
      jsonFiles = files
        .filter((f) => f.endsWith('.json') && f.startsWith('test4-'))
        .map((f) => path.join(RESULTS_DIR, f));

      // test4 が無ければ test2 も含める
      if (jsonFiles.length === 0) {
        jsonFiles = files.filter((f) => f.endsWith('.json')).map((f) => path.join(RESULTS_DIR, f));
      }
    }
  }

  if (jsonFiles.length === 0) {
    console.log('❌ No result files found.');
    console.log('   Run load tests first, then try again.');
    console.log('');
    console.log('Usage:');
    console.log('  node generate-report.js                    # Process all results');
    console.log('  node generate-report.js --input=file.json  # Process single file');
    console.log('  node generate-report.js --all              # Process all results');
    process.exit(1);
  }

  console.log(`📁 Found ${jsonFiles.length} result file(s):`);
  jsonFiles.forEach((f) => console.log(`   - ${path.basename(f)}`));
  console.log('');

  // 結果を集約
  const results = aggregateResults(jsonFiles);

  if (results.length === 0) {
    console.log('❌ No valid results to process.');
    process.exit(1);
  }

  console.log(`📈 Processing ${results.length} test result(s)...`);
  console.log('');

  // レポート生成
  const timestamp = new Date().toISOString().split('T')[0];

  // Markdown サマリー
  const mdPath = path.join(OUTPUT_DIR, `${REPORT_NAME}-${timestamp}.md`);
  const mdContent = generateMarkdownSummary(results);
  fs.writeFileSync(mdPath, mdContent);
  console.log(`✅ Markdown summary: ${mdPath}`);

  // HTML レポート
  const htmlPath = path.join(OUTPUT_DIR, `${REPORT_NAME}-${timestamp}.html`);
  const htmlContent = generateHtmlReport(results);
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`✅ HTML report: ${htmlPath}`);

  // CSV エクスポート
  const csvPath = path.join(OUTPUT_DIR, `${REPORT_NAME}-${timestamp}.csv`);
  const csvContent = generateCsv(results);
  fs.writeFileSync(csvPath, csvContent);
  console.log(`✅ CSV export: ${csvPath}`);

  // 最新へのシンボリックリンク（または最新版コピー）
  const latestMdPath = path.join(OUTPUT_DIR, 'summary.md');
  const latestHtmlPath = path.join(OUTPUT_DIR, 'report.html');

  try {
    fs.copyFileSync(mdPath, latestMdPath);
    fs.copyFileSync(htmlPath, latestHtmlPath);
    console.log('');
    console.log(`📋 Latest summary: ${latestMdPath}`);
    console.log(`📋 Latest report:  ${latestHtmlPath}`);
  } catch {
    // シンボリックリンクに失敗した場合は無視
  }

  console.log('');
  console.log('🎉 Report generation complete!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
