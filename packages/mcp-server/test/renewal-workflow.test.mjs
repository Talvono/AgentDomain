import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodeSetAutoRenewCalldata } from '@agentdomain/sdk';
import { getAddress, maxUint256 } from 'viem';

const resources = [];
const owner = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const otherOwner = '0x2222222222222222222222222222222222222222';
const registry = '0x234a2B83B32910436A35CDa797CCC57988B9Bd15';
const vault = getAddress('0xb7b19826a566ebd9e8b50bee986a8da04bbb2c0a');
const blockHash = `0x${'ab'.repeat(32)}`;
const atBlock = { blockHash, requireCanonical: true };
const tools = ['inspect_agent_renewal', 'prepare_auto_renew_change'];
const change = {
  tokenId: '7',
  expectedOwner: owner.toLowerCase(),
  enabled: true,
  builderCode: 'bc_agentdomain',
};

afterEach(async () => {
  while (resources.length) await resources.pop()();
});

async function start(mode = 'found', overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA)$/i.test(
        key,
      ),
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', './test/fixtures/renewal-rpc.mjs', 'dist/index.js'],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...env, RENEWAL_RPC_FIXTURE_MODE: mode, ...overrides },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: 'agentdomain-renewal-workflow-test', version: '1.0.0' });
  resources.push(() => client.close());
  await client.connect(transport);
  const traces = (prefix) =>
    stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
  return {
    client,
    calls: () => traces('RENEWAL_RPC_FIXTURE '),
    fetches: () => traces('RENEWAL_FETCH_FIXTURE '),
    multicalls: () => traces('RENEWAL_MULTICALL_FIXTURE '),
  };
}
function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(parsed), ['error']);
  assert.equal(parsed.error.code, code);
  assert.deepEqual(Object.keys(parsed.error).sort(), ['code', 'message']);
  assert.doesNotMatch(
    result.content[0].text,
    /https?:\/\/|UNTRUSTED_RPC_DETAILS|synthetic-key|not-a-valid-wallet-key/,
  );
  return parsed.error;
}
function readOnly(f) {
  assert.ok(
    f
      .calls()
      .every((call) =>
        ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(call.method),
      ),
  );
  for (const call of f
    .calls()
    .filter((call) => ['eth_call', 'eth_getCode'].includes(call.method))) {
    assert.deepEqual(call.params[1], atBlock);
    if (call.method === 'eth_call') {
      assert.equal(call.params[0].from, undefined);
      assert.equal(call.params[0].value, undefined);
    }
  }
  for (const request of f.fetches()) {
    assert.equal(request.url, 'https://mainnet.base.org/');
    assert.equal(request.method, 'POST');
    assert.ok(
      request.headers.every(
        (header) => !/authorization|cookie|api.key|signature|payment/i.test(header),
      ),
    );
  }
}

function assertServerVersion(manifest, advertised) {
  assert.deepEqual(advertised, { name: 'agentdomain-mcp', version: manifest.version });
}

describe('read-only renewal MCP binding with real SDK over stdio', () => {
  it('advertises the package version, closed schemas, and both tools as default read-only without any fetch', async () => {
    const f = await start();
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assertServerVersion(manifest, f.client.getServerVersion());
    const listed = (await f.client.listTools()).tools;
    for (const name of tools) {
      const tool = listed.find((item) => item.name === name);
      assert.ok(tool, name);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.tokenId.pattern, '^[1-9][0-9]{0,77}$');
      assert.equal(tool.inputSchema.properties.tokenId.maxLength, 78);
      assert.equal(tool.inputSchema.properties.expectedOwner.maxLength, 42);
    }
    const inspection = listed.find((t) => t.name === tools[0]);
    assert.deepEqual(Object.keys(inspection.inputSchema.properties).sort(), [
      'domain',
      'expectedOwner',
      'tokenId',
    ]);
    assert.deepEqual(inspection.inputSchema.oneOf, [
      { required: ['domain'] },
      { required: ['tokenId'] },
    ]);
    assert.equal(inspection.inputSchema.properties.domain.maxLength, 253);
    assert.match(inspection.description, /minimum fee is not a registrar quote/);
    const preparation = listed.find((t) => t.name === tools[1]);
    assert.deepEqual(Object.keys(preparation.inputSchema.properties).sort(), [
      'builderCode',
      'enabled',
      'expectedOwner',
      'tokenId',
    ]);
    assert.deepEqual(preparation.inputSchema.required, [
      'tokenId',
      'expectedOwner',
      'enabled',
      'builderCode',
    ]);
    assert.equal(preparation.inputSchema.properties.builderCode.maxLength, 32);
    assert.match(preparation.description, /UNSIGNED/);
    assert.match(preparation.description, /not authority/);
    for (const name of [
      'execute_auto_renew_change',
      'confirm_auto_renew_change',
      'fund_renewal_vault',
      'enable_auto_renew',
      'withdraw_renewal_vault',
    ]) {
      assert.ok(!listed.some((tool) => tool.name === name));
      const result = await f.client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown or disabled tool/);
    }
    assert.deepEqual(f.fetches(), []);
  });

  it('accepts future metadata versions and rejects stale advertised versions', () => {
    const manifest = { version: '0.12.0' };
    assertServerVersion(manifest, { name: 'agentdomain-mcp', version: '0.12.0' });
    assert.throws(() =>
      assertServerVersion(manifest, { name: 'agentdomain-mcp', version: '0.11.0' }),
    );
  });

  it('inspects identity and all canonical vault fields at the same EIP-1898 safe hash', async () => {
    const f = await start();
    const result = data(
      await f.client.callTool({
        name: tools[0],
        arguments: { domain: 'Reader.XYZ', expectedOwner: owner.toLowerCase() },
      }),
    );
    assert.equal(result.status, 'found');
    assert.equal(result.chainId, 8453);
    assert.equal(result.vaultAddress, vault);
    assert.equal(result.identity.tokenId, '7');
    assert.equal(result.identity.identity.domain, 'reader.xyz');
    assert.equal(result.identity.nftOwner, owner);
    assert.equal(result.identity.checks.expectedOwnerMatches, true);
    assert.equal(result.identity.block.hash, blockHash);
    assert.equal(result.identity.block.tag, 'safe');
    assert.equal(result.consistent, true);
    assert.equal(result.vault.availableAtomicUsdc, '20000000');
    assert.equal(result.vault.reservedAtomicUsdc, '0');
    assert.equal(result.vault.minimumFeeAtomicUsdc, '7000000');
    assert.equal(result.vault.pendingRenewal, null);
    assert.equal(result.renewalExecution, 'keeper_registrar_confirmation_required');
    assert.equal(result.vault.nft.toLowerCase(), registry.toLowerCase());
    assert.equal(result.vault.registry.toLowerCase(), registry.toLowerCase());
    assert.deepEqual(
      f
        .multicalls()
        .slice(-12)
        .map((call) => call.functionName),
      [
        'balanceOfToken',
        'autoRenewEnabled',
        'pendingRenewals',
        'renewalWindow',
        'renewalDuration',
        'renewalFee',
        'nft',
        'registry',
        'usdc',
        'lastRenewedAt',
        'isRenewable',
        'renewalVault',
      ],
    );
    assert.ok(
      f.calls().some((call) => call.method === 'eth_getBlockByNumber' && call.params[0] === 'safe'),
    );
    readOnly(f);
  });

  it('never treats a minimum fee or isRenewable flag as a registrar quote or sufficient balance', async () => {
    for (const mode of ['insufficient', 'minimum-unset']) {
      const f = await start(mode);
      const result = data(await f.client.callTool({ name: tools[0], arguments: { tokenId: '7' } }));
      assert.equal(result.consistent, true);
      assert.equal(result.checks.availableCoversMinimum, false);
      assert.equal(result.checks.minimumFeeConfigured, mode !== 'minimum-unset');
      if (mode === 'insufficient') assert.equal(result.vault.isRenewable, true);
      assert.equal(result.renewalExecution, 'keeper_registrar_confirmation_required');
      assert.equal(result.quote, undefined);
      assert.equal(result.vault.renewalQuote, undefined);
      assert.equal(result.transactionHash, undefined);
      readOnly(f);
    }
  });

  it('prepares only attributed unsigned zero-value calldata with SDK-normalized owner', async () => {
    const f = await start();
    const plan = data(await f.client.callTool({ name: tools[1], arguments: change }));
    assert.equal(plan.version, 1);
    assert.equal(plan.kind, 'set_auto_renew');
    assert.equal(plan.chainId, 8453);
    assert.equal(plan.expectedOwner, owner);
    assert.equal(plan.tokenId, '7');
    assert.equal(plan.enabled, true);
    assert.equal(plan.builderCode, change.builderCode);
    assert.match(plan.id, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(plan.transaction, {
      to: vault,
      value: '0',
      data: encodeSetAutoRenewCalldata(7n, true, change.builderCode),
    });
    assert.equal(plan.noChange, false);
    assert.equal(plan.transactionHash, undefined);
    assert.equal(plan.signature, undefined);
    assert.equal(plan.approved, undefined);
    assert.ok(plan.warnings.some((value) => /does not itself renew/.test(value)));
    assert.ok(
      plan.warnings.some((value) => /without a new wallet signature.*quote may exceed/.test(value)),
    );
    readOnly(f);
  });

  it('bypasses API and signer construction despite invalid ambient configuration and enabled legacy writes', async () => {
    const f = await start('found', {
      AGENTDOMAIN_ENABLE_WRITE_TOOLS: 'true',
      AGENTDOMAIN_API_URL: 'not-an-api-url',
      AGENTDOMAIN_API_KEY: 'synthetic-key-that-must-not-be-used',
      AGENT_PRIVATE_KEY: 'not-a-valid-wallet-key',
      AGENTDOMAIN_NETWORK: 'base-sepolia',
      AGENTDOMAIN_BUILDER_CODE: 'INVALID',
      RENEWAL_VAULT_ADDRESS: otherOwner,
    });
    const inspection = data(
      await f.client.callTool({ name: tools[0], arguments: { tokenId: '7' } }),
    );
    const plan = data(await f.client.callTool({ name: tools[1], arguments: change }));
    assert.equal(inspection.chainId, 8453);
    assert.equal(plan.transaction.to, vault);
    assert.equal(plan.builderCode, change.builderCode);
    readOnly(f);
  });

  it('marks no-op plans without submitting anything or claiming execution', async () => {
    const f = await start('enabled');
    const plan = data(await f.client.callTool({ name: tools[1], arguments: change }));
    assert.equal(plan.noChange, true);
    assert.equal(plan.observation.vault.autoRenewEnabled, true);
    assert.equal(plan.transaction.value, '0');
    assert.equal(plan.status, undefined);
    assert.equal(plan.transactionHash, undefined);
    readOnly(f);
  });

  it('keeps a pending reservation distinct and warns that disabling does not cancel it', async () => {
    const f = await start('pending');
    const plan = data(
      await f.client.callTool({ name: tools[1], arguments: { ...change, enabled: false } }),
    );
    assert.equal(plan.noChange, false);
    assert.equal(plan.observation.vault.reservedAtomicUsdc, '3000000');
    assert.deepEqual(plan.observation.vault.pendingRenewal, {
      amountAtomicUsdc: '3000000',
      expiresAt: '1800086400',
      reservedAt: '1799999700',
    });
    assert.equal(plan.observation.vault.isRenewable, false);
    assert.ok(plan.warnings.some((value) => /does not cancel/.test(value)));
    assert.equal(plan.observation.renewalExecution, 'keeper_registrar_confirmation_required');
    readOnly(f);
  });

  it('compares expected ownership without treating it as authority, and refuses a mismatching plan', async () => {
    const f = await start();
    const result = data(
      await f.client.callTool({
        name: tools[0],
        arguments: { tokenId: '7', expectedOwner: otherOwner },
      }),
    );
    assert.equal(result.identity.checks.expectedOwnerMatches, false);
    assert.equal(result.consistent, true);
    error(
      await f.client.callTool({
        name: tools[1],
        arguments: { ...change, expectedOwner: otherOwner },
      }),
      'OWNER_MISMATCH',
    );
    readOnly(f);
  });

  it('reports revocation/expiry and permits disabling, but refuses enabling through this workflow', async () => {
    for (const [mode, code] of [
      ['revoked', 'REVOKED'],
      ['expired', 'EXPIRED_TOO_LONG'],
    ]) {
      const f = await start(mode);
      const inspection = data(
        await f.client.callTool({ name: tools[0], arguments: { tokenId: '7' } }),
      );
      assert.equal(inspection.identity.lifecycle, mode);
      error(await f.client.callTool({ name: tools[1], arguments: change }), code);
      const plan = data(
        await f.client.callTool({ name: tools[1], arguments: { ...change, enabled: false } }),
      );
      assert.equal(plan.enabled, false);
      assert.equal(plan.transaction.value, '0');
      readOnly(f);
    }
  });

  it('retains SDK inconsistency results and never prepares from mismatched owner/vault/reservation records', async () => {
    for (const mode of ['owner-mismatch', 'vault-mismatch', 'reservation-mismatch']) {
      const f = await start(mode);
      const result = data(await f.client.callTool({ name: tools[0], arguments: { tokenId: '7' } }));
      assert.equal(result.status, 'found');
      assert.equal(result.consistent, false);
      error(await f.client.callTool({ name: tools[1], arguments: change }), 'INCONSISTENT_STATE');
      readOnly(f);
    }
  });

  it('returns a nested not-found observation, including a valid uint256 maximum, and no invented vault state', async () => {
    const f = await start('not-found');
    for (const input of [{ domain: 'reader.xyz' }, { tokenId: maxUint256.toString() }]) {
      const result = data(await f.client.callTool({ name: tools[0], arguments: input }));
      assert.equal(result.status, 'not_found');
      assert.equal(result.identity.status, 'not_found');
      assert.equal(result.identity.tokenId, input.tokenId ?? null);
      assert.equal(result.vault, undefined);
    }
    error(await f.client.callTool({ name: tools[1], arguments: change }), 'IDENTITY_NOT_FOUND');
    assert.deepEqual(f.multicalls(), []);
    readOnly(f);
  });

  it('rejects invalid, ambiguous and extensible inputs before any RPC or API fetch', async () => {
    const f = await start();
    const badOwner =
      owner.slice(0, 2) +
      owner
        .slice(2)
        .replace(/[a-fA-F]/, (character) =>
          character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
        );
    const invalidInspection = [
      {},
      { domain: 'reader.xyz', tokenId: '7' },
      { domain: null },
      { domain: '' },
      { domain: 'https://reader.xyz' },
      { domain: 'reader.xyz.' },
      { domain: 'a'.repeat(64) + '.xyz' },
      { domain: 'a'.repeat(254) },
      { tokenId: 7 },
      { tokenId: '0' },
      { tokenId: '07' },
      { tokenId: '0x7' },
      { tokenId: 'abc' },
      { tokenId: '-1' },
      { tokenId: '1e6' },
      { tokenId: (maxUint256 + 1n).toString() },
      { tokenId: '1'.repeat(79) },
      { tokenId: '7', expectedOwner: false },
      { tokenId: '7', expectedOwner: badOwner },
    ];
    const invalidChange = [
      {},
      { ...change, domain: 'reader.xyz' },
      { ...change, tokenId: 7 },
      { ...change, tokenId: '0' },
      { ...change, tokenId: '07' },
      { ...change, tokenId: 'abc' },
      { ...change, tokenId: (maxUint256 + 1n).toString() },
      { ...change, expectedOwner: badOwner },
      { ...change, expectedOwner: 'not-an-address' },
      { ...change, enabled: 'true' },
      { ...change, enabled: null },
      { ...change, builderCode: '' },
      { ...change, builderCode: 'INVALID' },
      { ...change, builderCode: 'a'.repeat(33) },
      { ...change, builderCode: 'with-dash' },
      { tokenId: '7', expectedOwner: owner, enabled: true },
    ];
    for (const key of [
      'rpcUrl',
      'chainId',
      'registryAddress',
      'renewalVaultAddress',
      'publicClient',
      'walletClient',
      'privateKey',
      'apiKey',
      'ccipRead',
      'options',
      'approve',
    ]) {
      invalidInspection.push({ tokenId: '7', [key]: 'not-permitted' });
      invalidChange.push({ ...change, [key]: 'not-permitted' });
    }
    for (const [name, inputs] of [
      [tools[0], invalidInspection],
      [tools[1], invalidChange],
    ])
      for (const input of inputs)
        error(await f.client.callTool({ name, arguments: input }), 'INVALID_INPUT');
    assert.deepEqual(f.fetches(), []);
  });

  it('defaults CCIP to false for identity and vault reads, without callback URL fetches', async () => {
    for (const mode of ['offchain-lookup', 'vault-offchain-lookup']) {
      const f = await start(mode);
      for (const name of tools)
        error(
          await f.client.callTool({
            name,
            arguments: name === tools[0] ? { tokenId: '7' } : change,
          }),
          'UNAVAILABLE',
        );
      assert.ok(f.fetches().length > 0);
      assert.ok(f.fetches().every((call) => !call.url.includes('rpc-callback')));
      readOnly(f);
    }
  });

  it('pins identity and vault reads to hash A, never mixing numeric-height fork B', async () => {
    const f = await start('fork-mix');
    const plan = data(await f.client.callTool({ name: tools[1], arguments: change }));
    assert.equal(plan.observation.identity.nftOwner, owner);
    assert.equal(plan.observation.vault.minimumFeeAtomicUsdc, '7000000');
    assert.equal(plan.observation.consistent, true);
    assert.equal(f.calls().filter((call) => call.method === 'eth_call').length, 3);
    readOnly(f);
  });

  it('sanitizes RPC, chain, unsafe snapshot and unsupported-selector failures without fallback or not-found claims', async () => {
    for (const [mode, code] of [
      ['rpc-error', 'UNAVAILABLE'],
      ['wrong-chain', 'WRONG_CHAIN'],
      ['changed-block', 'UNSAFE_SNAPSHOT'],
      ['renewal-changed-block', 'UNSAFE_SNAPSHOT'],
      ['unsupported-eip1898', 'UNAVAILABLE'],
    ]) {
      for (const name of tools) {
        const f = await start(mode);
        error(
          await f.client.callTool({
            name,
            arguments: name === tools[0] ? { tokenId: '7' } : change,
          }),
          code,
        );
        if (mode === 'unsupported-eip1898')
          assert.equal(f.calls().filter((call) => call.method === 'eth_call').length, 1);
        readOnly(f);
      }
    }
  });
});
