import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { registrationAcceptedSchema, registrationProgressSchema } from '@agentdomain/shared';
import {
  AgentDomain,
  RegistrationFailedError,
  RegistrationPendingError,
  buildAgentSignatureMessage,
  canonicalAgentRequestTarget,
} from '../dist/index.js';

const apiUrl = 'https://api.example.test/api/v1';
const payer = '0x1111111111111111111111111111111111111111';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-06T00:00:00.000Z');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete globalThis.location;
});

function accepted(overrides = {}) {
  return {
    registrationId: id,
    status: 'processing',
    statusUrl: `/api/v1/registrations/${id}`,
    domain: 'research-agent.xyz',
    paymentStatus: 'settled',
    pollAfterSeconds: 5,
    ...overrides,
  };
}

function progress(overrides = {}) {
  return {
    ...accepted(),
    agentId: null,
    stage: 'domain',
    messageCode: 'REGISTRATION_PROCESSING',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    revision: 1,
    estimatedDurationSeconds: null,
    completionEventId: null,
    ...overrides,
  };
}

function legacy() {
  return {
    registrationId: id,
    agentId: otherId,
    nftTokenId: 42,
    domain: 'research-agent.xyz',
    basename: null,
    ensName: null,
    txHash: `0x${'ab'.repeat(32)}`,
    sslStatus: 'active',
    estimatedReadyAt: now.toISOString(),
    metadataUri: 'ipfs://example',
  };
}

function wallet() {
  const messages = [];
  const typed = [];
  return {
    messages,
    typed,
    account: { address: payer },
    signMessage: async ({ message }) => {
      messages.push(message);
      return `0x${'11'.repeat(65)}`;
    },
    signTypedData: async (value) => {
      typed.push(value);
      return `0x${'22'.repeat(65)}`;
    },
  };
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'X-Authenticated-Wallet': payer } });
}

function isListUrl(url) {
  return new URL(url).pathname.endsWith('/registrations');
}

function challenge(baseUrl = apiUrl) {
  const body = {
    x402Version: 2,
    resource: {
      url: `${baseUrl}/agents/register`,
      description: 'Registration',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '100000',
        payTo: '0x2222222222222222222222222222222222222222',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2', requestBinding: `0x${'ab'.repeat(32)}` },
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body) },
  });
}

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

const handle = () => ({
  registrationId: null,
  statusUrl: null,
  domain: 'research-agent.xyz',
  startedAt: new Date(now.getTime() - 1000).toISOString(),
  endedAt: new Date(now.getTime() + 1000).toISOString(),
});

describe('public asynchronous registration contracts', () => {
  it('resolves a relative API base once against browser location before payment', async () => {
    const baseUrl = 'https://browser.example/api/v1';
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: 'https://browser.example/checkout' },
    });
    const urls = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      assert.ok(String(url).startsWith(baseUrl + '/'));
      if (init.method === 'POST')
        return urls.length === 1 ? challenge(baseUrl) : json(accepted(), 202);
      return json(progress());
    };
    const ad = new AgentDomain({ apiUrl: '/api/v1/', walletClient: wallet() });
    const submission = await ad.submitRegistration({ preferredName: 'research-agent' });
    assert.equal(submission.status, 'processing');
    await ad.getRegistration(submission.registrationId);
    assert.deepEqual(urls, [
      baseUrl + '/agents/register',
      baseUrl + '/agents/register',
      `${baseUrl}/registrations/${id}?expectedPayer=${payer}`,
    ]);
  });

  it('rejects relative bases without a browser and unsafe base URLs before signing or fetching', () => {
    delete globalThis.location;
    const signer = wallet();
    signer.signMessage = () => assert.fail('No signature for invalid configuration');
    signer.signTypedData = () => assert.fail('No payment for invalid configuration');
    globalThis.fetch = () => assert.fail('No request for invalid configuration');
    for (const value of [
      '/api/v1',
      '',
      'http://api.example/api/v1',
      'http://localhost.evil.example/api/v1',
      'file:///api/v1',
      'javascript:alert(1)',
      'https://user:password@example.test/api/v1',
      'https://api.example/api/v1?key=x',
      'https://api.example/api/v1#fragment',
    ]) {
      assert.throws(() => new AgentDomain({ apiUrl: value, walletClient: signer }), /apiUrl/);
    }
  });

  it('permits explicitly configured HTTP loopback development endpoints', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      assert.doesNotThrow(() => new AgentDomain({ apiUrl: `http://${host}:3000/api/v1` }));
    }
  });

  it('returns only the parsed public 200 projection, preserving the complete public snapshot', async () => {
    const snapshot = {
      version: 1,
      capturedAt: now.toISOString(),
      years: 1,
      currency: 'USDC',
      autoRenewTotalUsdc: '1',
      autoRenewTotalAtomic: '1000000',
      fullServiceTotalUsdc: null,
      fullServiceTotalAtomic: null,
      items: [
        {
          key: 'domain',
          label: 'Domain',
          selected: true,
          provisioned: true,
          includedInAutoRenew: true,
          amountUsdc: '1',
          amountAtomic: '1000000',
          source: 'spaceship',
          note: 'Public purchase snapshot',
        },
      ],
      warnings: ['Public warning'],
    };
    globalThis.fetch = async () =>
      json({
        ...legacy(),
        providerData: { hidden: true },
        requestParams: { hidden: true },
        renewalSnapshot: {
          ...snapshot,
          hidden: true,
          items: snapshot.items.map((item) => ({ ...item, hidden: true })),
        },
      });
    const result = await new AgentDomain({ apiUrl, walletClient: wallet() }).register({
      preferredName: 'research-agent',
    });
    assert.deepEqual(result, { ...legacy(), renewalSnapshot: snapshot });
  });

  it('rejects HTTP 200 for a different domain without returning it or paying again', async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return json({ ...legacy(), domain: 'other.xyz' });
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).register({
        preferredName: 'research-agent',
      }),
      (error) =>
        error instanceof RegistrationPendingError &&
        error.reason === 'invalid_response' &&
        error.handle.domain === 'research-agent.xyz',
    );
    assert.equal(requests, 1);
  });

  it('requires every required legacy result field before accepting HTTP 200', async () => {
    for (const key of Object.keys(legacy()).filter((key) => key !== 'registrationId')) {
      const partial = { ...legacy() };
      delete partial[key];
      globalThis.fetch = async () => json(partial);
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).register({
          preferredName: 'research-agent',
        }),
        (error) => error instanceof RegistrationPendingError && error.reason === 'invalid_response',
        key,
      );
    }
  });
  it('preserves a minimal review-required handle after payment without retrying checkout', async () => {
    let posts = 0;
    const signer = wallet();
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, 'POST');
      posts++;
      if (posts === 1) return challenge();
      return json(
        {
          registrationId: id,
          statusUrl: `/api/v1/registrations/${id}`,
          status: 'action_required',
          messageCode: 'REGISTRATION_REFUND_RECONCILIATION_REQUIRED',
        },
        202,
      );
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: signer }).register({
        preferredName: 'research-agent',
      }),
      (error) => {
        assert.ok(error instanceof RegistrationPendingError);
        assert.equal(error.reason, 'action_required');
        assert.equal(error.handle.registrationId, id);
        assert.equal(error.handle.domain, 'research-agent.xyz');
        assert.equal(error.progress, undefined);
        return true;
      },
    );
    assert.equal(posts, 2);
  });

  it('preserves full generic refund-review progress on 202', async () => {
    const review = progress({
      status: 'action_required',
      pollAfterSeconds: 30,
      messageCode: 'REGISTRATION_REFUND_RECONCILIATION_REQUIRED',
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return json(review, 202);
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration({
        preferredName: 'research-agent',
      }),
      (error) =>
        error instanceof RegistrationPendingError &&
        error.reason === 'action_required' &&
        error.progress.messageCode === review.messageCode,
    );
    assert.equal(calls, 1);
  });

  it('rejects a review-required handle for a different domain or status host', async () => {
    for (const changed of [
      { domain: 'another.xyz' },
      { statusUrl: 'https://other.example/status' },
    ]) {
      globalThis.fetch = async () => json(accepted({ status: 'action_required', ...changed }), 202);
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration({
          preferredName: 'research-agent',
        }),
        (error) => error instanceof RegistrationPendingError && error.reason === 'invalid_response',
      );
    }
  });
  it('does not interpret malformed HTTP 200 data as a completed registration', async () => {
    globalThis.fetch = async () => json({ registrationId: id, agentId: otherId });
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).register({
        preferredName: 'research-agent',
      }),
      (error) =>
        error instanceof RegistrationPendingError &&
        error.reason === 'invalid_response' &&
        error.handle.registrationId === id,
    );
  });
  it('accepts the minimum 202 and strips uncontracted state', () => {
    assert.deepEqual(registrationAcceptedSchema.parse(accepted()), accepted());
    assert.deepEqual(
      registrationProgressSchema.parse({
        ...progress(),
        paymentProof: 'not-public',
        internal: { secret: true },
      }),
      progress(),
    );
    assert.equal(
      registrationProgressSchema.safeParse(progress({ pollAfterSeconds: 0 })).success,
      false,
    );
    assert.equal(registrationProgressSchema.safeParse(progress({ revision: -1 })).success, false);
  });

  it('preserves a legacy HTTP 200 result without status reads', async () => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init.headers.Prefer, 'respond-async');
      return json(legacy());
    };
    assert.deepEqual(
      await new AgentDomain({ apiUrl, walletClient: wallet() }).register({
        preferredName: 'research-agent',
      }),
      legacy(),
    );
    assert.equal(calls, 1);
  });

  it('submits exactly one challenged payment with Prefer and returns the accepted handle', async () => {
    const signer = wallet();
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, ...init });
      return requests.length === 1 ? challenge() : json(accepted(), 202);
    };
    const ad = new AgentDomain({ apiUrl, apiKey: 'must-not-be-used', walletClient: signer });
    assert.deepEqual(await ad.submitRegistration({ preferredName: 'research-agent' }), accepted());
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    for (const request of requests) {
      assert.equal(request.headers.Prefer, 'respond-async');
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.credentials, 'omit');
      assert.equal(request.redirect, 'error');
    }
    const payment = decodePaymentSignatureHeader(requests[1].headers['PAYMENT-SIGNATURE']);
    assert.equal(payment.payload.authorization.from.toLowerCase(), payer);
    assert.equal(payment.payload.authorization.nonce, `0x${'ab'.repeat(32)}`);
    // Each POST carries its own single-use request-bound signature over the same body.
    assert.equal(signer.messages.length, 2);
    const [first, paid] = requests.map((request) => request.headers['X-Agent-Signature']);
    assert.match(first, /^v2:0x1{40}:\d{13}:[0-9a-f]{32}:0x(11){65}$/);
    assert.match(paid, /^v2:0x1{40}:\d{13}:[0-9a-f]{32}:0x(11){65}$/);
    assert.notEqual(first.split(':')[3], paid.split(':')[3]);
    for (const message of signer.messages) {
      assert.match(message, /^AgentDomain API request\nversion: 2\naudience: api\.example\.test\n/);
      assert.match(message, /\nmethod: POST\ntarget: \/api\/v1\/agents\/register\n/);
    }
  });
});

describe('payer-authenticated registration reads', () => {
  it('omits a different wallet cookie and binds detail, list, and recovery to the signer', async () => {
    const cookieWallet = '0x2222222222222222222222222222222222222222';
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const expected = new URL(url).searchParams.get('expectedPayer');
      requests.push({ expected, credentials: init.credentials });
      const authenticated = init.credentials === 'include' ? cookieWallet : payer;
      if (expected !== authenticated) return json({}, 401);
      assert.ok(init.headers['X-Agent-Signature']);
      return json(isListUrl(url) ? { items: [progress()], total: 1, hasMore: false } : progress());
    };
    const ad = new AgentDomain({ apiUrl, walletClient: wallet() });
    await ad.getRegistration(id);
    await ad.getRegistrations();
    await ad.recoverRegistration({ ...handle(), payerAddress: payer });
    assert.equal(requests.length, 4);
    assert.ok(
      requests.every((request) => request.expected === payer && request.credentials === 'omit'),
    );
  });

  it('binds session-only reads to an explicit payer and rejects a different authenticated cookie', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(url).searchParams.get('expectedPayer'), payer);
      assert.equal(init.credentials, 'include');
      assert.equal(init.headers['X-Agent-Signature'], undefined);
      return json({ error: 'UNAUTHORIZED' }, 401);
    };
    const ad = new AgentDomain({
      apiUrl,
      registrationAuth: 'session',
      registrationExpectedPayer: payer,
    });
    await assert.rejects(ad.getRegistration(id), /401/);
    await assert.rejects(ad.getRegistrations(), /401/);
  });

  it('requires a known payer for session reads without treating the query as authentication', async () => {
    globalThis.fetch = () => assert.fail('No unbound session read');
    await assert.rejects(
      new AgentDomain({ apiUrl, registrationAuth: 'session' }).getRegistrations(),
      /expectedPayer/,
    );
  });

  it('rejects a mismatched or missing authenticated-wallet header before decoding another wallet body', async () => {
    for (const authenticated of [null, '0x2222222222222222222222222222222222222222']) {
      let decoded = false;
      globalThis.fetch = async () => {
        const response = new Response('{}', {
          headers: authenticated ? { 'X-Authenticated-Wallet': authenticated } : {},
        });
        response.json = async () => {
          decoded = true;
          return progress();
        };
        return response;
      };
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
        (error) => error instanceof RegistrationPendingError && error.reason === 'invalid_response',
      );
      assert.equal(decoded, false);
    }
  });

  it('keeps the original payer in lost-response handles and blocks recovery with a different signer', async () => {
    let pending;
    globalThis.fetch = async () => {
      throw new TypeError('Lost submission response');
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration({
        preferredName: 'research-agent',
      }),
      (error) => {
        pending = error;
        return error instanceof RegistrationPendingError;
      },
    );
    assert.equal(pending.handle.payerAddress.toLowerCase(), payer);
    const different = wallet();
    different.account.address = '0x2222222222222222222222222222222222222222';
    globalThis.fetch = () => assert.fail('No wrong-payer recovery request');
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: different }).recoverRegistration(pending.handle),
      /Expected payer does not match the registration handle/,
    );
  });
  it('matches the server list default of 20 and maximum of 50 before requesting', async () => {
    const limits = [];
    globalThis.fetch = async (url) => {
      const limit = Number(new URL(url).searchParams.get('limit'));
      assert.ok(limit <= 50);
      limits.push(limit);
      return json({ items: [], total: 0, hasMore: false });
    };
    const ad = new AgentDomain({ apiUrl, walletClient: wallet() });
    await ad.getRegistrations();
    await ad.getRegistrations({ limit: 50 });
    await assert.rejects(ad.getRegistrations({ limit: 51 }), /1-50/);
    assert.deepEqual(limits, [20, 50]);
  });
  it('does not sign after abort', async () => {
    const signer = wallet();
    globalThis.fetch = async () => json(progress());
    const ad = new AgentDomain({ apiUrl, walletClient: signer });
    await ad.getRegistration(id);
    await assert.rejects(ad.getRegistration(id, { signal: AbortSignal.abort() }), {
      name: 'AbortError',
    });
    assert.equal(signer.messages.length, 1);
  });
  it('signs every read with a fresh request-bound signature and never sends the API key', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const signer = wallet();
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      return json(isListUrl(url) ? { items: [progress()], total: 1, hasMore: false } : progress());
    };
    const ad = new AgentDomain({ apiUrl, apiKey: 'agent-key', walletClient: signer });
    await Promise.all([ad.getRegistration(id), ad.getRegistrations()]);
    await ad.getRegistration(id);
    assert.equal(signer.messages.length, 3);
    const headers = requests.map((request) => request.headers['X-Agent-Signature']);
    assert.equal(new Set(headers).size, 3);
    for (const [index, request] of requests.entries()) {
      const [version, address, timestamp, nonce, signature] = headers[index].split(':');
      assert.equal(version, 'v2');
      assert.equal(address, payer);
      assert.equal(Number(timestamp), now.getTime());
      assert.match(nonce, /^[0-9a-f]{32}$/);
      assert.equal(signature, `0x${'11'.repeat(65)}`);
      const expected = buildAgentSignatureMessage({
        audience: 'api.example.test',
        method: 'GET',
        target: canonicalAgentRequestTarget(new URL(request.url)),
        bodySha256: EMPTY_SHA256,
        timestamp: now.getTime(),
        nonce,
      });
      assert.ok(signer.messages.includes(expected), expected);
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.headers['PAYMENT-SIGNATURE'], undefined);
    }
  });

  it('uses existing SIWE cookies without prompting a wallet in session mode', async () => {
    const signer = wallet();
    signer.signMessage = () => assert.fail('No wallet prompt for SIWE reads');
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(init.headers, {});
      assert.equal(init.credentials, 'include');
      return json(progress());
    };
    await new AgentDomain({
      apiUrl,
      walletClient: signer,
      registrationAuth: 'session',
    }).getRegistration(id);
  });

  it('does not treat API-key-only configuration as payer authentication', async () => {
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(init.headers, {});
      return json({ error: 'UNAUTHORIZED' }, 401);
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, apiKey: 'agent-key' }).getRegistration(id, {
        expectedPayer: payer,
      }),
      /401/,
    );
  });

  it('does not follow a foreign status URL or a status for another registration', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return json(progress({ statusUrl: `https://other.example/registrations/${id}` }));
    };
    const ad = new AgentDomain({ apiUrl, walletClient: wallet() });
    await assert.rejects(ad.getRegistration(id), /status URL/);
    assert.deepEqual(urls, [`${apiUrl}/registrations/${id}?expectedPayer=${payer}`]);
    globalThis.fetch = async () => json(progress({ registrationId: otherId }));
    await assert.rejects(ad.getRegistration(id), /identity mismatch/);
  });
});

describe('bounded status waiting', () => {
  it('returns the actual completed result for externally hosted SSL without inventing fields', async () => {
    const result = { ...legacy(), sslStatus: 'external' };
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, undefined);
      return json(
        progress({
          status: 'completed',
          stage: 'complete',
          agentId: otherId,
          completedAt: now.toISOString(),
          result,
        }),
      );
    };
    assert.deepEqual(
      await new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
      result,
    );
  });

  for (const invalid of [{ txHash: '0x' }, { sslStatus: 'provisioning' }]) {
    it(`does not fabricate completion for ${JSON.stringify(invalid)}`, async () => {
      let reads = 0;
      globalThis.fetch = async (_url, init) => {
        reads++;
        assert.equal(init.method, undefined);
        return json(
          progress({
            status: 'completed',
            stage: 'complete',
            agentId: otherId,
            completedAt: now.toISOString(),
            result: { ...legacy(), ...invalid },
          }),
        );
      };
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
        (error) =>
          error instanceof RegistrationPendingError &&
          error.reason === 'invalid_response' &&
          error.handle.registrationId === id,
      );
      assert.equal(reads, 1);
    });
  }
  it('honors Retry-After on rate-limited status reads without resubmitting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    let reads = 0;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, undefined);
      reads++;
      return reads === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })
        : json(
            progress({
              status: 'completed',
              stage: 'complete',
              agentId: otherId,
              completedAt: now.toISOString(),
              result: legacy(),
            }),
          );
    };
    const waiting = new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id);
    await flush();
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(reads, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await waiting, legacy());
  });
  it('register waits through 202 and returns only the server completed result without another POST', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    const signer = wallet();
    let posts = 0;
    let reads = 0;
    globalThis.fetch = async (_url, init) => {
      if (init.method === 'POST') {
        posts++;
        return posts === 1 ? challenge() : json(accepted(), 202);
      }
      reads++;
      return json(
        reads === 1
          ? progress({ stage: 'ssl', agentId: otherId })
          : progress({
              status: 'completed',
              stage: 'complete',
              agentId: otherId,
              completedAt: now.toISOString(),
              result: legacy(),
            }),
      );
    };
    const waiting = new AgentDomain({ apiUrl, walletClient: signer }).register({
      preferredName: 'research-agent',
    });
    await flush();
    assert.equal(reads, 0);
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(reads, 1);
    t.mock.timers.tick(5_000);
    assert.deepEqual(await waiting, legacy());
    assert.equal(posts, 2);
    assert.equal(reads, 2);
    // Two POSTs and two status reads, each with its own single-use signature.
    assert.equal(signer.messages.length, 4);
  });

  it('honors a longer server polling hint', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    let reads = 0;
    globalThis.fetch = async () => {
      reads++;
      return json(
        reads === 1
          ? progress({ pollAfterSeconds: 30 })
          : progress({
              status: 'completed',
              stage: 'complete',
              agentId: otherId,
              completedAt: now.toISOString(),
              result: legacy(),
            }),
      );
    };
    const waiting = new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id);
    await flush();
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(reads, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await waiting, legacy());
  });

  for (const result of [undefined, null]) {
    it(`does not fabricate a result when completed status has ${String(result)} result`, async () => {
      globalThis.fetch = async () =>
        json(
          progress({
            status: 'completed',
            stage: 'complete',
            agentId: otherId,
            completedAt: now.toISOString(),
            result,
          }),
        );
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
        (error) =>
          error instanceof RegistrationPendingError &&
          error.reason === 'completion_result_unavailable' &&
          error.handle.registrationId === id,
      );
    });
  }

  it('rejects a completed result bound to another agent instead of claiming success', async () => {
    globalThis.fetch = async () =>
      json(
        progress({
          status: 'completed',
          stage: 'complete',
          agentId: id,
          completedAt: now.toISOString(),
          result: legacy(),
        }),
      );
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
      (error) => error instanceof RegistrationPendingError && error.reason === 'invalid_response',
    );
  });

  it('returns pending with a reusable handle on wait timeout, not a failed registration', async () => {
    let reads = 0;
    globalThis.fetch = async () => {
      reads++;
      return json(progress());
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id, {
        timeoutMs: 20,
      }),
      (error) => {
        assert.ok(error instanceof RegistrationPendingError);
        assert.equal(error.reason, 'timeout');
        assert.equal(error.handle.registrationId, id);
        assert.equal(error.progress.status, 'processing');
        return true;
      },
    );
    assert.equal(reads, 1);
  });

  it('aborts an in-flight GET even when fetch ignores its signal', async () => {
    const controller = new AbortController();
    let requestSignal;
    globalThis.fetch = async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    };
    const waiting = new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      waiting,
      (error) =>
        error instanceof RegistrationPendingError &&
        error.reason === 'aborted' &&
        error.handle.registrationId === id,
    );
    await flush();
    controller.abort();
    await rejected;
    assert.equal(requestSignal.aborted, true);
  });

  it('never repeats a rejected signing prompt while waiting', async () => {
    let prompts = 0;
    const signer = wallet();
    signer.signMessage = async () => {
      prompts++;
      throw new Error('User rejected');
    };
    globalThis.fetch = () => assert.fail('No unauthenticated fallback');
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: signer }).waitForRegistration(id),
      (error) => error instanceof RegistrationPendingError && error.reason === 'status_unavailable',
    );
    assert.equal(prompts, 1);
  });

  it('stops on authorization failure without repeated reads or signing', async () => {
    let reads = 0;
    const signer = wallet();
    globalThis.fetch = async () => {
      reads++;
      return json({}, 401);
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: signer }).waitForRegistration(id),
      RegistrationPendingError,
    );
    assert.equal(reads, 1);
    assert.equal(signer.messages.length, 1);
  });

  for (const status of ['failed', 'refunded', 'action_required', 'awaiting_payment']) {
    it(`distinguishes the server's ${status} state from timeout`, async () => {
      globalThis.fetch = async () => json(progress({ status }));
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id),
        (error) => {
          assert.ok(
            error instanceof
              (status === 'failed' || status === 'refunded'
                ? RegistrationFailedError
                : RegistrationPendingError),
          );
          assert.equal(error.progress.status, status);
          return true;
        },
      );
    });
  }

  it('retries only GETs after transient failure, bounded by the wait deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(init);
      return json({}, 503);
    };
    const waiting = new AgentDomain({ apiUrl, walletClient: wallet() }).waitForRegistration(id, {
      timeoutMs: 12_000,
    });
    const rejected = assert.rejects(
      waiting,
      (error) => error instanceof RegistrationPendingError && error.reason === 'timeout',
    );
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(2_000);
    await rejected;
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => !request.method || request.method === 'GET'));
  });
});

describe('ambiguous submission and read-only recovery', () => {
  it('validates a known-ID recovery against the same domain, time, and payer contract', async () => {
    let reads = 0;
    globalThis.fetch = async (url, init) => {
      reads++;
      assert.equal(isListUrl(url), false);
      assert.equal(new URL(url).searchParams.get('expectedPayer'), payer);
      assert.equal(init.credentials, 'omit');
      return json(progress());
    };
    const recovery = {
      ...handle(),
      registrationId: id,
      statusUrl: `/api/v1/registrations/${id}`,
      payerAddress: payer,
    };
    assert.equal(
      (await new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration(recovery))
        .registrationId,
      id,
    );
    assert.equal(reads, 1);
  });

  for (const changed of [
    { domain: 'other.xyz' },
    { startedAt: '2026-09-05T00:00:00.000Z' },
    { startedAt: '2026-09-07T00:00:00.000Z' },
  ]) {
    it(`rejects a known-ID recovery result outside its handle binding: ${JSON.stringify(changed)}`, async () => {
      globalThis.fetch = async () => json(progress(changed));
      await assert.rejects(
        new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration({
          ...handle(),
          registrationId: id,
          payerAddress: payer,
        }),
        (error) =>
          error instanceof RegistrationPendingError &&
          error.reason === 'invalid_response' &&
          error.progress === undefined,
      );
    });
  }

  it('rejects invalid known-ID windows and a forged handle owner before reading', async () => {
    globalThis.fetch = () => assert.fail('Invalid recovery handles must not fetch');
    const ad = new AgentDomain({
      apiUrl,
      registrationAuth: 'session',
      registrationExpectedPayer: payer,
    });
    for (const changed of [
      { domain: '' },
      { startedAt: 'invalid' },
      { endedAt: '2026-09-01T00:00:00.000Z' },
    ]) {
      await assert.rejects(
        ad.recoverRegistration({
          ...handle(),
          registrationId: id,
          payerAddress: payer,
          ...changed,
        }),
        /exact domain and a valid submission time interval/,
      );
    }
    await assert.rejects(
      ad.recoverRegistration({
        ...handle(),
        registrationId: id,
        payerAddress: '0x2222222222222222222222222222222222222222',
      }),
      /Expected payer does not match/,
    );
  });

  it('requires the authenticated wallet header on known-ID session recovery', async () => {
    let decoded = false;
    globalThis.fetch = async () => {
      const response = new Response('{}', {
        headers: { 'X-Authenticated-Wallet': '0x2222222222222222222222222222222222222222' },
      });
      response.json = async () => {
        decoded = true;
        return progress();
      };
      return response;
    };
    const ad = new AgentDomain({
      apiUrl,
      registrationAuth: 'session',
      registrationExpectedPayer: payer,
    });
    await assert.rejects(
      ad.recoverRegistration({ ...handle(), registrationId: id, payerAddress: payer }),
      (error) => error instanceof RegistrationPendingError && error.reason === 'invalid_response',
    );
    assert.equal(decoded, false);
  });
  it('bounds an unresolved submission by its deadline without replaying it', async () => {
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      return new Promise(() => {});
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration(
        { preferredName: 'research-agent' },
        { timeoutMs: 20 },
      ),
      (error) => error instanceof RegistrationPendingError && error.reason === 'timeout',
    );
    assert.equal(posts, 1);
  });

  it('keeps abort propagation through the final recovery detail read', async () => {
    const controller = new AbortController();
    let readingDetail = false;
    globalThis.fetch = async (url) => {
      if (isListUrl(url)) return json({ items: [progress()], total: 1, hasMore: false });
      readingDetail = true;
      return new Promise(() => {});
    };
    const recovering = new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration(
      handle(),
      { signal: controller.signal },
    );
    const rejected = assert.rejects(
      recovering,
      (error) => error instanceof RegistrationPendingError && error.reason === 'aborted',
    );
    await flush();
    assert.equal(readingDetail, true);
    controller.abort();
    await rejected;
  });
  it('does not retry a lost initial response or ask for payment', async () => {
    let calls = 0;
    const signer = wallet();
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('Connection lost');
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: signer }).register({
        preferredName: 'research-agent',
      }),
      (error) => {
        assert.ok(error instanceof RegistrationPendingError);
        assert.equal(error.reason, 'transport_unknown');
        assert.equal(error.handle.registrationId, null);
        assert.equal(error.handle.domain, 'research-agent.xyz');
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(signer.typed.length, 0);
  });

  it('does not replay a paid POST after a lost response and can recover through authenticated list reads', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    let posts = 0;
    const signer = wallet();
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, 'POST');
      posts++;
      if (posts === 1) return challenge();
      throw new TypeError('Paid response lost');
    };
    const ad = new AgentDomain({ apiUrl, walletClient: signer });
    let pending;
    await assert.rejects(ad.register({ preferredName: 'research-agent' }), (error) => {
      pending = error;
      return error instanceof RegistrationPendingError;
    });
    assert.equal(posts, 2);
    let reads = 0;
    globalThis.fetch = async (url, init) => {
      reads++;
      assert.equal(init.method, undefined);
      assert.ok(init.headers['X-Agent-Signature']);
      assert.equal(init.headers['PAYMENT-SIGNATURE'], undefined);
      return json(isListUrl(url) ? { items: [progress()], hasMore: false, total: 1 } : progress());
    };
    assert.equal((await ad.recoverRegistration(pending.handle)).registrationId, id);
    assert.equal(reads, 2);
    assert.equal(posts, 2);
  });

  it('preserves a payment reference on an uncertain server response without treating it as authorization', async () => {
    const paymentIdentifier = `0x${'ab'.repeat(32)}`;
    globalThis.fetch = async () =>
      json({ paymentIdentifier, error: 'PAYMENT_STATUS_UNCERTAIN' }, 503);
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration({
        preferredName: 'research-agent',
      }),
      (error) =>
        error instanceof RegistrationPendingError &&
        error.handle.paymentIdentifier === paymentIdentifier &&
        error.handle.registrationId === null,
    );
  });

  it('aborting a dispatched POST preserves an unknown outcome', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Promise(() => {});
    };
    const submission = new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration(
      { preferredName: 'research-agent' },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(
      submission,
      (error) => error instanceof RegistrationPendingError && error.reason === 'aborted',
    );
    await flush();
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  });

  it('pre-aborted submission never sends a request', async () => {
    globalThis.fetch = () => assert.fail('No request after abort');
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).submitRegistration(
        { preferredName: 'research-agent' },
        { signal: AbortSignal.abort() },
      ),
      { name: 'AbortError' },
    );
  });

  it('refuses multiple matching registrations instead of choosing the newest', async () => {
    globalThis.fetch = async () =>
      json({
        items: [
          progress(),
          progress({ registrationId: otherId, statusUrl: `/api/v1/registrations/${otherId}` }),
        ],
        hasMore: false,
        total: 2,
      });
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration(handle()),
      (error) => error instanceof RegistrationPendingError && error.reason === 'ambiguous_recovery',
    );
  });

  it('requires exact domain and time and never treats no match as proof of no charge', async () => {
    globalThis.fetch = async () =>
      json({
        items: [
          progress({ domain: 'other.xyz' }),
          progress({ startedAt: '2026-09-05T00:00:00.000Z' }),
        ],
        hasMore: false,
        total: 2,
      });
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration(handle()),
      (error) => error instanceof RegistrationPendingError && error.reason === 'not_found',
    );
  });

  it('refuses a truncated search even when one match was found', async () => {
    let pages = 0;
    globalThis.fetch = async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('limit'), '50');
      assert.equal(query.get('offset'), String(pages * 50));
      pages++;
      return json({ items: pages === 1 ? [progress()] : [], hasMore: true, total: 2000 });
    };
    await assert.rejects(
      new AgentDomain({ apiUrl, walletClient: wallet() }).recoverRegistration(handle()),
      (error) =>
        error instanceof RegistrationPendingError && error.reason === 'incomplete_recovery',
    );
    assert.equal(pages, 10);
  });
});
