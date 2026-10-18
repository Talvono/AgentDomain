import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';

import { MACHINE_FILES, createMachineDocuments, parsePythonPackage } from './machine-docs.mjs';
import { DOCS_ORIGIN, API_ORIGIN } from './public-api-contract.mjs';
import { EXPECTED_DOCS, findForbiddenMatches, routeForDoc } from './validate-content.mjs';

const publicRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageMetadata = [
  ...['shared', 'sdk', 'mcp-server', 'agentkit-plugin', 'eliza-plugin', 'langchain-plugin'].map(
    (directory) => ({
      name: `@agentdomain/${directory}`,
      ecosystem: 'npm',
      manifest: `packages/${directory}/package.json`,
    }),
  ),
  {
    name: 'agentdomain-crewai',
    ecosystem: 'pypi',
    manifest: 'packages/crewai-plugin/pyproject.toml',
  },
  {
    name: 'agentdomain-autogen',
    ecosystem: 'pypi',
    manifest: 'packages/autogen-plugin/pyproject.toml',
  },
];

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

export async function validateMachineDocuments(documents) {
  assert.deepEqual(Object.keys(documents).sort(), Object.keys(MACHINE_FILES).sort());
  for (const [file, content] of Object.entries(documents)) {
    assert.equal(typeof content, 'string', file);
    assert.ok(content.length > 0, file);
    assert.deepEqual(findForbiddenMatches(content), [], `${file}: public boundary violation`);
    assert.doesNotMatch(content, /C:\\\\Users\\\\|\/Users\/[^/]+\/|-----BEGIN [A-Z ]*KEY-----/);
  }
  const openapi = JSON.parse(documents['openapi.json']);
  const index = JSON.parse(documents['api-index.json']);
  const discovery = JSON.parse(documents['.well-known/agentdomain.json']);
  walk(openapi, (object) => {
    if ('$ref' in object)
      assert.ok(object.$ref.startsWith('#/'), 'Only internal OpenAPI references are permitted');
  });
  await SwaggerParser.validate(structuredClone(openapi), {
    resolve: { external: false },
    dereference: { circular: false },
  });
  assert.equal(openapi.openapi, '3.0.3');
  assert.deepEqual(openapi.servers, [{ url: API_ORIGIN }]);
  assert.equal(openapi['x-coverage'], 'documented-http-surface-only');
  assert.equal(index.format, 'agentdomain.api-index');
  assert.equal(discovery.format, 'agentdomain.documentation-discovery');
  assert.deepEqual(index.source, discovery.source);
  assert.deepEqual(index.source, openapi['x-source']);
  assert.equal(index.source.packages.length, 8);
  assert.equal(index.source.packages.filter((pkg) => pkg.ecosystem === 'npm').length, 6);
  assert.deepEqual(
    index.source.packages
      .filter((pkg) => pkg.ecosystem === 'pypi')
      .map((pkg) => pkg.name)
      .sort(),
    ['agentdomain-autogen', 'agentdomain-crewai'],
  );
  assert.deepEqual(
    index.source.packages.map((pkg) => pkg.manifest).sort(),
    packageMetadata.map((pkg) => pkg.manifest).sort(),
  );
  for (const pkg of index.source.packages) {
    const expected = packageMetadata.find((entry) => entry.manifest === pkg.manifest);
    assert.equal(pkg.name, expected.name);
    assert.equal(pkg.ecosystem, expected.ecosystem);
    const content = await readFile(join(publicRoot, expected.manifest), 'utf8');
    const actual =
      expected.ecosystem === 'npm'
        ? JSON.parse(content)
        : parsePythonPackage(content, expected.name);
    assert.equal(actual.name, expected.name);
    assert.equal(
      pkg.version,
      actual.version,
      `${pkg.manifest}: source version differs from workspace metadata`,
    );
    assert.equal(pkg.publication, 'workspace-version-not-registry-verification');
  }
  assert.match(index.source.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(documents['llms-full.txt'], new RegExp(index.source.sourceSha256));
  assert.equal(index.documents.length, EXPECTED_DOCS.length);
  const validLinks = new Set([
    ...EXPECTED_DOCS.map((file) => `${DOCS_ORIGIN}${routeForDoc(file)}`),
    ...Object.keys(MACHINE_FILES).map((file) => `${DOCS_ORIGIN}/${file}`),
    `${DOCS_ORIGIN}/llms.txt`,
    DOCS_ORIGIN,
  ]);
  for (const value of [openapi, index, discovery])
    walk(value, (object) => {
      for (const child of Object.values(object)) {
        if (typeof child === 'string' && child.startsWith(DOCS_ORIGIN)) {
          assert.ok(validLinks.has(child.split('#')[0]), `Unknown machine link: ${child}`);
        }
      }
    });
  const operationIds = new Set();
  let operationCount = 0;
  for (const [path, methods] of Object.entries(openapi.paths)) {
    assert.match(path, /^\/api\/v1(?:\/|$)/);
    assert.doesNotMatch(path, /inspect|prepare|auto.?renew|execute|\/admin|\/internal/i);
    for (const [method, operation] of Object.entries(methods)) {
      operationCount++;
      assert.ok(!operationIds.has(operation.operationId), 'Duplicate operationId');
      operationIds.add(operation.operationId);
      assert.ok(Array.isArray(operation.security));
      assert.equal(operation['x-schema-coverage'], 'documented-projection');
      assert.equal(operation['x-idempotency'] === 'read-only', method === 'get');
      assert.ok(
        index.http.some(
          (item) =>
            item.path === path &&
            item.method === method.toUpperCase() &&
            item.operationId === operation.operationId,
        ),
      );
    }
  }
  assert.equal(index.http.length, operationCount);
  for (const path of [
    '/api/v1/registrations',
    '/api/v1/registrations/{registrationId}',
    '/api/v1/registration-notices',
  ]) {
    for (const operation of Object.values(openapi.paths[path])) {
      assert.deepEqual(operation.security, [{ WalletSignature: [] }]);
      assert.ok(operation.responses['200'].headers['X-Authenticated-Wallet']);
    }
  }
  assert.deepEqual(
    openapi.paths['/api/v1/agents/{id}/email/send'].post.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    ).in,
    'header',
  );
  assert.match(
    openapi.paths['/api/v1/agents/register'].post.description,
    /Recover uncertain payment/,
  );
  assert.equal(index.mcp.remoteHttpEndpoint, null);
  assert.equal(
    discovery.interfaces.find((item) => item.type === 'mcp-stdio').remoteHttpEndpoint,
    null,
  );
  assert.ok(
    index.mcp.tools.some((tool) => tool.name === 'inspect_agent_identity' && tool.readOnly),
  );
  assert.ok(index.sdk.exports.includes('inspectAgentIdentity'));
  for (const name of [
    'inspectAgentRenewal',
    'prepareAutoRenewChange',
    'executeAutoRenewChange',
    'confirmAutoRenewChange',
  ])
    assert.ok(index.sdk.exports.includes(name), `Missing SDK source export: ${name}`);
  for (const name of ['inspect_agent_renewal', 'prepare_auto_renew_change'])
    assert.ok(
      index.mcp.tools.some((tool) => tool.name === name && tool.readOnly && tool.defaultEnabled),
      `Missing default read-only MCP tool: ${name}`,
    );
  return {
    files: Object.keys(documents).length,
    pages: index.documents.length,
    operations: operationCount,
    packages: index.source.packages.length,
  };
}

export async function validateBuiltMachineDocuments(directory, { compareSource = true } = {}) {
  const documents = Object.fromEntries(
    await Promise.all(
      Object.keys(MACHINE_FILES).map(async (file) => [
        file,
        await readFile(join(directory, file), 'utf8'),
      ]),
    ),
  );
  const result = await validateMachineDocuments(documents);
  if (compareSource)
    assert.deepEqual(
      documents,
      await createMachineDocuments(),
      'Built machine files do not match the current public source',
    );
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateBuiltMachineDocuments(fileURLToPath(new URL('../dist/', import.meta.url)))
    .then((result) => console.log(`Machine docs valid: ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
