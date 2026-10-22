import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { quoteRegistrationAction, scheduleServicePlanRenewalAction } from '../dist/index.js';

const originalFetch = globalThis.fetch;
const agentId = '3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtime(settings = {}) {
  return { getSetting: (key) => settings[key] };
}

function capture(response) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return Response.json(response);
  };
  return requests;
}

const quote = {
  domain: 'promptbot.xyz',
  domainCostUsdc: '2.18',
  platformFeeUsdc: '3.90',
  serviceFeeUsdc: '3.90',
  totalUsdc: '6.08',
};

async function quotedParams(text) {
  const requests = capture(quote);
  await quoteRegistrationAction.handler(runtime(), { content: { text } });
  assert.equal(requests.length, 1);
  return requests[0].url.searchParams;
}

describe('Eliza plan and add-on intents', () => {
  it('does not add a paid plan or ENS from domain labels or ordinary words', async () => {
    const params = await quotedParams(
      'Quote promptbot.xyz for 2 years and provide a professional summary for my-ens-agent.xyz',
    );
    assert.equal(params.get('preferredName'), 'promptbot');
    assert.equal(params.get('tld'), 'xyz');
    assert.equal(params.get('years'), '2');
    assert.equal(params.get('premiumPlan'), 'included');
    assert.equal(params.get('registerEns'), 'false');
  });

  it('adds a plan and ENS only when the request names them', async () => {
    const params = await quotedParams('Quote helper.ai with the Pro plan and ENS');
    assert.equal(params.get('premiumPlan'), 'pro');
    assert.equal(params.get('registerEns'), 'true');
  });

  it('lists every paid line in the quote reply', async () => {
    capture({
      ...quote,
      domain: 'helper.ai',
      basenameCostUsdc: '10.12',
      ensCostUsdc: '13.48',
      premiumPlanLabel: 'Pro',
      premiumPlanFeeUsdc: '240',
      totalUsdc: '273.88',
    });
    const reply = await quoteRegistrationAction.handler(runtime(), {
      content: { text: 'Quote helper.ai for 2 years with the Pro plan and ENS' },
    });
    assert.equal(
      reply.text,
      'Total: $273.88 USDC for helper.ai (2 years). Domain $2.18, platform $3.90, Basename $10.12, ENS $13.48, Pro plan $240; email and SSL are included.',
    );
  });

  it('declines both add-ons when one negation lists them', async () => {
    const params = await quotedParams(
      'Quote research-agent.xyz for 1 year without Basename or ENS',
    );
    assert.equal(params.get('registerBasename'), 'false');
    assert.equal(params.get('registerEns'), 'false');
  });

  it('requires a full domain instead of quoting a default name', async () => {
    const requests = capture(quote);
    await assert.rejects(
      quoteRegistrationAction.handler(runtime(), { content: { text: 'Quote an agent name' } }),
      /Include the full domain/,
    );
    assert.equal(requests.length, 0);
  });

  it('schedules the named renewal plan, not one matched inside a domain', async () => {
    const requests = capture({ renewalPlanSku: 'starter' });
    await scheduleServicePlanRenewalAction.handler(runtime({ AGENTDOMAIN_API_KEY: 'test-key' }), {
      content: { text: `Schedule ${agentId} renewal for productbot.xyz on starter` },
    });
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      renewalPlan: 'starter',
      renewalPlanSku: 'starter',
    });
  });
});
