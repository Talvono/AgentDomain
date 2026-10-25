import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  AgentDomain,
  agentRequestBodySha256,
  agentSignatureAudience,
  buildAgentSignatureMessage,
  canonicalAgentRequestTarget,
} from '@agentdomain/sdk';
import { createWalletClient, custom, recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ToolInputParsingException } from '@langchain/core/tools';
import { createAgentDomainTools } from '../dist/index.js';
import { agentId, registrationId, other } from './fixtures/base-rpc.mjs';

process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';

// A disposable local signer verifies real SDK API authentication. It is never
// persisted, funded, printed, or used to send a transaction.
const account = privateKeyToAccount(generatePrivateKey());
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: custom({ request: async () => assert.fail('Wallet RPC is forbidden') }),
}).extend(() => ({
  signTypedData: async () => assert.fail('Typed-data signing is forbidden'),
  sendTransaction: async () => assert.fail('Transaction submission is forbidden'),
}));
const fixtureKey = 'local-fixture-api-value';
const nativeFetch = globalThis.fetch;
let server;
let apiUrl;
let mode = 'ok';
let requests = [];
const violations = [];

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, apiUrl);
      requests.push({ method: request.method, pathname: url.pathname });
      assert.equal(request.method, 'GET', 'API tools must never write');
      assert.equal(request.headers['payment-signature'], undefined);
      assert.equal(request.headers['x-payment'], undefined);
      if (mode === 'denied') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic-secret-auth-error' }));
        return;
      }
      if (url.pathname === `/api/v1/agents/${agentId}`) {
        assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            id: agentId,
            domain: 'reader.example',
            status: 'active',
            walletAddress: account.address,
            ownerAddress: account.address,
          }),
        );
        return;
      }
      assert.equal(url.pathname, `/api/v1/registrations/${registrationId}`);
      assert.equal(
        request.headers.authorization,
        undefined,
        'Registration does not use the ordinary API key',
      );
      assert.equal(url.searchParams.get('expectedPayer'), account.address.toLowerCase());
      const header = request.headers['x-agent-signature'];
      assert.equal(typeof header, 'string');
      const [version, claimed, issued, nonce, signature] = header.split(':');
      assert.equal(version, 'v2');
      // Rebuild from the URL this server actually received, as the API does.
      const recovered = await recoverMessageAddress({
        message: buildAgentSignatureMessage({
          audience: agentSignatureAudience(url.host),
          method: request.method,
          target: canonicalAgentRequestTarget(url),
          bodySha256: agentRequestBodySha256(),
          timestamp: Number(issued),
          nonce,
        }),
        signature,
      });
      assert.equal(recovered, account.address);
      assert.equal(claimed, account.address.toLowerCase());
      const body = {
        registrationId: mode === 'wrong-registration' ? agentId : registrationId,
        status: 'processing',
        statusUrl: `${apiUrl}/registrations/${registrationId}`,
        domain: 'reader.example',
        paymentStatus: 'settled',
        pollAfterSeconds: 5,
        agentId: null,
        stage: 'domain',
        messageCode: 'REGISTRATION_PROCESSING',
        startedAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
        completedAt: null,
        revision: 1,
        estimatedDurationSeconds: null,
        completionEventId: null,
      };
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Authenticated-Wallet': mode === 'wrong-payer' ? other : account.address,
      });
      response.end(JSON.stringify(body));
    } catch (error) {
      violations.push(error);
      response.writeHead(500);
      response.end('Fixture assertion failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(new Request(input, init).url).origin, new URL(apiUrl).origin);
    return nativeFetch(input, init);
  };
});
beforeEach(() => {
  requests = [];
  mode = 'ok';
});
afterEach(() => {
  assert.deepEqual(violations, []);
});
after(async () => {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function configured(apiClient = new AgentDomain({ apiUrl, apiKey: fixtureKey, walletClient })) {
  return createAgentDomainTools({ apiClient });
}

describe('explicit API opt-in with real SDK and authenticated HTTP', () => {
  it('does not create API tools without a host-configured client', () => {
    assert.ok(
      createAgentDomainTools().every(
        (candidate) => !['lookup_agent', 'get_registration_status'].includes(candidate.name),
      ),
    );
    assert.deepEqual(requests, []);
  });

  it('performs an authenticated lookup without embedding client credentials in the tool or result', async () => {
    const lookup = configured().find((candidate) => candidate.name === 'lookup_agent');
    assert.doesNotMatch(
      JSON.stringify(lookup.toJSON()),
      /local-fixture-api-value|walletClient|privateKey/,
    );
    const result = await lookup.invoke({ agentId });
    assert.equal(result.ok, true);
    assert.equal(result.data.domain, 'reader.example');
    assert.equal(result.data.id, agentId);
    assert.doesNotMatch(JSON.stringify(result), /local-fixture-api-value|x-agent-signature/i);
    assert.deepEqual(requests, [{ method: 'GET', pathname: `/api/v1/agents/${agentId}` }]);
  });

  it('authenticates a registration read with real signMessage, never a payment or transaction', async () => {
    const read = configured().find((candidate) => candidate.name === 'get_registration_status');
    const result = await read.invoke({ registrationId });
    assert.equal(result.ok, true);
    assert.equal(result.data.registrationId, registrationId);
    assert.equal(result.data.status, 'processing');
    assert.equal(requests.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 1, 'No polling or recovery loop');
  });

  it('does not pretend an API key alone supplies registration payer authentication', async () => {
    const read = configured(new AgentDomain({ apiUrl, apiKey: fixtureKey })).find(
      (candidate) => candidate.name === 'get_registration_status',
    );
    const result = await read.invoke({ registrationId });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'API_UNAVAILABLE');
    assert.equal(requests.length, 0);
  });

  for (const scenario of ['denied', 'wrong-payer', 'wrong-registration']) {
    it(`does not bypass or reinterpret ${scenario} as confirmed status`, async () => {
      mode = scenario;
      const result = await configured()
        .find((candidate) => candidate.name === 'get_registration_status')
        .invoke({ registrationId });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'API_UNAVAILABLE');
      assert.doesNotMatch(
        JSON.stringify(result),
        /synthetic-secret-auth-error|local-fixture-api-value/,
      );
      assert.equal(requests.length, 1);
    });
  }

  it('rejects model-supplied endpoints and invalid identifiers before HTTP', async () => {
    const lookup = configured().find((candidate) => candidate.name === 'lookup_agent');
    await assert.rejects(lookup.invoke({ agentId: '../../keys' }), ToolInputParsingException);
    await assert.rejects(
      lookup.invoke({ agentId, apiUrl: 'https://untrusted.example.invalid' }),
      ToolInputParsingException,
    );
    await assert.rejects(
      lookup.invoke({ agentId, apiKey: 'not-allowed' }),
      ToolInputParsingException,
    );
    assert.equal(requests.length, 0);
  });
});
