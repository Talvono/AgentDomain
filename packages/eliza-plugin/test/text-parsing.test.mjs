import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractEmailAddresses,
  extractFencedBlock,
  parseCompactQuantity,
  readLabeledEmail,
  readLabeledEmailUsername,
  readLabeledRemainder,
  readNamedPlan,
  readPlainWords,
  readRegistrationPlan,
} from '../dist/text-parsing.js';

describe('Eliza text parsing', () => {
  it('parses compact quantities without backtracking across repeated digits', () => {
    assert.deepEqual(parseCompactQuantity('enterprise 250k monthly'), {
      value: 250,
      suffix: 'k',
    });
    assert.deepEqual(parseCompactQuantity('enterprise 1.5 M monthly'), {
      value: 1.5,
      suffix: 'm',
    });
    assert.equal(parseCompactQuantity(`${'9'.repeat(100_000)}x`), undefined);
  });

  it('extracts fenced JSON and zone data using delimiter searches', () => {
    assert.equal(
      extractFencedBlock('records:\n```json\n[{"type":"A"}]\n```', ['json']),
      '[{"type":"A"}]\n',
    );
    assert.equal(
      extractFencedBlock('İstanbul zone:\n```BIND\n@ 300 IN A 192.0.2.1\n```', [
        'bind',
        'zone',
        'dns',
      ]),
      '@ 300 IN A 192.0.2.1\n',
    );
    assert.equal(extractFencedBlock(`\`\`\`json${' '.repeat(100_000)}`, ['json']), undefined);
  });

  it('reads labeled values and stops before later DNS fields', () => {
    assert.equal(
      readLabeledRemainder(
        'type TXT name=@ value=v=spf1 foo.ttl=preserved include:mail.example ~all ttl=300 priority:10',
        ['value'],
        { stopLabels: ['ttl', 'priority'] },
      ),
      'v=spf1 foo.ttl=preserved include:mail.example ~all',
    );
    assert.equal(
      readLabeledRemainder('subject: Deployment complete | body: Ready', ['subject'], {
        stopCharacter: '|',
      }),
      'Deployment complete',
    );
    assert.equal(
      readLabeledRemainder('İstanbul SUBJECT: Unicode-safe indexes', ['subject']),
      'Unicode-safe indexes',
    );
  });

  it('extracts validated email addresses and labeled fields in source order', () => {
    const text =
      'from:sender+tag@example.com to=recipient@example.org backup@example.net. body: Hello';
    assert.deepEqual(extractEmailAddresses(text), [
      'sender+tag@example.com',
      'recipient@example.org',
      'backup@example.net',
    ]);
    assert.equal(readLabeledEmail(text, ['from']), 'sender+tag@example.com');
    assert.equal(readLabeledEmail(text, ['to']), 'recipient@example.org');
    assert.equal(
      readLabeledEmailUsername('primary email: new.alias@example.com', [
        'email username',
        'primary email',
        'username',
        'alias',
      ]),
      'new.alias',
    );
  });

  it('rejects malformed email candidates and handles repeated percent input linearly', () => {
    assert.deepEqual(extractEmailAddresses('bad..local@example.com invalid@example'), []);
    assert.deepEqual(extractEmailAddresses(`${'%'.repeat(100_000)}!`), []);
    assert.equal(extractEmailAddresses(`${'%'.repeat(100_000)}@example.com`)[0]?.length, 100_012);
  });

  it('reads standalone words without domain or address labels', () => {
    assert.deepEqual(readPlainWords('Register promptbot.xyz (Pro plan), mail ops@starter.ai.'), [
      'register',
      'pro',
      'plan',
      'mail',
    ]);
    assert.deepEqual(readPlainWords('enterprise 1.5m monthly for my-ens.eth'), [
      'enterprise',
      '1.5m',
      'monthly',
      'for',
    ]);
    assert.equal(readPlainWords(`${'a'.repeat(100_000)}.`).length, 1);
  });

  it('selects a registration plan only when it is named as a plan', () => {
    for (const text of [
      'Register promptbot.xyz for 2 years',
      'Quote productive-agent.ai and provide the total',
      'Register approver.xyz, a professional enterprise-grade assistant',
      'Register starter-kit.xyz',
    ]) {
      assert.equal(readRegistrationPlan(text), undefined, text);
    }
    assert.equal(readRegistrationPlan('Register helper.ai with the Pro plan'), 'pro');
    assert.equal(readRegistrationPlan('Register helper.ai, plan: starter'), 'starter');
    assert.equal(
      readRegistrationPlan('Register helper.ai on the Enterprise Premium Plan'),
      'enterprise',
    );
    assert.throws(
      () => readRegistrationPlan('Register helper.ai with the Pro plan or the Starter plan'),
      /only one Premium Plan/,
    );
  });

  it('reads a named plan for upgrades without matching parts of other words', () => {
    assert.equal(readNamedPlan('Upgrade promptbot.xyz to starter'), 'starter');
    assert.equal(readNamedPlan('Upgrade productbot.xyz to Pro.'), 'pro');
    assert.equal(readNamedPlan('Upgrade promptbot.xyz and provide a receipt'), undefined);
    assert.throws(() => readNamedPlan('starter or pro?'), /only one Premium Plan/);
  });
});
