import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  DOCS_ROOT,
  EXPECTED_DOCS,
  findForbiddenMatches,
  parseFrontmatter,
  parseJsonc,
  routeForDoc,
  validateDocs,
  validateInternalLinks,
} from '../scripts/validate-content.mjs';
import { validateHtmlUrls } from '../scripts/validate-output.mjs';

function markdownLinkTarget(source, label) {
  const links = [...source.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].filter(
    ([, text]) => text === label,
  );
  assert.equal(links.length, 1, `Expected one Markdown link labeled ${label}`);
  return links[0][2];
}

test('the complete public docs contract validates', async () => {
  const result = await validateDocs();
  assert.deepEqual(result, { files: 21, routes: 21, approvedAssets: 4 });
});

test('docs header logo uses display-only corners without changing its dimensions', async () => {
  const css = await readFile(join(DOCS_ROOT, 'src', 'styles', 'docs.css'), 'utf8');
  const logoRule = /\.site-title img\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(logoRule, 'Expected the existing docs header logo rule');
  assert.match(logoRule, /\bborder-radius:\s*6px\s*;/);
  assert.match(logoRule, /\bmax-height:\s*2rem\s*;/);
  assert.match(logoRule, /\bwidth:\s*auto\s*;/);
});

test('forbidden infrastructure and operator details are detected', () => {
  assert.deepEqual(findForbiddenMatches('DynamoDB and /api/v1/admin/agents'), [
    'private admin route',
    'obsolete or internal provider',
  ]);
  assert.deepEqual(findForbiddenMatches('DATABASE_URL and process.env'), [
    'backend environment variable',
    'runtime environment access',
  ]);
  assert.deepEqual(findForbiddenMatches('Private planning and internal topology'), [
    'internal planning or topology narrative',
  ]);
});

test('frontmatter requires a useful description and no duplicate H1', () => {
  assert.throws(
    () => parseFrontmatter('---\ntitle: Bad\ndescription: short\n---\n', 'bad.mdx'),
    /at least 20 characters/,
  );
  assert.throws(
    () =>
      parseFrontmatter(
        '---\ntitle: Bad\ndescription: This description is long enough.\n---\n# Duplicate\n',
        'bad.mdx',
      ),
    /duplicate H1/,
  );
});

test('internal links resolve only to published routes', () => {
  const routes = new Set(EXPECTED_DOCS.map(routeForDoc));
  assert.doesNotThrow(() => validateInternalLinks('[Start](/quickstart/)', 'ok.mdx', routes));
  assert.throws(
    () => validateInternalLinks('[Private](/operations/)', 'bad.mdx', routes),
    /has no page/,
  );
  assert.throws(
    () => validateInternalLinks('[Relative](..\/private)', 'bad.mdx', routes),
    /root-relative/,
  );
});

test('built HTML requires an exact canonical origin and local brand assets', () => {
  const canonical = (href) => `<link rel="canonical" href="${href}">`;

  assert.doesNotThrow(() =>
    validateHtmlUrls(
      canonical('https://docs.agentdomain.app/quickstart/'),
      'quickstart/index.html',
    ),
  );
  assert.throws(
    () =>
      validateHtmlUrls(
        canonical('https://docs.agentdomain.app.evil.example/quickstart/'),
        'quickstart/index.html',
      ),
    /canonical docs URL is invalid/,
  );
  assert.throws(
    () =>
      validateHtmlUrls(
        `${canonical('https://docs.agentdomain.app/')}<img src="https://agentdomain.app/brand/logo.png">`,
        'index.html',
      ),
    /remote frontend brand dependency is forbidden/,
  );
  assert.throws(
    () =>
      validateHtmlUrls(
        canonical('https://attacker@docs.agentdomain.app/quickstart/'),
        'quickstart/index.html',
      ),
    /credential-free HTTPS URLs/,
  );
});

test('Cloudflare configuration is static-only and pinned', async () => {
  const configFile = join(DOCS_ROOT, 'wrangler.jsonc');
  const config = parseJsonc(await readFile(configFile, 'utf8'), configFile);
  assert.equal(config.name, 'agentdomain-docs');
  assert.equal(config.compatibility_date, '2026-09-01');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.main, undefined);
  assert.deepEqual(config.routes, [{ pattern: 'docs.agentdomain.app', custom_domain: true }]);
  assert.equal(config.assets.directory, './dist');
  assert.equal(config.assets.not_found_handling, '404-page');
  assert.deepEqual(config.env.preview, {
    name: 'agentdomain-docs-preview',
    workers_dev: false,
    preview_urls: false,
    routes: [],
  });
});

test('docs CSP enables only the WebAssembly and worker capabilities required by Pagefind', async () => {
  const headers = await readFile(join(DOCS_ROOT, 'public', '_headers'), 'utf8');
  assert.match(headers, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(headers, /worker-src 'self' blob:/);
  assert.doesNotMatch(headers, /(?:^|\s)'unsafe-eval'(?:\s|;|$)/m);
});

test('package cannot be published to npm', async () => {
  const pkg = JSON.parse(await readFile(join(DOCS_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.repository.url, 'https://github.com/Talvono/AgentDomain.git');
});

test('framework guides distinguish real language bridges and their publication status', async () => {
  for (const framework of ['langchain', 'crewai', 'autogen']) {
    const source = await readFile(
      join(DOCS_ROOT, 'src', 'content', 'docs', 'frameworks', `${framework}.mdx`),
      'utf8',
    );
    assert.match(source, /```python/);
    assert.match(source, /inspect_agent_identity/);
    assert.match(source, /prepare_auto_renew_change/);
    assert.match(source, /publication|published/);
    assert.match(source, /unsigned/i);
    assert.doesNotMatch(source, /## Coming soon/);
  }

  const docsConfig = await readFile(join(DOCS_ROOT, 'astro.config.mjs'), 'utf8');
  assert.match(docsConfig, /label: 'LangChain'/);
  assert.match(docsConfig, /label: 'CrewAI'/);
  assert.match(docsConfig, /label: 'AutoGen'/);
});

test('framework guides pin the published npm and Python releases while retaining source development', async () => {
  const framework = (name) =>
    readFile(join(DOCS_ROOT, 'src', 'content', 'docs', 'frameworks', `${name}.mdx`), 'utf8');
  for (const name of ['crewai', 'autogen']) {
    const source = await framework(name);
    assert.match(source, /0\.11\.0 is published on npm/);
    assert.match(source, /npm install --save-exact @agentdomain\/mcp-server@0\.11\.0/);
    assert.ok(source.includes(`python -m pip install agentdomain-${name}==0.11.0`));
    assert.ok(source.includes(`python -m pip install ./packages/${name}-plugin`));
    assert.ok(source.includes(`from agentdomain_${name} import`));
    assert.match(source, /passed scoped Windows and Linux/);
    assert.match(source, /synthetic RPC/);
    assert.match(source, /no paid model or live\s+transaction/);
    assert.doesNotMatch(source, /source-build targets|until a matching npm release/i);
  }
  const crewai = await framework('crewai');
  assert.match(crewai, /\*\*0\.11\.0 is published on PyPI\*\*/);
  assert.equal(
    markdownLinkTarget(crewai, '`agentdomain-crewai`'),
    'https://pypi.org/project/agentdomain-crewai/0.11.0/',
  );
  assert.equal(
    /```bash\r?\n([\s\S]*?)\r?\n```/.exec(crewai)?.[1].replaceAll('\r\n', '\n'),
    'python -m pip install agentdomain-crewai==0.11.0\nnpm install --save-exact @agentdomain/mcp-server@0.11.0',
  );
  assert.match(crewai, /For source development, install from the reviewed public repository root/);
  assert.equal(
    markdownLinkTarget(crewai, 'dated release evidence'),
    'https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.0',
  );
  assert.match(crewai, /records registry metadata and CI artifact comparison/);
  assert.match(crewai, /verified cryptographic\s+attestations for both artifacts/);
  assert.doesNotMatch(
    crewai,
    /release candidate|not yet published|After the Python registry release is verified/,
  );
  const autogen = await framework('autogen');
  assert.match(autogen, /\*\*0\.11\.0 is published on PyPI\*\*/);
  assert.equal(
    markdownLinkTarget(autogen, '`agentdomain-autogen`'),
    'https://pypi.org/project/agentdomain-autogen/0.11.0/',
  );
  assert.equal(
    /```bash\r?\n([\s\S]*?)\r?\n```/.exec(autogen)?.[1].replaceAll('\r\n', '\n'),
    'python -m pip install agentdomain-autogen==0.11.0\nnpm install --save-exact @agentdomain/mcp-server@0.11.0',
  );
  assert.match(autogen, /For source development, install from the reviewed public repository root/);
  assert.equal(
    markdownLinkTarget(autogen, 'dated release evidence'),
    'https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.0',
  );
  assert.match(autogen, /records matching registry metadata and CI artifacts/);
  assert.match(autogen, /verified cryptographic\s+attestations for both artifacts/);
  assert.doesNotMatch(
    autogen,
    /release candidate|not yet published|After the Python registry release is verified|before publication|still pending/,
  );
  const langchain = await framework('langchain');
  assert.match(langchain, /`@agentdomain\/langchain-plugin` \*\*0\.11\.0 is published on npm\*\*/);
  assert.match(
    langchain,
    /```bash\s+npm install @agentdomain\/langchain-plugin@0\.11\.0 @langchain\/core@\^1\.2\.11\s+```/,
  );
  assert.match(langchain, /0\.11\.0 are published on npm/);
  assert.match(langchain, /September 14,\s+2026 local publication has no OIDC provenance/);
  assert.equal(
    markdownLinkTarget(langchain, 'publication follow-up'),
    'https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.0',
  );
  assert.match(langchain, /source manifest does not query or establish registry publication/);
  assert.match(langchain, /For source development, build from the reviewed public repository root/);
  assert.match(langchain, /pnpm --filter @agentdomain\/shared build/);
  assert.match(langchain, /pnpm --filter @agentdomain\/sdk build/);
  assert.match(langchain, /pnpm --filter @agentdomain\/langchain-plugin build/);
  assert.match(langchain, /does not add an execution tool/);
  assert.doesNotMatch(
    langchain,
    /release candidate|publication is not yet verified|After registry verification/,
  );
  const renewal = await readFile(
    join(DOCS_ROOT, 'src', 'content', 'docs', 'guides', 'renewal.mdx'),
    'utf8',
  );
  assert.match(renewal, /published SDK \*\*0\.11\.0\*\*/);
  assert.doesNotMatch(renewal, /source-build target/);
});

test('CrewAI guide matches the native helper and discloses the pinned Python dependency risk', async () => {
  const source = await readFile(
    join(DOCS_ROOT, 'src', 'content', 'docs', 'frameworks', 'crewai.mdx'),
    'utf8',
  );
  for (const term of [
    'MCPClient',
    'StdioTransport',
    'MCPNativeTool',
    'readonly_flow.py',
    'README.md',
    'requirements.in',
    'requirements.lock',
    'call_json(tools["inspect_agent_identity"], {"tokenId": token_id})',
    '.venv-native',
    '--require-hashes',
    'ChromaDB 1.1.1',
    'CVE-2026-45829',
    'CVE-2026-45830',
    'CVE-2026-45831',
    'CVE-2026-45833',
  ]) {
    assert.ok(source.includes(term), `CrewAI: missing ${term}`);
  }
  assert.equal(
    markdownLinkTarget(source, "example's security note"),
    'https://github.com/Talvono/AgentDomain/blob/main/packages/mcp-server/examples/crewai/README.md#security-note',
  );
  assert.equal(
    markdownLinkTarget(source, 'poisoned-collection configuration risk in the Python client'),
    'https://github.com/chroma-core/chroma/issues/6717',
  );
  assert.doesNotMatch(source, /MCPServerAdapter|from crewai_tools/);
  assert.match(source, /reject explicit `null`/);
  assert.match(source, /opens and closes a local stdio client for each invocation/);
  assert.match(source, /risk is not limited to running an HTTP server/);
  assert.match(source, /not the installed library's safety/);
  assert.match(source, /\*\*not clean\*\*/);
});
