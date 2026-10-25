import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import {
  AgentDomain,
  agentRequestBodySha256,
  agentSignatureAudience,
  buildAgentSignatureMessage,
  canonicalAgentRequestTarget,
  createAgentSignatureHeader,
} from '../dist/index.js';

const API = 'https://api.agentdomain.app/api/v1';
const NONCE = '0123456789abcdef0123456789abcdef';
// Public deterministic test key, shared with the backend verifier's test vector.
const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Must stay byte-identical to services/backend/test/agent-signature.test.ts in the platform. */
const VECTOR = {
  url: `${API}/agents/7c9e6679-7425-40de-944b-e07fc1f90ae7/email/send?b=2&a=x%20y&a=1`,
  body: '{"to":"ops@example.com","subject":"Hi","text":"Hello"}',
  timestamp: 1793534400000,
  message: [
    'AgentDomain API request',
    'version: 2',
    'audience: agentdomain.app',
    'method: POST',
    'target: /api/v1/agents/7c9e6679-7425-40de-944b-e07fc1f90ae7/email/send?a=1&a=x%20y&b=2',
    'body-sha256: 3a90c2606d84342cb4d1c3c299372326499cecf5eab9ba5e4f763ba617f17c3e',
    'timestamp: 1793534400000',
    `nonce: ${NONCE}`,
  ].join('\n'),
  address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  signature:
    '0x2b64821be253ad72e8b041a1490c498c924a115c34aa22d2131f6ddff0d5d968434570a1da6df9bd7538c1a8ce3919316325d347b52a46c2f7e73257e59ac8031b',
};

function signer() {
  const messages = [];
  return {
    messages,
    address: account.address,
    signMessage: async (message) => {
      messages.push(message);
      return account.signMessage({ message });
    },
  };
}

describe('request-bound agent signature v2', () => {
  it('reproduces the shared backend vector byte for byte', async () => {
    const header = await createAgentSignatureHeader(
      signer(),
      { method: 'post', url: VECTOR.url, body: VECTOR.body },
      { timestamp: VECTOR.timestamp, nonce: NONCE },
    );
    assert.equal(account.address, VECTOR.address);
    assert.equal(header, `v2:${VECTOR.address}:${VECTOR.timestamp}:${NONCE}:${VECTOR.signature}`);
    assert.equal(
      await recoverMessageAddress({ message: VECTOR.message, signature: VECTOR.signature }),
      VECTOR.address,
    );
  });

  it('canonicalizes equivalent targets and hashes exact body bytes', () => {
    const plus = canonicalAgentRequestTarget(new URL(`${API}/x?q=a+b&z=1&a=%40`));
    assert.equal(plus, '/api/v1/x?a=%40&q=a%20b&z=1');
    assert.equal(canonicalAgentRequestTarget(new URL(`${API}/x?a=@&z=1&q=a%20b`)), plus);
    assert.equal(
      canonicalAgentRequestTarget(new URL(`${API}/a%27b/c?k=(v)*!`)),
      '/api/v1/a%27b/c?k=%28v%29%2A%21',
    );
    assert.equal(
      agentRequestBodySha256(VECTOR.body),
      createHash('sha256').update(VECTOR.body).digest('hex'),
    );
    assert.equal(agentRequestBodySha256(), createHash('sha256').update('').digest('hex'));
    assert.equal(
      agentRequestBodySha256(new TextEncoder().encode('é')),
      createHash('sha256').update('é').digest('hex'),
    );
  });

  it('binds the platform audience for every agentdomain.app host only', () => {
    assert.equal(agentSignatureAudience('api.agentdomain.app'), 'agentdomain.app');
    assert.equal(agentSignatureAudience('agentdomain.app'), 'agentdomain.app');
    assert.equal(
      agentSignatureAudience('agentdomain.app.evil.example'),
      'agentdomain.app.evil.example',
    );
    assert.equal(agentSignatureAudience('localhost:3000'), 'localhost:3000');
  });

  it('rejects a malformed caller nonce', async () => {
    await assert.rejects(
      createAgentSignatureHeader(signer(), { method: 'GET', url: API }, { nonce: 'ABC' }),
      TypeError,
    );
  });

  it('signs each client request over its own method, target, body and nonce', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, ...init });
      return Response.json({ messageId: 'm', status: 'queued' });
    };
    const wallet = signer();
    const ad = new AgentDomain({
      walletClient: {
        account: { address: account.address },
        signMessage: ({ message }) => wallet.signMessage(message),
      },
    });
    const args = { to: 'ops@example.com', subject: 'Hi', text: 'Hello' };
    await ad.sendEmail('agent-1', args);
    await ad.sendEmail('agent-1', args);
    assert.equal(requests.length, 2);
    const nonces = new Set();
    for (const [index, request] of requests.entries()) {
      const [version, address, timestamp, nonce, signature] =
        request.headers['X-Agent-Signature'].split(':');
      assert.equal(version, 'v2');
      assert.equal(address, account.address);
      nonces.add(nonce);
      const message = buildAgentSignatureMessage({
        audience: 'agentdomain.app',
        method: 'POST',
        target: '/api/v1/agents/agent-1/email/send',
        bodySha256: createHash('sha256').update(request.body).digest('hex'),
        timestamp: Number(timestamp),
        nonce,
      });
      assert.equal(wallet.messages[index], message);
      assert.equal(await recoverMessageAddress({ message, signature }), account.address);
    }
    assert.equal(nonces.size, 2, 'every request uses a fresh nonce');
  });

  it('sends an API key instead of a signature unless the route requires the wallet', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return Response.json(url.endsWith('/keys') ? { id: 'k' } : { agentId: 'a' });
    };
    const wallet = signer();
    const ad = new AgentDomain({
      apiKey: 'agk_test_key',
      walletClient: {
        account: { address: account.address },
        signMessage: ({ message }) => wallet.signMessage(message),
      },
    });
    await ad.getAgentById('a');
    await ad.createApiKey('a', 'ci');
    assert.equal(requests[0].headers.Authorization, 'Bearer agk_test_key');
    assert.equal(requests[0].headers['X-Agent-Signature'], undefined);
    assert.equal(requests[1].headers.Authorization, undefined);
    assert.match(requests[1].headers['X-Agent-Signature'], /^v2:/);
    assert.match(wallet.messages[0], /\nmethod: POST\ntarget: \/api\/v1\/keys\n/);
  });
});
