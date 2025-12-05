#!/usr/bin/env node
/**
 * k6 CSV出力データを集計するスクリプト
 */

import fs from 'node:fs';

const resultDir = process.argv[2] || process.env.RESULTS_DIR;

if (!resultDir) {
  console.error('Usage: node aggregate-k6-csv.js <results_dir>');
  process.exit(1);
}

// Parse CSV helper
function parseCsv(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].replace(/"/g, '').split(',');
  return lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuote = false;
    for (const char of line) {
      if (char === '"') {
        inQuote = !inQuote;
      } else if (char === ',' && !inQuote) {
        values.push(current.replace(/"/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.replace(/"/g, ''));
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] || '';
    });
    return obj;
  });
}

// Read files
const iterations = parseCsv(fs.readFileSync(`${resultDir}/metric_iterations.csv`, 'utf-8'));
const tokenRotation = parseCsv(fs.readFileSync(`${resultDir}/metric_token_rotation_success.csv`, 'utf-8'));
const serverErrors = parseCsv(fs.readFileSync(`${resultDir}/metric_server_errors.csv`, 'utf-8'));
const httpDuration = parseCsv(fs.readFileSync(`${resultDir}/metric_http_req_duration.csv`, 'utf-8'));

// Aggregate iterations
const totalIterations = iterations.reduce((sum, row) => sum + parseInt(row.count || 0), 0);

// Aggregate token rotation
let rotationSuccess = 0;
let rotationTotal = 0;
tokenRotation.forEach(row => {
  rotationSuccess += parseInt(row.nz_count || 0);
  rotationTotal += parseInt(row.count || 0);
});

// Aggregate server errors
const totalServerErrors = serverErrors.reduce((sum, row) => sum + parseInt(row.count || 0), 0);

// Calculate duration percentiles (weighted)
let totalCount = 0;
let sumP50 = 0, sumP90 = 0, sumP95 = 0, sumP99 = 0, sumMean = 0;
let maxP99 = 0, maxMax = 0, minMin = Infinity;

httpDuration.forEach(row => {
  const count = parseInt(row.count || 0);
  if (count > 0) {
    totalCount += count;
    sumP50 += parseFloat(row.median || 0) * count;
    sumP90 += parseFloat(row.p95 || 0) * count;
    sumP99 += parseFloat(row.p99 || 0) * count;
    sumMean += parseFloat(row.mean || 0) * count;
    maxP99 = Math.max(maxP99, parseFloat(row.p99 || 0));
    maxMax = Math.max(maxMax, parseFloat(row.max || 0));
    minMin = Math.min(minMin, parseFloat(row.min || 0));
  }
});

// Calculate test duration
const times = iterations.map(r => new Date(r.time)).filter(d => !isNaN(d));
const startTime = new Date(Math.min(...times));
const endTime = new Date(Math.max(...times));
const durationSec = (endTime - startTime) / 1000;

// Calculate RPS
const rps = totalIterations / durationSec;

// Status code breakdown from httpDuration
const statusCounts = {};
httpDuration.forEach(row => {
  const status = row.status || 'unknown';
  statusCounts[status] = (statusCounts[status] || 0) + parseInt(row.count || 0);
});

console.log(JSON.stringify({
  test_period: {
    start: startTime.toISOString(),
    end: endTime.toISOString(),
    duration_sec: durationSec
  },
  k6_metrics: {
    total_iterations: totalIterations,
    total_http_requests: totalCount,
    rps: parseFloat(rps.toFixed(1)),
    token_rotation: {
      success: rotationSuccess,
      total: rotationTotal,
      rate: parseFloat((rotationSuccess / rotationTotal * 100).toFixed(2))
    },
    server_errors: totalServerErrors,
    latency_ms: {
      avg: totalCount > 0 ? parseFloat((sumMean / totalCount).toFixed(2)) : 0,
      p50: totalCount > 0 ? parseFloat((sumP50 / totalCount).toFixed(2)) : 0,
      p95: totalCount > 0 ? parseFloat((sumP90 / totalCount).toFixed(2)) : 0,
      p99: totalCount > 0 ? parseFloat((sumP99 / totalCount).toFixed(2)) : 0,
      max: parseFloat(maxMax.toFixed(2)),
      min: parseFloat(minMin.toFixed(2)),
      worst_p99: parseFloat(maxP99.toFixed(2))
    },
    status_codes: statusCounts
  }
}, null, 2));
