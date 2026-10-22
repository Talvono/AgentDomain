import { AgentDomain, encodeSetAutoRenewCalldata } from '@agentdomain/sdk';
import {
  AGENTDOMAIN_API_BASE_URL,
  SERVICE_PLAN_KEYS,
  SUPPORTED_TLDS,
} from '@agentdomain/shared/constants';
import {
  DNS_RECORD_TYPES,
  dnsRecordSchema as sharedDnsRecordSchema,
  type DnsRecordInput,
  type ServicePlanKey,
} from '@agentdomain/shared';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { z } from 'zod';
import {
  extractEmailAddresses,
  extractFencedBlock,
  parseCompactQuantity,
  readLabeledEmail,
  readLabeledEmailUsername,
  readLabeledRemainder,
  readAddOnIntent,
  readNamedPlan,
  readPlainWords,
  readRegistrationPlan,
} from './text-parsing.js';

interface IAgentRuntime {
  getSetting(key: string): string | undefined;
  character?: { settings?: { secrets?: Record<string, string> } };
}

interface Memory {
  content: { text: string };
}

/** Builds the attributed direct calldata used by Eliza's post-registration auto-renew step. */
export function encodeElizaAutoRenewCalldata(tokenId: bigint, builderCode?: string) {
  if (!builderCode) {
    throw new Error(
      'AGENTDOMAIN_BUILDER_CODE is required for attributed direct Base transactions.',
    );
  }
  return encodeSetAutoRenewCalldata(tokenId, true, builderCode);
}

function getClients(runtime: IAgentRuntime, opts: { requireWallet?: boolean } = {}) {
  const apiUrl = runtime.getSetting('AGENTDOMAIN_API_URL') ?? AGENTDOMAIN_API_BASE_URL;
  const apiKey = runtime.getSetting('AGENTDOMAIN_API_KEY');
  const pk = runtime.getSetting('AGENT_PRIVATE_KEY');
  const rpc = runtime.getSetting('BASE_RPC_URL') ?? 'https://mainnet.base.org';
  const network = (runtime.getSetting('AGENTDOMAIN_NETWORK') as 'base' | 'base-sepolia') ?? 'base';
  const builderCode = runtime.getSetting('AGENTDOMAIN_BUILDER_CODE');
  const chain = network === 'base-sepolia' ? baseSepolia : base;

  if (!pk) {
    if (opts.requireWallet) throw new Error('AGENT_PRIVATE_KEY not set');
    const ad = new AgentDomain({ apiUrl, apiKey, network, builderCode });
    return { ad, account: null, walletClient: null, publicClient: null, network, chain, rpc };
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  const ad = new AgentDomain({
    apiUrl,
    apiKey,
    network,
    walletClient: walletClient as never,
    publicClient: publicClient as never,
    builderCode,
  });

  return { ad, account, walletClient, publicClient, network, chain, rpc };
}

const TLD_PATTERN = new RegExp(String.raw`([a-z0-9-]{3,63})\.([a-z]{2,20})\b`, 'i');
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const AMOUNT_PATTERN = /\$?\s*(\d+(?:\.\d{1,6})?)\s*(?:usdc)?/i;
const EMAIL_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

const registerSchema = z.object({
  preferredName: z.string(),
  tld: z.enum(SUPPORTED_TLDS).default('xyz'),
  registerBasename: z.boolean().default(true),
  registerEns: z.boolean().default(false),
  emailEnabled: z.boolean().default(true),
  emailUsername: z.string().trim().toLowerCase().regex(EMAIL_USERNAME_PATTERN).default('agent'),
  years: z.number().int().min(1).max(10).default(1),
  autoRenew: z.boolean().default(false),
  premiumPlan: z.enum(SERVICE_PLAN_KEYS).default('included'),
});

const dnsRecordSchema = z.object({
  type: z.enum(DNS_RECORD_TYPES),
  name: z.string(),
  value: z.string().min(1).max(65_535),
  ttl: z.number().int().min(60).max(3600).default(3600),
  priority: z.number().int().min(0).optional(),
});

function parseParamsFromText(text: string): {
  preferredName: string;
  tld: string;
  registerBasename: boolean;
  registerEns: boolean;
  emailEnabled: boolean;
  emailUsername: string;
  years: number;
  autoRenew: boolean;
  premiumPlan: ServicePlanKey;
} {
  const m = text.match(TLD_PATTERN);
  if (!m) {
    throw new Error('Include the full domain to quote or register, for example research-agent.xyz');
  }
  const lower = text.toLowerCase();
  const yearsMatch = lower.match(/([1-9]|10)\s*years?/);
  const addOns = readAddOnIntent(text);
  return {
    preferredName: m[1]!.toLowerCase(),
    tld: m[2]!.toLowerCase(),
    registerBasename: !addOns.basenameDeclined,
    registerEns: addOns.ensRequested,
    emailEnabled: true,
    emailUsername: parseEmailUsername(text) ?? 'agent',
    years: yearsMatch ? parseInt(yearsMatch[1]!, 10) : 1,
    autoRenew:
      lower.includes('auto renew') || lower.includes('auto-renew') || lower.includes('autorenew'),
    premiumPlan: readRegistrationPlan(text) ?? 'included',
  };
}

function requireAgentId(text: string): string {
  const agentId = text.match(UUID_PATTERN)?.[0];
  if (!agentId) throw new Error('Agent ID UUID is required');
  return agentId;
}

function parseAmountUsdc(text: string): string {
  const amount = text.match(AMOUNT_PATTERN)?.[1];
  if (!amount) throw new Error('USDC amount is required');
  return amount;
}

function parsePlan(text: string): {
  plan: 'starter' | 'pro' | 'enterprise';
  planSku?: import('@agentdomain/shared').ServicePlanSku;
} {
  const plan = readNamedPlan(text);
  if (!plan) throw new Error('Name the Premium Plan: Starter, Pro, or Enterprise');
  if (plan === 'enterprise') {
    const quantity = parseCompactQuantity(readPlainWords(text).join(' '));
    const monthly = quantity
      ? Math.round(quantity.value * (quantity.suffix === 'm' ? 1_000_000 : 1_000))
      : 100_000;
    return {
      plan: 'enterprise',
      planSku: `enterprise-${monthly}` as import('@agentdomain/shared').ServicePlanSku,
    };
  }
  return { plan };
}

function parseDnsRecord(text: string) {
  const lower = text.toLowerCase();
  const typeMatch = text.match(/\b(A|AAAA|ALIAS|CAA|CNAME|HTTPS|MX|NS|PTR|SRV|SVCB|TLSA|TXT)\b/i);
  const nameMatch = text.match(/\bname[:=]\s*([^\s]+)/i);
  const value = readLabeledRemainder(text, ['value'], {
    stopLabels: ['ttl', 'priority'],
  });
  const ttlMatch = text.match(/\bttl[:=]\s*(\d+)/i);
  const priorityMatch = text.match(/\bpriority[:=]\s*(\d+)/i);
  const parsed = dnsRecordSchema.parse({
    type: typeMatch?.[1]?.toUpperCase() ?? (lower.includes('txt') ? 'TXT' : 'A'),
    name: nameMatch?.[1] ?? '@',
    value: value ?? text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ?? '',
    ttl: ttlMatch ? Number(ttlMatch[1]) : 3600,
    priority: priorityMatch ? Number(priorityMatch[1]) : undefined,
  });
  return parsed;
}

function parseDnsRecordsJson(text: string): DnsRecordInput[] {
  const fenced = extractFencedBlock(text, ['json']);
  const json = fenced ?? text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  if (!json) throw new Error('A JSON array of DNS records is required');
  return z.array(sharedDnsRecordSchema).min(1).max(200).parse(JSON.parse(json)) as DnsRecordInput[];
}

function parseZoneFile(text: string): string {
  const fenced = extractFencedBlock(text, ['bind', 'zone', 'dns']);
  if (!fenced?.trim()) throw new Error('Put the BIND zone records inside a fenced code block');
  return fenced.trim();
}

function parseDnsApplyOptions(text: string) {
  const lower = text.toLowerCase();
  return {
    mode: lower.includes('replace') ? ('replace' as const) : ('merge' as const),
    dryRun: !/\bapply\b/i.test(text),
    baseRevision: text.match(/\bbaseRevision[:=]\s*([a-f0-9]{64})/i)?.[1],
  };
}

function requireDnsRevision(value: string | undefined): string {
  if (!value) throw new Error('Apply requires baseRevision from a fresh DNS preview');
  return value;
}

function parseEmailUsername(text: string): string | null {
  const explicit =
    readLabeledEmailUsername(text, ['email username', 'primary email', 'username', 'alias']) ??
    extractEmailAddresses(text)[0]?.split('@')[0];
  const username = explicit?.trim().toLowerCase();
  return username && EMAIL_USERNAME_PATTERN.test(username) ? username : null;
}

function parseEmailRequest(text: string) {
  const fromAddress = readLabeledEmail(text, ['from']);
  const explicitTo = readLabeledEmail(text, ['to']);
  const emails = extractEmailAddresses(text);
  const to =
    explicitTo ?? emails.find((email) => email.toLowerCase() !== fromAddress?.toLowerCase());
  if (!to) throw new Error('Recipient email address is required');
  const subject =
    readLabeledRemainder(text, ['subject'], { stopCharacter: '|' }) ?? 'AgentDomain message';
  const body =
    readLabeledRemainder(text, ['text', 'body', 'message']) ?? text.replace(to, '').trim();
  return { to, fromAddress, subject, text: body || 'Hello from AgentDomain.' };
}

export const quoteRegistrationAction = {
  name: 'QUOTE_AGENT_REGISTRATION',
  description: 'Quote an AgentDomain registration before paying.',
  similes: ['PRICE_DOMAIN', 'REGISTRATION_QUOTE', 'QUOTE_IDENTITY'],
  examples: [],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const params = parseParamsFromText(message.content.text);
    const { ad } = getClients(runtime);
    const quote = await ad.quote(params);
    const addOns = [
      Number(quote.basenameCostUsdc) > 0 ? `Basename $${quote.basenameCostUsdc}` : '',
      Number(quote.ensCostUsdc) > 0 ? `ENS $${quote.ensCostUsdc}` : '',
      Number(quote.premiumPlanFeeUsdc ?? 0) > 0
        ? `${quote.premiumPlanLabel} plan $${quote.premiumPlanFeeUsdc}`
        : '',
    ].filter(Boolean);
    return {
      text: `Total: $${quote.totalUsdc} USDC for ${quote.domain} (${params.years} year${params.years === 1 ? '' : 's'}). Domain $${quote.domainCostUsdc}, platform $${quote.platformFeeUsdc ?? quote.serviceFeeUsdc}${addOns.length ? `, ${addOns.join(', ')}` : ''}; email and SSL are included.`,
      data: quote,
    };
  },
};

export const registerIdentityAction = {
  name: 'REGISTER_IDENTITY',
  description:
    'Register a complete agent identity bundle on AgentDomain. Domain, DNS, email setup, SSL certification, AgentID NFT orchestration, and platform fee are included by default. Include the full domain. Users can say "no basename" to skip Basename, "with ENS" to add ENS, "with the Pro plan" to add a paid Premium Plan, and "email username support" to customize the primary inbox.',
  similes: ['CLAIM_DOMAIN', 'CREATE_IDENTITY', 'GET_DOMAIN'],
  examples: [
    [
      { user: 'user1', content: { text: 'Register me as helpful-bot.ai email username support' } },
      {
        user: 'agent',
        content: {
          text: "I'll register helpful-bot.ai with included email and SSL infrastructure now.",
          action: 'REGISTER_IDENTITY',
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, _message?: Memory) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const params = parseParamsFromText(message.content.text);
    const validated = registerSchema.parse(params);

    const { ad, account, walletClient, publicClient, chain } = getClients(runtime, {
      requireWallet: true,
    });
    if (!account || !walletClient || !publicClient) throw new Error('AGENT_PRIVATE_KEY not set');

    const result = await ad.register({
      ...validated,
      emailEnabled: true,
      wallet: account.address,
    } as any);

    let autoRenewMsg = '';
    if (validated.autoRenew) {
      const vaultAddress = runtime.getSetting('RENEWAL_VAULT_ADDRESS');
      if (vaultAddress) {
        try {
          const txHash = await walletClient.sendTransaction({
            to: vaultAddress as `0x${string}`,
            data: encodeElizaAutoRenewCalldata(
              BigInt(result.nftTokenId),
              runtime.getSetting('AGENTDOMAIN_BUILDER_CODE'),
            ),
            chain,
            account,
          });
          let receipt;
          try {
            receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          } catch (e) {
            throw new Error(
              `Auto-renew transaction ${txHash} was submitted but confirmation failed or remained pending: ${String(e)}`,
            );
          }
          if (receipt.status !== 'success') {
            throw new Error(
              `Auto-renew transaction ${txHash} confirmed with status ${receipt.status}; auto-renew was not enabled.`,
            );
          }
          autoRenewMsg = ` Auto-renew enabled via tx ${txHash}.`;
        } catch (e) {
          autoRenewMsg = ` Failed to enable auto-renew automatically: ${String(e)}`;
        }
      } else {
        autoRenewMsg = ' (Requires RENEWAL_VAULT_ADDRESS env var to enable auto-renew on-chain).';
      }
    }

    return {
      text: `Registered ${result.domain}${result.basename ? ` and ${result.basename}` : ''}. Token #${result.nftTokenId}.${autoRenewMsg}`,
      data: result,
    };
  },
};

export const searchAgentsAction = {
  name: 'SEARCH_AGENTS',
  description: 'Search the public AgentDomain registry by name, capability, or framework.',
  similes: ['FIND_AGENT', 'DISCOVER_AGENT'],
  examples: [],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const q = message.content.text;
    const result = await ad.search({ q, limit: 10 });
    return {
      text: `Found ${result.items.length} agents.`,
      data: result,
    };
  },
};

export const listEmailAction = {
  name: 'LIST_AGENT_EMAIL',
  description:
    'List text-only email messages and extracted verification codes for an AgentDomain identity.',
  similes: ['CHECK_EMAIL', 'READ_INBOX'],
  examples: [],
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting('AGENT_PRIVATE_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = message.content.text.match(/[0-9a-f-]{36}/i)?.[0];
    if (!agentId) throw new Error('Agent ID UUID is required to list email');
    const result = await ad.listEmail(agentId, { limit: 20 });
    return { text: `Found ${result.messages.length} messages.`, data: result };
  },
};

export const deleteEmailMessageAction = {
  name: 'DELETE_AGENT_EMAIL',
  description: 'Permanently delete one AgentDomain email message.',
  similes: ['DELETE_EMAIL_MESSAGE', 'REMOVE_EMAIL_MESSAGE'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const ids = message.content.text.match(new RegExp(UUID_PATTERN.source, 'gi')) ?? [];
    if (!ids[0] || !ids[1]) throw new Error('Agent ID and message ID UUIDs are required');
    const result = await ad.deleteEmailMessage(ids[0], ids[1]);
    return { text: `Deleted email message ${ids[1]}.`, data: result };
  },
};

export const sendEmailAction = {
  name: 'SEND_AGENT_EMAIL',
  description: 'Send text-only email from an AgentDomain primary address or active alias.',
  similes: ['SEND_EMAIL', 'EMAIL_FROM_AGENT'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const payload = parseEmailRequest(message.content.text);
    const result = await ad.sendEmail(agentId, payload);
    return { text: `Email queued: ${result.id}.`, data: result };
  },
};

export const emailUsageAction = {
  name: 'GET_AGENT_EMAIL_USAGE',
  description: 'Get combined monthly sent and received email usage.',
  similes: ['EMAIL_USAGE', 'EMAIL_QUOTA'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const result = await ad.getEmailUsage(requireAgentId(message.content.text));
    return {
      text: `Used ${result.used} of ${result.limit} emails; ${result.remaining} remain.`,
      data: result,
    };
  },
};
export const configureEmailWebhookAction = {
  name: 'CONFIGURE_EMAIL_WEBHOOK',
  description: 'Configure a signed inbound email webhook. Include an HTTPS URL in the request.',
  similes: ['SET_EMAIL_WEBHOOK'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const url = message.content.text.match(/https:\/\/[^\s]+/)?.[0];
    if (!url) throw new Error('HTTPS webhook URL is required');
    const result = await ad.setEmailWebhook(agentId, {
      url,
      payloadMode: /inline/i.test(message.content.text) ? 'inline_text' : 'metadata',
      enabled: true,
    });
    return { text: 'Inbound email webhook configured.', data: result };
  },
};
export const sendEmailBatchAction = {
  name: 'SEND_AGENT_EMAIL_BATCH',
  description: 'Queue up to 100 emails supplied as a JSON messages array.',
  similes: ['BATCH_EMAIL'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const json = message.content.text.slice(message.content.text.indexOf('{'));
    const parsed = JSON.parse(json) as {
      messages: Array<{ to: string; subject: string; text: string }>;
    };
    const result = await ad.sendEmailBatch(agentId, { messages: parsed.messages });
    return { text: `Queued ${result.jobs.length} email jobs.`, data: result };
  },
};

export const updatePrimaryEmailAction = {
  name: 'UPDATE_PRIMARY_EMAIL',
  description:
    'Request a primary email username change. Inspect the returned phase; pending is not completion. The old primary stops receiving after completion.',
  similes: ['CHANGE_PRIMARY_EMAIL', 'RENAME_EMAIL'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const username = parseEmailUsername(message.content.text);
    if (!username) throw new Error('New email username is required');
    const result = await ad.updatePrimaryEmail(agentId, username);
    return {
      text:
        'change' in result
          ? `Email address change ${result.change.phase}: ${result.change.target}. Request: ${result.change.requestId}.`
          : result.message,
      data: result,
    };
  },
};

export const createEmailAliasAction = {
  name: 'CREATE_EMAIL_ALIAS',
  description:
    'Request a receive-and-send alias. Requires paid-plan capacity. Inspect the returned phase before using a pending alias.',
  similes: ['ADD_EMAIL_ALIAS', 'CREATE_ALIAS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const username = parseEmailUsername(message.content.text);
    if (!username) throw new Error('Alias username is required');
    const result = await ad.createEmailAlias(agentId, username);
    return {
      text:
        'change' in result
          ? `Email address change ${result.change.phase}: ${result.change.target}. Request: ${result.change.requestId}.`
          : `Created email alias ${result.address.emailAddress}.`,
      data: result,
    };
  },
};

export const deleteEmailAliasAction = {
  name: 'DELETE_EMAIL_ALIAS',
  description:
    'Request deletion of an active email alias. Inspect the returned phase; pending is not completion.',
  similes: ['REMOVE_EMAIL_ALIAS', 'DELETE_ALIAS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const emailAddress = extractEmailAddresses(message.content.text)[0];
    if (!emailAddress) throw new Error('Full alias email address is required');
    const result = await ad.deleteEmailAlias(agentId, emailAddress);
    return {
      text:
        'change' in result
          ? `Email address change ${result.change.phase}: ${result.change.target}. Request: ${result.change.requestId}.`
          : `Deleted email alias ${emailAddress}.`,
      data: result,
    };
  },
};

export const renewalStatusAction = {
  name: 'GET_RENEWAL_STATUS',
  description: 'Get RenewalVault balance, shortfall, renewal amount, and auto-renew state.',
  similes: ['RENEWAL_STATUS', 'CHECK_RENEWAL', 'VAULT_STATUS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const status = await ad.getRenewalStatus(agentId);
    return {
      text: `Renewal for ${status.domain}: next $${status.nextRenewalAmountUsdc}, balance $${status.vaultBalanceUsdc}, shortfall $${status.shortfallUsdc}, auto-renew ${status.autoRenewEnabled ? 'enabled' : 'off'}.`,
      data: status,
    };
  },
};

export const fundRenewalAction = {
  name: 'FUND_RENEWAL_VAULT',
  description: 'Deposit USDC into an AgentID renewal vault.',
  similes: ['DEPOSIT_RENEWAL', 'FUND_VAULT'],
  examples: [],
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting('AGENT_PRIVATE_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime, { requireWallet: true });
    const agentId = requireAgentId(message.content.text);
    const amountUsdc = parseAmountUsdc(message.content.text);
    const result = await ad.fundRenewalVault(agentId, amountUsdc);
    return {
      text: `Deposited $${amountUsdc} USDC into renewal vault for ${result.domain}.`,
      data: result,
    };
  },
};

export const enableAutoRenewAction = {
  name: 'ENABLE_AUTO_RENEW',
  description: 'Enable on-chain RenewalVault auto-renew for an AgentDomain identity.',
  similes: ['AUTO_RENEW', 'ENABLE_RENEWAL'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') && runtime.getSetting('RENEWAL_VAULT_ADDRESS')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime, { requireWallet: true });
    const agentId = requireAgentId(message.content.text);
    const result = await ad.setAutoRenew(agentId, true, {
      renewalVaultAddress: runtime.getSetting('RENEWAL_VAULT_ADDRESS') as Address,
      waitForReceipt: true,
    });
    return { text: `Auto-renew enabled for token #${result.tokenId}.`, data: result };
  },
};

export const reconfigureSslAction = {
  name: 'RECONFIGURE_SSL',
  description:
    'Rebuild the managed SSL hostname and sync DNS validation records for an AgentDomain identity.',
  similes: ['FIX_SSL', 'REPAIR_SSL', 'SYNC_SSL'],
  examples: [],
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting('AGENT_PRIVATE_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = message.content.text.match(/[0-9a-f-]{36}/i)?.[0];
    if (!agentId) throw new Error('Agent ID UUID is required to reconfigure SSL');
    const result = await ad.reconfigureSsl(agentId);
    return {
      text: `SSL reconfigured for ${result.domain}. Status: ${result.sslStatus}.`,
      data: result,
    };
  },
};

export const listDnsAction = {
  name: 'LIST_DNS_RECORDS',
  description: 'List DNS records for an AgentDomain identity.',
  similes: ['DNS_RECORDS', 'LIST_DNS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const records = await ad.listDnsRecords(agentId);
    return { text: `Found ${records.length} DNS records.`, data: records };
  },
};

export const dnsCapabilitiesAction = {
  name: 'GET_DNS_CAPABILITIES',
  description:
    'Get AgentDomain DNS record types, validation fields, limits, and provider warnings.',
  similes: ['DNS_CAPABILITIES', 'DNS_TYPES', 'DNS_LIMITS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const result = await ad.getDnsCapabilities(requireAgentId(message.content.text));
    return {
      text: `AgentDomain supports ${result.supportedTypes.length} DNS record types.`,
      data: result,
    };
  },
};

export const createDnsAction = {
  name: 'CREATE_DNS_RECORD',
  description:
    'Create a user-managed DNS record. Use text like: agentId type A name @ value 1.2.3.4.',
  similes: ['ADD_DNS', 'CREATE_DNS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const record = parseDnsRecord(message.content.text);
    const result = await ad.createDnsRecord(agentId, record);
    return { text: `Created ${result.type} DNS record ${result.name}.`, data: result };
  },
};

export const updateDnsAction = {
  name: 'UPDATE_DNS_RECORD',
  description: 'Update a user-managed DNS record. Include agent UUID and record UUID.',
  similes: ['EDIT_DNS', 'UPDATE_DNS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const ids = message.content.text.match(new RegExp(UUID_PATTERN.source, 'gi')) ?? [];
    const agentId = ids[0];
    const recordId = ids[1];
    if (!agentId || !recordId) throw new Error('Agent ID and record ID UUIDs are required');
    const record = parseDnsRecord(message.content.text);
    const result = await ad.updateDnsRecord(agentId, recordId, record);
    return { text: `Updated ${result.type} DNS record ${result.name}.`, data: result };
  },
};

export const deleteDnsAction = {
  name: 'DELETE_DNS_RECORD',
  description: 'Delete a user-managed DNS record. Include agent UUID and record UUID.',
  similes: ['REMOVE_DNS', 'DELETE_DNS'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const ids = message.content.text.match(new RegExp(UUID_PATTERN.source, 'gi')) ?? [];
    const agentId = ids[0];
    const recordId = ids[1];
    if (!agentId || !recordId) throw new Error('Agent ID and record ID UUIDs are required');
    const result = await ad.deleteDnsRecord(agentId, recordId);
    return { text: `Deleted DNS record ${recordId}.`, data: result };
  },
};

export const changeDnsRecordsAction = {
  name: 'CHANGE_DNS_RECORDS',
  description:
    'Preview or apply a revision-protected DNS batch from a JSON array of structured records.',
  similes: ['BATCH_DNS', 'PREVIEW_DNS_CHANGES', 'APPLY_DNS_CHANGES'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const records = parseDnsRecordsJson(message.content.text);
    const options = parseDnsApplyOptions(message.content.text);
    const result = options.dryRun
      ? await ad.previewDnsBatch(agentId, records, options.mode)
      : await ad.applyDnsBatch(
          agentId,
          records,
          requireDnsRevision(options.baseRevision),
          options.mode,
        );
    return {
      text: options.dryRun ? 'DNS preview generated.' : 'DNS change set applied.',
      data: result,
    };
  },
};

export const importDnsZoneAction = {
  name: 'IMPORT_DNS_ZONE',
  description: 'Preview or apply a validated BIND DNS zone import.',
  similes: ['DNS_ZONE_IMPORT', 'IMPORT_BIND_ZONE'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const zoneFile = parseZoneFile(message.content.text);
    const options = parseDnsApplyOptions(message.content.text);
    const result = options.dryRun
      ? await ad.previewDnsImport(agentId, zoneFile, options.mode)
      : await ad.applyDnsImport(
          agentId,
          zoneFile,
          requireDnsRevision(options.baseRevision),
          options.mode,
        );
    return {
      text: options.dryRun ? 'DNS import preview generated.' : 'DNS zone import applied.',
      data: result,
    };
  },
};

export const exportDnsZoneAction = {
  name: 'EXPORT_DNS_ZONE',
  description: 'Export AgentDomain DNS records as a standard BIND zone file.',
  similes: ['DNS_ZONE_EXPORT', 'EXPORT_BIND_ZONE'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const zone = await ad.exportDnsZone(
      requireAgentId(message.content.text),
      /\b(?:all|complete)\b/i.test(message.content.text) ? 'all' : 'user',
    );
    return { text: zone, data: { format: 'bind', zone } };
  },
};

export const servicePlanStatusAction = {
  name: 'GET_SERVICE_PLAN',
  description: 'Get an agent Premium Plan, limits, current period, and billing state.',
  similes: ['PLAN_STATUS', 'CHECK_PLAN'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const result = await ad.getServicePlan(agentId);
    return {
      text: `${result.domain} is on ${result.entitlement.plan}. Email limit ${result.entitlement.limits.monthlyEmails}/month combined, DNS limit ${result.entitlement.limits.dnsRecords}, registry hidden ${result.registryVisibility.hidden}.`,
      data: result,
    };
  },
};

export const setRegistryVisibilityAction = {
  name: 'SET_REGISTRY_VISIBILITY',
  description:
    'Hide or show an agent in the public AgentDomain registry. Hiding requires an active paid Premium Plan.',
  similes: ['HIDE_AGENT_REGISTRY', 'SHOW_AGENT_REGISTRY', 'REGISTRY_VISIBILITY'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const text = message.content.text.toLowerCase();
    const wantsPublic =
      text.includes('unhide') ||
      text.includes('show') ||
      text.includes('visible') ||
      text.includes('public');
    const registryHidden = !wantsPublic && (text.includes('hide') || text.includes('private'));
    const result = await ad.setRegistryVisibility(agentId, registryHidden);
    return {
      text: `${result.domain} is now ${result.registryVisibility.hidden ? 'hidden from' : 'visible in'} the public registry.`,
      data: result,
    };
  },
};

export const scheduleServicePlanRenewalAction = {
  name: 'SCHEDULE_SERVICE_PLAN_RENEWAL',
  description: 'Choose the exact AgentDomain Premium Plan SKU for the next identity renewal.',
  similes: ['CHANGE_RENEWAL_PLAN', 'SET_NEXT_RENEWAL_PLAN'],
  examples: [],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(runtime.getSetting('AGENT_PRIVATE_KEY') || runtime.getSetting('AGENTDOMAIN_API_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime);
    const agentId = requireAgentId(message.content.text);
    const plan: ServicePlanKey = readNamedPlan(message.content.text) ?? 'included';
    const parsed =
      plan === 'enterprise' ? parsePlan(message.content.text) : { plan, planSku: plan };
    const result = await ad.scheduleServicePlanRenewal(agentId, parsed);
    return {
      text: `Scheduled ${result.renewalPlanSku} for the next identity renewal.`,
      data: result,
    };
  },
};

export const purchaseServicePlanAction = {
  name: 'PURCHASE_SERVICE_PLAN',
  description: 'Upgrade an agent to AgentDomain Starter, Pro, or Enterprise using x402 USDC.',
  similes: ['BUY_PLAN', 'UPGRADE_PLAN'],
  examples: [],
  validate: async (runtime: IAgentRuntime) => Boolean(runtime.getSetting('AGENT_PRIVATE_KEY')),
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const { ad } = getClients(runtime, { requireWallet: true });
    const agentId = requireAgentId(message.content.text);
    const plan = parsePlan(message.content.text);
    const result = await ad.purchaseServicePlan({
      agentId,
      ...plan,
    });
    return {
      text: `Purchased ${result.entitlement.plan} Premium Plan for ${result.domain}.`,
      data: result,
    };
  },
};

export const agentDomainPlugin = {
  name: 'agentdomain',
  description: 'Programmable identity and communication infrastructure for AI agents.',
  actions: [
    quoteRegistrationAction,
    registerIdentityAction,
    searchAgentsAction,
    sendEmailAction,
    sendEmailBatchAction,
    emailUsageAction,
    configureEmailWebhookAction,
    listEmailAction,
    deleteEmailMessageAction,
    updatePrimaryEmailAction,
    createEmailAliasAction,
    deleteEmailAliasAction,
    renewalStatusAction,
    fundRenewalAction,
    enableAutoRenewAction,
    reconfigureSslAction,
    dnsCapabilitiesAction,
    listDnsAction,
    createDnsAction,
    updateDnsAction,
    deleteDnsAction,
    changeDnsRecordsAction,
    importDnsZoneAction,
    exportDnsZoneAction,
    servicePlanStatusAction,
    setRegistryVisibilityAction,
    scheduleServicePlanRenewalAction,
    purchaseServicePlanAction,
  ],
  evaluators: [],
  providers: [],
};

export default agentDomainPlugin;
