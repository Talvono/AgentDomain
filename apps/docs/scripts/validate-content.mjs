import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const DOCS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTENT_ROOT = join(DOCS_ROOT, 'src', 'content', 'docs');

export function parseJsonc(source, file) {
  const result = ts.parseConfigFileTextToJson(file, source);
  if (result.error) throw new Error(`${file}: invalid JSONC`);
  return result.config;
}

export const EXPECTED_DOCS = [
  'api-reference/agents.mdx',
  'api-reference/dns.mdx',
  'api-reference/email.mdx',
  'api-reference/overview.mdx',
  'api-reference/register.mdx',
  'concepts.mdx',
  'frameworks/agentkit.mdx',
  'frameworks/autogen.mdx',
  'frameworks/crewai.mdx',
  'frameworks/elizaos.mdx',
  'frameworks/langchain.mdx',
  'guides/dns.mdx',
  'guides/email.mdx',
  'guides/registration.mdx',
  'guides/renewal.mdx',
  'guides/ssl.mdx',
  'guides/x402-payments.mdx',
  'index.mdx',
  'quickstart.mdx',
  'sdk/mcp.mdx',
  'sdk/typescript.mdx',
].sort();

export const MACHINE_DOC_ROUTES = [
  '/llms.txt',
  '/llms-full.txt',
  '/openapi.json',
  '/api-index.json',
  '/.well-known/agentdomain.json',
];

export const FORBIDDEN_CONTENT = [
  { label: 'private admin route', pattern: /\/api\/v1\/admin(?:\/|\b)/i },
  { label: 'private webhook route', pattern: /\/api\/webhooks(?:\/|\b)/i },
  {
    label: 'secret-like environment variable',
    pattern: /\b[A-Z][A-Z0-9_]*(?:SECRET|PRIVATE_KEY|PASSWORD)[A-Z0-9_]*\b/,
  },
  {
    label: 'backend environment variable',
    pattern: /\b(?:DATABASE_URL|ADMIN_ADDRESSES|AWS_[A-Z0-9_]+)\b/,
  },
  {
    label: 'obsolete or internal provider',
    pattern: /\b(?:AWS|SES|DynamoDB|QStash|Aurora|RDS|Amazon S3|Lambda|Neon|Vercel)\b/i,
  },
  {
    label: 'private persistence detail',
    pattern: /\b(?:transactional_outbox|durable_workflows|migration_checkpoints)\b/i,
  },
  {
    label: 'private origin detail',
    pattern: /\b(?:Cloud Run URL|service account|edge HMAC|origin secret)\b/i,
  },
  {
    label: 'internal planning or topology narrative',
    pattern:
      /\b(?:private planning|private platform implementation|internal topology|internal runbooks?|backend deployment instructions?|private checkout)\b/i,
  },
  { label: 'runtime environment access', pattern: /\bprocess\.env\b/ },
  { label: 'insecure URL', pattern: /http:\/\//i },
  { label: 'obsolete docs URL', pattern: /https:\/\/agentdomain\.app\/docs(?:\/|\b)/i },
];

const APPROVED_ASSETS = {
  'src/assets/logo.svg': '299fef1db3404fc0ff64340d264d80af2fd8fb7564701517a7216314db6aa6a4',
  'src/assets/logo-black.svg': '5de88e88e332ca99aef904a3a868a853841d1a4087fee285a181cb91d41fce4e',
  'public/brand/favicon-96.png': '1db3717ab5ae04390ee036415ece401f5e7c2ba3b7878b9b19e327229c45a24f',
  'public/brand/agentdomain-docs-card.png':
    'df73a8d0ef7e0a1202ef826dff958de93be47c96717815c3b2136faa921220fc',
};

function toPosix(value) {
  return value.split(sep).join('/');
}

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export function parseFrontmatter(source, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);

  const title = /^title:\s*(.+)$/m
    .exec(match[1])?.[1]
    ?.replace(/^['"]|['"]$/g, '')
    .trim();
  const description = /^description:\s*(.+)$/m
    .exec(match[1])?.[1]
    ?.replace(/^['"]|['"]$/g, '')
    .trim();
  if (!title) throw new Error(`${file}: frontmatter title is required`);
  if (!description || description.length < 20) {
    throw new Error(`${file}: frontmatter description must be at least 20 characters`);
  }
  if (/^#\s+/m.test(source.slice(match[0].length))) {
    throw new Error(`${file}: Starlight renders the page title; do not add a duplicate H1`);
  }
  return { title, description, body: source.slice(match[0].length) };
}

export function routeForDoc(file) {
  const withoutExtension = file.replace(/\.mdx?$/, '');
  if (withoutExtension === 'index') return '/';
  return `/${withoutExtension}/`;
}

export function findForbiddenMatches(source) {
  return FORBIDDEN_CONTENT.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label);
}

function normalizeInternalLink(link) {
  const withoutQuery = link.split(/[?#]/, 1)[0];
  if (withoutQuery === '/') return '/';
  return `/${withoutQuery.replace(/^\/+|\/+$/g, '')}/`;
}

export function validateInternalLinks(source, file, routes) {
  const markdownLink = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const [, rawTarget] of source.matchAll(markdownLink)) {
    const target = rawTarget.trim().split(/\s+/, 1)[0];
    if (target.startsWith('#') || target.startsWith('mailto:')) continue;
    if (/^https:\/\//.test(target)) continue;
    if (!target.startsWith('/')) {
      throw new Error(`${file}: internal links must be root-relative: ${target}`);
    }
    if (MACHINE_DOC_ROUTES.includes(target.split(/[?#]/, 1)[0])) continue;
    const route = normalizeInternalLink(target);
    if (!routes.has(route)) throw new Error(`${file}: internal link has no page: ${target}`);
  }
}

async function assertApprovedAssets() {
  for (const [file, expected] of Object.entries(APPROVED_ASSETS)) {
    const content = await readFile(join(DOCS_ROOT, file));
    const hashInput = file.endsWith('.svg')
      ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'))
      : content;
    const digest = createHash('sha256').update(hashInput).digest('hex');
    if (digest !== expected) throw new Error(`${file}: approved asset hash mismatch`);
  }
}

async function assertAppContract() {
  const pkg = JSON.parse(await readFile(join(DOCS_ROOT, 'package.json'), 'utf8'));
  if (pkg.private !== true) throw new Error('package.json: private must remain true');
  if (pkg.license !== 'Apache-2.0') throw new Error('package.json: license must be Apache-2.0');
  if (pkg.homepage !== 'https://docs.agentdomain.app') {
    throw new Error('package.json: canonical homepage mismatch');
  }
  if (pkg.dependencies?.astro !== '7.3.1') throw new Error('package.json: Astro must be 7.3.1');
  if (pkg.dependencies?.['@astrojs/starlight'] !== '0.42.0') {
    throw new Error('package.json: Starlight must be 0.42.0');
  }

  const wranglerFile = join(DOCS_ROOT, 'wrangler.jsonc');
  const wrangler = parseJsonc(await readFile(wranglerFile, 'utf8'), wranglerFile);
  if (wrangler.name !== 'agentdomain-docs') throw new Error('wrangler.jsonc: worker name mismatch');
  if (wrangler.compatibility_date !== '2026-09-01') {
    throw new Error('wrangler.jsonc: compatibility date mismatch');
  }
  if (wrangler.workers_dev !== false || wrangler.preview_urls !== false) {
    throw new Error('wrangler.jsonc: production workers.dev exposure must remain disabled');
  }
  if (wrangler.observability?.enabled !== true) {
    throw new Error('wrangler.jsonc: observability must remain enabled');
  }
  if (wrangler.main !== undefined)
    throw new Error('wrangler.jsonc: static docs must not add Worker code');
  if (wrangler.assets?.directory !== './dist' || wrangler.assets?.run_worker_first !== false) {
    throw new Error('wrangler.jsonc: static asset boundary mismatch');
  }
  const domain = wrangler.routes?.find(
    (route) => route.pattern === 'docs.agentdomain.app' && route.custom_domain === true,
  );
  if (!domain) throw new Error('wrangler.jsonc: canonical custom domain is missing');
  if (
    wrangler.env?.preview?.name !== 'agentdomain-docs-preview' ||
    wrangler.env.preview.workers_dev !== false ||
    wrangler.env.preview.preview_urls !== false ||
    JSON.stringify(wrangler.env.preview.routes) !== '[]'
  ) {
    throw new Error('wrangler.jsonc: disabled deny-by-default preview environment is required');
  }

  const config = await readFile(join(DOCS_ROOT, 'astro.config.mjs'), 'utf8');
  if (!config.includes("const canonicalSite = 'https://docs.agentdomain.app'")) {
    throw new Error('astro.config.mjs: canonical site mismatch');
  }
  if (!config.includes("baseUrl: 'https://github.com/Talvono/AgentDomain/edit/main/apps/docs/'")) {
    throw new Error('astro.config.mjs: public edit-link base mismatch');
  }
  if (!config.includes('disable404Route: true')) {
    throw new Error('astro.config.mjs: explicit 404 route must remain enabled');
  }
  const notFoundPage = await readFile(join(DOCS_ROOT, 'src', 'pages', '404.astro'), 'utf8');
  const forbidden404 = findForbiddenMatches(notFoundPage);
  if (forbidden404.length) {
    throw new Error(`src/pages/404.astro: forbidden public content: ${forbidden404.join(', ')}`);
  }
  const robots = await readFile(join(DOCS_ROOT, 'public', 'robots.txt'), 'utf8');
  if (!robots.includes('Sitemap: https://docs.agentdomain.app/sitemap-index.xml')) {
    throw new Error('robots.txt: canonical sitemap is missing');
  }
  const headers = await readFile(join(DOCS_ROOT, 'public', '_headers'), 'utf8');
  for (const required of [
    'Content-Security-Policy:',
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    'Strict-Transport-Security:',
    'X-Content-Type-Options: nosniff',
    'X-Robots-Tag: noindex, nofollow',
  ]) {
    if (!headers.includes(required)) throw new Error(`_headers: missing ${required}`);
  }

  for (const removed of ['mint.json', 'guides/aws-migration.mdx', 'guides/ses-inbound.mdx']) {
    try {
      await stat(join(DOCS_ROOT, removed));
      throw new Error(`${removed}: legacy/private file must not exist`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function validateDocs() {
  await assertAppContract();
  await assertApprovedAssets();

  const files = (await listFiles(CONTENT_ROOT))
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => toPosix(relative(CONTENT_ROOT, file)))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_DOCS)) {
    const missing = EXPECTED_DOCS.filter((file) => !files.includes(file));
    const unexpected = files.filter((file) => !EXPECTED_DOCS.includes(file));
    throw new Error(
      `docs allowlist mismatch; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`,
    );
  }

  const routes = new Set(files.map(routeForDoc));
  for (const file of files) {
    const source = await readFile(join(CONTENT_ROOT, file), 'utf8');
    parseFrontmatter(source, file);
    const forbidden = findForbiddenMatches(source);
    if (forbidden.length)
      throw new Error(`${file}: forbidden public content: ${forbidden.join(', ')}`);
    if (/!\[[^\]]*\]\(https:\/\//i.test(source)) {
      throw new Error(`${file}: documentation images must be local assets`);
    }
    validateInternalLinks(source, file, routes);
  }

  return {
    files: files.length,
    routes: routes.size,
    approvedAssets: Object.keys(APPROVED_ASSETS).length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateDocs()
    .then((result) => console.log(`Docs content valid: ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
