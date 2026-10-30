import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/yaml';
import {
  REVIEWED_PACKAGE_LICENSE_EXCEPTIONS,
  REVIEWED_PRODUCTION_LICENSES,
  inspectProductionLicenseReport,
  parseProductionLicenseReport,
} from './check-production-licenses.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('accepts every explicitly reviewed production license expression', () => {
  const report = Object.fromEntries(
    REVIEWED_PRODUCTION_LICENSES.map((license) => [license, [{ name: `package-${license}` }]]),
  );
  assert.deepEqual(inspectProductionLicenseReport(report), []);
});

test('rejects unresolved, non-commercial and strong-copyleft licenses', () => {
  for (const license of [
    'Unknown',
    'SEE LICENSE IN LICENSE.md',
    'LicenseRef-NonCommercial-1.0',
    'GPL-3.0-only',
    'AGPL-3.0-or-later',
    'SSPL-1.0',
  ]) {
    const violations = inspectProductionLicenseReport({ [license]: [{ name: 'blocked-package' }] });
    assert.equal(violations.length, 1, license);
    assert.equal(violations[0].reason, 'forbidden or unresolved license');
  }
});

test('rejects a valid but unreviewed SPDX license', () => {
  const violations = inspectProductionLicenseReport({ 'WTFPL-2.0': [{ name: 'surprise' }] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'license is not in the reviewed allow-list');
});

test('allows LGPL only for the reviewed Linux sharp runtime package', () => {
  const [sharpPackage] = REVIEWED_PACKAGE_LICENSE_EXCEPTIONS['LGPL-3.0-or-later'];
  assert.deepEqual(
    inspectProductionLicenseReport({
      'LGPL-3.0-or-later': [{ name: sharpPackage }],
    }),
    [],
  );

  const violations = inspectProductionLicenseReport({
    'LGPL-3.0-or-later': [{ name: sharpPackage }, { name: 'unreviewed-lgpl-package' }],
  });
  assert.deepEqual(violations, [
    {
      license: 'LGPL-3.0-or-later',
      packages: ['unreviewed-lgpl-package'],
      reason: 'license is not in the reviewed allow-list',
    },
  ]);
});

test('rejects malformed license command output', () => {
  assert.throws(() => parseProductionLicenseReport('not-json'), {
    message: 'PRODUCTION_LICENSE_REPORT_INVALID',
  });
  assert.deepEqual(inspectProductionLicenseReport(null), [
    { license: '<invalid report>', packages: [], reason: 'malformed license report' },
  ]);
});

test('repository pins reviewed production dependencies and excludes unsafe graphs', async () => {
  const [
    rootPackageText,
    frontendPackageText,
    lockfile,
    wagmiSource,
    walletButtonSource,
    workflow,
  ] = await Promise.all([
    readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    readFile(path.join(repoRoot, 'apps/frontend/package.json'), 'utf8'),
    readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
    readFile(path.join(repoRoot, 'apps/frontend/src/lib/wagmi.ts'), 'utf8'),
    readFile(
      path.join(repoRoot, 'apps/frontend/src/components/wallet/connect-wallet-button.tsx'),
      'utf8',
    ),
    readFile(path.join(repoRoot, '.github/workflows/dependency-review.yml'), 'utf8'),
  ]);
  const rootPackage = JSON.parse(rootPackageText);
  const frontendPackage = JSON.parse(frontendPackageText);

  assert.equal(rootPackage.pnpm.overrides['qs@<6.16.2'], '6.16.2');
  assert.match(lockfile, /qs@6\.16\.2:/);
  assert.doesNotMatch(lockfile, /qs@6\.16\.0:/);
  assert.equal(rootPackage.pnpm.overrides['fast-uri@>=3.0.0 <3.1.9'], '3.1.9');
  assert.equal(frontendPackage.dependencies.next, '16.4.2');
  assert.equal(frontendPackage.devDependencies['eslint-config-next'], '16.4.2');
  assert.equal(frontendPackage.dependencies.wagmi, '3.7.7');
  assert.equal(frontendPackage.dependencies['@coinbase/wallet-sdk'], '4.3.7');
  assert.equal(frontendPackage.dependencies['@walletconnect/ethereum-provider'], '2.21.8');
  assert.doesNotMatch(lockfile, /@metamask\/sdk/i);
  assert.doesNotMatch(`${wagmiSource}\n${walletButtonSource}`, /from ['"]wagmi\/connectors['"]/);
  assert.match(wagmiSource, /wagmi\/connectors\/coinbaseWallet/);
  assert.match(wagmiSource, /wagmi\/connectors\/walletConnect/);
  assert.match(`${wagmiSource}\n${walletButtonSource}`, /wagmi\/connectors\/injected/);
  assert.match(workflow, /allow-licenses:/);
  assert.doesNotMatch(workflow, /deny-licenses:/);
});

test('the only audit exception is zod 3 inside upstream x402, never a workspace package', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const lockfile = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  assert.deepEqual(manifest.pnpm.auditConfig, { ignoreGhsas: ['GHSA-mrhx-c7xc-m3w5'] });
  assert.equal(manifest.pnpm.overrides['@reown/appkit-wallet>zod'], '4.6.7');
  const zod = [...lockfile.matchAll(/^ {2}zod@(\d+)\.(\d+)\.(\d+):/gm)].map(([, ...parts]) =>
    parts.map(Number),
  );
  for (const [major, minor, patch] of zod.filter(([major]) => major >= 4))
    assert.ok(
      minor > 6 || (minor === 6 && patch >= 6),
      `zod ${major}.${minor}.${patch} must be patched`,
    );
  // Every workspace package resolves a patched zod 4.
  const importers = lockfile.slice(
    lockfile.indexOf('\nimporters:\n'),
    lockfile.indexOf('\npackages:\n'),
  );
  const workspaceZod = [...importers.matchAll(/zod:\n\s+specifier: [^\n]+\n\s+version: ([^\n]+)/g)];
  assert.ok(workspaceZod.length >= 7);
  for (const [, version] of workspaceZod)
    assert.match(version, /^4\.(?:6\.(?:[6-9]|\d{2,})|(?:[7-9]|\d{2,})\.\d+)$/);
  // zod 3 may remain only inside Coinbase x402 (latest 2.28.0 still requires zod ^3.24.2)
  // and abitype as its optional peer. Remove the exception once x402 moves to zod 4.
  const snapshots = lockfile.slice(lockfile.indexOf('\nsnapshots:\n'));
  const zod3Consumers = new Set(
    snapshots
      .split(/\n(?=  \S)/)
      .filter((block) => /\n\s+zod: 3\./.test(block))
      // Snapshot keys look like '@x402/core@2.25.0' or abitype@1.2.3(peer@x); keep the name.
      .map((block) => /^'?(@?[^@'\s]+)@/.exec(block.split('\n')[0].trim())?.[1]),
  );
  assert.ok(
    zod.some(([major]) => major < 4),
    'No zod 3 remains: remove the GHSA-mrhx-c7xc-m3w5 audit exception and its CONTRIBUTING note.',
  );
  assert.deepEqual(
    [...zod3Consumers].sort(),
    ['@x402/core', '@x402/evm', '@x402/extensions', 'abitype'],
    'Only upstream x402 may still depend on zod 3',
  );
});

test('security overrides cover every locked resolution at the reviewed official versions', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const lockfile = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const { children } = parsers.yaml.parse(lockfile);
  assert.equal(children.length, 1);
  const root = children[0].children.find(({ type }) => type === 'documentBody').children[0];
  const mappingEntries = (node) => {
    assert.equal(node.type, 'mapping');
    return node.children.map(({ children: [key, value] }) => [
      key.children[0].value,
      value.children[0],
    ]);
  };
  const sections = Object.fromEntries(mappingEntries(root));
  const expectedOverrides = {
    'body-parser@>=2.0.0 <2.4.0': '2.4.0',
    'brace-expansion@>=1.0.0 <1.1.21': '1.1.21',
    'brace-expansion@>=2.0.0 <2.1.7': '2.1.7',
    'brace-expansion@>=4.0.0 <5.0.12': '5.0.12',
    'devalue@>=5.0.0 <5.9.3': '5.9.3',
    'fast-uri@>=3.0.0 <3.1.9': '3.1.9',
    'glob@>=10.2.0 <10.5.0': '10.5.0',
    'hono@<4.13.13': '4.13.13',
    'ip-address@<=10.7.3': '10.7.4',
    'postcss-selector-parser@<7.1.6': '7.1.6',
    'proxy-addr@>=2.0.0 <2.0.8': '2.0.8',
    'sharp@<0.35.5': '0.35.5',
    'smol-toml@<1.9.0': '1.9.0',
    'source-map-js@>=1.0.0 <1.2.2': '1.2.2',
    'undici@>=6.0.0 <6.29.1': '6.29.1',
    'undici@>=7.0.0 <7.30.1': '7.30.1',
    'undici@>=8.0.0 <8.12.2': '8.12.2',
    'vite@>=8.2.0 <8.2.4': '8.2.4',
  };
  const lockedOverrides = Object.fromEntries(
    mappingEntries(sections.overrides).map(([key, value]) => [key, value.value]),
  );
  for (const [selector, version] of Object.entries(expectedOverrides)) {
    assert.equal(manifest.pnpm.overrides[selector], version);
    assert.equal(lockedOverrides[selector], version);
  }
  for (const section of ['packages', 'snapshots']) {
    const keys = mappingEntries(sections[section]).map(([key]) => key);
    for (const [name, versions] of Object.entries({
      'brace-expansion': ['1.1.21', '2.1.7', '5.0.12'],
      devalue: ['5.9.3'],
      'fast-uri': ['3.1.9'],
      glob: ['10.5.0', '13.0.6'],
      hono: ['4.13.13'],
      'ip-address': ['10.7.4'],
      '@modelcontextprotocol/sdk': ['1.32.1'],
      next: ['16.4.2'],
      'eslint-config-next': ['16.4.2'],
      'postcss-selector-parser': ['7.1.6'],
      'proxy-addr': ['2.0.8'],
      sharp: ['0.35.5'],
      'smol-toml': ['1.9.0'],
      'source-map-js': ['1.2.2'],
      undici: ['6.29.1', '7.30.1', '8.12.2'],
      vite: ['8.2.4'],
      'body-parser': ['2.4.0'],
    })) {
      assert.deepEqual(
        [
          ...new Set(
            keys.filter((key) => key.startsWith(`${name}@`)).map((key) => key.split('(')[0]),
          ),
        ].sort(),
        versions.map((version) => `${name}@${version}`).sort(),
        `${section}: ${name} must contain only the reviewed patched resolutions`,
      );
    }
    for (const key of keys.filter((key) => key.startsWith('@img/sharp-'))) {
      const expectedVersion = key.startsWith('@img/sharp-libvips-') ? '1.3.4' : '0.35.5';
      assert.ok(
        key.endsWith(`@${expectedVersion}`),
        `${section}: outdated Sharp native package ${key}`,
      );
    }
    assert.ok(keys.includes('@img/sharp-linux-x64@0.35.5'));
    assert.ok(keys.includes('@img/sharp-libvips-linux-x64@1.3.4'));
  }
});
