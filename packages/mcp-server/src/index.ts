#!/usr/bin/env node
/**
 * AgentDomain MCP Server
 *
 * Exposes AgentDomain identity tools to any MCP-compatible LLM client
 * (Claude Desktop, ChatGPT desktop, custom agents, etc.).
 *
 * Stdio transport. Run via:
 *   agentdomain-mcp
 * or in a client config:
 *   {
 *     "mcpServers": {
 *       "agentdomain": {
 *         "command": "npx",
 *         "args": ["-y", "@agentdomain/mcp-server"],
 *         "env": {
 *           "AGENTDOMAIN_API_URL": "https://api.agentdomain.app/api/v1"
 *         }
 *       }
 *     }
 *   }
 *
 * Inject optional signing credentials through a trusted external secret source,
 * and only when a signing operation is explicitly enabled.
 */

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AgentDomain,
  IdentityInspectionError,
  RenewalWorkflowError,
  inspectAgentIdentity,
  inspectAgentRenewal,
  prepareAutoRenewChange,
  validateBuilderCode,
} from '@agentdomain/sdk';
import {
  DNS_RECORD_TYPES,
  dnsRecordSchema,
  dnsRecordObjectSchema,
  type DnsRecordInput,
  type ServicePlanSku,
} from '@agentdomain/shared';
import {
  AGENTDOMAIN_API_BASE_URL,
  SERVICE_PLAN_KEYS,
  SUPPORTED_FRAMEWORKS,
  SUPPORTED_TLDS,
} from '@agentdomain/shared/constants';
import { createPublicClient, createWalletClient, http, maxUint256, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const API_URL = process.env.AGENTDOMAIN_API_URL ?? AGENTDOMAIN_API_BASE_URL;
const NETWORK = (process.env.AGENTDOMAIN_NETWORK ?? 'base') as 'base' | 'base-sepolia';
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const AGENTDOMAIN_API_KEY = process.env.AGENTDOMAIN_API_KEY;
const AGENTDOMAIN_BUILDER_CODE = process.env.AGENTDOMAIN_BUILDER_CODE;
const RENEWAL_VAULT_ADDRESS = process.env.RENEWAL_VAULT_ADDRESS as Address | undefined;
const WRITE_TOOLS_ENV = 'AGENTDOMAIN_ENABLE_WRITE_TOOLS';
const WRITE_TOOLS_ENABLED = parseWriteToolsEnabled(process.env[WRITE_TOOLS_ENV]);
const identityInspectionInput = z.union([
  z.object({ domain: z.string(), expectedOwner: z.string().optional() }).strict(),
  z.object({ tokenId: z.string(), expectedOwner: z.string().optional() }).strict(),
]);
const renewalTokenId = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .refine((value) => /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) <= maxUint256);
const renewalOwner = z
  .string()
  .length(42)
  .regex(/^0x[0-9a-fA-F]{40}$/);
const renewalInspectionInput = z.union([
  z
    .object({ domain: z.string().trim().min(1).max(253), expectedOwner: renewalOwner.optional() })
    .strict(),
  z.object({ tokenId: renewalTokenId, expectedOwner: renewalOwner.optional() }).strict(),
]);
const autoRenewChangeInput = z
  .object({
    tokenId: renewalTokenId,
    expectedOwner: renewalOwner,
    enabled: z.boolean(),
    builderCode: z.string().regex(/^[a-z0-9_]{1,32}$/),
  })
  .strict();

function getClient(): AgentDomain {
  const config: ConstructorParameters<typeof AgentDomain>[0] = {
    apiUrl: API_URL,
    apiKey: AGENTDOMAIN_API_KEY,
    network: NETWORK,
    renewalVaultAddress: RENEWAL_VAULT_ADDRESS,
    builderCode: AGENTDOMAIN_BUILDER_CODE,
  };
  if (AGENT_PRIVATE_KEY) {
    const account = privateKeyToAccount(AGENT_PRIVATE_KEY as `0x${string}`);
    const chain = NETWORK === 'base' ? base : baseSepolia;
    const rpc = NETWORK === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
    // Cast: viem's deeply-generic types do not always match cleanly across
    // duplicated installs in monorepos. Behaviour is identical at runtime.
    config.walletClient = createWalletClient({ account, chain, transport: http(rpc) }) as never;
    config.publicClient = createPublicClient({ chain, transport: http(rpc) }) as never;
  }
  return new AgentDomain(config);
}

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const server = new Server(
  { name: 'agentdomain-mcp', version: packageManifest.version },
  { capabilities: { tools: {} } },
);

// ----------------------------------------------------------------------
// TOOL DEFINITIONS
// ----------------------------------------------------------------------

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'inspect_agent_renewal',
    description:
      'Read the custom AgentDomain ERC-721 identity and canonical renewal vault on Base mainnet at one safe block. Supply exactly one domain or decimal tokenId, optionally expectedOwner. No platform API, wallet, signing, metadata fetch, or CCIP callback. The minimum fee is not a registrar quote; balances, flags, and pending reservations are observations, not confirmation that a renewal executed.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          minLength: 1,
          maxLength: 253,
          description: 'Full ASCII domain, without a URL, path, or trailing dot.',
        },
        tokenId: {
          type: 'string',
          pattern: '^[1-9][0-9]{0,77}$',
          maxLength: 78,
          description:
            'Positive uint256 decimal token ID, without leading zeros; not an agent UUID.',
        },
        expectedOwner: {
          type: 'string',
          pattern: '^0x[0-9a-fA-F]{40}$',
          minLength: 42,
          maxLength: 42,
          description: 'Optional EVM owner comparison, not authorization. SDK validates checksum.',
        },
      },
      oneOf: [{ required: ['domain'] }, { required: ['tokenId'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_auto_renew_change',
    description:
      "Prepare an UNSIGNED, zero-value setAutoRenew transaction for the current canonical NFT owner on Base mainnet. Preparation does not sign, submit, or spend; the returned plan is not authority to execute. If separately approved and executed, enabling permits keepers to spend this token's funded vault balance without a new signature for each renewal; the actual quote may exceed the minimum fee. Disabling stops new reservations, but existing reservations can still complete and charge. noChange identifies an already matching flag.",
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: {
          type: 'string',
          pattern: '^[1-9][0-9]{0,77}$',
          maxLength: 78,
          description: 'Positive uint256 decimal token ID, without leading zeros.',
        },
        expectedOwner: {
          type: 'string',
          pattern: '^0x[0-9a-fA-F]{40}$',
          minLength: 42,
          maxLength: 42,
          description: 'Current NFT owner to verify. SDK validates and normalizes checksum.',
        },
        enabled: {
          type: 'boolean',
          description: 'Desired auto-renew flag; never execution approval.',
        },
        builderCode: {
          type: 'string',
          pattern: '^[a-z0-9_]{1,32}$',
          minLength: 1,
          maxLength: 32,
          description: 'Explicit ERC-8021 builder attribution for the unsigned calldata.',
        },
      },
      required: ['tokenId', 'expectedOwner', 'enabled', 'builderCode'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_agent_identity',
    description:
      'Inspect the custom AgentDomain ERC-721 identity registry on Base mainnet at a safe block. Supply exactly one domain or decimal tokenId, optionally an expectedOwner. Uses public RPC without a wallet or platform API key; never fetches metadata, signs, or writes. Results are RPC observations, not consensus/SPV, DNS ownership, KYC, or verification of linked Basename/ENS labels.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The registered domain, without a URL or path.' },
        tokenId: {
          type: 'string',
          description: 'Decimal AgentDomain ERC-721 token ID, not an agent UUID.',
        },
        expectedOwner: {
          type: 'string',
          description: 'Optional EVM owner address to compare, not authorization.',
        },
      },
      oneOf: [{ required: ['domain'] }, { required: ['tokenId'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'check_domain_availability',
    description:
      'Check whether an agent domain (name + tld) is available for registration. Returns availability status and pricing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The desired label, e.g. "myagent"' },
        tld: {
          type: 'string',
          enum: SUPPORTED_TLDS,
          description: 'TLD',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'quote_registration',
    description:
      'Get a price quote for registering an agent identity bundle. Domain, DNS, email, SSL, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional.',
    inputSchema: {
      type: 'object',
      properties: {
        preferredName: { type: 'string' },
        tld: { type: 'string', enum: SUPPORTED_TLDS },
        registerBasename: {
          type: 'boolean',
          description: 'Set false to skip Basename registration and cost.',
          default: true,
        },
        registerEns: {
          type: 'boolean',
          description: 'Set true to add ENS; false skips ENS cost.',
          default: false,
        },
        emailEnabled: {
          type: 'boolean',
          description: 'Deprecated compatibility flag. Email is now always included.',
          default: true,
        },
        emailUsername: {
          type: 'string',
          description: 'Primary email username. Defaults to agent, producing agent@domain.',
          default: 'agent',
        },
        premiumPlan: {
          type: 'string',
          enum: SERVICE_PLAN_KEYS,
          default: 'included',
          description: 'Premium Plan to buy with registration.',
        },
        years: { type: 'integer', default: 1, minimum: 1, maximum: 10 },
      },
      required: ['preferredName'],
    },
  },
  {
    name: 'register_agent_identity',
    description:
      'Register a complete agent identity bundle. Domain, DNS, email, SSL, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional. Pays in USDC on Base. Requires AGENT_PRIVATE_KEY env var.',
    inputSchema: {
      type: 'object',
      properties: {
        preferredName: { type: 'string' },
        tld: { type: 'string', enum: SUPPORTED_TLDS },
        registerBasename: {
          type: 'boolean',
          description: 'Set false to skip Basename registration and cost.',
          default: true,
        },
        basenameLabel: { type: 'string', description: 'Optional alternate Basename label' },
        registerEns: {
          type: 'boolean',
          description: 'Set true to add ENS; false skips ENS cost.',
          default: false,
        },
        ensLabel: { type: 'string', description: 'Optional alternate ENS label' },
        ownerAddress: {
          type: 'string',
          description: 'Optional EVM address to receive NFT ownership',
        },
        emailEnabled: {
          type: 'boolean',
          description: 'Deprecated compatibility flag. Email is now always included.',
          default: true,
        },
        emailUsername: {
          type: 'string',
          description: 'Primary email username. Defaults to agent, producing agent@domain.',
          default: 'agent',
        },
        premiumPlan: {
          type: 'string',
          enum: SERVICE_PLAN_KEYS,
          default: 'included',
          description: 'Premium Plan to buy with registration.',
        },
        years: { type: 'integer', default: 1, minimum: 1, maximum: 10 },
        autoRenew: { type: 'boolean', default: false },
        dnsTarget: { type: 'string', description: 'URL or IP to point the domain at' },
        metadata: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            framework: { type: 'string', enum: SUPPORTED_FRAMEWORKS },
            x402Endpoint: { type: 'string' },
          },
        },
      },
      required: ['preferredName'],
    },
  },
  {
    name: 'lookup_agent',
    description: 'Look up agent identities by wallet address.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: '0x wallet address' },
      },
      required: ['wallet'],
    },
  },
  {
    name: 'get_agent',
    description:
      'Get one agent identity by AgentDomain agent ID. Works with an agent-scoped API key.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'search_agents',
    description: 'Search the public agent registry by name, capability, or framework.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text query' },
        capability: { type: 'string' },
        framework: {
          type: 'string',
          enum: SUPPORTED_FRAMEWORKS,
        },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'send_agent_email',
    description: "Send an email from an agent's address (requires email-enabled identity).",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        to: { type: 'string' },
        subject: { type: 'string' },
        text: { type: 'string' },
        fromAddress: {
          type: 'string',
          description: 'Optional primary or active alias address to send from.',
        },
      },
      required: ['agentId', 'to', 'subject'],
    },
  },
  {
    name: 'update_primary_email',
    description:
      'Change the primary email username for an agent. The old primary address stops receiving new mail.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        username: { type: 'string', description: 'New primary local-part, e.g. agent or support' },
      },
      required: ['agentId', 'username'],
    },
  },
  {
    name: 'send_agent_email_batch',
    description:
      'Queue up to 100 emails in one request; each recipient counts toward monthly usage.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        messages: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              subject: { type: 'string' },
              text: { type: 'string' },
              fromAddress: { type: 'string' },
            },
            required: ['to', 'subject', 'text'],
          },
        },
        idempotencyKey: { type: 'string' },
      },
      required: ['agentId', 'messages'],
    },
  },
  {
    name: 'get_agent_email_usage',
    description: 'Get combined sent and received monthly quota usage and reset date.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    },
  },
  {
    name: 'configure_email_webhook',
    description: 'Configure the signed email.received webhook for an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        url: { type: 'string' },
        payloadMode: { type: 'string', enum: ['metadata', 'inline_text'] },
        enabled: { type: 'boolean' },
      },
      required: ['agentId', 'url'],
    },
  },
  {
    name: 'create_email_alias',
    description: 'Create an extra receive-and-send email alias. Requires paid-plan alias capacity.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        username: { type: 'string', description: 'Alias local-part, e.g. billing' },
      },
      required: ['agentId', 'username'],
    },
  },
  {
    name: 'delete_email_alias',
    description: 'Delete an active email alias from an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        emailAddress: { type: 'string', description: 'Full alias address to delete' },
      },
      required: ['agentId', 'emailAddress'],
    },
  },
  {
    name: 'list_agent_email',
    description:
      'List received/sent text-only email messages for an email-enabled agent, including extracted verification codes.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        limit: { type: 'number', default: 20 },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'delete_agent_email',
    description: 'Permanently delete one email message from an agent inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        messageId: { type: 'string', description: 'Email message ID (UUID)' },
      },
      required: ['agentId', 'messageId'],
    },
  },
  {
    name: 'get_dns_capabilities',
    description:
      'Get the machine-readable DNS types, fields, limits, and safety warnings supported by AgentDomain.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' } },
      required: ['agentId'],
    },
  },
  {
    name: 'list_dns_records',
    description: 'List DNS records for an agent domain.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'create_dns_record',
    description: 'Create a user-managed DNS record and apply the resulting DNS state.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        type: { type: 'string', enum: DNS_RECORD_TYPES },
        name: { type: 'string' },
        value: { type: 'string', description: 'Legacy format; structured data is preferred' },
        data: { type: 'object', description: 'Type-specific structured DNS record data' },
        ttl: { type: 'number', default: 3600 },
        priority: { type: 'number' },
      },
      required: ['agentId', 'type', 'name'],
    },
  },
  {
    name: 'update_dns_record',
    description: 'Update a user-managed DNS record and apply the resulting DNS state.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        recordId: { type: 'string' },
        type: { type: 'string', enum: DNS_RECORD_TYPES },
        name: { type: 'string' },
        value: { type: 'string' },
        data: { type: 'object', description: 'Type-specific structured DNS record data' },
        ttl: { type: 'number' },
        priority: { type: 'number' },
      },
      required: ['agentId', 'recordId'],
    },
  },
  {
    name: 'delete_dns_record',
    description: 'Delete a user-managed DNS record and apply the resulting DNS state.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        recordId: { type: 'string' },
      },
      required: ['agentId', 'recordId'],
    },
  },
  {
    name: 'change_dns_records',
    description:
      'Preview or apply an atomic DNS merge/replace batch. Apply requires the baseRevision returned by preview.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        records: { type: 'array', maxItems: 200, items: { type: 'object' } },
        mode: { type: 'string', enum: ['merge', 'replace'], default: 'merge' },
        dryRun: { type: 'boolean', default: true },
        baseRevision: { type: 'string', description: 'Required when dryRun is false' },
      },
      required: ['agentId', 'records'],
    },
  },
  {
    name: 'import_dns_zone',
    description: 'Preview or apply a BIND zone import. System-managed records remain protected.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        zoneFile: { type: 'string', description: 'BIND zone text, maximum 256 KiB' },
        mode: { type: 'string', enum: ['merge', 'replace'], default: 'merge' },
        dryRun: { type: 'boolean', default: true },
        baseRevision: { type: 'string', description: 'Required when dryRun is false' },
      },
      required: ['agentId', 'zoneFile'],
    },
  },
  {
    name: 'export_dns_zone',
    description:
      'Export user-managed or permitted complete DNS state as a standard BIND zone file.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        scope: { type: 'string', enum: ['user', 'all'], default: 'user' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'reconfigure_ssl',
    description: 'Rebuild the managed SSL hostname and sync required DNS validation records.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'fund_renewal_vault',
    description: "Deposit USDC into an agent's renewal vault to keep its domain alive.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        amountUsdc: { type: 'string', description: 'USDC amount, e.g. "10.00"' },
      },
      required: ['agentId', 'amountUsdc'],
    },
  },
  {
    name: 'withdraw_renewal_vault',
    description:
      'Build the owner-signed withdrawal transaction for unused funds in an AgentID renewal vault.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        amountUsdc: { type: 'string', description: 'USDC amount, e.g. "5.00"' },
      },
      required: ['agentId', 'amountUsdc'],
    },
  },
  {
    name: 'get_renewal_status',
    description:
      'Get renewal vault status for an agent, including exact renewal amount, vault balance, missing deposit, expiry, and auto-renew readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_service_plan',
    description:
      'Get the current AgentDomain Premium Plan, entitlement limits, billing interval, registry privacy, and recent purchases for one agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'purchase_service_plan',
    description:
      'Upgrade one agent to Starter, Pro, or Enterprise with x402 USDC. Requires AGENT_PRIVATE_KEY for the owner wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
        planSku: {
          type: 'string',
          description: 'For Enterprise, e.g. enterprise-100000 through enterprise-5000000.',
        },
      },
      required: ['agentId', 'plan'],
    },
  },
  {
    name: 'set_registry_visibility',
    description:
      'Hide or show one agent in the public AgentDomain registry. Hiding requires an active paid Premium Plan.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        registryHidden: {
          type: 'boolean',
          description: 'true hides the agent from public registry/search; false makes it public',
        },
      },
      required: ['agentId', 'registryHidden'],
    },
  },
  {
    name: 'schedule_service_plan_renewal',
    description:
      'Choose the exact Premium Plan SKU to charge at the next identity renewal, including any Enterprise email tier.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        plan: { type: 'string', enum: ['included', 'starter', 'pro', 'enterprise'] },
        planSku: {
          type: 'string',
          description:
            'Exact SKU; Enterprise examples range from enterprise-100000 to enterprise-5000000.',
        },
      },
      required: ['agentId', 'plan', 'planSku'],
    },
  },
  {
    name: 'enable_auto_renew',
    description:
      'Enable on-chain auto-renew for an agent. Requires the owner wallet private key and the RenewalVault contract address.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
      },
      required: ['agentId'],
    },
  },
];

const READ_ONLY_TOOL_NAMES = new Set([
  'inspect_agent_identity',
  'inspect_agent_renewal',
  'prepare_auto_renew_change',
  'check_domain_availability',
  'quote_registration',
  'lookup_agent',
  'get_agent',
  'search_agents',
  'get_agent_email_usage',
  'list_agent_email',
  'get_dns_capabilities',
  'list_dns_records',
  'export_dns_zone',
  'get_renewal_status',
  'get_service_plan',
]);

const ADDITIVE_WRITE_TOOL_NAMES = new Set([
  'send_agent_email',
  'send_agent_email_batch',
  'create_email_alias',
  'create_dns_record',
]);

function annotationsForTool(name: string): ToolAnnotations {
  const readOnly = READ_ONLY_TOOL_NAMES.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : !ADDITIVE_WRITE_TOOL_NAMES.has(name),
    idempotentHint: readOnly,
    openWorldHint: true,
  };
}

const TOOLS: Tool[] = TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  annotations: annotationsForTool(tool.name),
}));
const ENABLED_TOOLS = WRITE_TOOLS_ENABLED
  ? TOOLS
  : TOOLS.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
const ENABLED_TOOL_NAMES = new Set(ENABLED_TOOLS.map((tool) => tool.name));

// ----------------------------------------------------------------------
// HANDLERS
// ----------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ENABLED_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (!ENABLED_TOOL_NAMES.has(name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown or disabled tool: ${name}` }],
      };
    }

    // This public chain read must not construct a platform client or load a signer.
    if (name === 'inspect_agent_identity') {
      const input = identityInspectionInput.parse(args);
      const result = await inspectAgentIdentity(input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'inspect_agent_renewal') {
      const result = await inspectAgentRenewal(renewalInspectionInput.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    if (name === 'prepare_auto_renew_change') {
      const result = await prepareAutoRenewChange(autoRenewChangeInput.parse(args));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const client = getClient();
    switch (name) {
      case 'check_domain_availability': {
        const a = z
          .object({ name: z.string(), tld: z.enum(SUPPORTED_TLDS).default('xyz') })
          .parse(args);
        const result = await client.checkAvailability(a.name, { tld: a.tld });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'quote_registration': {
        const a = z
          .object({
            preferredName: z.string(),
            tld: z.enum(SUPPORTED_TLDS).default('xyz'),
            registerBasename: z.boolean().default(true),
            registerEns: z.boolean().default(false),
            emailEnabled: z.boolean().default(true),
            emailUsername: z.string().optional(),
            premiumPlan: z.enum(SERVICE_PLAN_KEYS).default('included'),
            years: z.number().int().min(1).max(10).default(1),
          })
          .parse(args);
        const result = await client.quote(a);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'register_agent_identity': {
        if (!AGENT_PRIVATE_KEY) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: "AGENT_PRIVATE_KEY env var is required for registration. Set it to your agent's wallet private key.",
              },
            ],
          };
        }
        const a = z
          .object({
            preferredName: z.string(),
            tld: z.enum(SUPPORTED_TLDS).default('xyz'),
            registerBasename: z.boolean().default(true),
            basenameLabel: z.string().optional(),
            registerEns: z.boolean().default(false),
            ensLabel: z.string().optional(),
            ownerAddress: z
              .string()
              .regex(/^0x[a-fA-F0-9]{40}$/)
              .optional(),
            emailEnabled: z.boolean().default(true),
            emailUsername: z.string().optional(),
            premiumPlan: z.enum(SERVICE_PLAN_KEYS).default('included'),
            years: z.number().int().min(1).max(10).default(1),
            autoRenew: z.boolean().default(false),
            dnsTarget: z.string().optional(),
            metadata: z.record(z.string(), z.any()).optional(),
          })
          .parse(args);
        const account = privateKeyToAccount(AGENT_PRIVATE_KEY as `0x${string}`);
        const result = await client.register({
          ...a,
          wallet: account.address,
          ownerAddress: a.ownerAddress as `0x${string}` | undefined,
          metadata: a.metadata as never,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'lookup_agent': {
        const a = z.object({ wallet: z.string() }).parse(args);
        const result = await client.getAgentsByWallet(a.wallet as `0x${string}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_agent': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.getAgentById(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'search_agents': {
        const a = z
          .object({
            q: z.string().optional(),
            capability: z.string().optional(),
            framework: z.enum(SUPPORTED_FRAMEWORKS).optional(),
            limit: z.number().default(20),
          })
          .parse(args);
        const result = await client.search(a);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'send_agent_email': {
        const a = z
          .object({
            agentId: z.string(),
            to: z.string(),
            subject: z.string(),
            text: z.string(),
            fromAddress: z.string().email().optional(),
          })
          .parse(args);
        const result = await client.sendEmail(a.agentId, {
          to: a.to,
          fromAddress: a.fromAddress,
          subject: a.subject,
          text: a.text,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_agent_email': {
        const a = z.object({ agentId: z.string(), limit: z.number().default(20) }).parse(args);
        const result = await client.listEmail(a.agentId, { limit: a.limit });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'delete_agent_email': {
        const a = z
          .object({ agentId: z.string().uuid(), messageId: z.string().uuid() })
          .parse(args);
        const result = await client.deleteEmailMessage(a.agentId, a.messageId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'send_agent_email_batch': {
        const a = z
          .object({
            agentId: z.string(),
            messages: z
              .array(
                z.object({
                  to: z.string().email(),
                  subject: z.string(),
                  text: z.string(),
                  fromAddress: z.string().email().optional(),
                }),
              )
              .max(100),
            idempotencyKey: z.string().optional(),
          })
          .parse(args);
        const result = await client.sendEmailBatch(a.agentId, {
          messages: a.messages,
          idempotencyKey: a.idempotencyKey,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'get_agent_email_usage': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.getEmailUsage(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'configure_email_webhook': {
        const a = z
          .object({
            agentId: z.string(),
            url: z.string().url(),
            payloadMode: z.enum(['metadata', 'inline_text']).default('metadata'),
            enabled: z.boolean().default(true),
          })
          .parse(args);
        const result = await client.setEmailWebhook(a.agentId, a);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'update_primary_email': {
        const a = z.object({ agentId: z.string(), username: z.string() }).parse(args);
        const result = await client.updatePrimaryEmail(a.agentId, a.username);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'create_email_alias': {
        const a = z.object({ agentId: z.string(), username: z.string() }).parse(args);
        const result = await client.createEmailAlias(a.agentId, a.username);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'delete_email_alias': {
        const a = z.object({ agentId: z.string(), emailAddress: z.string().email() }).parse(args);
        const result = await client.deleteEmailAlias(a.agentId, a.emailAddress);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_dns_capabilities': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.getDnsCapabilities(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_dns_records': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.listDnsRecords(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'create_dns_record': {
        const a = z
          .object({
            agentId: z.string(),
            type: z.enum(DNS_RECORD_TYPES),
            name: z.string(),
            value: z.string().optional(),
            data: z.record(z.string(), z.unknown()).optional(),
            ttl: z.number().default(3600),
            priority: z.number().optional(),
          })
          .parse(args);
        const { agentId, ...record } = a;
        const result = await client.createDnsRecord(
          agentId,
          dnsRecordSchema.parse(record) as DnsRecordInput,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'update_dns_record': {
        const a = z
          .object({
            agentId: z.string(),
            recordId: z.string(),
            type: z.enum(DNS_RECORD_TYPES).optional(),
            name: z.string().optional(),
            value: z.string().optional(),
            data: z.record(z.string(), z.unknown()).optional(),
            ttl: z.number().optional(),
            priority: z.number().optional(),
          })
          .parse(args);
        const { agentId, recordId, ...record } = a;
        const result = await client.updateDnsRecord(
          agentId,
          recordId,
          dnsRecordObjectSchema.partial().parse(record) as Partial<DnsRecordInput>,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'delete_dns_record': {
        const a = z.object({ agentId: z.string(), recordId: z.string() }).parse(args);
        const result = await client.deleteDnsRecord(a.agentId, a.recordId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'change_dns_records': {
        const a = z
          .object({
            agentId: z.string(),
            records: z.array(dnsRecordSchema).min(1).max(200),
            mode: z.enum(['merge', 'replace']).default('merge'),
            dryRun: z.boolean().default(true),
            baseRevision: z.string().length(64).optional(),
          })
          .parse(args);
        const result = a.dryRun
          ? await client.previewDnsBatch(a.agentId, a.records as DnsRecordInput[], a.mode)
          : await client.applyDnsBatch(
              a.agentId,
              a.records as DnsRecordInput[],
              requireDnsRevision(a.baseRevision),
              a.mode,
            );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'import_dns_zone': {
        const a = z
          .object({
            agentId: z.string(),
            zoneFile: z.string().min(1).max(262_144),
            mode: z.enum(['merge', 'replace']).default('merge'),
            dryRun: z.boolean().default(true),
            baseRevision: z.string().length(64).optional(),
          })
          .parse(args);
        const result = a.dryRun
          ? await client.previewDnsImport(a.agentId, a.zoneFile, a.mode)
          : await client.applyDnsImport(
              a.agentId,
              a.zoneFile,
              requireDnsRevision(a.baseRevision),
              a.mode,
            );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'export_dns_zone': {
        const a = z
          .object({ agentId: z.string(), scope: z.enum(['user', 'all']).default('user') })
          .parse(args);
        const result = await client.exportDnsZone(a.agentId, a.scope);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'reconfigure_ssl': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.reconfigureSsl(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'fund_renewal_vault': {
        const a = z.object({ agentId: z.string(), amountUsdc: z.string() }).parse(args);
        const result = await client.fundRenewalVault(a.agentId, a.amountUsdc);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'withdraw_renewal_vault': {
        requireDirectBaseWriteBuilderCode('withdraw_renewal_vault');
        const a = z.object({ agentId: z.string(), amountUsdc: z.string() }).parse(args);
        const result = await client.withdrawFromVault(a.agentId, a.amountUsdc);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_renewal_status': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.getRenewalStatus(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_service_plan': {
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.getServicePlan(a.agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'purchase_service_plan': {
        if (!AGENT_PRIVATE_KEY) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'AGENT_PRIVATE_KEY env var is required to purchase a Premium Plan.',
              },
            ],
          };
        }
        const a = z
          .object({
            agentId: z.string(),
            plan: z.enum(['starter', 'pro', 'enterprise']),
            planSku: z.custom<ServicePlanSku>().optional(),
          })
          .parse(args);
        const result = await client.purchaseServicePlan(a);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'set_registry_visibility': {
        const a = z.object({ agentId: z.string(), registryHidden: z.boolean() }).parse(args);
        const result = await client.setRegistryVisibility(a.agentId, a.registryHidden);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'schedule_service_plan_renewal': {
        const a = z
          .object({
            agentId: z.string().uuid(),
            plan: z.enum(['included', 'starter', 'pro', 'enterprise']),
            planSku: z.custom<ServicePlanSku>(),
          })
          .parse(args);
        const result = await client.scheduleServicePlanRenewal(a.agentId, {
          plan: a.plan,
          planSku: a.planSku,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'enable_auto_renew': {
        if (!AGENT_PRIVATE_KEY) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'AGENT_PRIVATE_KEY env var is required to enable auto-renew. Use the owner wallet private key.',
              },
            ],
          };
        }
        if (!RENEWAL_VAULT_ADDRESS) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'RENEWAL_VAULT_ADDRESS env var is required to enable auto-renew on-chain.',
              },
            ],
          };
        }
        requireDirectBaseWriteBuilderCode('enable_auto_renew');
        const a = z.object({ agentId: z.string() }).parse(args);
        const result = await client.setAutoRenew(a.agentId, true, { waitForReceipt: true });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
  } catch (e) {
    if (name === 'inspect_agent_renewal' || name === 'prepare_auto_renew_change') {
      const error =
        e instanceof RenewalWorkflowError
          ? { code: e.code, message: e.message }
          : e instanceof z.ZodError
            ? {
                code: 'INVALID_INPUT',
                message:
                  name === 'inspect_agent_renewal'
                    ? 'Provide exactly one domain or positive decimal tokenId, optionally expectedOwner. Other arguments are not accepted.'
                    : 'Provide a positive decimal tokenId, expectedOwner, boolean enabled, and builderCode. Other arguments are not accepted.',
              }
            : {
                code: 'UNAVAILABLE',
                message:
                  'Base renewal inspection or unsigned preparation is unavailable. No transaction was submitted.',
              };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
      };
    }
    if (name === 'inspect_agent_identity') {
      const error =
        e instanceof IdentityInspectionError
          ? { code: e.code, message: e.message }
          : e instanceof z.ZodError
            ? {
                code: 'INVALID_INPUT',
                message:
                  'Provide exactly one domain or decimal tokenId, optionally expectedOwner. Other arguments are not accepted.',
              }
            : {
                code: 'UNAVAILABLE',
                message: 'Identity inspection is unavailable. No identity verdict was produced.',
              };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
});

// ----------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------

function requireDnsRevision(value: string | undefined): string {
  if (!value) throw new Error('Apply requires baseRevision from a fresh DNS dry-run preview.');
  return value;
}

function parseWriteToolsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${WRITE_TOOLS_ENV} must be exactly "true" or "false" when set.`);
}

function requireDirectBaseWriteBuilderCode(toolName: string): string {
  if (!AGENTDOMAIN_BUILDER_CODE) {
    throw new Error(
      `${toolName} requires AGENTDOMAIN_BUILDER_CODE so its direct Base transaction includes ERC-8021 attribution.`,
    );
  }
  try {
    return validateBuilderCode(AGENTDOMAIN_BUILDER_CODE);
  } catch (error) {
    throw new Error(
      `AGENTDOMAIN_BUILDER_CODE is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentDomain MCP server running on stdio');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
