import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const docsApiDir = path.join(root, 'docs/api');
const generatedDir = path.join(docsApiDir, 'generated');
const copiedSpecsDir = path.join(docsApiDir, 'openapi');
const specsPath = path.join(docsApiDir, 'specs.json');
const scalarScriptUrl = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.60.0';

const scalarConfig = {
  layout: 'modern',
  theme: 'default',
  hideDarkModeToggle: false,
  searchHotKey: 'k',
  defaultHttpClient: {
    targetKey: 'javascript',
    clientKey: 'fetch',
  },
  metaData: {
    title: 'Authrim API Reference',
    description: 'Authrim OpenAPI reference documentation.',
  },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function groupedSpecs(specs) {
  const groups = new Map();
  for (const spec of specs) {
    const group = spec.group ?? 'Other';
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(spec);
  }
  return groups;
}

function htmlShell({ title, body, extraHead = '' }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${extraHead}
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function renderIndex(specs) {
  const groups = groupedSpecs(specs);
  const sections = [...groups.entries()]
    .map(([group, items]) => {
      const links = items
        .map(
          (spec) => `          <a class="api-link" href="${escapeHtmlAttribute(spec.html)}">
            <span>
              <strong>${escapeHtml(spec.title)}</strong>
              <small>${escapeHtml(spec.description)}</small>
            </span>
            <code>${escapeHtml(spec.spec)}</code>
          </a>`
        )
        .join('\n');
      return `      <section>
        <h2>${escapeHtml(group)}</h2>
${links}
      </section>`;
    })
    .join('\n');

  return htmlShell({
    title: 'Authrim API Reference',
    extraHead: `<style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #657282;
        --border: #d9dee6;
        --accent: #0f766e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 40px 24px 56px;
      }
      header {
        margin-bottom: 32px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 32px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        max-width: 760px;
        color: var(--muted);
        line-height: 1.6;
      }
      section {
        margin-top: 28px;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 18px;
        line-height: 1.3;
        letter-spacing: 0;
      }
      .api-link {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(260px, 420px);
        gap: 20px;
        align-items: center;
        margin: 10px 0;
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--panel);
        color: inherit;
        text-decoration: none;
      }
      .api-link:hover {
        border-color: var(--accent);
      }
      strong {
        display: block;
        font-size: 15px;
        line-height: 1.35;
      }
      small {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        line-height: 1.45;
      }
      code {
        min-width: 0;
        overflow-wrap: anywhere;
        color: #44515f;
        font-size: 12px;
      }
      @media (max-width: 780px) {
        main { padding: 28px 16px 44px; }
        .api-link { grid-template-columns: 1fr; gap: 10px; }
      }
    </style>`,
    body: `    <main>
      <header>
        <h1>Authrim API Reference</h1>
        <p>
          Scalar documentation generated from package-local OpenAPI contracts.
          The source of truth remains under <code>packages/*/openapi</code>.
        </p>
      </header>
${sections}
    </main>`,
  });
}

function renderScalarPage(spec) {
  const specUrlFromGeneratedPage = `../${spec.spec}`;
  const pageConfig = {
    ...scalarConfig,
    metaData: {
      title: spec.title,
      description: spec.description,
    },
  };

  return htmlShell({
    title: spec.title,
    extraHead: `<style>
      body { margin: 0; }
      .topbar {
        display: flex;
        gap: 16px;
        align-items: center;
        min-height: 48px;
        padding: 0 16px;
        border-bottom: 1px solid #dde3ea;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .topbar a {
        color: #0f766e;
        text-decoration: none;
        font-size: 14px;
      }
      .topbar strong {
        color: #17202a;
        font-size: 14px;
      }
    </style>`,
    body: `    <div class="topbar">
      <a href="../index.html">API Reference</a>
      <strong>${escapeHtml(spec.title)}</strong>
    </div>
    <script
      id="api-reference"
      data-url="${escapeHtmlAttribute(specUrlFromGeneratedPage)}"
      data-configuration="${escapeHtmlAttribute(JSON.stringify(pageConfig))}"
      src="${escapeHtmlAttribute(scalarScriptUrl)}"
    ></script>`,
  });
}

function renderGenericScalar() {
  return htmlShell({
    title: 'Authrim Scalar Viewer',
    extraHead: `<style>body { margin: 0; }</style>`,
    body: `    <script>
      const params = new URLSearchParams(window.location.search);
      const specUrl = params.get('spec');
      if (!specUrl) {
        document.body.innerHTML = '<p style="font-family: sans-serif; padding: 24px;">Missing ?spec= parameter.</p>';
      } else {
        const script = document.createElement('script');
        script.id = 'api-reference';
        script.src = '${scalarScriptUrl}';
        script.dataset.url = specUrl;
        script.dataset.configuration = ${JSON.stringify(JSON.stringify(scalarConfig))};
        document.body.append(script);
      }
    </script>`,
  });
}

async function copyOpenApiSpecs(specs) {
  await mkdir(copiedSpecsDir, { recursive: true });

  for (const spec of specs) {
    if (!spec.source) {
      throw new Error(`Missing source for ${spec.id}`);
    }
    if (!spec.spec.startsWith('openapi/')) {
      throw new Error(`Expected ${spec.id}.spec to point under openapi/`);
    }

    const sourcePath = path.resolve(docsApiDir, spec.source);
    const targetPath = path.join(docsApiDir, spec.spec);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

const specs = JSON.parse(await readFile(specsPath, 'utf8'));
await mkdir(generatedDir, { recursive: true });
await copyOpenApiSpecs(specs);

await writeFile(path.join(docsApiDir, 'index.html'), renderIndex(specs));
await writeFile(path.join(docsApiDir, 'scalar.html'), renderGenericScalar());

for (const spec of specs) {
  await writeFile(path.join(docsApiDir, spec.html), renderScalarPage(spec));
}

process.stdout.write(`Generated Scalar pages for ${specs.length} OpenAPI documents.\n`);
