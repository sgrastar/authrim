# Enrai - OpenID Conformance Test Results

This directory stores test results from the OpenID Conformance Suite.

## Directory Structure

```
test-results/
├── README.md                 # This file
├── result-YYYYMMDD-HHMM.json # Test results (JSON format)
└── report-YYYYMMDD.md        # Test report (Markdown format)
```

## How to Save Test Results

### 1. Export from OpenID Conformance Suite

After test completion, download the JSON test results with the following steps:

1. Click the "Export" button on the test results screen
2. Download in JSON format (`conformance-test-result-*.json`)
3. Move and save to this directory

```bash
# Move downloaded file
mv ~/Downloads/conformance-test-result-*.json .

# Rename with date
mv conformance-test-result-*.json result-$(date +%Y%m%d-%H%M).json
```

### 2. Create Test Report

Create a report based on the test results. Use the template [report-template.md](./report-template.md).

```bash
# Copy template
cp report-template.md report-$(date +%Y%m%d).md

# Edit with editor
vim report-$(date +%Y%m%d).md
```

## Recording Test Results

After each test execution, record the following information:

| Date | Tester | Version | Pass Rate | Report |
|------|----------|------------|--------|----------|
| 2025-11-11 | (Your Name) | v0.2.0 | XX% | [report-20251111.md](./report-20251111.md) |

## Goals

**Phase 3 Goals:**
- Conformance Score: ≥ 85%
- Critical Failures: 0
- Pass all Core Tests

**Phase 5 (Certification) Goals:**
- Conformance Score: ≥ 95%
- Pass all tests
- Minimize warnings

## Resources

- [Testing Guide](../testing-guide.md) - Detailed testing procedures
- [Phase 3 Quickstart](../phase3-quickstart.md) - Quick start guide
- [Manual Checklist](../manual-checklist.md) - Manual testing checklist

---

> 💥 **Enrai** - Test results tracking for OpenID Conformance
