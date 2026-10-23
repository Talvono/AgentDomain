import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import rejection from '../../shared/test/fixtures/registration-payment-rejection.json' with { type: 'json' };
import {
  AgentDomain,
  RegistrationPaymentRejectedError,
  RegistrationPendingError,
} from '../dist/index.js';

const apiUrl = 'https://api.example.test/api/v1';
const payer = '0x1111111111111111111111111111111111111111';
const args = { preferredName: 'research-agent' };

function challenge() {
  const required = {
    x402Version: 2,
    resource: {
      url: `${apiUrl}/agents/register`,
      description: 'Registration',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x2222222222222222222222222222222222222222',
        amount: '6218032',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2', requestBinding: `0x${'ab'.repeat(32)}` },
      },
    ],
  };
  return Response.json(required, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) },
  });
}

function fixture(t, paidResponse, challengeFirst = true) {
  const calls = { posts: 0, paymentSignatures: 0, authSignatures: 0 };
  const bodies = [];
  const walletClient = {
    account: { address: payer },
    signMessage: async () => {
      calls.authSignatures++;
      return `0x${'11'.repeat(65)}`;
    },
    signTypedData: async () => {
      calls.paymentSignatures++;
      return `0x${'22'.repeat(65)}`;
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `${apiUrl}/agents/register`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    calls.posts++;
    assert.ok(calls.posts <= (challengeFirst ? 2 : 1), 'No automatic resend or recovery request');
    bodies.push(init.body);
    if (challengeFirst && calls.posts === 1) return challenge();
    if (challengeFirst) assert.ok(init.headers['PAYMENT-SIGNATURE']);
    return paidResponse();
  });
  return { client: new AgentDomain({ apiUrl, walletClient }), calls, bodies };
}

function assertOnePayment(h) {
  // One single-use request signature per POST: the challenge and the paid retry.
  assert.deepEqual(h.calls, { posts: 2, paymentSignatures: 1, authSignatures: 2 });
  assert.equal(h.bodies[0], h.bodies[1]);
}

describe('SDK paid registration rejection', () => {
  for (const status of [400, 401, 402, 403, 404, 409, 410, 422, 429, 499]) {
    it(`exposes the actual backend HTTP ${status} rejection as a typed error, not pending`, async (t) => {
      const h = fixture(t, () => Response.json(rejection, { status }));
      await assert.rejects(h.client.submitRegistration(args), (error) => {
        assert.ok(error instanceof RegistrationPaymentRejectedError);
        assert.equal(error instanceof RegistrationPendingError, false);
        assert.equal(error.name, 'RegistrationPaymentRejectedError');
        assert.equal(error.code, 'REGISTRATION_PAYMENT_REJECTED');
        assert.equal(error.serverCode, rejection.code);
        assert.equal(error.message, rejection.message);
        assert.equal(error.settlementAttempted, false);
        assert.equal(error.cause, undefined);
        assert.equal(error.handle.registrationId, null);
        assert.equal(error.handle.statusUrl, null);
        assert.equal(error.handle.paymentIdentifier, undefined);
        assert.equal(error.handle.domain, 'research-agent.xyz');
        assert.equal(error.handle.payerAddress, payer);
        assert.ok(Number.isFinite(Date.parse(error.handle.startedAt)));
        assert.ok(Date.parse(error.handle.endedAt) >= Date.parse(error.handle.startedAt));
        return true;
      });
      assertOnePayment(h);
    });
  }

  it('register propagates the typed rejection without wrapping it or starting status polling', async (t) => {
    const h = fixture(t, () => Response.json(rejection, { status: 409 }));
    await assert.rejects(h.client.register(args), RegistrationPaymentRejectedError);
    assertOnePayment(h);
  });

  it('supports an omitted error alias and preserves a new server rejection code', async (t) => {
    const { error: _alias, ...withoutAlias } = rejection;
    const h = fixture(t, () =>
      Response.json({ ...withoutAlias, code: 'NEW_TERMINAL_DECLINE' }, { status: 409 }),
    );
    await assert.rejects(
      h.client.submitRegistration(args),
      (error) =>
        error instanceof RegistrationPaymentRejectedError &&
        error.serverCode === 'NEW_TERMINAL_DECLINE',
    );
    assertOnePayment(h);
  });

  for (const status of [200, 202, 300, 302, 399, 408, 500, 502, 503, 504]) {
    it(`keeps HTTP ${status} uncertain even with a valid rejection body`, async (t) => {
      const h = fixture(t, () => Response.json(rejection, { status }));
      await assert.rejects(h.client.submitRegistration(args), RegistrationPendingError);
      assertOnePayment(h);
    });
  }

  for (const [label, body] of [
    ['unknown response', {}],
    ['missing marker', { error: rejection.code, code: rejection.code, message: rejection.message }],
    ['conflicting error alias', { ...rejection, error: 'PAYMENT_STATUS_UNCERTAIN' }],
    ['invalid error alias', { ...rejection, error: null }],
    ['missing code', { ...rejection, code: undefined }],
    ['blank message', { ...rejection, message: ' ' }],
    ['missing attempt flag', { ...rejection, paymentSubmission: { status: 'rejected' } }],
    [
      'attempted settlement',
      { ...rejection, paymentSubmission: { status: 'rejected', settlementAttempted: true } },
    ],
    [
      'string flag',
      { ...rejection, paymentSubmission: { status: 'rejected', settlementAttempted: 'false' } },
    ],
    [
      'nested financial fields',
      { ...rejection, paymentSubmission: { ...rejection.paymentSubmission, txHash: '0x1234' } },
    ],
    ['settled payment', { ...rejection, paymentStatus: 'settled' }],
    ['transaction hash', { ...rejection, paymentTxHash: `0x${'ab'.repeat(32)}` }],
    ['payment reference', { ...rejection, paymentIdentifier: `0x${'ab'.repeat(32)}` }],
    ['registration reference', { ...rejection, registrationId: 'existing-registration' }],
    ['processing status', { ...rejection, status: 'processing' }],
  ]) {
    it(`keeps ${label} pending and never resends payment`, async (t) => {
      const h = fixture(t, () => Response.json(body, { status: 409 }));
      await assert.rejects(h.client.submitRegistration(args), (error) => {
        assert.ok(error instanceof RegistrationPendingError);
        assert.equal(error instanceof RegistrationPaymentRejectedError, false);
        assert.equal(error.handle.domain, 'research-agent.xyz');
        if ('paymentIdentifier' in body)
          assert.equal(error.handle.paymentIdentifier, body.paymentIdentifier);
        if ('registrationId' in body)
          assert.equal(error.handle.registrationId, body.registrationId);
        return true;
      });
      assertOnePayment(h);
    });
  }

  for (const status of [200, 202]) {
    it(`does not accept a contradictory paid HTTP ${status} success with a rejection marker`, async (t) => {
      const body =
        status === 202
          ? {
              registrationId: 'existing-registration',
              status: 'processing',
              domain: 'research-agent.xyz',
              statusUrl: '/api/v1/registrations/existing-registration',
              paymentStatus: 'settled',
              pollAfterSeconds: 5,
            }
          : {
              registrationId: 'existing-registration',
              agentId: 'existing-agent',
              nftTokenId: 42,
              domain: 'research-agent.xyz',
              basename: null,
              ensName: null,
              txHash: `0x${'ab'.repeat(32)}`,
              sslStatus: 'active',
              estimatedReadyAt: new Date().toISOString(),
              metadataUri: 'ipfs://synthetic',
            };
      const h = fixture(t, () =>
        Response.json({ ...body, paymentSubmission: rejection.paymentSubmission }, { status }),
      );
      await assert.rejects(h.client.submitRegistration(args), RegistrationPendingError);
      assertOnePayment(h);
    });
  }

  for (const kind of ['transport loss', 'invalid JSON']) {
    it(`keeps ${kind} pending after the paid POST`, async (t) => {
      const h = fixture(t, () => {
        if (kind === 'transport loss') throw new Error('Paid response lost');
        return new Response('{', { status: 409 });
      });
      await assert.rejects(h.client.submitRegistration(args), RegistrationPendingError);
      assertOnePayment(h);
    });
  }

  it('never promotes a rejection received after the request deadline out of pending', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let start;
    let finish;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    const delayed = new Promise((resolve) => {
      finish = resolve;
    });
    const h = fixture(t, () => {
      start();
      return delayed;
    });
    const submission = h.client.submitRegistration(args, { timeoutMs: 25 });
    const pending = assert.rejects(
      submission,
      (error) => error instanceof RegistrationPendingError && error.reason === 'timeout',
    );
    await started;
    t.mock.timers.tick(25);
    await pending;
    finish(Response.json(rejection, { status: 409 }));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(submission, RegistrationPendingError);
    assertOnePayment(h);
  });

  it('does not classify an initial unpaid 409 as a rejected payment', async (t) => {
    const h = fixture(t, () => Response.json(rejection, { status: 409 }), false);
    await assert.rejects(
      h.client.submitRegistration(args),
      (error) =>
        !(error instanceof RegistrationPaymentRejectedError) &&
        !(error instanceof RegistrationPendingError) &&
        /HTTP 409/.test(error.message),
    );
    assert.equal(h.calls.posts, 1);
    assert.equal(h.calls.paymentSignatures, 0);
  });
});
