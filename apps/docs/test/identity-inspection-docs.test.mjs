import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const doc = (name) =>
  readFile(new URL(`../src/content/docs/sdk/${name}.mdx`, import.meta.url), 'utf8');

function markdownLinkTarget(source, label) {
  const links = [...source.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].filter(
    ([, text]) => text === label,
  );
  assert.equal(links.length, 1, `Expected one Markdown link labeled ${label}`);
  return links[0][2];
}

test('the source catalog records all eight workspace packages without claiming registry publication', async () => {
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  const { version } = JSON.parse(
    await readFile(new URL('../../../packages/shared/package.json', import.meta.url), 'utf8'),
  );
  const catalog = readme
    .replaceAll('\r\n', '\n')
    .split('## Public packages\n')[1]
    ?.split('\n## ')[0];
  assert.equal(typeof catalog, 'string');
  const rows = catalog.split('\n').filter((line) => /^\| \[/.test(line));
  assert.equal(rows.length, 8);
  assert.ok(catalog.includes(`The coordinated source version is **${version}**`));
  assert.match(catalog, /source version alone is not publication evidence/);
  assert.doesNotMatch(catalog, /All eight packages are published at|\|\s*Published\b/i);
  assert.doesNotMatch(
    catalog,
    /Install the published SDK:/i,
    'The source catalog must not imply that its workspace version is already published',
  );
  for (const name of [
    'shared',
    'sdk',
    'mcp-server',
    'agentkit-plugin',
    'eliza-plugin',
    'langchain-plugin',
  ]) {
    const row = rows.find((line) => line.startsWith(`| [\`@agentdomain/${name}\`](`));
    assert.ok(row, `${name}: missing npm catalog link`);
    assert.equal(
      markdownLinkTarget(row, `\`@agentdomain/${name}\``),
      `https://www.npmjs.com/package/@agentdomain/${name}`,
    );
    assert.match(row, /\| npm\s*\|/);
  }
  const crewai = rows.find((line) => line.startsWith('| [`agentdomain-crewai`]('));
  assert.ok(crewai, 'Missing CrewAI catalog entry');
  assert.equal(
    markdownLinkTarget(crewai, '`agentdomain-crewai`'),
    'https://pypi.org/project/agentdomain-crewai/',
  );
  assert.match(crewai, /\| PyPI\s*\|/);
  const autogen = rows.find((line) => line.startsWith('| [`agentdomain-autogen`]('));
  assert.ok(autogen, 'Missing AutoGen catalog entry');
  assert.equal(
    markdownLinkTarget(autogen, '`agentdomain-autogen`'),
    'https://pypi.org/project/agentdomain-autogen/',
  );
  assert.match(autogen, /\| PyPI\s*\|/);
  assert.match(readme, /five npm 0\.11\.0 packages had verified GitHub Actions OIDC provenance/);
  assert.match(readme, /LangChain 0\.11\.0 local publication did not/);
  assert.match(
    readme,
    /do not invent REST endpoints for onchain functions,\s+authorize actions, or prove npm publication/,
  );
});

test('retired root records are absent and release evidence remains linked', async () => {
  for (const name of ['CHANGELOG.md', 'PREEXISTING.md']) {
    await assert.rejects(readFile(new URL(`../../../${name}`, import.meta.url)), {
      code: 'ENOENT',
    });
  }
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  const releaseNotes = new Set(
    [...readme.matchAll(/\[release notes\]\(([^)]+)\)/g)].map(([, url]) => url),
  );
  assert.ok(releaseNotes.has('https://github.com/0xmdrakib/AgentDomain/releases/tag/npm-v0.11.0'));
  for (const target of releaseNotes)
    assert.ok(
      [
        'https://github.com/0xmdrakib/AgentDomain/releases/tag/npm-v0.11.0',
        'https://github.com/Talvono/AgentDomain/releases/latest',
      ].includes(target),
      `Unexpected release evidence link: ${target}`,
    );
  assert.match(
    readme,
    /AgentDomain is the agent-native identity and communications infrastructure/,
  );
  assert.match(
    readme,
    /Built for developers, people working through agents, and autonomous workflows/,
  );
  assert.doesNotMatch(readme, /CHANGELOG\.md|PREEXISTING\.md|ETHOnline|ETHGlobal|hackathon/i);
});

test('AI disclosure states human control without event-submission claims', async () => {
  const source = await readFile(new URL('../../../AI_DISCLOSURE.md', import.meta.url), 'utf8');
  assert.match(source, /agent-native identity and communications infrastructure/);
  assert.match(source, /OpenAI Codex has assisted its development/);
  assert.match(source, /not permission to sign a transaction, spend funds/);
  assert.match(source, /human approval callback/);
  assert.equal(
    markdownLinkTarget(source, 'release notes'),
    'https://github.com/0xmdrakib/AgentDomain/releases/tag/npm-v0.11.0',
  );
  assert.doesNotMatch(source, /private operational plans|backend implementation/);
  assert.doesNotMatch(source, /ETHOnline|ETHGlobal|hackathon|submission|post-event|demo/i);
});

test('inspection docs pin verified 0.11.0 releases without treating the source catalog as registry proof', async () => {
  const sdk = await doc('typescript');
  const mcp = await doc('mcp');
  assert.match(sdk, /npm install @agentdomain\/sdk@0\.11\.0 viem@2\.56\.3/);
  assert.match(mcp, /npm install --global @agentdomain\/mcp-server@0\.11\.0/);
  assert.match(sdk, /0\.11\.0 is published on npm/);
  assert.match(mcp, /0\.11\.0 is published on npm/);
  assert.match(sdk, /source manifest does not query or establish registry publication/);
  assert.match(mcp, /source metadata, not a\s+registry availability check/);
  for (const source of [sdk, mcp]) {
    assert.doesNotMatch(source, /0\.11\.0 is a release candidate/);
    assert.doesNotMatch(source, /source-build target|new source-checkout (?:feature|export)/);
    assert.doesNotMatch(source, /independent-identity-inspection-source-checkout/);
  }
  assert.match(sdk, /pnpm --filter @agentdomain\/sdk build/);
  assert.match(mcp, /node packages\/mcp-server\/dist\/index\.js/);
});

test('both interfaces document public read-only provenance and explicit trust limits', async () => {
  for (const name of ['typescript', 'mcp']) {
    const source = await doc(name);
    for (const term of [
      'RPC',
      'consensus',
      'SPV',
      'DNS',
      'KYC',
      'ERC-721',
      'ERC-8004',
      'safe',
      'rate limited',
      'EIP-1898',
      'requireCanonical: true',
    ]) {
      assert.ok(source.includes(term), `${name}: missing ${term}`);
    }
    assert.match(source, /not instructions|rather than instructions/);
    assert.match(source, /never fetches metadata|without being\s+fetched/);
    assert.match(source, /INVALID_INPUT/);
    assert.match(source, /WRONG_CHAIN/);
    assert.match(source, /UNSAFE_SNAPSHOT/);
    assert.match(source, /UNAVAILABLE/);
    assert.match(source, /expectedOwnerMatches/);
  }
});

test('SDK documentation does not conflate expected owner, activity and internal consistency', async () => {
  const source = await doc('typescript');
  assert.match(source, /does not include `expectedOwnerMatches`/);
  assert.match(source, /does not establish\s+agent safety or endorse its behavior/);
  assert.match(source, /not `not_found`/);
  assert.match(source, /manually choose and inject a trusted Base RPC client/);
  assert.match(source, /ccipRead: false/);
  assert.match(source, /before any\s+RPC request/);
  assert.match(source, /no numeric-block or\s+`latest` fallback/);
  assert.doesNotMatch(source, /uses that block number for the contract calls/);
});

test('MCP documents no caller-selected RPC, registry or network and no platform authentication', async () => {
  const source = await doc('mcp');
  assert.match(source, /without constructing an authenticated platform client/);
  assert.match(source, /does not switch chains/);
  assert.match(source, /network overrides are not accepted as tool arguments/);
  assert.match(source, /No wallet, platform API key or write-tool opt-in/);
});

test('renewal docs separate unsigned plans, future spending authority and actual completion', async () => {
  const source = await readFile(
    new URL('../src/content/docs/guides/renewal.mdx', import.meta.url),
    'utf8',
  );
  for (const name of [
    'inspectAgentRenewal',
    'prepareAutoRenewChange',
    'executeAutoRenewChange',
    'confirmAutoRenewChange',
  ])
    assert.ok(source.includes(name));
  assert.match(source, /not a registrar\s+quote/);
  assert.match(source, /without a new wallet signature for each renewal/);
  assert.match(source, /existing\s+pending reservation may still complete and charge/);
  assert.match(source, /model-supplied boolean or unconditional approval/);
  assert.match(source, /limited\s+to the same plan object/);
  assert.match(source, /settled `no_change` result is not retained/);
  assert.match(source, /requires a new host approval if a change is now needed/);
  assert.match(source, /receipt to be after the plan's recorded safe observation block/);
  assert.match(source, /not cryptographic proof that a\s+particular human approved/);
  assert.match(source, /not\*\*\s+that the domain/);
  assert.match(source, /network gas/);
});

test('general AI disclosure retains assisted workflows without event or internal-role claims', async () => {
  const ai = await readFile(new URL('../../../AI_DISCLOSURE.md', import.meta.url), 'utf8');
  assert.match(ai, /Resumable registration, payment-state handling and recovery/);
  assert.match(ai, /Read-only identity and renewal inspection/);
  assert.doesNotMatch(
    ai,
    /ETHOnline|ETHGlobal|hackathon|coordinating implementation|frontend owner|parent handles|\bFermat\b/i,
  );
});
