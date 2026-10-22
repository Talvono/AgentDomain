import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

// Exercise the SDK's transitive dependency without adding a direct Hono dependency.
const sdkRequire = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'));
const adapterRequire = createRequire(sdkRequire.resolve('@hono/node-server'));
const { Hono } = sdkRequire('hono');

test('the root override covers the reviewed Hono advisories through 4.13.13', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.pnpm.overrides['hono@<4.13.13'], '4.13.13');
  assert.equal(manifest.pnpm.overrides['hono@<4.13.7'], undefined);
  assert.equal(manifest.pnpm.overrides['hono@<4.12.34'], undefined);
  assert.equal(adapterRequire.resolve('hono'), sdkRequire.resolve('hono'));
});

const queryCases = [
  {
    name: 'ignores a query that appears only after the fragment',
    suffix: '#fragment?hidden=yes',
    query: {},
    queries: {},
  },
  {
    name: 'ends a real query at the fragment',
    suffix: '?visible=yes#fragment?hidden=yes',
    query: { visible: 'yes' },
    queries: { visible: ['yes'] },
  },
  {
    name: 'preserves repeated parameters and percent-encoded delimiters',
    suffix: '?tag=one&tag=two&value=a%23b%3Fc',
    query: { tag: 'one', value: 'a#b?c' },
    queries: { tag: ['one', 'two'], value: ['a#b?c'] },
  },
];

for (const { name, suffix, query, queries } of queryCases) {
  test(`transitive Hono ${name} (GHSA-crvj-82cr-hjcx)`, async () => {
    const app = new Hono();
    app.get('/query', (context) =>
      context.json({ query: context.req.query(), queries: context.req.queries() }),
    );
    const response = await app.request(`http://localhost/query${suffix}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { query, queries });
  });
}
