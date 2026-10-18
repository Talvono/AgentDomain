import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { registrationParamsSchema } from '@agentdomain/shared';

import {
  createMachineDocuments,
  documentedHttpRoutes,
  extractPublicFeatures,
  MACHINE_FILES,
  parsePythonPackage,
} from '../scripts/machine-docs.mjs';
import { validateMachineDocuments } from '../scripts/validate-machine-docs.mjs';
import { publicSchemas } from '../scripts/public-api-contract.mjs';
import { DOCS_ROOT, validateInternalLinks } from '../scripts/validate-content.mjs';

test('machine docs are deterministic, source-derived and valid OpenAPI without external resolution', async () => {
  const first = await createMachineDocuments();
  assert.deepEqual(await createMachineDocuments(), first);
  assert.ok(
    first['llms-full.txt'].includes(
      'AgentDomain is the agent-native identity and communications infrastructure.',
    ),
  );
  assert.match(
    first['llms-full.txt'].replace(/\s+/g, ' '),
    /Developers can integrate directly through APIs and SDKs, people can guide agents, and autonomous workflows can operate within configured permissions/,
  );
  assert.doesNotMatch(
    first['llms-full.txt'],
    /Build, register, and operate durable internet identities for autonomous agents/,
  );
  const result = await validateMachineDocuments(first);
  assert.equal(result.files, 4);
  assert.equal(result.pages, 21);
  assert.equal(result.packages, 8);
  assert.ok(result.operations >= 30);
  const source = JSON.parse(first['api-index.json']).source;
  const tools = JSON.parse(first['api-index.json']).mcp.tools;
  const prepare = tools.find((tool) => tool.name === 'prepare_auto_renew_change');
  assert.deepEqual(prepare.inputSchema.required, [
    'tokenId',
    'expectedOwner',
    'enabled',
    'builderCode',
  ]);
  assert.equal(prepare.inputSchema.additionalProperties, false);
  assert.equal(prepare.inputSchema.properties.enabled.type, 'boolean');
  assert.deepEqual(tools.find((tool) => tool.name === 'inspect_agent_renewal').inputSchema.oneOf, [
    { required: ['domain'] },
    { required: ['tokenId'] },
  ]);
  for (const pkg of source.packages) {
    const manifest = await readFile(join(DOCS_ROOT, '..', '..', pkg.manifest), 'utf8');
    const actual =
      pkg.ecosystem === 'npm' ? JSON.parse(manifest) : parsePythonPackage(manifest, pkg.name);
    assert.equal(pkg.version, actual.version);
    assert.equal(pkg.publication, 'workspace-version-not-registry-verification');
  }
});

test('Python package discovery parses TOML and rejects mismatched or dynamic release metadata', () => {
  const source = `[project]\nname = "agentdomain-crewai"\nversion = "0.11.0"\ndescription = "Native CrewAI integration"\nrequires-python = ">=3.10"\nlicense = "Apache-2.0"\n`;
  assert.equal(parsePythonPackage(source, 'agentdomain-crewai').version, '0.11.0');
  for (const version of ['0.12.0', '2.0.0']) {
    assert.equal(
      parsePythonPackage(source.replace('0.11.0', version), 'agentdomain-crewai').version,
      version,
    );
  }
  assert.throws(() => parsePythonPackage(source, 'agentdomain-autogen'), /Invalid public/);
  assert.throws(
    () => parsePythonPackage(source + 'dynamic = ["version"]\n', 'agentdomain-crewai'),
    /Invalid public/,
  );
  assert.throws(
    () => parsePythonPackage(source.replace('Apache-2.0', 'UNLICENSED'), 'agentdomain-crewai'),
    /Invalid public/,
  );
  assert.throws(
    () => parsePythonPackage(source.replace('version = "0.11.0"', ''), 'agentdomain-crewai'),
    /Invalid public/,
  );
});

test('machine validation rejects stale versions, substituted manifests and invented publication status', async () => {
  const documents = await createMachineDocuments();
  for (const tamper of [
    (source) => {
      source.packages[0].version = `${source.packages[0].version}-stale`;
    },
    (source) => {
      source.packages[0].manifest = 'package.json';
    },
    (source) => {
      source.packages[0].publication = 'published';
    },
    (source) => {
      source.packages[0].name = '@agentdomain/unreviewed';
    },
  ]) {
    const changed = { ...documents };
    const index = JSON.parse(documents['api-index.json']);
    tamper(index.source);
    const discovery = JSON.parse(documents['.well-known/agentdomain.json']);
    const openapi = JSON.parse(documents['openapi.json']);
    discovery.source = index.source;
    openapi['x-source'] = index.source;
    changed['api-index.json'] = JSON.stringify(index);
    changed['.well-known/agentdomain.json'] = JSON.stringify(discovery);
    changed['openapi.json'] = JSON.stringify(openapi);
    await assert.rejects(validateMachineDocuments(changed));
  }
});

test('documented route extraction canonicalizes only real HTTP paths', () => {
  const routes = documentedHttpRoutes([
    {
      file: 'api-reference/agents.mdx',
      body: 'GET /api/v1/agents/:id\nGET /api/v1/agents/search?q=one\ninspectAgentIdentity({ tokenId: "1" })',
    },
  ]);
  assert.deepEqual([...routes], ['get /api/v1/agents/{id}', 'get /api/v1/agents/search']);
});

test('shared request schemas retain reviewed defaults, bounds and required fields', () => {
  const schemas = publicSchemas();
  assert.ok(schemas.RegistrationRequest.required.includes('wallet'));
  assert.ok(schemas.RegistrationRequest.required.includes('preferredName'));
  assert.equal(schemas.RegistrationRequest.properties.years.maximum, 10);
  assert.equal(schemas.DnsBatchInput.properties.records.maxItems, 200);
  const input = registrationParamsSchema.parse({
    wallet: '0x1111111111111111111111111111111111111111',
    preferredName: 'example',
    tld: 'xyz',
  });
  assert.equal(schemas.RegistrationRequest.properties.years.default, input.years);
  assert.equal(
    schemas.RegistrationRequest.properties.registerBasename.default,
    input.registerBasename,
  );
  assert.equal(
    schemas.RegistrationResult.properties.renewalSnapshot['x-schema-coverage'],
    'partial',
  );
  assert.equal(schemas.RegistrationResult.properties.basename.nullable, true);
  assert.equal(schemas.RegistrationResult.properties.ensName.nullable, true);
  assert.equal(schemas.RegistrationProgress.properties.agentId.nullable, true);
  assert.ok(Object.keys(schemas.RegistrationProgress.properties).length > 10);
  assert.equal(schemas.DnsRecordInput.properties.data.type, 'object');
  assert.equal(schemas.DocumentedJson['x-schema-coverage'], 'unspecified');
});

test('machine validation rejects external references and undocumented routes', async () => {
  const documents = await createMachineDocuments();
  const api = JSON.parse(documents['openapi.json']);
  api.components.schemas.Hostile = { $ref: 'https://untrusted.example/schema.json' };
  await assert.rejects(
    validateMachineDocuments({ ...documents, 'openapi.json': JSON.stringify(api) }),
    /Only internal/,
  );
  const changed = JSON.parse(documents['openapi.json']);
  changed.paths['/api/v1/inspect'] = structuredClone(changed.paths['/api/v1/agents/{id}']);
  await assert.rejects(
    validateMachineDocuments({ ...documents, 'openapi.json': JSON.stringify(changed) }),
  );
});

test('HTTP-style responses parse as JSON or text and link to current public resources', async () => {
  const documents = await createMachineDocuments();
  const headers = await readFile(join(DOCS_ROOT, 'public', '_headers'), 'utf8');
  const server = createServer((request, response) => {
    const file = request.url.slice(1);
    if (!Object.hasOwn(MACHINE_FILES, file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': MACHINE_FILES[file],
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(documents[file]);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const parsed = {};
    for (const [file, contentType] of Object.entries(MACHINE_FILES)) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${file}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      parsed[file] = await response.text();
      assert.ok(
        headers.includes(`/${file}\n  Content-Type: ${contentType}`) ||
          headers.includes(`/${file}\r\n  Content-Type: ${contentType}`),
      );
      assert.doesNotThrow(() =>
        validateInternalLinks(`[Machine](/${file})`, 'machine.mdx', new Set()),
      );
    }
    await validateMachineDocuments(parsed);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('source feature parsing is non-executing and fails closed if structure changes', () => {
  assert.throws(
    () => extractPublicFeatures('export const value = 1;', 'runEverything()'),
    /could not be derived/,
  );
});
