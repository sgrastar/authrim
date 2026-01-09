/**
 * HTML Template for Authrim Setup Web UI
 *
 * A simple, self-contained UI for the setup wizard.
 * Follows the setup flow defined in the design document.
 */

export function getHtmlTemplate(sessionToken?: string, manageOnly?: boolean): string {
  // Escape token for safe embedding in JavaScript
  const safeToken = sessionToken ? sessionToken.replace(/['"\\]/g, '') : '';
  const manageOnlyFlag = manageOnly ? 'true' : 'false';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authrim Setup</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
    }

    header {
      text-align: center;
      margin-bottom: 2rem;
    }

    h1 {
      font-size: 2rem;
      color: var(--primary);
      margin-bottom: 0.5rem;
    }

    .subtitle {
      color: var(--text-muted);
    }

    .card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 9999px;
      font-weight: 500;
    }

    .status-pending { background: var(--border); color: var(--text-muted); }
    .status-running { background: #dbeafe; color: var(--primary); }
    .status-success { background: #d1fae5; color: var(--success); }
    .status-error { background: #fee2e2; color: var(--error); }
    .status-warning { background: #fef3c7; color: #b45309; }

    /* Mode selection cards */
    .mode-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .mode-card {
      border: 2px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }

    .mode-card:hover {
      border-color: var(--primary);
      background: #f8fafc;
    }

    .mode-card.selected {
      border-color: var(--primary);
      background: #eff6ff;
    }

    .mode-card .mode-icon {
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }

    .mode-card h3 {
      font-size: 1.1rem;
      margin-bottom: 0.5rem;
    }

    .mode-card p {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }

    .mode-card ul {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-left: 1rem;
    }

    .mode-card ul li {
      margin-bottom: 0.25rem;
    }

    .mode-badge {
      position: absolute;
      top: -8px;
      right: 10px;
      background: var(--primary);
      color: white;
      font-size: 0.7rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-weight: 500;
    }

    .form-group {
      margin-bottom: 1rem;
    }

    label {
      display: block;
      font-weight: 500;
      margin-bottom: 0.5rem;
    }

    input[type="text"],
    input[type="password"],
    input[type="file"],
    select {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--primary);
    }

    /* Fix browser autofill/autocomplete styling */
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    input:-webkit-autofill:active {
      -webkit-box-shadow: 0 0 0 30px white inset !important;
      -webkit-text-fill-color: #1e293b !important;
      caret-color: #1e293b !important;
    }

    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    /* Infrastructure info section */
    .infra-section {
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }

    .infra-section h4 {
      margin: 0 0 0.75rem 0;
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    .infra-item {
      display: flex;
      justify-content: space-between;
      padding: 0.25rem 0;
      font-size: 0.85rem;
    }

    .infra-label {
      color: var(--text-muted);
    }

    .infra-value {
      font-family: monospace;
      color: var(--primary);
    }

    /* Domain configuration section */
    .domain-section {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }

    .domain-section h4 {
      margin: 0 0 0.5rem 0;
      font-size: 0.95rem;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .domain-section .section-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      padding: 0.5rem;
      background: #f0f9ff;
      border-radius: 4px;
    }

    .domain-row {
      display: grid;
      grid-template-columns: 90px 1fr;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .domain-row:last-of-type {
      margin-bottom: 0;
    }

    .domain-label {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    .domain-input-wrapper {
      position: relative;
    }

    .domain-input-wrapper input {
      padding-right: 180px;
    }

    .domain-default {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.7rem;
      color: var(--text-muted);
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .issuer-preview {
      margin-top: 0.75rem;
      padding: 0.5rem;
      background: #f0fdf4;
      border-radius: 4px;
      font-size: 0.85rem;
    }

    .issuer-preview .label {
      color: var(--text-muted);
      font-size: 0.75rem;
    }

    .issuer-preview .value {
      color: #16a34a;
      font-family: monospace;
      word-break: break-all;
    }

    button {
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--primary-dark);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: var(--border);
      color: var(--text);
    }

    .btn-secondary:hover {
      background: #cbd5e1;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      margin-top: 1.5rem;
    }

    .progress-log {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem;
      max-height: 300px;
      overflow-y: auto;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.875rem;
    }

    .progress-log pre {
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .step-indicator {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 2rem;
    }

    .step {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.875rem;
    }

    .step-active {
      background: var(--primary);
      color: white;
    }

    .step-complete {
      background: var(--success);
      color: white;
    }

    .step-pending {
      background: var(--border);
      color: var(--text-muted);
    }

    .step-connector {
      width: 40px;
      height: 2px;
      background: var(--border);
      align-self: center;
    }

    .alert {
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
    }

    .alert-success { background: #d1fae5; color: #065f46; }
    .alert-error { background: #fee2e2; color: #991b1b; }
    .alert-warning { background: #fef3c7; color: #92400e; }
    .alert-info { background: #dbeafe; color: #1e40af; }

    .url-display {
      background: var(--bg);
      padding: 1rem;
      border-radius: 8px;
      margin-top: 1rem;
    }

    .url-item {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .url-label {
      font-weight: 500;
      min-width: 100px;
    }

    .url-value {
      color: var(--primary);
      word-break: break-all;
      overflow-wrap: break-word;
    }

    .file-input-wrapper {
      position: relative;
      overflow: hidden;
      display: inline-block;
    }

    .file-input-wrapper input[type=file] {
      position: absolute;
      left: 0;
      top: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }

    .file-input-btn {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: var(--border);
      color: var(--text);
      border-radius: 8px;
      cursor: pointer;
    }

    .file-input-btn:hover {
      background: #cbd5e1;
    }

    .config-preview {
      background: var(--bg);
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.8rem;
      max-height: 200px;
      overflow-y: auto;
    }

    .hidden { display: none; }

    /* Modal styles */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal.hidden { display: none; }
    .modal-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
    }
    .modal-content {
      position: relative;
      background: var(--card-bg);
      border-radius: 12px;
      padding: 1.5rem;
      max-width: 450px;
      width: 90%;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }

    /* Resource preview styles */
    .resource-preview {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
    }

    .resource-list {
      display: grid;
      gap: 1rem;
    }

    .resource-category {
      font-size: 0.875rem;
    }

    .resource-category strong {
      display: block;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    .resource-category ul {
      margin: 0;
      padding-left: 1.5rem;
      color: var(--text-muted);
    }

    .resource-category li {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.8rem;
      margin-bottom: 0.25rem;
    }

    /* Progress spinner */
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 0.5rem;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .progress-item {
      display: flex;
      align-items: center;
      margin-bottom: 0.5rem;
      color: #e2e8f0;
    }

    .progress-item.complete {
      color: var(--success);
    }

    .progress-item.error {
      color: var(--error);
    }

    /* Environment cards */
    .env-cards {
      display: grid;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .env-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
    }

    .env-card:hover {
      border-color: var(--primary);
      background: #f8fafc;
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
    }

    .env-card-info {
      flex: 1;
    }

    .env-card-name {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .env-card-stats {
      display: flex;
      gap: 1rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .env-card-stat {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .env-card-actions {
      display: flex;
      gap: 0.5rem;
    }

    .btn-danger {
      background: var(--error);
      color: white;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
    }

    .btn-danger:hover {
      background: #dc2626;
    }

    .btn-info {
      background: var(--primary);
      color: white;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
    }

    .btn-info:hover {
      background: var(--primary-dark);
    }

    /* Resource list in details view */
    .resource-section {
      margin-bottom: 1.5rem;
    }

    .resource-section-title {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .resource-section-title .count {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-weight: normal;
    }

    .resource-list {
      background: var(--bg);
      border-radius: 8px;
      padding: 0.75rem;
    }

    .resource-item {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.8rem;
      padding: 0.25rem 0.5rem;
      margin-bottom: 0.25rem;
      background: var(--card-bg);
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .resource-item:last-child {
      margin-bottom: 0;
    }

    .resource-item-name {
      font-weight: 500;
    }

    .resource-item-details {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .resource-item-details span {
      margin-right: 1rem;
    }

    .resource-item-loading {
      color: var(--text-muted);
      font-style: italic;
    }

    .resource-item-error {
      color: var(--error);
    }

    .resource-item-not-deployed {
      color: var(--warning);
      font-style: italic;
    }

    .resource-empty {
      color: var(--text-muted);
      font-style: italic;
      font-size: 0.875rem;
    }

    /* Delete options */
    .delete-options {
      display: grid;
      gap: 0.75rem;
    }

    .delete-option {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
    }

    .delete-option:hover {
      background: var(--bg);
    }

    .delete-option input[type="checkbox"] {
      width: 18px;
      height: 18px;
    }

    .delete-option span {
      display: flex;
      flex-direction: column;
    }

    .delete-option small {
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    /* Database configuration styles */
    .database-config-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .database-config-stack {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .database-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }

    .database-card h3 {
      margin: 0 0 1rem 0;
      font-size: 1.1rem;
    }

    .db-description {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
    }

    .db-description p {
      margin: 0 0 0.5rem 0;
    }

    .db-description ul {
      margin: 0.5rem 0;
      padding-left: 1.25rem;
    }

    .db-description li {
      margin-bottom: 0.25rem;
    }

    .db-hint {
      font-style: italic;
      margin-top: 0.75rem;
      padding: 0.5rem;
      background: #f0f9ff;
      border-radius: 4px;
    }

    .region-selection h4 {
      margin: 0 0 0.75rem 0;
      font-size: 0.95rem;
      font-weight: 600;
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .radio-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      padding: 0.25rem 0;
    }

    .radio-item input[type="radio"] {
      margin: 0;
      width: 16px;
      height: 16px;
    }

    .radio-separator {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin: 0.5rem 0 0.25rem 0;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    @media (max-width: 768px) {
      .database-config-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔐 Authrim Setup</h1>
      <p class="subtitle">OIDC Provider on Cloudflare Workers</p>
    </header>

    <!-- Development Warning Banner -->
    <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem; text-align: center;">
      <strong style="color: #92400e;">⚠️ WARNING: Under Development!</strong>
      <p style="color: #78350f; margin: 0.5rem 0 0 0; font-size: 0.875rem;">
        This project is still under active development and does not work correctly yet.<br>
        Admin UI is incomplete and does not support login functionality.
      </p>
    </div>

    <div class="step-indicator" id="step-indicator">
      <div class="step step-active" id="step-1">1</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-2">2</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-3">3</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-4">4</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-5">5</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-6">6</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-7">7</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-8">8</div>
    </div>

    <!-- Step 1: Prerequisites -->
    <div id="section-prerequisites" class="card">
      <h2 class="card-title">
        Prerequisites
        <span class="status-badge status-running" id="prereq-status">Checking...</span>
      </h2>
      <div id="prereq-content">
        <p>Checking system requirements...</p>
      </div>
    </div>

    <!-- Step 1.5: Top Menu (New Setup / Load Config / Manage) -->
    <div id="section-top-menu" class="card hidden">
      <h2 class="card-title">Get Started</h2>
      <p style="margin-bottom: 1.5rem; color: var(--text-muted);">Choose an option to continue:</p>

      <div class="mode-cards" style="grid-template-columns: repeat(3, 1fr);">
        <div class="mode-card" id="menu-new-setup">
          <div class="mode-icon">🆕</div>
          <h3>New Setup</h3>
          <p>Create a new Authrim deployment from scratch</p>
        </div>

        <div class="mode-card" id="menu-load-config">
          <div class="mode-icon">📂</div>
          <h3>Load Config</h3>
          <p>Resume or redeploy using existing config</p>
        </div>

        <div class="mode-card" id="menu-manage-env">
          <div class="mode-icon">⚙️</div>
          <h3>Manage Environments</h3>
          <p>View, inspect, or delete existing environments</p>
        </div>
      </div>
    </div>

    <!-- Step 1.6: Setup Mode Selection (Quick / Custom) -->
    <div id="section-mode" class="card hidden">
      <h2 class="card-title">Setup Mode</h2>
      <p style="margin-bottom: 1.5rem; color: var(--text-muted);">Choose how you want to set up Authrim:</p>

      <div class="mode-cards">
        <div class="mode-card" id="mode-quick">
          <div class="mode-icon">⚡</div>
          <h3>Quick Setup</h3>
          <p>Get started in ~5 minutes</p>
          <ul>
            <li>Environment selection</li>
            <li>Optional custom domain</li>
            <li>Default components</li>
          </ul>
          <span class="mode-badge">Recommended</span>
        </div>

        <div class="mode-card" id="mode-custom">
          <div class="mode-icon">🔧</div>
          <h3>Custom Setup</h3>
          <p>Full control over configuration</p>
          <ul>
            <li>Component selection</li>
            <li>URL configuration</li>
            <li>Advanced settings</li>
          </ul>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-top">Back</button>
      </div>
    </div>

    <!-- Step 1.7: Load Config -->
    <div id="section-load-config" class="card hidden">
      <h2 class="card-title">Load Configuration</h2>
      <p style="margin-bottom: 1rem; color: var(--text-muted);">Select your authrim-config.json file:</p>

      <div class="form-group">
        <div class="file-input-wrapper">
          <span class="file-input-btn">📁 Choose File</span>
          <input type="file" id="config-file" accept=".json">
        </div>
        <span id="config-file-name" style="margin-left: 1rem; color: var(--text-muted);"></span>
      </div>

      <div id="config-preview-section" class="hidden">
        <h3 style="font-size: 1rem; margin-bottom: 0.5rem;">Configuration Preview</h3>
        <div class="config-preview" id="config-preview-content"></div>
      </div>

      <div id="config-validation-error" class="hidden" style="margin-top: 1rem; padding: 1rem; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 8px;">
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="font-size: 1.25rem;">⚠️</span>
          <strong style="color: #b91c1c;">Configuration Validation Failed</strong>
        </div>
        <ul id="config-validation-errors" style="margin: 0; padding-left: 1.5rem; color: #991b1b; font-size: 0.875rem;"></ul>
      </div>

      <div id="config-validation-success" class="hidden" style="margin-top: 1rem; padding: 0.75rem 1rem; background: #d1fae5; border: 1px solid #6ee7b7; border-radius: 8px;">
        <span style="color: #065f46;">✓ Configuration is valid</span>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-top-2">Back</button>
        <button class="btn-primary" id="btn-load-config" disabled>Load & Continue</button>
      </div>
    </div>

    <!-- Step 2: Configuration -->
    <div id="section-config" class="card hidden">
      <h2 class="card-title">Configuration</h2>

      <!-- 1. Components (shown in custom mode) -->
      <div id="advanced-options" class="hidden">
        <h3 style="margin: 0 0 1rem; font-size: 1rem;">📦 Components</h3>

        <!-- API Component (required) -->
        <div class="component-card" style="background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-api" checked disabled>
            🔐 API (required)
          </label>
          <p style="margin: 0.25rem 0 0.5rem 1.5rem; font-size: 0.85rem; color: var(--text-muted);">
            OIDC Provider endpoints: authorize, token, userinfo, discovery, management APIs.
          </p>
          <div style="margin-left: 1.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem;">
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-saml">
              SAML IdP
            </label>
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-async">
              Device Flow / CIBA
            </label>
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-vc">
              Verifiable Credentials
            </label>
          </div>
        </div>

        <!-- Login UI Component -->
        <div class="component-card" style="background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-login-ui" checked>
            🖥️ Login UI
          </label>
          <p style="margin: 0.25rem 0 0 1.5rem; font-size: 0.85rem; color: var(--text-muted);">
            User-facing login, registration, consent, and account management pages.
          </p>
        </div>

        <!-- Admin UI Component -->
        <div class="component-card" style="background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-admin-ui" checked>
            ⚙️ Admin UI
          </label>
          <p style="margin: 0.25rem 0 0 1.5rem; font-size: 0.85rem; color: var(--text-muted);">
            Admin dashboard for managing tenants, clients, users, and system settings.
          </p>
        </div>

        <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--border);">
      </div>

      <!-- 2. Environment Name -->
      <div class="form-group">
        <label for="env">Environment Name <span style="color: var(--error);">*</span></label>
        <input type="text" id="env" placeholder="e.g., prod, staging, dev" required>
        <small style="color: var(--text-muted)">Lowercase letters, numbers, and hyphens only</small>
      </div>

      <!-- 3. Domain Configuration -->
      <!-- 3.1 API / Issuer Domain -->
      <div class="domain-section">
        <h4>🌐 API / Issuer Domain</h4>

        <div class="form-group" style="margin-bottom: 0.75rem;">
          <label for="base-domain">Base Domain (API Domain)</label>
          <input type="text" id="base-domain" placeholder="oidc.example.com">
          <small style="color: var(--text-muted)">Custom domain for Authrim. Leave empty to use workers.dev</small>
          <label class="checkbox-item" id="naked-domain-label" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="checkbox" id="naked-domain">
            <span>Exclude tenant name from URL</span>
          </label>
          <small id="naked-domain-hint" style="color: var(--text-muted); margin-left: 1.5rem;">
            Use https://example.com instead of https://{tenant}.example.com
          </small>
          <small id="workers-dev-note" style="color: #d97706; margin-left: 1.5rem; display: none;">
            ⚠️ Tenant subdomains require a custom domain. Workers.dev does not support wildcard subdomains.
          </small>
        </div>

        <!-- Default Tenant (hidden when naked domain is checked or using workers.dev) -->
        <div id="tenant-fields">
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label for="tenant-name">Default Tenant ID</label>
            <input type="text" id="tenant-name" placeholder="default" value="default">
            <small style="color: var(--text-muted)">First tenant identifier (lowercase, no spaces)</small>
            <small id="tenant-workers-note" style="color: #6b7280; display: none;">
              (Tenant ID is used internally. URL subdomain requires custom domain.)
            </small>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 0;">
          <label for="tenant-display">Tenant Display Name</label>
          <input type="text" id="tenant-display" placeholder="My Company" value="Default Tenant">
          <small style="color: var(--text-muted)">Name shown on login page and consent screen</small>
        </div>
      </div>

      <!-- 3.2 UI Domains -->
      <div class="domain-section" id="ui-domains-section">
        <h4>🖥️ UI Domains (Optional)</h4>
        <div class="section-hint">
          Custom domains for Login/Admin UIs. Each can be set independently.
          Leave empty to use Cloudflare Pages default.
        </div>

        <div class="domain-row" id="login-domain-row">
          <span class="domain-label">Login UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="login-domain" placeholder="login.example.com">
            <span class="domain-default" id="login-default">{env}-ar-ui.pages.dev</span>
          </div>
        </div>

        <div class="domain-row" id="admin-domain-row">
          <span class="domain-label">Admin UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="admin-domain" placeholder="admin.example.com">
            <span class="domain-default" id="admin-default">{env}-ar-ui.pages.dev/admin</span>
          </div>
        </div>

        <div class="section-hint" style="margin-top: 0.75rem; background: #fef3c7;">
          💡 CORS: Cross-origin requests from Login/Admin UI to API are automatically allowed.
        </div>
      </div>

      <!-- 4. Preview Section (at the bottom) -->
      <div class="infra-section" id="config-preview">
        <h4>📋 Configuration Preview</h4>
        <div class="infra-item">
          <span class="infra-label">Components:</span>
          <span class="infra-value" id="preview-components">API, Login UI, Admin UI</span>
        </div>
        <div class="infra-item">
          <span class="infra-label">Workers:</span>
          <span class="infra-value" id="preview-workers">{env}-ar-router, {env}-ar-auth, ...</span>
        </div>
        <div class="infra-item">
          <span class="infra-label">Issuer URL:</span>
          <span class="infra-value" id="preview-issuer">https://{tenant}.{base-domain}</span>
        </div>
        <div class="infra-item">
          <span class="infra-label">Login UI:</span>
          <span class="infra-value" id="preview-login">{env}-ar-ui.pages.dev</span>
        </div>
        <div class="infra-item">
          <span class="infra-label">Admin UI:</span>
          <span class="infra-value" id="preview-admin">{env}-ar-ui.pages.dev/admin</span>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-mode">Back</button>
        <button class="btn-primary" id="btn-configure">Continue</button>
      </div>
    </div>

    <!-- Step 3: Database Configuration -->
    <div id="section-database" class="card hidden">
      <h2 class="card-title">🗄️ Database Configuration</h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);">
        Authrim uses two separate D1 databases to isolate personal data from application data.
      </p>

      <p style="margin-bottom: 1.5rem; font-size: 0.85rem; color: var(--text-muted);">
        Note: Database region cannot be changed after creation.
      </p>

      <div class="database-config-stack">
        <!-- Core Database (Non-PII) -->
        <div class="database-card">
          <h3>🗄️ Core Database <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">(Non-PII)</span></h3>
          <div class="db-description">
            <p>Stores non-personal application data including:</p>
            <ul>
              <li>OAuth clients and their configurations</li>
              <li>Authorization codes and access tokens</li>
              <li>User sessions and login state</li>
              <li>Tenant settings and configurations</li>
              <li>Audit logs and security events</li>
            </ul>
            <p class="db-hint">This database handles all authentication flows and should be placed close to your primary user base.</p>
          </div>

          <div class="region-selection">
            <h4>Region</h4>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="auto" checked>
                <span>Automatic (nearest to you)</span>
              </label>
              <div class="radio-separator">Location Hints</div>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="wnam">
                <span>North America (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="enam">
                <span>North America (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="weur">
                <span>Europe (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="eeur">
                <span>Europe (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="apac">
                <span>Asia Pacific</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="oc">
                <span>Oceania</span>
              </label>
              <div class="radio-separator">Jurisdiction (Compliance)</div>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="eu">
                <span>EU Jurisdiction (GDPR compliance)</span>
              </label>
            </div>
          </div>
        </div>

        <!-- PII Database -->
        <div class="database-card">
          <h3>🔒 PII Database <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">(Personal Identifiable Information)</span></h3>
          <div class="db-description">
            <p>Stores personal user data including:</p>
            <ul>
              <li>User profiles (name, email, phone)</li>
              <li>Passkey/WebAuthn credentials</li>
              <li>User preferences and settings</li>
              <li>Any custom user attributes</li>
            </ul>
            <p class="db-hint">This database contains personal data. Consider placing it in a region that complies with your data protection requirements.</p>
          </div>

          <div class="region-selection">
            <h4>Region</h4>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="auto" checked>
                <span>Automatic (nearest to you)</span>
              </label>
              <div class="radio-separator">Location Hints</div>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="wnam">
                <span>North America (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="enam">
                <span>North America (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="weur">
                <span>Europe (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="eeur">
                <span>Europe (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="apac">
                <span>Asia Pacific</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="oc">
                <span>Oceania</span>
              </label>
              <div class="radio-separator">Jurisdiction (Compliance)</div>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="eu">
                <span>EU Jurisdiction (GDPR compliance)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-database">Back</button>
        <button class="btn-primary" id="btn-continue-database">Continue</button>
      </div>
    </div>

    <!-- Step 4: Email Provider Configuration -->
    <div id="section-email" class="card hidden">
      <h2 class="card-title">📧 Email Provider</h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);">
        Used for sending Mail OTP and email address verification.
        You can configure this later if you prefer.
      </p>

      <div class="radio-group" style="margin-bottom: 1.5rem;">
        <label class="radio-item" style="padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;">
          <input type="radio" name="email-setup-choice" value="later" checked>
          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
            <strong>Configure later</strong>
            <small style="color: var(--text-muted);">Skip for now and configure later.</small>
          </span>
        </label>
        <label class="radio-item" style="padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; margin-top: 0.5rem;">
          <input type="radio" name="email-setup-choice" value="configure">
          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
            <strong>Configure Resend</strong>
            <small style="color: var(--text-muted);">Set up email sending with Resend (recommended for production).</small>
          </span>
        </label>
      </div>

      <!-- Resend Configuration Form (hidden by default) -->
      <div id="resend-config-form" class="hidden" style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem;">
        <h3 style="margin: 0 0 1rem 0; font-size: 1rem;">🔑 Resend Configuration</h3>

        <div class="alert alert-info" style="margin-bottom: 1rem;">
          <strong>📋 Before you begin:</strong>
          <ol style="margin: 0.5rem 0 0 1rem; padding: 0;">
            <li>Create a Resend account at <a href="https://resend.com" target="_blank" style="color: var(--primary);">resend.com</a></li>
            <li>Add and verify your domain at <a href="https://resend.com/domains" target="_blank" style="color: var(--primary);">Domains Dashboard</a></li>
            <li>Create an API key at <a href="https://resend.com/api-keys" target="_blank" style="color: var(--primary);">API Keys</a></li>
          </ol>
        </div>

        <div class="form-group">
          <label for="resend-api-key">Resend API Key</label>
          <input type="password" id="resend-api-key" placeholder="re_xxxxxxxxxx" autocomplete="off">
          <small style="color: var(--text-muted);">Your API key starts with "re_"</small>
        </div>

        <div class="form-group">
          <label for="email-from-address">From Email Address</label>
          <input type="email" id="email-from-address" placeholder="noreply@yourdomain.com" autocomplete="off">
          <small style="color: var(--text-muted);">Must be from a verified domain in your Resend account</small>
        </div>

        <div class="form-group">
          <label for="email-from-name">From Display Name (optional)</label>
          <input type="text" id="email-from-name" placeholder="Authrim" autocomplete="off">
          <small style="color: var(--text-muted);">Displayed as the sender name in email clients</small>
        </div>

        <div class="alert alert-warning" style="margin-top: 1rem;">
          <strong>⚠️ Domain Verification Required</strong>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.875rem;">
            Before your domain is verified, emails can only be sent from <code>onboarding@resend.dev</code> (for testing).
            <a href="https://resend.com/docs/dashboard/domains/introduction" target="_blank" style="color: var(--primary);">Learn more about domain verification →</a>
          </p>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-email">Back</button>
        <button class="btn-primary" id="btn-continue-email">Continue</button>
      </div>
    </div>

    <!-- Step 5: Provisioning -->
    <div id="section-provision" class="card hidden">
      <h2 class="card-title">
        Resource Provisioning
        <span class="status-badge status-pending" id="provision-status">Ready</span>
      </h2>

      <p style="margin-bottom: 1rem;">The following resources will be created:</p>

      <!-- Resource names preview -->
      <div id="resource-preview" class="resource-preview">
        <h4 style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">📋 Resource Names:</h4>
        <div class="resource-list">
          <div class="resource-category">
            <strong>D1 Databases:</strong>
            <ul id="preview-d1"></ul>
          </div>
          <div class="resource-category">
            <strong>KV Namespaces:</strong>
            <ul id="preview-kv"></ul>
          </div>
          <div class="resource-category">
            <strong>Cryptographic Keys:</strong>
            <ul id="preview-keys"></ul>
          </div>
        </div>
      </div>

      <div class="progress-log hidden" id="provision-log">
        <pre id="provision-output"></pre>
      </div>

      <!-- Keys saved location (shown after completion) -->
      <div id="keys-saved-info" class="alert alert-info hidden" style="margin-top: 1rem;">
        <strong>🔑 Keys saved to:</strong>
        <code style="display: block; margin-top: 0.5rem; padding: 0.5rem; background: #f1f5f9; border-radius: 4px;" id="keys-path"></code>
        <p style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);">
          ⚠️ Keep this directory safe and add it to .gitignore
        </p>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-config">Back</button>
        <button class="btn-primary" id="btn-provision">Create Resources</button>
        <button class="btn-secondary hidden" id="btn-save-config-provision" title="Save configuration to file">💾 Save Config</button>
        <button class="btn-primary hidden" id="btn-goto-deploy">Continue to Deploy →</button>
      </div>
    </div>

    <!-- Step 4: Deployment -->
    <div id="section-deploy" class="card hidden">
      <h2 class="card-title">
        Deployment
        <span class="status-badge status-pending" id="deploy-status">Ready</span>
      </h2>

      <p style="margin-bottom: 1rem;">Ready to deploy Authrim workers to Cloudflare.</p>

      <div class="progress-log hidden" id="deploy-log">
        <pre id="deploy-output"></pre>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-provision">Back</button>
        <button class="btn-primary" id="btn-deploy">Start Deploy</button>
      </div>
    </div>

    <!-- Complete -->
    <div id="section-complete" class="card hidden">
      <h2 class="card-title" style="color: var(--success);">
        ✅ Setup Complete!
      </h2>

      <p>Authrim has been successfully deployed.</p>

      <div class="url-display" id="urls">
        <!-- URLs will be inserted here -->
      </div>

      <div class="alert alert-info" style="margin-top: 1rem;">
        <strong>Next Steps:</strong>
        <ol style="margin-left: 1.5rem; margin-top: 0.5rem;">
          <li>Visit the <strong>Admin Setup</strong> URL above to register your first admin with Passkey</li>
          <li>Log in to the Admin UI to create OAuth clients</li>
          <li>Configure your application to use the OIDC endpoints</li>
        </ol>
      </div>

      <div class="button-group" style="margin-top: 1.5rem;">
        <button class="btn-secondary" id="btn-save-config-complete" title="Save configuration to file">💾 Save Configuration</button>
      </div>
    </div>

    <!-- Environment Management: List -->
    <div id="section-env-list" class="card hidden">
      <h2 class="card-title">
        Manage Environments
        <span class="status-badge status-pending" id="env-list-status">Loading...</span>
      </h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);">
        Detected Authrim environments in your Cloudflare account:
      </p>

      <div id="env-list-loading" class="progress-log">
        <pre id="env-scan-output"></pre>
      </div>

      <div id="env-list-content" class="hidden">
        <div id="env-cards" class="env-cards">
          <!-- Environment cards will be inserted here -->
        </div>

        <div id="no-envs-message" class="alert alert-info hidden">
          No Authrim environments detected in this Cloudflare account.
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-list">Back</button>
        <button class="btn-secondary" id="btn-refresh-env-list">🔄 Refresh</button>
      </div>
    </div>

    <!-- Environment Management: Details -->
    <div id="section-env-detail" class="card hidden">
      <h2 class="card-title">
        📋 Environment Details
        <code id="detail-env-name" style="background: var(--bg); padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 1rem;"></code>
      </h2>

      <div id="detail-resources">
        <!-- Workers -->
        <div class="resource-section">
          <div class="resource-section-title">
            🔧 Workers <span class="count" id="detail-workers-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-workers-list"></div>
        </div>

        <!-- D1 Databases -->
        <div class="resource-section">
          <div class="resource-section-title">
            📊 D1 Databases <span class="count" id="detail-d1-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-d1-list"></div>
        </div>

        <!-- KV Namespaces -->
        <div class="resource-section">
          <div class="resource-section-title">
            🗄️ KV Namespaces <span class="count" id="detail-kv-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-kv-list"></div>
        </div>

        <!-- Queues -->
        <div class="resource-section" id="detail-queues-section">
          <div class="resource-section-title">
            📨 Queues <span class="count" id="detail-queues-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-queues-list"></div>
        </div>

        <!-- R2 Buckets -->
        <div class="resource-section" id="detail-r2-section">
          <div class="resource-section-title">
            📁 R2 Buckets <span class="count" id="detail-r2-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-r2-list"></div>
        </div>

        <!-- Pages Projects -->
        <div class="resource-section" id="detail-pages-section">
          <div class="resource-section-title">
            📄 Pages Projects <span class="count" id="detail-pages-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-pages-list"></div>
        </div>
      </div>

      <!-- Admin Setup Section -->
      <div id="admin-setup-section" class="resource-section hidden" style="margin-top: 1.5rem; padding: 1rem; background: #fef3c7; border-radius: 8px; border: 1px solid #fcd34d;">
        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem;">
          <span style="font-size: 1.5rem;">⚠️</span>
          <div>
            <div style="font-weight: 600; color: #92400e;">Admin Account Not Configured</div>
            <div style="font-size: 0.875rem; color: #a16207;">Initial administrator has not been set up for this environment.</div>
          </div>
        </div>
        <button class="btn-primary" id="btn-start-admin-setup" style="margin-top: 0.5rem;">
          🔐 Start Admin Account Setup with Passkey
        </button>
        <div id="admin-setup-result" class="hidden" style="margin-top: 1rem; padding: 0.75rem; background: white; border-radius: 6px;">
          <div style="font-weight: 500; margin-bottom: 0.5rem;">Setup URL Generated:</div>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="text" id="admin-setup-url" readonly style="flex: 1; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-family: monospace; font-size: 0.875rem;">
            <button class="btn-secondary" id="btn-copy-setup-url" style="white-space: nowrap;">📋 Copy</button>
            <a id="btn-open-setup-url" href="#" target="_blank" class="btn-primary" style="text-decoration: none; white-space: nowrap;">🔗 Open</a>
          </div>
          <div style="font-size: 0.75rem; color: #6b7280; margin-top: 0.5rem;">
            This URL is valid for 1 hour. Open it in a browser to register the first admin account.
          </div>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-detail">← Back to List</button>
        <button class="btn-danger" id="btn-delete-from-detail">🗑️ Delete Environment...</button>
      </div>
    </div>

    <!-- Environment Management: Delete Confirmation -->
    <div id="section-env-delete" class="card hidden">
      <h2 class="card-title" style="color: var(--error);">
        ⚠️ Delete Environment
      </h2>

      <div class="alert alert-warning">
        <strong>Warning:</strong> This action is irreversible. All selected resources will be permanently deleted.
      </div>

      <div style="margin: 1.5rem 0;">
        <h3 style="font-size: 1.1rem; margin-bottom: 1rem;">
          Environment: <code id="delete-env-name" style="background: var(--bg); padding: 0.25rem 0.5rem; border-radius: 4px;"></code>
        </h3>

        <p style="margin-bottom: 1rem; color: var(--text-muted);">Select resources to delete:</p>

        <div class="delete-options">
          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-workers" checked>
            <span>
              <strong>Workers</strong>
              <small id="delete-workers-count">(0 workers)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-d1" checked>
            <span>
              <strong>D1 Databases</strong>
              <small id="delete-d1-count">(0 databases)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-kv" checked>
            <span>
              <strong>KV Namespaces</strong>
              <small id="delete-kv-count">(0 namespaces)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-queues" checked>
            <span>
              <strong>Queues</strong>
              <small id="delete-queues-count">(0 queues)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-r2" checked>
            <span>
              <strong>R2 Buckets</strong>
              <small id="delete-r2-count">(0 buckets)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-pages" checked>
            <span>
              <strong>Pages Projects</strong>
              <small id="delete-pages-count">(0 projects)</small>
            </span>
          </label>
        </div>
      </div>

      <div class="progress-log hidden" id="delete-log">
        <pre id="delete-output"></pre>
      </div>

      <div id="delete-result" class="hidden"></div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-delete">Cancel</button>
        <button class="btn-primary" id="btn-confirm-delete" style="background: var(--error);">🗑️ Delete Selected</button>
      </div>
    </div>
  </div>

  <!-- Save Config Modal -->
  <div id="save-config-modal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h3 style="margin: 0 0 1rem 0;">💾 Save Configuration?</h3>
      <p style="color: var(--text-muted); margin-bottom: 1.5rem;">
        Would you like to save your configuration to a file before proceeding?
        This allows you to resume setup later or use the same settings for another deployment.
      </p>
      <div class="button-group" style="justify-content: flex-end;">
        <button class="btn-secondary" id="modal-skip-save">Skip</button>
        <button class="btn-primary" id="modal-save-config">Save Configuration</button>
      </div>
    </div>
  </div>

  <script>
    // Session token for API authentication (embedded by server)
    const SESSION_TOKEN = '${safeToken}';
    const MANAGE_ONLY = ${manageOnlyFlag};

    // State
    let currentStep = 1;
    let setupMode = 'quick'; // 'quick' or 'custom'
    let config = {};
    let loadedConfig = null;
    let provisioningCompleted = false;
    let provisionPollInterval = null;

    // Elements
    const steps = {
      1: document.getElementById('step-1'),
      2: document.getElementById('step-2'),
      3: document.getElementById('step-3'),
      4: document.getElementById('step-4'),
      5: document.getElementById('step-5'),
      6: document.getElementById('step-6'),
      7: document.getElementById('step-7'),
      8: document.getElementById('step-8'),
    };

    const sections = {
      prerequisites: document.getElementById('section-prerequisites'),
      topMenu: document.getElementById('section-top-menu'),
      mode: document.getElementById('section-mode'),
      loadConfig: document.getElementById('section-load-config'),
      config: document.getElementById('section-config'),
      database: document.getElementById('section-database'),
      email: document.getElementById('section-email'),
      provision: document.getElementById('section-provision'),
      deploy: document.getElementById('section-deploy'),
      complete: document.getElementById('section-complete'),
      envList: document.getElementById('section-env-list'),
      envDetail: document.getElementById('section-env-detail'),
      envDelete: document.getElementById('section-env-delete'),
    };

    // Environment management state
    let detectedEnvironments = [];
    let selectedEnvForDetail = null;
    let selectedEnvForDelete = null;
    let workingDirectory = '';
    let workersSubdomain = ''; // e.g., 'sgrastar' for {worker}.sgrastar.workers.dev

    // API helpers (with session token authentication)
    async function api(endpoint, options = {}) {
      const response = await fetch('/api' + endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': SESSION_TOKEN,
        },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      return response.json();
    }

    // Step navigation
    function setStep(step) {
      currentStep = step;
      for (let i = 1; i <= 7; i++) {
        const el = steps[i];
        el.className = 'step ' + (i < step ? 'step-complete' : i === step ? 'step-active' : 'step-pending');
      }
    }

    function showSection(name) {
      Object.values(sections).forEach(s => s.classList.add('hidden'));
      sections[name].classList.remove('hidden');
    }

    // Auto-scroll helper for progress logs
    function scrollToBottom(element) {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }

    // Safe DOM element creation helpers
    function createAlert(type, content) {
      const div = document.createElement('div');
      div.className = 'alert alert-' + type;
      if (typeof content === 'string') {
        div.textContent = content;
      } else {
        div.appendChild(content);
      }
      return div;
    }

    function createUrlItem(label, url) {
      const div = document.createElement('div');
      div.className = 'url-item';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'url-label';
      labelSpan.textContent = label;

      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.className = 'url-value';
      link.textContent = url;

      div.appendChild(labelSpan);
      div.appendChild(link);
      return div;
    }

    // Check prerequisites
    async function checkPrerequisites() {
      const prereqStatus = document.getElementById('prereq-status');
      const prereqContent = document.getElementById('prereq-content');

      try {
        const result = await api('/prerequisites');

        // Clear existing content
        prereqContent.textContent = '';

        if (!result.wranglerInstalled) {
          prereqStatus.textContent = 'Error';
          prereqStatus.className = 'status-badge status-error';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-error';

          const title = document.createElement('strong');
          title.textContent = 'Wrangler not installed';
          alertDiv.appendChild(title);

          const para = document.createElement('p');
          para.textContent = 'Please install wrangler first:';
          alertDiv.appendChild(para);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.style.padding = '0.5rem';
          code.style.background = '#f1f5f9';
          code.style.borderRadius = '4px';
          code.textContent = 'npm install -g wrangler';
          alertDiv.appendChild(code);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        if (!result.auth.isLoggedIn) {
          prereqStatus.textContent = 'Login Required';
          prereqStatus.className = 'status-badge status-warning';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-warning';

          const title = document.createElement('strong');
          title.textContent = 'Not logged in to Cloudflare';
          alertDiv.appendChild(title);

          const para1 = document.createElement('p');
          para1.textContent = 'Please run this command in your terminal:';
          alertDiv.appendChild(para1);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.style.padding = '0.5rem';
          code.style.background = '#f1f5f9';
          code.style.borderRadius = '4px';
          code.textContent = 'wrangler login';
          alertDiv.appendChild(code);

          const para2 = document.createElement('p');
          para2.style.marginTop = '0.5rem';
          para2.textContent = 'Then refresh this page.';
          alertDiv.appendChild(para2);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        prereqStatus.textContent = 'Ready';
        prereqStatus.className = 'status-badge status-success';

        // Store working directory and workers subdomain for later use
        workingDirectory = result.cwd || '';
        workersSubdomain = result.workersSubdomain || '';

        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-success';

        const p1 = document.createElement('p');
        p1.textContent = '✓ Wrangler installed';
        alertDiv.appendChild(p1);

        const p2 = document.createElement('p');
        p2.textContent = '✓ Logged in as ' + (result.auth.email || 'Unknown');
        alertDiv.appendChild(p2);

        prereqContent.appendChild(alertDiv);

        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'button-group';

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.textContent = 'Continue';
        btn.addEventListener('click', showTopMenu);
        buttonGroup.appendChild(btn);

        prereqContent.appendChild(buttonGroup);

        return true;
      } catch (error) {
        prereqStatus.textContent = 'Error';
        prereqStatus.className = 'status-badge status-error';
        prereqContent.textContent = '';
        prereqContent.appendChild(createAlert('error', 'Error checking prerequisites: ' + error.message));
        return false;
      }
    }

    // Show top menu
    function showTopMenu() {
      showSection('topMenu');
    }

    // Top menu handlers
    document.getElementById('menu-new-setup').addEventListener('click', () => {
      showSection('mode');
    });

    document.getElementById('menu-load-config').addEventListener('click', () => {
      showSection('loadConfig');
    });

    // Setup mode handlers
    document.getElementById('mode-quick').addEventListener('click', () => {
      setupMode = 'quick';
      document.getElementById('mode-quick').classList.add('selected');
      document.getElementById('mode-custom').classList.remove('selected');
      document.getElementById('advanced-options').classList.add('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    document.getElementById('mode-custom').addEventListener('click', () => {
      setupMode = 'custom';
      document.getElementById('mode-custom').classList.add('selected');
      document.getElementById('mode-quick').classList.remove('selected');
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    document.getElementById('btn-back-top').addEventListener('click', () => {
      showSection('topMenu');
    });

    document.getElementById('btn-back-top-2').addEventListener('click', () => {
      showSection('topMenu');
    });

    // Load config handlers
    document.getElementById('config-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      document.getElementById('config-file-name').textContent = file.name;

      // Reset validation display
      document.getElementById('config-validation-error').classList.add('hidden');
      document.getElementById('config-validation-success').classList.add('hidden');
      document.getElementById('config-preview-section').classList.add('hidden');
      document.getElementById('btn-load-config').disabled = true;

      const reader = new FileReader();
      reader.onload = async (event) => {
        let rawConfig;
        try {
          rawConfig = JSON.parse(event.target.result);
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = 'Invalid JSON: ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
          return;
        }

        // Show preview
        document.getElementById('config-preview-content').textContent = JSON.stringify(rawConfig, null, 2);
        document.getElementById('config-preview-section').classList.remove('hidden');

        // Validate via API
        try {
          const response = await api('/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawConfig),
          });

          if (response.valid) {
            loadedConfig = response.config;
            document.getElementById('config-validation-success').classList.remove('hidden');
            document.getElementById('btn-load-config').disabled = false;
          } else {
            document.getElementById('config-validation-error').classList.remove('hidden');
            const errorList = document.getElementById('config-validation-errors');
            while (errorList.firstChild) errorList.removeChild(errorList.firstChild);

            if (response.errors) {
              for (const err of response.errors) {
                const li = document.createElement('li');
                li.textContent = (err.path ? err.path + ': ' : '') + err.message;
                errorList.appendChild(li);
              }
            } else if (response.error) {
              const li = document.createElement('li');
              li.textContent = response.error;
              errorList.appendChild(li);
            }
            loadedConfig = null;
          }
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = 'Validation request failed: ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-load-config').addEventListener('click', async () => {
      if (!loadedConfig) return;

      // Support both new format (v1.0.0) and old format (v0.1.x)
      const isNewFormat = loadedConfig.version === '1.0.0' || loadedConfig.environment?.prefix;

      // Extract values (with fallback for old format)
      const env = isNewFormat
        ? loadedConfig.environment?.prefix
        : loadedConfig.env || 'prod';

      const apiDomain = isNewFormat
        ? loadedConfig.urls?.api?.custom
        : loadedConfig.apiDomain;

      const loginUiDomain = isNewFormat
        ? loadedConfig.urls?.loginUi?.custom
        : loadedConfig.loginUiDomain;

      const adminUiDomain = isNewFormat
        ? loadedConfig.urls?.adminUi?.custom
        : loadedConfig.adminUiDomain;

      const tenant = loadedConfig.tenant || {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
      };

      const components = loadedConfig.components || {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      };

      // Build internal config
      config = {
        env,
        apiDomain: apiDomain || null,
        loginUiDomain: loginUiDomain || null,
        adminUiDomain: adminUiDomain || null,
        tenant,
        components,
      };

      // Set form values
      document.getElementById('env').value = config.env;
      document.getElementById('base-domain').value = config.tenant?.baseDomain || config.apiDomain || '';
      document.getElementById('login-domain').value = config.loginUiDomain || '';
      document.getElementById('admin-domain').value = config.adminUiDomain || '';
      document.getElementById('tenant-name').value = config.tenant?.name || 'default';
      document.getElementById('tenant-display').value = config.tenant?.displayName || 'Default Tenant';
      document.getElementById('naked-domain').checked = config.tenant?.nakedDomain || false;

      // Set component checkboxes
      if (document.getElementById('comp-login-ui')) {
        document.getElementById('comp-login-ui').checked = components.loginUi !== false;
      }
      if (document.getElementById('comp-admin-ui')) {
        document.getElementById('comp-admin-ui').checked = components.adminUi !== false;
      }
      if (document.getElementById('comp-saml')) {
        document.getElementById('comp-saml').checked = components.saml === true;
      }
      if (document.getElementById('comp-async')) {
        document.getElementById('comp-async').checked = components.async === true;
      }
      if (document.getElementById('comp-vc')) {
        document.getElementById('comp-vc').checked = components.vc === true;
      }

      // Trigger env input to update preview/default labels
      document.getElementById('env').dispatchEvent(new Event('input'));

      // Show configuration screen for review/editing
      // User can modify settings before proceeding to provision
      setupMode = 'custom'; // Enable all options for editing
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    // Configuration handlers
    // Update preview section when any input changes
    function updatePreview() {
      const env = document.getElementById('env').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '{env}';
      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomain = document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();

      // Components - build list based on mode and selections
      const components = ['API'];
      if (setupMode === 'quick') {
        components.push('Login UI', 'Admin UI');
      } else {
        if (document.getElementById('comp-login-ui').checked) components.push('Login UI');
        if (document.getElementById('comp-admin-ui').checked) components.push('Admin UI');
        if (document.getElementById('comp-saml').checked) components.push('SAML IdP');
        if (document.getElementById('comp-async').checked) components.push('Device Flow/CIBA');
        if (document.getElementById('comp-vc').checked) components.push('Verifiable Credentials');
      }
      document.getElementById('preview-components').textContent = components.join(', ');

      // Workers
      document.getElementById('preview-workers').textContent = env + '-ar-router, ' + env + '-ar-auth, ...';

      // Generate domains with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      // Note: Pages uses {project}.pages.dev format (no account subdomain, unlike Workers)
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Issuer URL
      // Note: Tenant subdomain is only supported with custom domains, NOT workers.dev
      // Workers.dev doesn't support wildcard subdomains, so tenant prefix cannot be used

      if (baseDomain) {
        // Custom domain - tenant prefix can be used
        if (nakedDomain) {
          document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
        } else {
          document.getElementById('preview-issuer').textContent = 'https://' + tenantName + '.' + baseDomain;
        }
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        document.getElementById('preview-issuer').textContent = 'https://' + workersDomain;
      }

      // Login UI - check if component is enabled (in custom mode)
      const loginUiEnabled = document.getElementById('comp-login-ui').checked;
      const previewLogin = document.getElementById('preview-login');
      if (!loginUiEnabled) {
        previewLogin.textContent = '(Not deployed)';
        previewLogin.style.color = 'var(--text-muted)';
      } else if (loginDomain) {
        previewLogin.textContent = 'https://' + loginDomain;
        previewLogin.style.color = '';
      } else {
        previewLogin.textContent = 'https://' + pagesDomain;
        previewLogin.style.color = '';
      }
      document.getElementById('login-default').textContent = pagesDomain;

      // Admin UI - check if component is enabled (in custom mode)
      const adminUiEnabled = document.getElementById('comp-admin-ui').checked;
      const previewAdmin = document.getElementById('preview-admin');
      if (!adminUiEnabled) {
        previewAdmin.textContent = '(Not deployed)';
        previewAdmin.style.color = 'var(--text-muted)';
      } else if (adminDomain) {
        previewAdmin.textContent = 'https://' + adminDomain;
        previewAdmin.style.color = '';
      } else {
        previewAdmin.textContent = 'https://' + pagesDomain + '/admin';
        previewAdmin.style.color = '';
      }
      document.getElementById('admin-default').textContent = pagesDomain + '/admin';
    }

    // Attach event listeners to all inputs
    ['env', 'base-domain', 'naked-domain', 'tenant-name', 'login-domain', 'admin-domain', 'comp-login-ui', 'comp-admin-ui', 'comp-saml', 'comp-async', 'comp-vc'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updatePreview);
        el.addEventListener('change', updatePreview);
      }
    });

    // Update UI based on base domain presence
    function updateBaseDomainUI() {
      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomainCheckbox = document.getElementById('naked-domain');
      const nakedDomainLabel = document.getElementById('naked-domain-label');
      const nakedDomainHint = document.getElementById('naked-domain-hint');
      const workersDevNote = document.getElementById('workers-dev-note');
      const tenantWorkersNote = document.getElementById('tenant-workers-note');
      const tenantFields = document.getElementById('tenant-fields');

      if (baseDomain) {
        // Custom domain - enable tenant subdomain options
        nakedDomainCheckbox.disabled = false;
        nakedDomainLabel.style.opacity = '1';
        nakedDomainHint.style.display = 'block';
        workersDevNote.style.display = 'none';
        tenantWorkersNote.style.display = 'none';
        // Show tenant fields if naked domain is not checked
        if (!nakedDomainCheckbox.checked) {
          tenantFields.style.display = 'block';
        }
      } else {
        // Workers.dev - tenant subdomains not supported
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.opacity = '0.5';
        nakedDomainHint.style.display = 'none';
        workersDevNote.style.display = 'block';
        tenantWorkersNote.style.display = 'block';
        tenantFields.style.display = 'block'; // Show tenant fields (for internal use)
      }
    }

    // Base domain change - update UI for tenant subdomain options
    document.getElementById('base-domain').addEventListener('input', () => {
      updateBaseDomainUI();
      updatePreview();
    });

    // Initial UI state
    updateBaseDomainUI();

    // Naked domain toggle - show/hide tenant name field and update placeholder
    document.getElementById('naked-domain').addEventListener('change', (e) => {
      const tenantFields = document.getElementById('tenant-fields');
      const baseDomainInput = document.getElementById('base-domain');
      if (e.target.checked) {
        tenantFields.style.display = 'none';
        baseDomainInput.placeholder = 'example.com';
      } else {
        tenantFields.style.display = 'block';
        baseDomainInput.placeholder = 'oidc.example.com';
      }
      updatePreview();
    });

    // Login UI component toggle - grey out domain settings when unchecked
    document.getElementById('comp-login-ui').addEventListener('change', (e) => {
      const loginDomainRow = document.getElementById('login-domain-row');
      const loginDomainInput = document.getElementById('login-domain');
      if (e.target.checked) {
        loginDomainRow.style.opacity = '1';
        loginDomainInput.disabled = false;
      } else {
        loginDomainRow.style.opacity = '0.4';
        loginDomainInput.disabled = true;
        loginDomainInput.value = '';
      }
      updatePreview();
    });

    // Admin UI component toggle - grey out domain settings when unchecked
    document.getElementById('comp-admin-ui').addEventListener('change', (e) => {
      const adminDomainRow = document.getElementById('admin-domain-row');
      const adminDomainInput = document.getElementById('admin-domain');
      if (e.target.checked) {
        adminDomainRow.style.opacity = '1';
        adminDomainInput.disabled = false;
      } else {
        adminDomainRow.style.opacity = '0.4';
        adminDomainInput.disabled = true;
        adminDomainInput.value = '';
      }
      updatePreview();
    });

    document.getElementById('btn-back-mode').addEventListener('click', () => {
      setStep(1);
      showSection('mode');
    });

    document.getElementById('btn-configure').addEventListener('click', async () => {
      // Get and validate environment name
      let env = document.getElementById('env').value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!env) {
        alert('Please enter a valid environment name');
        return;
      }

      // Check if environment already exists
      const configureBtn = document.getElementById('btn-configure');
      const originalText = configureBtn.textContent;
      configureBtn.textContent = 'Checking...';
      configureBtn.disabled = true;

      try {
        const envResult = await api('/environments');
        if (envResult.success && envResult.environments) {
          const existingEnv = envResult.environments.find(e => e.name === env);
          if (existingEnv) {
            alert('Environment "' + env + '" already exists.\\n\\nWorkers: ' + existingEnv.workers.length + ', D1: ' + existingEnv.d1.length + ', KV: ' + existingEnv.kv.length + '\\n\\nPlease choose a different name or use "Manage Environments" to delete it first.');
            return;
          }
        }
      } catch (e) {
        // Continue if check fails - will catch errors later
        console.warn('Environment check failed:', e);
      } finally {
        configureBtn.textContent = originalText;
        configureBtn.disabled = false;
      }

      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomain = document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const tenantDisplayName = document.getElementById('tenant-display').value.trim() || 'Default Tenant';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();

      // API domain = base domain or null (workers.dev fallback)
      const apiDomain = baseDomain || null;

      config = {
        env,
        apiDomain,
        loginUiDomain: loginDomain || null,
        adminUiDomain: adminDomain || null,
        tenant: {
          name: nakedDomain ? null : tenantName,  // null for naked domain
          displayName: tenantDisplayName,
          multiTenant: baseDomain ? true : false,  // Only multi-tenant with custom domain
          baseDomain: baseDomain || undefined,
          nakedDomain: baseDomain ? nakedDomain : false,
        },
        components: {
          api: true,
          loginUi: setupMode === 'quick' || document.getElementById('comp-login-ui').checked,
          adminUi: setupMode === 'quick' || document.getElementById('comp-admin-ui').checked,
          saml: setupMode === 'custom' && document.getElementById('comp-saml').checked,
          async: setupMode === 'custom' && document.getElementById('comp-async').checked,
          vc: setupMode === 'custom' && document.getElementById('comp-vc').checked,
          bridge: true, // Standard component
          policy: true, // Standard component
        },
      };

      // Create default config with component settings
      await api('/config/default', {
        method: 'POST',
        body: {
          env,
          apiDomain,
          loginUiDomain: loginDomain,
          adminUiDomain: adminDomain,
          tenant: config.tenant,
          components: config.components,
        },
      });

      // Update resource preview with the selected env
      updateResourcePreview(env);
      updateProvisionButtons();

      // Go to database configuration step
      setStep(4);
      showSection('database');
    });

    document.getElementById('btn-back-config').addEventListener('click', () => {
      // Go back to email configuration (previous step in the flow)
      setStep(5);
      showSection('email');
    });

    // Database configuration handlers
    document.getElementById('btn-back-database').addEventListener('click', () => {
      setStep(3);
      showSection('config');
    });

    document.getElementById('btn-continue-database').addEventListener('click', () => {
      // Get selected values
      const coreLocation = document.querySelector('input[name="db-core-location"]:checked').value;
      const piiLocation = document.querySelector('input[name="db-pii-location"]:checked').value;

      // Parse location vs jurisdiction
      function parseDbLocation(value) {
        if (value === 'eu') {
          return { location: 'auto', jurisdiction: 'eu' };
        }
        return { location: value, jurisdiction: 'none' };
      }

      // Add database config to config object
      config.database = {
        core: parseDbLocation(coreLocation),
        pii: parseDbLocation(piiLocation),
      };

      // Proceed to email configuration
      setStep(5);
      showSection('email');
    });

    // Email configuration handlers
    // Toggle resend config form visibility
    document.querySelectorAll('input[name="email-setup-choice"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const resendForm = document.getElementById('resend-config-form');
        const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
        if (choice === 'configure') {
          resendForm.classList.remove('hidden');
        } else {
          resendForm.classList.add('hidden');
        }
      });
    });

    document.getElementById('btn-back-email').addEventListener('click', () => {
      setStep(4);
      showSection('database');
    });

    document.getElementById('btn-continue-email').addEventListener('click', async () => {
      const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
      const btn = document.getElementById('btn-continue-email');

      if (choice === 'configure') {
        // Validate and store email configuration
        const apiKey = document.getElementById('resend-api-key').value.trim();
        const fromAddress = document.getElementById('email-from-address').value.trim();
        const fromName = document.getElementById('email-from-name').value.trim();

        // Validate API key format
        if (!apiKey) {
          alert('Please enter your Resend API key');
          return;
        }
        if (!apiKey.startsWith('re_')) {
          if (!confirm('API key does not start with "re_". This may not be a valid Resend API key. Continue anyway?')) {
            return;
          }
        }

        // Validate email address
        if (!fromAddress) {
          alert('Please enter a From email address');
          return;
        }
        if (!fromAddress.includes('@')) {
          alert('Please enter a valid email address');
          return;
        }

        // Save email configuration to server
        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
          const result = await api('/email/configure', {
            method: 'POST',
            body: {
              env: config.env,
              provider: 'resend',
              apiKey: apiKey,
              fromAddress: fromAddress,
              fromName: fromName || undefined,
            },
          });

          if (!result.success) {
            throw new Error(result.error || 'Failed to save email configuration');
          }

          // Store email configuration (without apiKey for config file)
          config.email = {
            provider: 'resend',
            fromAddress: fromAddress,
            fromName: fromName || undefined,
            configured: true,
          };
        } catch (error) {
          alert('Failed to save email configuration: ' + error.message);
          btn.disabled = false;
          btn.textContent = 'Continue';
          return;
        }

        btn.disabled = false;
        btn.textContent = 'Continue';
      } else {
        // Configure later - no email provider
        config.email = {
          provider: 'none',
        };
      }

      // Show save config modal before proceeding
      const modal = document.getElementById('save-config-modal');
      modal.classList.remove('hidden');
    });

    // Modal handlers
    document.getElementById('modal-skip-save').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    document.getElementById('modal-save-config').addEventListener('click', async () => {
      const modal = document.getElementById('save-config-modal');
      const btn = document.getElementById('modal-save-config');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        await saveConfigToFile();
        modal.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = 'Save Configuration';
        proceedToProvision();
      } catch (error) {
        alert('Failed to save configuration: ' + error.message);
        btn.disabled = false;
        btn.textContent = 'Save Configuration';
      }
    });

    // Close modal on backdrop click
    document.querySelector('.modal-backdrop').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    function proceedToProvision() {
      updateResourcePreview(config.env);
      setStep(6);
      showSection('provision');
    }

    // Provision
    document.getElementById('btn-provision').addEventListener('click', async () => {
      const btn = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const status = document.getElementById('provision-status');
      const log = document.getElementById('provision-log');
      const output = document.getElementById('provision-output');
      const resourcePreview = document.getElementById('resource-preview');
      const keysSavedInfo = document.getElementById('keys-saved-info');
      const keysPath = document.getElementById('keys-path');

      btn.disabled = true;
      btnGotoDeploy.classList.add('hidden');
      status.textContent = 'Running...';
      status.className = 'status-badge status-running';
      log.classList.remove('hidden');
      resourcePreview.classList.add('hidden');
      keysSavedInfo.classList.add('hidden');
      output.textContent = '';

      // Start polling for progress
      let lastProgressLength = 0;
      provisionPollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            // Append new progress messages
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        } catch (e) {
          // Ignore polling errors
        }
      }, 500);

      try {
        // Check if keys already exist for this environment
        const keysCheck = await api('/keys/check/' + config.env);
        if (keysCheck.exists) {
          output.textContent += '⚠️ Warning: Keys already exist for environment "' + config.env + '"\\n';
          output.textContent += '   Existing keys will be overwritten.\\n';
          output.textContent += '\\n';
          scrollToBottom(log);
        }

        // Generate keys
        output.textContent += '🔐 Generating cryptographic keys...\\n';
        scrollToBottom(log);
        const keyResult = await api('/keys/generate', {
          method: 'POST',
          body: { keyId: config.env + '-key-' + Date.now(), env: config.env },
        });
        output.textContent += '  ✓ RSA key pair generated\\n';
        output.textContent += '  ✓ Encryption keys generated\\n';
        output.textContent += '  ✓ Admin secrets generated\\n';
        output.textContent += '\\n';
        scrollToBottom(log);

        // Show keys saved location (full path with environment)
        keysPath.textContent = workingDirectory ? workingDirectory + '/.keys/' + config.env + '/' : './.keys/' + config.env + '/';

        // Provision resources
        output.textContent += '☁️ Provisioning Cloudflare resources...\\n';
        scrollToBottom(log);

        const result = await api('/provision', {
          method: 'POST',
          body: { env: config.env, databaseConfig: config.database },
        });

        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        if (result.success) {
          output.textContent += '\\n✅ Provisioning complete!\\n';
          scrollToBottom(log);
          status.textContent = 'Complete';
          status.className = 'status-badge status-success';

          // Mark provisioning as completed
          provisioningCompleted = true;

          // Show keys saved info
          keysSavedInfo.classList.remove('hidden');

          // Update buttons
          btn.textContent = 'Re-provision (Delete & Create)';
          btn.disabled = false;
          btnGotoDeploy.classList.remove('hidden');
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        output.textContent += '\\n❌ Error: ' + error.message + '\\n';
        scrollToBottom(log);
        status.textContent = 'Error';
        status.className = 'status-badge status-error';
        btn.disabled = false;
        resourcePreview.classList.remove('hidden');
      }
    });

    // Continue to Deploy button
    document.getElementById('btn-goto-deploy').addEventListener('click', () => {
      setStep(7);
      showSection('deploy');
    });

    document.getElementById('btn-back-provision').addEventListener('click', () => {
      setStep(6);
      // Update buttons based on provisioning status
      updateProvisionButtons();
      // Show resource preview if not completed
      if (!provisioningCompleted) {
        document.getElementById('resource-preview').classList.remove('hidden');
      }
      showSection('provision');
    });

    // Deploy
    document.getElementById('btn-deploy').addEventListener('click', async () => {
      const btn = document.getElementById('btn-deploy');
      const status = document.getElementById('deploy-status');
      const log = document.getElementById('deploy-log');
      const output = document.getElementById('deploy-output');

      btn.disabled = true;
      status.textContent = 'Deploying...';
      status.className = 'status-badge status-running';
      log.classList.remove('hidden');
      output.textContent = 'Starting deployment...\\n\\n';
      scrollToBottom(log);

      try {
        // Generate wrangler configs first
        output.textContent += 'Generating wrangler.toml files...\\n';
        scrollToBottom(log);
        await api('/wrangler/generate', {
          method: 'POST',
          body: { env: config.env },
        });
        output.textContent += '✓ Config files generated\\n\\n';
        scrollToBottom(log);

        // Start deployment
        output.textContent += 'Deploying workers...\\n';
        scrollToBottom(log);

        // Poll for status updates
        const pollInterval = setInterval(async () => {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > 0) {
            output.textContent = statusResult.progress.join('\\n') + '\\n';
            scrollToBottom(log);
          }
        }, 1000);

        const result = await api('/deploy', {
          method: 'POST',
          body: {
            env: config.env,
            dryRun: false,
          },
        });

        clearInterval(pollInterval);

        if (result.success) {
          output.textContent += '\\n✓ Deployment complete!\\n';
          scrollToBottom(log);

          // Complete admin setup to get setup URL
          output.textContent += '\\nSetting up initial admin...\\n';
          scrollToBottom(log);
          const workersDomain = workersSubdomain
            ? config.env + '-ar-router.' + workersSubdomain + '.workers.dev'
            : config.env + '-ar-router.workers.dev';
          // Build API URL
          // Note: Tenant subdomain only works with custom domains, NOT workers.dev
          let apiUrl;
          if (config.apiDomain) {
            // Custom domain - add tenant prefix if not naked domain
            if (config.tenant && config.tenant.name && !config.tenant.nakedDomain) {
              apiUrl = 'https://' + config.tenant.name + '.' + config.apiDomain;
            } else {
              apiUrl = 'https://' + config.apiDomain;
            }
          } else {
            // Workers.dev - no tenant prefix (wildcard subdomains not supported)
            apiUrl = 'https://' + workersDomain;
          }
          // Login UI URL for setup page (setup page is in Login UI, not API)
          const pagesDomain = config.env + '-ar-ui.pages.dev';
          const loginUiUrl = config.loginUiDomain ? 'https://' + config.loginUiDomain : 'https://' + pagesDomain;

          output.textContent += '  API URL: ' + apiUrl + '\\n';
          output.textContent += '  Login UI URL: ' + loginUiUrl + '\\n';
          output.textContent += '  Keys Dir: .keys/' + config.env + '\\n';
          scrollToBottom(log);

          let adminSetupResult;
          try {
            adminSetupResult = await api('/admin/setup', {
              method: 'POST',
              body: {
                env: config.env,
                baseUrl: apiUrl,  // Setup page is served by ar-auth worker (API)
                keysDir: '.keys',
              },
            });
            output.textContent += '  API Response: ' + JSON.stringify(adminSetupResult) + '\\n';
            scrollToBottom(log);
          } catch (adminError) {
            output.textContent += '  ✗ Admin setup API error: ' + adminError.message + '\\n';
            scrollToBottom(log);
            adminSetupResult = { success: false, error: adminError.message };
          }

          if (adminSetupResult.success && adminSetupResult.setupUrl) {
            output.textContent += '✓ Admin setup ready!\\n';
            output.textContent += '  Setup URL: ' + adminSetupResult.setupUrl + '\\n';
          } else if (adminSetupResult.alreadyCompleted) {
            output.textContent += 'ℹ Admin setup already completed\\n';
          } else if (adminSetupResult.error) {
            output.textContent += '⚠ Admin setup warning: ' + adminSetupResult.error + '\\n';
          } else {
            output.textContent += '⚠ Admin setup: No setup URL returned\\n';
          }
          scrollToBottom(log);

          status.textContent = 'Complete';
          status.className = 'status-badge status-success';

          // Show completion with setup URL and debug info
          showComplete({
            ...result,
            setupUrl: adminSetupResult.setupUrl,
            adminSetupDebug: adminSetupResult,
          });
        } else {
          throw new Error(result.error || 'Deployment failed');
        }
      } catch (error) {
        output.textContent += '\\n✗ Error: ' + error.message + '\\n';
        scrollToBottom(log);
        status.textContent = 'Error';
        status.className = 'status-badge status-error';
        btn.disabled = false;
      }
    });

    // Show completion
    function showComplete(result) {
      const urlsEl = document.getElementById('urls');
      const env = config.env;

      // Generate correct URLs with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      // Note: Pages uses {project}.pages.dev format (no account subdomain, unlike Workers)
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Build API URL
      // Note: Tenant subdomain only works with custom domains, NOT workers.dev
      let apiUrl;
      if (config.apiDomain) {
        // Custom domain - add tenant prefix if not naked domain
        if (config.tenant && config.tenant.name && !config.tenant.nakedDomain) {
          apiUrl = 'https://' + config.tenant.name + '.' + config.apiDomain;
        } else {
          apiUrl = 'https://' + config.apiDomain;
        }
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        apiUrl = 'https://' + workersDomain;
      }
      const loginUrl = config.loginUiDomain ? 'https://' + config.loginUiDomain : 'https://' + pagesDomain;
      const adminUrl = config.adminUiDomain ? 'https://' + config.adminUiDomain : 'https://' + pagesDomain + '/admin';

      // Clear and rebuild URLs section safely
      urlsEl.textContent = '';

      // API URL with OIDC Discovery link
      urlsEl.appendChild(createUrlItem('API (Issuer):', apiUrl));
      const discoveryUrl = apiUrl + '/.well-known/openid-configuration';
      urlsEl.appendChild(createUrlItem('Discovery:', discoveryUrl));

      urlsEl.appendChild(createUrlItem('Login UI:', loginUrl));
      urlsEl.appendChild(createUrlItem('Admin UI:', adminUrl));

      // Add setup URL if available
      if (result && result.setupUrl) {
        const setupItem = createUrlItem('Admin Setup:', result.setupUrl);
        setupItem.querySelector('a').style.fontWeight = 'bold';
        urlsEl.appendChild(setupItem);

        // Add warning about one-time use and time limit
        const setupNote = document.createElement('div');
        setupNote.style.cssText = 'margin-top: 0.5rem; margin-bottom: 0.5rem; padding: 0.5rem 0.75rem; background: #fef3c7; border-radius: 0.375rem; font-size: 0.85rem; color: #92400e;';
        setupNote.innerHTML = '⚠️ This URL can only be used <strong>once</strong> and expires in <strong>1 hour</strong>.';
        urlsEl.appendChild(setupNote);
      } else {
        // Show debug info when setup URL is missing
        const debugDiv = document.createElement('div');
        debugDiv.style.cssText = 'margin-top: 1rem; padding: 0.75rem; background: #fef3c7; border-radius: 0.5rem; font-size: 0.875rem;';
        debugDiv.innerHTML = '<strong>⚠️ Admin Setup URL not generated</strong><br>';
        if (result && result.adminSetupDebug) {
          const debug = result.adminSetupDebug;
          if (debug.error) {
            debugDiv.innerHTML += '<span style="color: #dc2626;">Error: ' + debug.error + '</span><br>';
          }
          if (debug.alreadyCompleted) {
            debugDiv.innerHTML += 'Status: Already completed (setup can only be done once)<br>';
          }
          debugDiv.innerHTML += '<br><small>Debug: ' + JSON.stringify(debug) + '</small>';
        } else {
          debugDiv.innerHTML += 'No debug information available';
        }
        urlsEl.appendChild(debugDiv);
      }

      setStep(8);
      showSection('complete');
    }

    // Resource naming functions
    function getResourceNames(env) {
      // Keys are stored in environment-specific subdirectory: .keys/{env}/
      const keysDir = workingDirectory ? workingDirectory + '/.keys/' + env : '.keys/' + env;
      return {
        d1: [
          env + '-authrim-core-db',
          env + '-authrim-pii-db'
        ],
        kv: [
          env + '-CLIENTS_CACHE',
          env + '-INITIAL_ACCESS_TOKENS',
          env + '-SETTINGS',
          env + '-REBAC_CACHE',
          env + '-USER_CACHE',
          env + '-AUTHRIM_CONFIG',
          env + '-STATE_STORE',
          env + '-CONSENT_CACHE'
        ],
        keys: [
          keysDir + '/private.pem (RSA Private Key)',
          keysDir + '/public.jwk.json (JWK Public Key)',
          keysDir + '/rp_token_encryption_key.txt',
          keysDir + '/admin_api_secret.txt',
          keysDir + '/key_manager_secret.txt',
          keysDir + '/setup_token.txt'
        ]
      };
    }

    // Get human-readable label for database region
    function getRegionLabel(location, jurisdiction) {
      if (jurisdiction === 'eu') {
        return 'EU Jurisdiction';
      }
      const labels = {
        'auto': 'Automatic',
        'wnam': 'North America (West)',
        'enam': 'North America (East)',
        'weur': 'Europe (West)',
        'eeur': 'Europe (East)',
        'apac': 'Asia Pacific',
        'oc': 'Oceania',
      };
      return labels[location] || 'Automatic';
    }

    function updateResourcePreview(env) {
      const resources = getResourceNames(env);

      const d1List = document.getElementById('preview-d1');
      const kvList = document.getElementById('preview-kv');
      const keysList = document.getElementById('preview-keys');

      d1List.innerHTML = '';
      kvList.innerHTML = '';
      keysList.innerHTML = '';

      // Get region info from config
      const coreRegion = config.database?.core || { location: 'auto', jurisdiction: 'none' };
      const piiRegion = config.database?.pii || { location: 'auto', jurisdiction: 'none' };

      // D1 databases with region info
      const coreDbName = env + '-authrim-core-db';
      const piiDbName = env + '-authrim-pii-db';

      const coreLi = document.createElement('li');
      coreLi.innerHTML = coreDbName + ' <span style="color: var(--text-muted); font-size: 0.85em;">(' + getRegionLabel(coreRegion.location, coreRegion.jurisdiction) + ')</span>';
      d1List.appendChild(coreLi);

      const piiLi = document.createElement('li');
      piiLi.innerHTML = piiDbName + ' <span style="color: var(--text-muted); font-size: 0.85em;">(' + getRegionLabel(piiRegion.location, piiRegion.jurisdiction) + ')</span>';
      d1List.appendChild(piiLi);

      resources.kv.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        kvList.appendChild(li);
      });

      resources.keys.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        keysList.appendChild(li);
      });
    }

    // Update provision button state based on completion status
    function updateProvisionButtons() {
      const btnProvision = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const btnSaveConfig = document.getElementById('btn-save-config-provision');

      if (provisioningCompleted) {
        btnProvision.textContent = 'Re-provision (Delete & Create)';
        btnProvision.disabled = false;
        btnGotoDeploy.classList.remove('hidden');
        btnSaveConfig.classList.remove('hidden');
      } else {
        btnProvision.textContent = 'Create Resources';
        btnProvision.disabled = false;
        btnGotoDeploy.classList.add('hidden');
        btnSaveConfig.classList.add('hidden');
      }
    }

    // Save configuration to file (AuthrimConfigSchema format)
    function saveConfigToFile() {
      if (!config || !config.env) {
        alert('No configuration to save');
        return;
      }

      const now = new Date().toISOString();
      const env = config.env;

      // Calculate auto-generated URLs
      const workersDomain = env + '-ar-router.workers.dev';
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Build issuer URL based on tenant settings
      let issuerAutoUrl = 'https://' + workersDomain;
      if (config.tenant && config.tenant.baseDomain) {
        if (config.tenant.nakedDomain) {
          issuerAutoUrl = 'https://' + config.tenant.baseDomain;
        } else {
          const tenantName = config.tenant.name || 'default';
          issuerAutoUrl = 'https://' + tenantName + '.' + config.tenant.baseDomain;
        }
      }

      // Build config in AuthrimConfigSchema format
      const configToSave = {
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
        environment: {
          prefix: env,
        },
        urls: {
          api: {
            custom: config.apiDomain || null,
            auto: config.apiDomain ? issuerAutoUrl : 'https://' + workersDomain,
          },
          loginUi: {
            custom: config.loginUiDomain || null,
            auto: 'https://' + pagesDomain,
          },
          adminUi: {
            custom: config.adminUiDomain || null,
            auto: 'https://' + pagesDomain + '/admin',
          },
        },
        tenant: {
          name: config.tenant?.name || 'default',
          displayName: config.tenant?.displayName || 'Default Tenant',
          multiTenant: config.tenant?.multiTenant || false,
          baseDomain: config.tenant?.baseDomain || undefined,
        },
        components: config.components || {
          api: true,
          loginUi: true,
          adminUi: true,
          saml: false,
          async: false,
          vc: false,
          bridge: true,
          policy: true,
        },
        keys: {
          secretsPath: './.keys/',
        },
        database: config.database || {
          core: { location: 'auto', jurisdiction: 'none' },
          pii: { location: 'auto', jurisdiction: 'none' },
        },
        features: {
          email: {
            provider: config.email?.provider || 'none',
            fromAddress: config.email?.fromAddress || undefined,
            fromName: config.email?.fromName || undefined,
            configured: config.email?.provider === 'resend' && config.email?.apiKey ? true : false,
          },
        },
      };

      // Remove undefined values for cleaner output
      if (!configToSave.tenant.baseDomain) {
        delete configToSave.tenant.baseDomain;
      }
      if (!configToSave.features.email.fromAddress) {
        delete configToSave.features.email.fromAddress;
      }
      if (!configToSave.features.email.fromName) {
        delete configToSave.features.email.fromName;
      }

      const blob = new Blob([JSON.stringify(configToSave, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'authrim-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Save config button handlers
    document.getElementById('btn-save-config-provision').addEventListener('click', saveConfigToFile);
    document.getElementById('btn-save-config-complete').addEventListener('click', saveConfigToFile);

    // =============================================================================
    // Environment Management
    // =============================================================================

    // Menu handler for environment management
    document.getElementById('menu-manage-env').addEventListener('click', () => {
      loadEnvironments();
      showSection('envList');
    });

    // Load environments
    async function loadEnvironments() {
      const status = document.getElementById('env-list-status');
      const loading = document.getElementById('env-list-loading');
      const content = document.getElementById('env-list-content');
      const output = document.getElementById('env-scan-output');
      const noEnvsMessage = document.getElementById('no-envs-message');

      status.textContent = 'Scanning...';
      status.className = 'status-badge status-running';
      loading.classList.remove('hidden');
      content.classList.add('hidden');
      output.textContent = '';

      // Poll for progress
      let lastProgressLength = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
            });
            lastProgressLength = statusResult.progress.length;
          }
        } catch (e) {}
      }, 500);

      try {
        const result = await api('/environments');
        clearInterval(pollInterval);

        if (result.success) {
          detectedEnvironments = result.environments || [];

          status.textContent = detectedEnvironments.length + ' found';
          status.className = 'status-badge status-success';
          loading.classList.add('hidden');
          content.classList.remove('hidden');

          renderEnvironmentCards();
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        clearInterval(pollInterval);
        status.textContent = 'Error';
        status.className = 'status-badge status-error';
        output.textContent += '\\n❌ Error: ' + error.message;
      }
    }

    // Render environment cards
    function renderEnvironmentCards() {
      const container = document.getElementById('env-cards');
      const noEnvsMessage = document.getElementById('no-envs-message');

      // Clear existing cards using safe method
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      if (detectedEnvironments.length === 0) {
        noEnvsMessage.classList.remove('hidden');
        return;
      }

      noEnvsMessage.classList.add('hidden');

      for (const env of detectedEnvironments) {
        const card = document.createElement('div');
        card.className = 'env-card';
        card.id = 'env-card-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_');

        const info = document.createElement('div');
        info.className = 'env-card-info';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;';

        const name = document.createElement('div');
        name.className = 'env-card-name';
        name.textContent = env.env;
        nameRow.appendChild(name);

        // Badge placeholder for admin status (will be populated async)
        const badgeContainer = document.createElement('span');
        badgeContainer.id = 'admin-badge-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_');
        nameRow.appendChild(badgeContainer);

        info.appendChild(nameRow);

        const stats = document.createElement('div');
        stats.className = 'env-card-stats';

        const statItems = [
          { icon: '🔧', label: 'Workers', count: env.workers.length },
          { icon: '📊', label: 'D1', count: env.d1.length },
          { icon: '🗄️', label: 'KV', count: env.kv.length },
          { icon: '📨', label: 'Queues', count: env.queues.length },
          { icon: '📁', label: 'R2', count: env.r2.length },
        ];

        for (const item of statItems) {
          if (item.count > 0) {
            const stat = document.createElement('span');
            stat.className = 'env-card-stat';
            stat.textContent = item.icon + ' ' + item.count + ' ' + item.label;
            stats.appendChild(stat);
          }
        }

        info.appendChild(stats);
        card.appendChild(info);

        // Make entire card clickable
        card.addEventListener('click', () => showEnvDetail(env));
        container.appendChild(card);

        // Check admin status and add badge if needed
        checkAndAddAdminBadge(env);
      }
    }

    // Check admin status and add badge to environment card
    async function checkAndAddAdminBadge(env) {
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      if (!configKv || !configKv.id) return;

      try {
        const response = await api('/admin/status/' + encodeURIComponent(configKv.id));
        if (response.success && !response.adminSetupCompleted) {
          const badgeContainer = document.getElementById('admin-badge-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_'));
          if (badgeContainer) {
            const badge = document.createElement('span');
            badge.className = 'status-badge status-warning';
            badge.style.cssText = 'font-size: 0.75rem; padding: 0.125rem 0.5rem;';
            badge.textContent = 'Admin未設定';
            badgeContainer.appendChild(badge);
          }
        }
      } catch (error) {
        console.error('Failed to check admin status for ' + env.env + ':', error);
      }
    }

    // Show environment details
    function showEnvDetail(env) {
      selectedEnvForDetail = env;

      document.getElementById('detail-env-name').textContent = env.env;

      // Render resource lists with loading state
      renderResourceList('detail-workers-list', 'detail-workers-count', env.workers, 'name', 'worker');
      renderResourceList('detail-d1-list', 'detail-d1-count', env.d1, 'name', 'd1');
      renderResourceList('detail-kv-list', 'detail-kv-count', env.kv, 'name', 'kv');
      renderResourceList('detail-queues-list', 'detail-queues-count', env.queues, 'name', 'queue');
      renderResourceList('detail-r2-list', 'detail-r2-count', env.r2, 'name', 'r2');
      renderResourceList('detail-pages-list', 'detail-pages-count', env.pages || [], 'name', 'pages');

      // Hide empty sections
      document.getElementById('detail-queues-section').style.display = env.queues.length === 0 ? 'none' : 'block';
      document.getElementById('detail-r2-section').style.display = env.r2.length === 0 ? 'none' : 'block';
      document.getElementById('detail-pages-section').style.display = (env.pages || []).length === 0 ? 'none' : 'block';

      // Check and show/hide admin setup section
      const adminSetupSection = document.getElementById('admin-setup-section');
      const resultDiv = document.getElementById('admin-setup-result');
      const btn = document.getElementById('btn-start-admin-setup');

      // Reset state
      adminSetupSection.classList.add('hidden');
      resultDiv.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = '🔐 Start Admin Account Setup with Passkey';

      // Find AUTHRIM_CONFIG KV namespace
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      if (configKv && configKv.id) {
        // Check admin setup status asynchronously
        checkAndShowAdminSetup(configKv.id);
      }

      showSection('envDetail');

      // Load details asynchronously
      loadResourceDetails(env);
    }

    // Check admin setup status and show section if needed
    async function checkAndShowAdminSetup(kvNamespaceId) {
      try {
        const response = await api('/admin/status/' + encodeURIComponent(kvNamespaceId));
        if (response.success && !response.adminSetupCompleted) {
          document.getElementById('admin-setup-section').classList.remove('hidden');
        }
      } catch (error) {
        console.error('Failed to check admin status:', error);
      }
    }

    // Helper to render resource list
    function renderResourceList(listId, countId, resources, nameKey, resourceType) {
      const list = document.getElementById(listId);
      const count = document.getElementById(countId);

      list.innerHTML = '';
      count.textContent = '(' + resources.length + ')';

      if (resources.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'resource-empty';
        empty.textContent = 'None';
        list.appendChild(empty);
        return;
      }

      for (const resource of resources) {
        const item = document.createElement('div');
        item.className = 'resource-item';
        item.id = 'resource-' + resourceType + '-' + (resource.name || resource.title || '').replace(/[^a-zA-Z0-9-]/g, '_');

        const nameDiv = document.createElement('div');
        nameDiv.className = 'resource-item-name';
        nameDiv.textContent = resource[nameKey] || resource.title || resource.id || 'Unknown';
        item.appendChild(nameDiv);

        // Add loading placeholder for D1 and Workers
        if (resourceType === 'd1' || resourceType === 'worker') {
          const detailsDiv = document.createElement('div');
          detailsDiv.className = 'resource-item-details resource-item-loading';
          detailsDiv.textContent = 'Loading...';
          item.appendChild(detailsDiv);
        }

        list.appendChild(item);
      }
    }

    // Load resource details asynchronously
    async function loadResourceDetails(env) {
      // Load D1 and Worker details in parallel
      const d1Promises = env.d1.map(db => loadD1Details(db.name));
      const workerPromises = env.workers.map(w => loadWorkerDetails(w.name));

      // Wait for all to complete (don't block on errors)
      await Promise.allSettled([...d1Promises, ...workerPromises]);
    }

    // Load D1 database details
    async function loadD1Details(name) {
      try {
        const result = await fetch('/api/d1/' + encodeURIComponent(name) + '/info').then(r => r.json());

        const itemId = 'resource-d1-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.info) {
          const info = result.info;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (info.databaseSize) {
            const span = document.createElement('span');
            span.textContent = '📦 ' + info.databaseSize;
            detailsDiv.appendChild(span);
          }
          if (info.region) {
            const span = document.createElement('span');
            span.textContent = '🌍 ' + info.region;
            detailsDiv.appendChild(span);
          }
          if (info.createdAt) {
            const span = document.createElement('span');
            span.textContent = '📅 ' + formatDate(info.createdAt);
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-error';
          detailsDiv.textContent = 'Failed to load';
        }
      } catch (e) {
        console.error('Failed to load D1 details:', e);
      }
    }

    // Load Worker deployment details
    async function loadWorkerDetails(name) {
      try {
        const result = await fetch('/api/worker/' + encodeURIComponent(name) + '/deployments').then(r => r.json());

        const itemId = 'resource-worker-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.deployments) {
          const info = result.deployments;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (!info.exists) {
            detailsDiv.className = 'resource-item-details resource-item-not-deployed';
            detailsDiv.textContent = '⚠️ Not deployed';
            return;
          }

          if (info.lastDeployedAt) {
            const span = document.createElement('span');
            span.textContent = '🚀 ' + formatDate(info.lastDeployedAt);
            detailsDiv.appendChild(span);
          }
          if (info.author) {
            const span = document.createElement('span');
            span.textContent = '👤 ' + info.author;
            detailsDiv.appendChild(span);
          }
          if (info.versionId) {
            const span = document.createElement('span');
            span.textContent = '🏷️ ' + info.versionId.substring(0, 8) + '...';
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-not-deployed';
          detailsDiv.textContent = '⚠️ Not deployed';
        }
      } catch (e) {
        console.error('Failed to load Worker details:', e);
      }
    }

    // Format ISO date to readable format with timezone
    function formatDate(isoString) {
      try {
        const date = new Date(isoString);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Get timezone abbreviation
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzAbbr = date.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
        return dateStr + ' (' + tzAbbr + ')';
      } catch {
        return isoString;
      }
    }

    // Show delete confirmation
    function showDeleteConfirmation(env) {
      selectedEnvForDelete = env;

      document.getElementById('delete-env-name').textContent = env.env;
      document.getElementById('delete-workers-count').textContent = '(' + env.workers.length + ' workers)';
      document.getElementById('delete-d1-count').textContent = '(' + env.d1.length + ' databases)';
      document.getElementById('delete-kv-count').textContent = '(' + env.kv.length + ' namespaces)';
      document.getElementById('delete-queues-count').textContent = '(' + env.queues.length + ' queues)';
      document.getElementById('delete-r2-count').textContent = '(' + env.r2.length + ' buckets)';
      document.getElementById('delete-pages-count').textContent = '(' + (env.pages || []).length + ' projects)';

      // Reset checkboxes
      document.getElementById('delete-workers').checked = true;
      document.getElementById('delete-d1').checked = true;
      document.getElementById('delete-kv').checked = true;
      document.getElementById('delete-queues').checked = true;
      document.getElementById('delete-r2').checked = true;
      document.getElementById('delete-pages').checked = true;

      // Reset UI state
      document.getElementById('delete-log').classList.add('hidden');
      document.getElementById('delete-result').classList.add('hidden');
      document.getElementById('delete-result').innerHTML = '';
      document.getElementById('btn-confirm-delete').disabled = false;

      showSection('envDelete');
    }

    // Back buttons for environment management
    document.getElementById('btn-back-env-list').addEventListener('click', () => {
      showSection('topMenu');
    });

    document.getElementById('btn-refresh-env-list').addEventListener('click', () => {
      loadEnvironments();
    });

    document.getElementById('btn-back-env-detail').addEventListener('click', () => {
      showSection('envList');
    });

    document.getElementById('btn-delete-from-detail').addEventListener('click', () => {
      if (selectedEnvForDetail) {
        showDeleteConfirmation(selectedEnvForDetail);
      }
    });

    // Admin setup button
    document.getElementById('btn-start-admin-setup').addEventListener('click', async () => {
      if (!selectedEnvForDetail) return;

      const btn = document.getElementById('btn-start-admin-setup');
      const resultDiv = document.getElementById('admin-setup-result');
      const urlInput = document.getElementById('admin-setup-url');
      const openLink = document.getElementById('btn-open-setup-url');

      btn.disabled = true;
      btn.textContent = '⏳ Generating token...';

      try {
        // Find AUTHRIM_CONFIG KV namespace
        const configKv = selectedEnvForDetail.kv.find(kv =>
          kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
          kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
        );

        if (!configKv) {
          alert('Could not find AUTHRIM_CONFIG KV namespace for this environment');
          btn.disabled = false;
          btn.textContent = '🔐 Start Admin Account Setup with Passkey';
          return;
        }

        // Find router worker to construct base URL
        const router = selectedEnvForDetail.workers.find(w =>
          w.name.toLowerCase().includes('router')
        );

        let baseUrl = '';
        if (router && router.name) {
          // Construct URL from worker name
          baseUrl = 'https://' + router.name + '.workers.dev';
        } else {
          // Fallback - ask for URL
          baseUrl = prompt('Enter the base URL for the router (e.g., https://myenv-ar-router.workers.dev):');
          if (!baseUrl) {
            btn.disabled = false;
            btn.textContent = '🔐 Start Admin Account Setup with Passkey';
            return;
          }
        }

        const response = await api('/admin/generate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kvNamespaceId: configKv.id,
            baseUrl: baseUrl,
          }),
        });

        if (response.success && response.setupUrl) {
          urlInput.value = response.setupUrl;
          openLink.href = response.setupUrl;
          resultDiv.classList.remove('hidden');
          btn.textContent = '✓ Token Generated';
        } else {
          alert('Failed to generate token: ' + (response.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = '🔐 Start Admin Account Setup with Passkey';
        }
      } catch (error) {
        alert('Error: ' + error.message);
        btn.disabled = false;
        btn.textContent = '🔐 Start Admin Account Setup with Passkey';
      }
    });

    // Copy setup URL button
    document.getElementById('btn-copy-setup-url').addEventListener('click', () => {
      const urlInput = document.getElementById('admin-setup-url');
      urlInput.select();
      document.execCommand('copy');
      const btn = document.getElementById('btn-copy-setup-url');
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    });

    document.getElementById('btn-back-env-delete').addEventListener('click', () => {
      // Go back to detail view if we came from there
      if (selectedEnvForDetail) {
        showSection('envDetail');
      } else {
        showSection('envList');
      }
    });

    // Delete environment
    document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
      if (!selectedEnvForDelete) return;

      const btn = document.getElementById('btn-confirm-delete');
      const log = document.getElementById('delete-log');
      const output = document.getElementById('delete-output');
      const result = document.getElementById('delete-result');

      btn.disabled = true;
      log.classList.remove('hidden');
      result.classList.add('hidden');
      output.textContent = '';

      const deleteOptions = {
        deleteWorkers: document.getElementById('delete-workers').checked,
        deleteD1: document.getElementById('delete-d1').checked,
        deleteKV: document.getElementById('delete-kv').checked,
        deleteQueues: document.getElementById('delete-queues').checked,
        deleteR2: document.getElementById('delete-r2').checked,
        deletePages: document.getElementById('delete-pages').checked,
      };

      // Poll for progress
      let lastProgressLength = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
            });
            lastProgressLength = statusResult.progress.length;
            log.scrollTop = log.scrollHeight;
          }
        } catch (e) {}
      }, 500);

      try {
        const deleteResult = await api('/environments/' + selectedEnvForDelete.env + '/delete', {
          method: 'POST',
          body: deleteOptions,
        });

        clearInterval(pollInterval);

        // Show final progress
        if (deleteResult.progress) {
          output.textContent = deleteResult.progress.join('\\n');
        }

        result.classList.remove('hidden');

        if (deleteResult.success) {
          result.textContent = '';
          result.appendChild(createAlert('success', '✅ Environment deleted successfully!'));

          // Refresh environment list after a short delay
          setTimeout(() => {
            loadEnvironments();
            showSection('envList');
          }, 2000);
        } else {
          result.textContent = '';
          result.appendChild(createAlert('error', '❌ Some errors occurred: ' + (deleteResult.errors || []).join(', ')));
          btn.disabled = false;
        }
      } catch (error) {
        clearInterval(pollInterval);
        result.classList.remove('hidden');
        result.textContent = '';
        result.appendChild(createAlert('error', '❌ Error: ' + error.message));
        btn.disabled = false;
      }
    });

    // Initialize
    if (MANAGE_ONLY) {
      // Skip prerequisites UI and go directly to environment management
      // Prerequisites were already checked by CLI
      loadEnvironments();
      showSection('envList');
    } else {
      checkPrerequisites();
    }
  </script>
</body>
</html>`;
}
