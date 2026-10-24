import assert from 'node:assert/strict';
import test from 'node:test';
import { dnsRecordObjectSchema, dnsRecordSchema } from '../dist/index.js';

test('an omitted ttl stays omitted, so partial updates never reset it', () => {
  // zod 4 applies defaults inside optional(); a default here would send ttl 3600 with
  // every partial update. The API applies its own default to new records.
  assert.deepEqual(dnsRecordObjectSchema.partial().parse({ name: 'www' }), { name: 'www' });
  assert.deepEqual(dnsRecordSchema.parse({ type: 'A', name: 'www', value: '192.0.2.1' }), {
    type: 'A',
    name: 'www',
    value: '192.0.2.1',
  });
  assert.equal(
    dnsRecordSchema.parse({ type: 'A', name: 'www', value: '192.0.2.1', ttl: 600 }).ttl,
    600,
  );
});

test('structured record data requires string keys under zod 4', () => {
  const parsed = dnsRecordObjectSchema.parse({
    type: 'MX',
    name: '@',
    data: { priority: 10, exchange: 'mail.example.com' },
  });
  assert.deepEqual(parsed.data, { priority: 10, exchange: 'mail.example.com' });
  assert.throws(() => dnsRecordObjectSchema.parse({ type: 'A', name: 'www', ttl: 30 }));
});
