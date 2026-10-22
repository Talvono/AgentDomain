import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { createMachineDocuments } from '../scripts/machine-docs.mjs';
import { DOCS_ROOT, EXPECTED_DOCS } from '../scripts/validate-content.mjs';

const root = join(DOCS_ROOT, '..', '..');
const canonicalRepository = 'https://github.com/Talvono/AgentDomain';
const repository = canonicalRepository;
const read = (path) => readFile(join(root, path), 'utf8');
const packageReadmes = [
  'shared',
  'sdk',
  'mcp-server',
  'agentkit-plugin',
  'eliza-plugin',
  'langchain-plugin',
  'crewai-plugin',
  'autogen-plugin',
  'mcp-server/examples/crewai',
  'mcp-server/examples/autogen',
].map((directory) => `packages/${directory}/README.md`);
const historicalRelease = 'https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.2';

test('public npm and Python manifests use the canonical source and coordinated workspace version', async () => {
  const { version } = JSON.parse(await read('packages/shared/package.json'));
  for (const directory of [
    'shared',
    'sdk',
    'mcp-server',
    'agentkit-plugin',
    'eliza-plugin',
    'langchain-plugin',
  ]) {
    const manifest = JSON.parse(await read(`packages/${directory}/package.json`));
    assert.equal(manifest.version, version);
    assert.equal(manifest.repository.url, `git+${canonicalRepository}.git`);
    assert.equal(manifest.repository.directory, `packages/${directory}`);
    assert.equal(manifest.bugs.url, `${canonicalRepository}/issues`);
    assert.equal(manifest.license, 'Apache-2.0');
  }
  for (const directory of ['crewai-plugin', 'autogen-plugin']) {
    const { project } = parseToml(await read(`packages/${directory}/pyproject.toml`));
    assert.equal(project.version, version);
    assert.equal(
      project.urls.Repository,
      directory === 'autogen-plugin'
        ? `${canonicalRepository}/tree/main/packages/${directory}`
        : canonicalRepository,
    );
    assert.equal(project.urls.Issues, `${canonicalRepository}/issues`);
    assert.equal(project.license, 'Apache-2.0');
  }
  const contracts = JSON.parse(await read('contracts/package.json'));
  assert.equal(contracts.repository, `${repository}.git`);
  assert.equal(contracts.private, true);
});

test('shared docs navigation and metadata use the public GitHub repository', async () => {
  const config = await read('apps/docs/astro.config.mjs');
  assert.ok(config.includes(`baseUrl: '${repository}/edit/main/apps/docs/'`));
  assert.match(
    config,
    /icon: 'github',\s+label: 'AgentDomain on GitHub',\s+href: 'https:\/\/github\.com\/Talvono\/AgentDomain'/,
  );
  assert.doesNotMatch(config, /gitlab\.com\/agentdomain\/AgentDomain/);
  const manifest = JSON.parse(await read('apps/docs/package.json'));
  assert.equal(manifest.repository.url, `${repository}.git`);
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'Apache-2.0');
});

test('generated machine documents share GitHub source and native package/license URLs', async () => {
  const documents = await createMachineDocuments();
  const index = JSON.parse(documents['api-index.json']);
  const source = index.source;
  assert.equal(source.repository, repository);
  for (const file of ['openapi.json', '.well-known/agentdomain.json']) {
    const document = JSON.parse(documents[file]);
    assert.deepEqual(document.source ?? document['x-source'], source);
  }
  assert.equal(
    JSON.parse(documents['openapi.json']).info.license.url,
    `${repository}/blob/main/LICENSE`,
  );
  assert.equal(JSON.parse(documents['.well-known/agentdomain.json']).links.source, repository);
  for (const pkg of source.packages) {
    const directory = pkg.manifest.slice(0, pkg.manifest.lastIndexOf('/'));
    assert.equal(pkg.source, `${repository}/tree/main/${directory}`);
  }
  for (const pkg of index.python) {
    assert.equal(pkg.source, source.packages.find((entry) => entry.name === pkg.package).source);
  }
  for (const document of Object.values(documents)) {
    assert.doesNotMatch(document, /https:\/\/gitlab\.com\/agentdomain\/AgentDomain/);
  }
});

test('contribution links and release verification use GitHub', async () => {
  const readme = await read('README.md');
  const contributing = await read('CONTRIBUTING.md');
  assert.ok(readme.includes(`[GitHub](${canonicalRepository})`));
  assert.ok(contributing.includes(`[public GitHub repository](${canonicalRepository}/pulls)`));
  assert.match(contributing, /Require GitHub's\s+`verification\.verified: true`/);
  assert.doesNotMatch(contributing, /gitlab-signed-registry-v1|GitLab hosts current development/);
  assert.ok(readme.includes('https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.2'));
});

test('security reporting uses private GitHub vulnerability reporting', async () => {
  const policy = await read('SECURITY.md');
  assert.ok(
    policy.includes(`[private vulnerability reporting](${repository}/security/advisories/new)`),
  );
  assert.match(policy, /do not open a public issue/);
  assert.doesNotMatch(policy, /gitlab\.com\/agentdomain\/AgentDomain/);
});

test('public guides use GitHub-native source links and preserve historical references', async () => {
  const historical = new Map([
    ['README.md', [historicalRelease]],
    ['apps/docs/README.md', [historicalRelease]],
    ['apps/docs/src/content/docs/frameworks/autogen.mdx', [historicalRelease]],
    ['apps/docs/src/content/docs/frameworks/crewai.mdx', [historicalRelease]],
    ['apps/docs/src/content/docs/frameworks/langchain.mdx', [historicalRelease]],
    [
      'apps/docs/src/content/docs/sdk/typescript.mdx',
      [
        'https://github.com/Talvono/AgentDomain/commit/f14392b280d117380cdf9a92b78f0bd37f78b619',
        'https://github.com/Talvono/AgentDomain/commit/c4f477c617f5832df618a508e5769bdf44a738a9',
      ],
    ],
  ]);
  for (const file of [
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'apps/docs/README.md',
    'apps/docs/public/llms.txt',
    ...packageReadmes,
    ...EXPECTED_DOCS.map((file) => `apps/docs/src/content/docs/${file}`),
  ]) {
    const source = await read(file);
    const links = [
      ...new Set(
        source.match(/https:\/\/github\.com\/(?:0xmdrakib|Talvono)\/AgentDomain[^\s)<>"'`]*/g),
      ),
    ];
    for (const target of historical.get(file) ?? []) {
      assert.ok(links.includes(target), `${file}: missing historical reference ${target}`);
    }
    assert.doesNotMatch(source, /https:\/\/gitlab\.com\/agentdomain\/AgentDomain/, file);
    for (const target of links) {
      assert.ok(
        target === canonicalRepository ||
          target.startsWith(`${canonicalRepository}/`) ||
          target === `${canonicalRepository}.git`,
        `${file}: source link must use the Talvono organization: ${target}`,
      );
      if ((historical.get(file) ?? []).includes(target)) continue;
      const { pathname } = new URL(target);
      const suffix = pathname.replace(/^\/(?:0xmdrakib|Talvono)\/AgentDomain/, '');
      if (
        !suffix ||
        /^(?:\.git|\/issues(?:\/new)?|\/pulls|\/releases\/latest|\/security\/(?:policy|advisories\/new))$/.test(
          suffix,
        )
      )
        continue;
      const path = /^\/(tree|blob|edit)\/main\/(.+)$/.exec(suffix);
      assert.ok(path, `${file}: invalid GitHub-native link: ${target}`);
      const resolved = await stat(join(root, decodeURIComponent(path[2])));
      assert.equal(path[1] === 'tree' ? resolved.isDirectory() : resolved.isFile(), true, target);
    }
  }
});

test('upstream security, implementation and license references are not relabeled as project source', async () => {
  for (const [file, links] of [
    [
      'packages/langchain-plugin/README.md',
      [
        'https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/tools/index.ts',
        'https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/LICENSE',
      ],
    ],
    [
      'packages/crewai-plugin/README.md',
      [
        'https://github.com/chroma-core/chroma/issues/6717',
        'https://github.com/crewAIInc/crewAI/blob/1.15.21/lib/crewai/src/crewai/mcp/client.py',
      ],
    ],
    [
      'packages/mcp-server/examples/crewai/README.md',
      [
        'https://github.com/chroma-core/chroma/issues/6717',
        'https://github.com/crewAIInc/crewAI/blob/1.15.21/lib/crewai/src/crewai/mcp/client.py',
        'https://github.com/modelcontextprotocol/python-sdk/tree/v1.28.1',
      ],
    ],
    [
      'apps/docs/src/content/docs/frameworks/crewai.mdx',
      ['https://github.com/chroma-core/chroma/issues/6717'],
    ],
    [
      'apps/docs/src/content/docs/frameworks/autogen.mdx',
      ['https://microsoft.github.io/autogen/stable/reference/python/autogen_ext.tools.mcp.html'],
    ],
  ]) {
    const source = await read(file);
    for (const link of links) assert.ok(source.includes(link), `${file}: missing ${link}`);
  }
});
