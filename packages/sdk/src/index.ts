import {
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
  type Transport,
  type Chain,
  type Account,
  keccak256,
  toHex,
  getAddress,
  isAddress,
  maxUint256,
  zeroAddress,
  concatHex,
  encodeFunctionData,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
export {
  inspectAgentIdentity,
  IdentityInspectionError,
  AGENT_IDENTITY_REGISTRY_BASE,
  type IdentityInspectionInput,
  type IdentityInspectionOptions,
  type IdentityInspectionPublicClient,
  type IdentityInspectionResult,
  type IdentityInspectionErrorCode,
  type FoundAgentIdentity,
  type MissingAgentIdentity,
} from './identity-inspection.js';
export {
  inspectAgentRenewal,
  prepareAutoRenewChange,
  executeAutoRenewChange,
  confirmAutoRenewChange,
  RenewalWorkflowError,
  AGENT_RENEWAL_VAULT_BASE,
  AGENT_RENEWAL_USDC_BASE,
  type RenewalWorkflowErrorCode,
  type RenewalWorkflowOptions,
  type RenewalPublicClient,
  type AgentRenewalInspection,
  type FoundAgentRenewal,
  type MissingAgentRenewal,
  type AutoRenewChangeInput,
  type AutoRenewChangePlan,
  type ExecuteAutoRenewChangeOptions,
  type AutoRenewChangeExecution,
  type AutoRenewChangeConfirmation,
} from './renewal-workflow.js';
import { z } from 'zod';
import {
  emailAddressChangeResultSchema,
  emailAddressChangeStatusSchema,
  emailServiceStatusSchema,
  primaryEmailUpdatedSchema,
  emailAliasCreatedSchema,
  emailAliasDeletedSchema,
  type EmailAddressChange,
  type EmailAddressChangeResult,
  type EmailAddressChangeStatus,
  type EmailServiceStatus,
  type PrimaryEmailUpdateResult,
  type EmailAliasCreateResult,
  type EmailAliasDeleteResult,
} from '@agentdomain/shared/schemas';
export type {
  EmailAddressChange,
  EmailAddressChangeResult,
  EmailAddressChangeStatus,
  EmailServiceStatus,
  PrimaryEmailUpdateResult,
  EmailAliasCreateResult,
  EmailAliasDeleteResult,
} from '@agentdomain/shared/schemas';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayloadResult, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import {
  BUILDER_CODE_PATTERN,
  encodeBuilderCodeSuffix,
  parseBuilderCodeSuffixFromCalldata,
} from '@x402/extensions/builder-code';
import type {
  DnsRecord,
  DnsRecordData,
  DnsRecordInput,
  DnsCapabilities,
  DnsBulkMode,
  DnsChangePreview,
  RegistrationParams,
  RegistrationResult,
  EmailMessage,
  RenewalPriceSnapshot,
  ServicePlanEntitlement,
  ServicePlanKey,
  ServicePlanSku,
} from '@agentdomain/shared';
import {
  AGENTDOMAIN_API_BASE_URL,
  BASE_CHAIN_ID,
  USDC_BASE,
  X402_NETWORK,
} from '@agentdomain/shared/constants';
import {
  RegistrationClient,
  encodeApiPathSegment,
  normalizeApiBaseUrl,
  type RegistrationHandle,
  type RegistrationListOptions,
  type RegistrationRequestOptions,
  type RegistrationWaitOptions,
} from './registration.js';
import type {
  RegistrationAccepted,
  RegistrationListResult,
  RegistrationProgress,
} from '@agentdomain/shared';
import { createAgentSignatureHeader, type AgentSignatureRequest } from './agent-signature.js';
export {
  AGENT_SIGNATURE_AUDIENCE,
  agentRequestBodySha256,
  agentSignatureAudience,
  buildAgentSignatureMessage,
  canonicalAgentRequestTarget,
  createAgentSignatureHeader,
  createAgentSignatureNonce,
  type AgentSignatureRequest,
  type AgentSignatureSigner,
} from './agent-signature.js';
export {
  RegistrationPendingError,
  RegistrationFailedError,
  RegistrationPaymentRejectedError,
  type RegistrationHandle,
  type RegistrationListOptions,
  type RegistrationRequestOptions,
  type RegistrationWaitOptions,
  type RegistrationPendingReason,
  type RegistrationAccepted,
  type RegistrationListResult,
  type RegistrationProgress,
} from './registration.js';

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const RENEWAL_VAULT_ABI = [
  {
    type: 'function',
    name: 'setAutoRenew',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'enabled', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

export interface AgentDomainOptions {
  /** Trusted application configuration, never an untrusted request parameter. Supports custom APIs. */
  apiUrl?: string;
  apiKey?: string;
  walletClient?: WalletClient<Transport, Chain, Account>;
  publicClient?: PublicClient<Transport, Chain>;
  network?: 'base' | 'base-sepolia';
  renewalVaultAddress?: Address;
  /** Use an existing SIWE cookie instead of signing registration requests with walletClient. */
  registrationAuth?: 'signature' | 'session';
  /** Payer identity expected for registration session reads; this does not authenticate requests. */
  registrationExpectedPayer?: Address;
  /**
   * Public ERC-8021 app identifier used for direct Base transactions created by this SDK.
   * Required only for direct onchain writes such as auto-renew and vault withdrawal.
   * x402 v2 payments use the resource server's standard builder-code extension instead.
   */
  builderCode?: string;
}

/**
 * Validates a public ERC-8021 builder code without normalizing configuration mistakes.
 */
export function validateBuilderCode(builderCode: string): string {
  if (!BUILDER_CODE_PATTERN.test(builderCode)) {
    throw new Error('builderCode must contain 1-32 lowercase letters, numbers, or underscores.');
  }
  return builderCode;
}

/**
 * Appends one validated ERC-8021 Schema 2 app attribution suffix to EVM calldata.
 * Existing matching attribution is preserved; conflicting attribution is rejected.
 */
export function appendBuilderCodeAttribution(data: Hex, builderCode: string): Hex {
  const validated = validateBuilderCode(builderCode);
  const existing = parseBuilderCodeSuffixFromCalldata(data);
  if (existing) {
    if (existing.a === validated) return data;
    throw new Error('Transaction calldata already contains different builder-code attribution.');
  }
  return concatHex([data, encodeBuilderCodeSuffix({ a: validated })]);
}

/** Decodes an ERC-8021 builder-code suffix from complete transaction calldata. */
export function parseBuilderCodeAttribution(data: Hex) {
  return parseBuilderCodeSuffixFromCalldata(data);
}

/** Builds the exact attributed calldata used for RenewalVault auto-renew writes. */
export function encodeSetAutoRenewCalldata(
  tokenId: bigint,
  enabled: boolean,
  builderCode: string,
): Hex {
  const data = encodeFunctionData({
    abi: RENEWAL_VAULT_ABI,
    functionName: 'setAutoRenew',
    args: [tokenId, enabled],
  });
  return appendBuilderCodeAttribution(data, builderCode);
}

export interface AvailabilityResult {
  available: boolean;
  domain?: string;
  reason?: string;
}

export interface QuoteResult {
  domain: string;
  basename?: string;
  ensName?: string;
  years: number;
  domainCostUsdc: string;
  basenameCostUsdc: string;
  ensCostUsdc: string;
  serviceFeeUsdc: string;
  platformFeeUsdc?: string;
  premiumPlan: ServicePlanKey;
  premiumPlanLabel: string;
  premiumPlanFeeUsdc: string;
  emailFeeUsdc: string;
  sslCertificationFeeUsdc: string;
  emailIncluded?: boolean;
  sslIncluded?: boolean;
  includedServices?: string[];
  providerCostUsdc?: string;
  treasuryFeeUsdc?: string;
  totalUsdc: string;
}

export type RegisterArgs = Omit<
  RegistrationParams,
  'wallet' | 'tld' | 'registerBasename' | 'registerEns' | 'emailEnabled' | 'years' | 'autoRenew'
> & {
  wallet?: Address;
  tld?: RegistrationParams['tld'];
  registerBasename?: boolean;
  registerEns?: boolean;
  emailEnabled?: boolean;
  years?: number;
  autoRenew?: boolean;
};

export interface AgentRow {
  id: string;
  domain: string;
  basename?: string;
  ensName?: string;
  status: string;
  walletAddress: Address;
  ownerAddress: Address;
}

export interface EmailResult {
  id: string;
  status: string;
  messages?: unknown[];
}

export interface EmailUsageResult {
  agentId: string;
  plan: ServicePlanKey;
  limit: number;
  sent: number;
  received: number;
  reserved: number;
  used: number;
  remaining: number;
  requestsPerSecond: number;
  cycleStart: string;
  cycleEnd: string;
}
export interface EmailWebhookConfig {
  agentId: string;
  url: string;
  payloadMode: 'metadata' | 'inline_text';
  enabled: boolean;
  secretVersion: number;
}

export interface EmailAddressSummary {
  id: string;
  agentId: string;
  emailAddress: string;
  kind: 'primary' | 'alias';
  status: 'active' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

export interface EmailListResult {
  inbox: unknown;
  addresses?: EmailAddressSummary[];
  limits?: { plan: ServicePlanKey; planLabel: string; emailAliases: number };
  messages: EmailMessage[];
  addressChange?: EmailAddressChangeStatus | null;
  mailStatus?: EmailServiceStatus;
}

export interface EmailAddressMutationOptions {
  /** Reuse the same UUID when explicitly retrying an unconfirmed request. */
  idempotencyKey?: string;
}

function emailAddressHeaders(options: EmailAddressMutationOptions) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.idempotencyKey !== undefined)
    headers['Idempotency-Key'] = z.string().uuid().parse(options.idempotencyKey).toLowerCase();
  return headers;
}

async function emailAddressResult<T>(
  response: Response,
  legacy: z.ZodType<T>,
  action: EmailAddressChange['action'],
  options: EmailAddressMutationOptions,
): Promise<T | EmailAddressChangeResult> {
  const value: unknown = await response.json();
  if (response.status === 202 || (value && typeof value === 'object' && 'change' in value)) {
    const result = emailAddressChangeResultSchema.parse(value);
    if (
      result.change.action !== action ||
      (options.idempotencyKey &&
        result.change.requestId.toLowerCase() !== options.idempotencyKey.toLowerCase()) ||
      (response.status === 200) !== (result.change.phase === 'completed')
    )
      throw new Error('Invalid email address change response');
    return result;
  }
  return legacy.parse(value);
}

export interface VaultFundResult {
  success: boolean;
  depositTxHash: string;
  autoRenewEnabled: boolean;
  autoRenewTxHash: string | null;
  vaultBalance: string;
  agentId: string;
  domain: string;
}

export interface VaultWithdrawResult {
  chainId: number;
  to: Address;
  data: Hex;
  value: '0';
  functionName: 'withdraw';
  args: {
    tokenId: string;
    amount: string;
  };
}

export interface RenewalStatus {
  agentId: string;
  domain: string;
  tokenId: string | null;
  autoRenewEnabled: boolean;
  vaultBalanceUsdc: string;
  vaultBalanceAtomic: string;
  vaultBalance: string;
  pendingRenewalAmountUsdc?: string;
  pendingRenewalAmountAtomic?: string;
  renewalFeeUsdc: string;
  renewalFeeAtomic: string;
  nextRenewalAmountUsdc: string;
  nextRenewalAmountAtomic: string;
  shortfallUsdc: string;
  shortfallAtomic: string;
  requiredAmount: string;
  hasEnoughBalanceForNextRenewal: boolean;
  isFunded: boolean;
  estimatedYearsCovered: number;
  expiresAt: string | null;
  renewableFrom: string | null;
  daysUntilExpiry: number | null;
  renewalWindowDays: number;
  renewalDurationDays: number;
  isRenewableNow: boolean;
  status: string;
  message: string;
  warning?: string | null;
  warnings?: string[];
  renewalBreakdown?: {
    years: number;
    domainRenewalCostUsdc: string;
    domainRenewalCostAtomic: string;
    platformFeeUsdc: string;
    platformFeeAtomic: string;
    premiumPlan: ServicePlanKey;
    premiumPlanFeeUsdc: string;
    premiumPlanFeeAtomic: string;
    sslCertificationFeeUsdc: string;
    sslCertificationFeeAtomic: string;
    emailFeeUsdc: string;
    emailFeeAtomic: string;
    totalUsdc: string;
    totalAtomic: string;
  };
  renewalSnapshot?: RenewalPriceSnapshot | null;
  ownerAddress: string;
}

export interface AutoRenewResult {
  agentId: string;
  tokenId: string;
  enabled: boolean;
  changed: boolean;
  txHash: Hex | null;
}

export interface SslReconfigureResult {
  ok: true;
  agentId: string;
  domain: string;
  cloudflareCustomHostnameId: string;
  hostnameStatus: string;
  sslStatus: string;
  validationRecordsCount: number;
  recordsCount: number;
}

export interface ServicePlanStatusResult {
  agentId: string;
  domain: string;
  entitlement: ServicePlanEntitlement;
  subscription: unknown | null;
  purchases: unknown[];
  catalog: Record<string, unknown>;
  renewalPlan: ServicePlanKey;
  renewalPlanSku: ServicePlanSku;
  upgradeQuotes?: Record<string, unknown>;
  registryVisibility: RegistryVisibilityStatus;
}

export interface ServicePlanPurchaseResult {
  success: true;
  agentId: string;
  domain: string;
  paymentTxHash: string | null;
  amountUsdc: string;
  subscription: unknown;
  purchase: unknown;
  entitlement: ServicePlanEntitlement;
}

export interface ServicePlanRenewalResult {
  success: true;
  agentId: string;
  renewalPlan: ServicePlanKey;
  renewalPlanSku: ServicePlanSku;
  entitlement: ServicePlanEntitlement;
  registryVisibility: RegistryVisibilityStatus;
}

export interface RegistryVisibilityStatus {
  hidden: boolean;
  hiddenUntil: string | null;
  requestedHidden: boolean;
  canHide: boolean;
  defaultHidden: boolean;
}

export interface RegistryVisibilityResult {
  success: true;
  agentId: string;
  domain: string;
  entitlement: ServicePlanEntitlement;
  registryVisibility: RegistryVisibilityStatus;
}

export interface ApiKeySummary {
  id: string;
  agentId: string | null;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  agentId: string;
  fullKey: string;
  warning?: string;
}

interface Eip3009RequirementForClient {
  maxAmountRequired: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  chainId?: number;
}

async function createRequestBoundPaymentPayload(
  requirements: PaymentRequirements,
  walletClient: WalletClient<Transport, Chain, Account>,
): Promise<PaymentPayloadResult> {
  const requestBinding = requirements.extra?.requestBinding;
  if (typeof requestBinding !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(requestBinding)) {
    throw new Error('Server returned an invalid x402 request binding.');
  }
  if (requirements.network !== X402_NETWORK || requirements.scheme !== 'exact') {
    throw new Error('AgentDomain request binding requires exact Base mainnet payments.');
  }
  if (
    typeof requirements.asset !== 'string' ||
    !isAddress(requirements.asset) ||
    getAddress(requirements.asset) !== USDC_BASE
  ) {
    throw new Error('AgentDomain request binding requires the Base USDC asset.');
  }
  if (
    requirements.extra?.assetTransferMethod !== undefined &&
    requirements.extra.assetTransferMethod !== 'eip3009'
  ) {
    throw new Error('AgentDomain request binding requires an EIP-3009 x402 authorization.');
  }
  if (requirements.extra?.name !== 'USD Coin' || requirements.extra.version !== '2') {
    throw new Error('Server returned an invalid Base USDC EIP-712 domain.');
  }
  if (
    typeof requirements.payTo !== 'string' ||
    !isAddress(requirements.payTo) ||
    getAddress(requirements.payTo) === zeroAddress
  ) {
    throw new Error('Server returned an invalid x402 payTo address.');
  }
  if (
    typeof requirements.amount !== 'string' ||
    !/^[0-9]+$/.test(requirements.amount) ||
    BigInt(requirements.amount) <= 0n ||
    BigInt(requirements.amount) > maxUint256
  ) {
    throw new Error(
      'Server returned an invalid x402 amount; expected positive uint256 atomic units.',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds <= 0 ||
    !Number.isSafeInteger(now + requirements.maxTimeoutSeconds)
  ) {
    throw new Error('Server returned an invalid x402 authorization timeout.');
  }
  let validBefore = now + requirements.maxTimeoutSeconds;
  const quoteExpiresAt = requirements.extra?.quoteExpiresAt;
  if (quoteExpiresAt !== undefined) {
    const expiry = z.string().datetime({ offset: true }).safeParse(quoteExpiresAt);
    const expirySeconds = expiry.success ? Math.floor(Date.parse(expiry.data) / 1000) : NaN;
    if (!Number.isSafeInteger(expirySeconds)) {
      throw new Error('Server returned an invalid x402 quote expiry; expected an ISO timestamp.');
    }
    if (expirySeconds <= now) {
      throw new Error('The x402 checkout quote has expired.');
    }
    validBefore = Math.min(validBefore, expirySeconds);
  }

  // Bind the sole signature to the issued nonce without rewriting accepted requirements.
  const authorization = {
    from: getAddress(walletClient.account.address),
    to: getAddress(requirements.payTo),
    value: requirements.amount,
    validAfter: '0',
    validBefore: validBefore.toString(),
    nonce: requestBinding as Hex,
  };
  const signature = await walletClient.signTypedData({
    account: walletClient.account,
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: BASE_CHAIN_ID,
      verifyingContract: USDC_BASE,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return { x402Version: 2, payload: { authorization, signature } };
}

export async function createX402PaymentHeaders(
  response: Response,
  walletClient: WalletClient<Transport, Chain, Account>,
): Promise<Record<string, string>> {
  if (!walletClient.account) {
    throw new Error('A connected wallet account is required for x402 payment.');
  }

  const signer = {
    address: walletClient.account.address,
    signTypedData: async (message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      walletClient.signTypedData({
        account: walletClient.account,
        ...message,
      } as Parameters<typeof walletClient.signTypedData>[0]),
  };

  // No implicit dollar cap; unbound payments retain the upstream asset policy.
  const client = new x402Client().setSpendControls(false);
  const exactScheme = new ExactEvmScheme(signer);
  client.register(X402_NETWORK, {
    scheme: exactScheme.scheme,
    findDefaultAsset: exactScheme.findDefaultAsset,
    createPaymentPayload: (version, requirements, context) => {
      // @x402/evm 2.25.0 has no nonce override. Use the public scheme interface
      // for bound EIP-3009 payments; leave unbound flows entirely upstream.
      return requirements.extra?.requestBinding === undefined
        ? exactScheme.createPaymentPayload(version, requirements, context)
        : createRequestBoundPaymentPayload(requirements, walletClient);
    },
  });
  const httpClient = new x402HTTPClient(client);

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => response.headers.get(name),
    body,
  );
  if (paymentRequired.x402Version !== 2) {
    throw new Error(
      `AgentDomain requires x402 v2; server returned v${paymentRequired.x402Version}.`,
    );
  }

  const payload = await httpClient.createPaymentPayload(paymentRequired);
  return httpClient.encodePaymentSignatureHeader(payload);
}

export class AgentDomain {
  private apiUrl: string;
  private apiKey?: string;
  private renewalVaultAddress?: Address;
  private readonly builderCode?: string;
  private readonly registrationClient: RegistrationClient;
  readonly walletClient?: WalletClient<Transport, Chain, Account>;
  readonly publicClient?: PublicClient<Transport, Chain>;
  readonly network: 'base' | 'base-sepolia';

  constructor(opts?: AgentDomainOptions) {
    this.apiUrl = normalizeApiBaseUrl(opts?.apiUrl ?? AGENTDOMAIN_API_BASE_URL);
    this.apiKey = opts?.apiKey;
    this.walletClient = opts?.walletClient;
    this.publicClient = opts?.publicClient;
    this.network = opts?.network ?? 'base';
    this.renewalVaultAddress = opts?.renewalVaultAddress;
    this.builderCode = opts?.builderCode;
    this.registrationClient = new RegistrationClient({
      apiUrl: this.apiUrl,
      walletClient: this.walletClient,
      network: this.network,
      authentication: opts?.registrationAuth,
      expectedPayer: opts?.registrationExpectedPayer,
      createPaymentHeaders: createX402PaymentHeaders,
    });
  }

  private requireBuilderCode(operation: string): string {
    if (!this.builderCode) {
      throw new Error(
        `${operation} requires builderCode in the AgentDomain constructor so the direct Base transaction is attributed.`,
      );
    }
    return validateBuilderCode(this.builderCode);
  }

  async checkAvailability(name: string, opts: { tld: string }): Promise<AvailabilityResult> {
    const url = `${this.apiUrl}/domains/availability?name=${encodeURIComponent(name)}&tld=${encodeURIComponent(opts.tld)}`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await fetch(url);
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async quote(args: {
    preferredName: string;
    tld: string;
    registerBasename?: boolean;
    basenameLabel?: string;
    registerEns?: boolean;
    ensLabel?: string;
    emailEnabled?: boolean;
    emailUsername?: string;
    premiumPlan?: ServicePlanKey;
    premiumPlanSku?: import('@agentdomain/shared').ServicePlanSku;
    years?: number;
  }): Promise<QuoteResult> {
    const params = new URLSearchParams();
    params.set('preferredName', args.preferredName);
    params.set('tld', args.tld);
    if (args.registerBasename !== undefined)
      params.set('registerBasename', String(args.registerBasename));
    if (args.basenameLabel) params.set('basenameLabel', args.basenameLabel);
    if (args.registerEns !== undefined) params.set('registerEns', String(args.registerEns));
    if (args.ensLabel) params.set('ensLabel', args.ensLabel);
    if (args.emailEnabled !== undefined) params.set('emailEnabled', String(args.emailEnabled));
    if (args.emailUsername) params.set('emailUsername', args.emailUsername);
    if (args.premiumPlan) params.set('premiumPlan', args.premiumPlan);
    if (args.premiumPlanSku) params.set('premiumPlanSku', args.premiumPlanSku);
    if (args.years) params.set('years', String(args.years));
    const url = `${this.apiUrl}/agents/quote?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async register(
    args: RegisterArgs,
    options: RegistrationWaitOptions = {},
  ): Promise<RegistrationResult> {
    const expectedPayer =
      options.expectedPayer ?? args.wallet ?? this.walletClient?.account.address;
    const result = await this.submitRegistration(args, { signal: options.signal, expectedPayer });
    return 'status' in result
      ? this.waitForRegistration(result, { ...options, expectedPayer })
      : result;
  }

  async submitRegistration(
    args: RegisterArgs,
    options: RegistrationRequestOptions = {},
  ): Promise<RegistrationAccepted | RegistrationResult> {
    return this.registrationClient.submit(args, options);
  }

  async getRegistration(
    registrationId: string,
    options: RegistrationRequestOptions = {},
  ): Promise<RegistrationProgress> {
    return this.registrationClient.get(registrationId, options);
  }

  async getRegistrations(options: RegistrationListOptions = {}): Promise<RegistrationListResult> {
    return this.registrationClient.list(options);
  }

  async waitForRegistration(
    registration: string | RegistrationAccepted | RegistrationProgress | RegistrationHandle,
    options: RegistrationWaitOptions = {},
  ): Promise<RegistrationResult> {
    return this.registrationClient.wait(registration, options);
  }

  async recoverRegistration(
    handle: RegistrationHandle,
    options: RegistrationRequestOptions = {},
  ): Promise<RegistrationProgress> {
    return this.registrationClient.recover(handle, options);
  }

  private async buildEip3009Authorization(requirement: Eip3009RequirementForClient, from: Address) {
    const chain = this.network === 'base-sepolia' ? baseSepolia : base;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const validBefore = now + BigInt(requirement.maxTimeoutSeconds || 300);
    const nonce = keccak256(
      toHex(`${from}:${Date.now()}:${Math.floor(Math.random() * 1e15)}`),
    ) as Hex;
    const message = {
      from,
      to: requirement.payTo as Address,
      value: BigInt(requirement.maxAmountRequired),
      validAfter: 0n,
      validBefore,
      nonce,
    };

    const signature = await this.walletClient!.signTypedData({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: requirement.chainId ?? chain.id,
        verifyingContract: requirement.asset as Address,
      },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
    });

    return {
      signature,
      authorization: {
        from,
        to: requirement.payTo,
        value: requirement.maxAmountRequired,
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce,
      },
    };
  }

  async getAgentsByWallet(wallet: Address): Promise<AgentRow[]> {
    const url = `${this.apiUrl}/agents/by-wallet/${encodeApiPathSegment(wallet)}`;
    const res = await this.signedFetch(url, {
      authOptions: { useApiKey: false },
    });
    if (!res.ok) throw new Error(await responseError(res));
    const data = await res.json();
    return Array.isArray(data) ? data : data.agent ? [data.agent] : [];
  }

  async getAgentById(agentId: string): Promise<AgentRow> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}`;
    const res = await this.signedFetch(url, {});
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async getAgent(wallet: Address): Promise<AgentRow | null> {
    const agents = await this.getAgentsByWallet(wallet);
    return agents[0] ?? null;
  }

  async search(args: {
    q?: string;
    framework?: string;
    capability?: string;
    limit?: number;
  }): Promise<{ items: AgentRow[]; total: number }> {
    const params = new URLSearchParams();
    if (args.q) params.set('q', args.q);
    if (args.framework) params.set('framework', args.framework);
    if (args.capability) params.set('capability', args.capability);
    if (args.limit) params.set('limit', String(args.limit));
    const url = `${this.apiUrl}/agents/search?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async sendEmail(
    agentId: string,
    args: {
      to: string | string[];
      subject: string;
      text: string;
      fromAddress?: string;
      replyTo?: string;
      idempotencyKey?: string;
    },
  ): Promise<EmailResult> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/send`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.idempotencyKey ? { 'Idempotency-Key': args.idempotencyKey } : {}),
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async sendEmailBatch(
    agentId: string,
    args: {
      messages: Array<{
        to: string | string[];
        subject: string;
        text: string;
        fromAddress?: string;
        replyTo?: string;
      }>;
      validationMode?: 'strict' | 'partial';
      idempotencyKey?: string;
    },
  ) {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/batch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(args.idempotencyKey ? { 'Idempotency-Key': args.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          messages: args.messages,
          validationMode: args.validationMode ?? 'strict',
        }),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json() as Promise<{
      batchId: string;
      status: string;
      jobs: unknown[];
      errors: unknown[];
    }>;
  }

  async getEmailUsage(agentId: string): Promise<EmailUsageResult> {
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/usage`,
      {},
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async getEmailWebhook(agentId: string): Promise<{ webhook: EmailWebhookConfig | null }> {
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/webhook`,
      {},
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async setEmailWebhook(
    agentId: string,
    args: { url: string; payloadMode?: 'metadata' | 'inline_text'; enabled?: boolean },
  ): Promise<{ webhook: EmailWebhookConfig; signingSecret?: string }> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/webhook`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async rotateEmailWebhookSecret(
    agentId: string,
  ): Promise<{ webhook: EmailWebhookConfig; signingSecret: string }> {
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/webhook`,
      {
        method: 'PATCH',
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async updatePrimaryEmail(
    agentId: string,
    username: string,
    options: EmailAddressMutationOptions = {},
  ): Promise<PrimaryEmailUpdateResult> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email`,
      {
        method: 'PATCH',
        headers: emailAddressHeaders(options),
        body: JSON.stringify({ username, confirmReplace: true }),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return emailAddressResult(res, primaryEmailUpdatedSchema, 'primary-rename', options);
  }

  async createEmailAlias(
    agentId: string,
    username: string,
    options: EmailAddressMutationOptions = {},
  ): Promise<EmailAliasCreateResult> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/aliases`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'POST',
        headers: emailAddressHeaders(options),
        body: JSON.stringify({ username }),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return emailAddressResult(res, emailAliasCreatedSchema, 'alias-create', options);
  }

  async deleteEmailAlias(
    agentId: string,
    emailAddress: string,
    options: EmailAddressMutationOptions = {},
  ): Promise<EmailAliasDeleteResult> {
    const params = new URLSearchParams({ emailAddress });
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/aliases?${params}`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'DELETE',
        headers: emailAddressHeaders(options),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return emailAddressResult(res, emailAliasDeletedSchema, 'alias-delete', options);
  }

  async listEmail(
    agentId: string,
    args: { limit?: number; unreadOnly?: boolean; sync?: boolean } = {},
  ): Promise<EmailListResult> {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    if (args.unreadOnly) params.set('unreadOnly', 'true');
    if (args.sync !== undefined) params.set('sync', String(args.sync));
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email?${params.toString()}`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(url, {});
    if (!res.ok) throw new Error(await responseError(res));
    const result: EmailListResult = await res.json();
    if (result.addressChange !== undefined && result.addressChange !== null)
      result.addressChange = emailAddressChangeStatusSchema.parse(result.addressChange);
    if (result.mailStatus !== undefined)
      result.mailStatus = emailServiceStatusSchema.parse(result.mailStatus);
    return result;
  }

  async deleteEmailMessage(
    agentId: string,
    messageId: string,
  ): Promise<{ deleted: true; messageId: string }> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/email/${encodeApiPathSegment(messageId)}`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'DELETE',
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async listDnsRecords(agentId: string): Promise<DnsRecord[]> {
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns`,
      {},
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async getDnsCapabilities(agentId: string): Promise<DnsCapabilities> {
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/capabilities`,
      {},
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async createDnsRecord(agentId: string, record: DnsRecordInput): Promise<DnsRecord> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async updateDnsRecord(
    agentId: string,
    recordId: string,
    record: Partial<DnsRecordInput>,
  ): Promise<DnsRecord> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/${encodeApiPathSegment(recordId)}`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async deleteDnsRecord(agentId: string, recordId: string): Promise<{ success: boolean }> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/${encodeApiPathSegment(recordId)}`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {
        method: 'DELETE',
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async previewDnsBatch(
    agentId: string,
    records: DnsRecordInput[],
    mode: DnsBulkMode = 'merge',
  ): Promise<DnsChangePreview> {
    return this.sendDnsBatch(agentId, { records, mode, dryRun: true });
  }

  async applyDnsBatch(
    agentId: string,
    records: DnsRecordInput[],
    baseRevision: string,
    mode: DnsBulkMode = 'merge',
  ): Promise<DnsChangePreview> {
    assertDnsRevision(baseRevision);
    return this.sendDnsBatch(agentId, { records, mode, dryRun: false, baseRevision });
  }

  async previewDnsImport(
    agentId: string,
    zoneFile: string,
    mode: DnsBulkMode = 'merge',
  ): Promise<DnsChangePreview> {
    return this.sendDnsImport(agentId, { zoneFile, mode, dryRun: true });
  }

  async applyDnsImport(
    agentId: string,
    zoneFile: string,
    baseRevision: string,
    mode: DnsBulkMode = 'merge',
  ): Promise<DnsChangePreview> {
    assertDnsRevision(baseRevision);
    return this.sendDnsImport(agentId, { zoneFile, mode, dryRun: false, baseRevision });
  }

  async exportDnsZone(agentId: string, scope: 'user' | 'all' = 'user'): Promise<string> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/export?scope=${encodeURIComponent(scope)}`, // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      {},
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.text();
  }

  private async sendDnsBatch(
    agentId: string,
    payload: {
      records: DnsRecordInput[];
      mode: DnsBulkMode;
      dryRun: boolean;
      baseRevision?: string;
    },
  ): Promise<DnsChangePreview> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  private async sendDnsImport(
    agentId: string,
    payload: { zoneFile: string; mode: DnsBulkMode; dryRun: boolean; baseRevision?: string },
  ): Promise<DnsChangePreview> {
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/dns/import`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async fundRenewalVault(agentId: string, amountUsdc: string): Promise<VaultFundResult> {
    const walletAddress = this.walletClient?.account?.address as Address | undefined;
    if (!this.walletClient || !walletAddress) {
      throw new Error(
        'Funding the renewal vault requires a walletClient so the SDK can sign a USDC authorization.',
      );
    }

    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/renewal/fund`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    let res = await this.signedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsdc }),
    });

    if (res.status === 402) {
      const challenge = (await res.json()) as {
        scheme: 'eip3009';
        chainId: number;
        asset: string;
        payTo: string;
        maxAmountRequired: string;
        maxTimeoutSeconds: number;
      };
      const authorization = await this.buildEip3009Authorization(challenge, walletAddress);
      // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
      // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
      res = await this.signedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: amountUsdc,
          signature: authorization.signature,
          authorization: authorization.authorization,
        }),
      });
    }

    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async getRenewalStatus(agentId: string): Promise<RenewalStatus> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/renewal/status`;
    const res = await this.signedFetch(url, {});
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async setAutoRenew(
    agentId: string,
    enabled: boolean,
    opts: { renewalVaultAddress?: Address; waitForReceipt?: boolean } = {},
  ): Promise<AutoRenewResult> {
    const walletAddress = this.walletClient?.account?.address as Address | undefined;
    if (!this.walletClient || !walletAddress) {
      throw new Error(
        'Auto-renew requires a walletClient for the AgentID NFT owner wallet. Any wallet can fund RenewalVault, but only the owner wallet can change auto-renew.',
      );
    }

    const renewalVaultAddress = opts.renewalVaultAddress ?? this.renewalVaultAddress;
    if (!renewalVaultAddress) {
      throw new Error(
        'renewalVaultAddress is required to enable auto-renew. Pass it to the AgentDomain constructor or setAutoRenew options.',
      );
    }

    const status = await this.getRenewalStatus(agentId);
    if (!status.tokenId) {
      throw new Error('Auto-renew cannot be changed before the AgentID NFT is minted.');
    }

    if (status.ownerAddress && !sameAddress(walletAddress, status.ownerAddress)) {
      throw new Error(
        `Auto-renew can only be changed by the AgentID NFT owner wallet (${status.ownerAddress}).`,
      );
    }

    if (status.autoRenewEnabled === enabled) {
      return {
        agentId,
        tokenId: status.tokenId,
        enabled,
        changed: false,
        txHash: null,
      };
    }

    if (opts.waitForReceipt && !this.publicClient) {
      throw new Error('waitForReceipt requires a publicClient in the AgentDomain constructor.');
    }

    const chain = this.network === 'base-sepolia' ? baseSepolia : base;
    const data = encodeSetAutoRenewCalldata(
      BigInt(status.tokenId),
      enabled,
      this.requireBuilderCode('Auto-renew'),
    );
    const txHash = (await this.walletClient.sendTransaction({
      to: renewalVaultAddress,
      data,
      account: this.walletClient.account,
      chain,
    })) as Hex;

    if (opts.waitForReceipt) {
      const receipt = await this.publicClient!.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error(`Auto-renew transaction ${txHash} reverted on Base.`);
      }
    }

    return {
      agentId,
      tokenId: status.tokenId,
      enabled,
      changed: true,
      txHash,
    };
  }

  async withdrawFromVault(agentId: string, amountUsdc: string): Promise<VaultWithdrawResult> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/renewal/withdraw`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsdc }),
    });
    if (!res.ok) throw new Error(await responseError(res));
    const transaction = (await res.json()) as VaultWithdrawResult;
    return {
      ...transaction,
      data: appendBuilderCodeAttribution(
        transaction.data,
        this.requireBuilderCode('RenewalVault withdrawal'),
      ),
    };
  }

  async reconfigureSsl(agentId: string): Promise<SslReconfigureResult> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/ssl`;
    const res = await this.signedFetch(url, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async getServicePlan(agentId: string): Promise<ServicePlanStatusResult> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/plan`;
    const res = await this.signedFetch(url, {});
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async purchaseServicePlan(args: {
    agentId: string;
    plan: Exclude<ServicePlanKey, 'included'>;
    planSku?: import('@agentdomain/shared').ServicePlanSku;
  }): Promise<ServicePlanPurchaseResult> {
    const walletAddress = this.walletClient?.account?.address as Address | undefined;
    if (!this.walletClient || !walletAddress) {
      throw new Error(
        'Premium Plan purchase requires a walletClient so the SDK can sign the USDC x402 payment.',
      );
    }

    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(args.agentId)}/plan`;
    const body = JSON.stringify({
      plan: args.plan,
      planSku: args.planSku,
    });

    let res = await this.signedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 402) {
      if (this.network !== 'base') {
        throw new Error('AgentDomain x402 payments are supported only on Base mainnet.');
      }
      const paymentHeaders = await createX402PaymentHeaders(res, this.walletClient);

      res = await this.signedFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...paymentHeaders,
        },
        body,
      });
    }

    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async setRegistryVisibility(
    agentId: string,
    registryHidden: boolean,
  ): Promise<RegistryVisibilityResult> {
    const url = `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/plan`;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registryHidden }),
    });
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async scheduleServicePlanRenewal(
    agentId: string,
    args: { plan: ServicePlanKey; planSku?: ServicePlanSku },
  ): Promise<ServicePlanRenewalResult> {
    const planSku = args.planSku ?? args.plan;
    // Trusted constructor API base; inputs are encoded path/query data, not destination URLs.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    const res = await this.signedFetch(
      `${this.apiUrl}/agents/${encodeApiPathSegment(agentId)}/plan`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renewalPlan: args.plan, renewalPlanSku: planSku }),
      },
    );
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async listApiKeys(agentId: string): Promise<ApiKeySummary[]> {
    const params = new URLSearchParams({ agentId });
    const res = await this.signedFetch(`${this.apiUrl}/keys?${params.toString()}`, {
      authOptions: { useApiKey: false },
    });
    if (!res.ok) throw new Error(await responseError(res));
    const data = (await res.json()) as { keys: ApiKeySummary[] };
    return data.keys;
  }

  async createApiKey(agentId: string, name: string): Promise<CreatedApiKey> {
    const res = await this.signedFetch(`${this.apiUrl}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      authOptions: { useApiKey: false },
      body: JSON.stringify({ agentId, name }),
    });
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  async revokeApiKey(keyId: string): Promise<{ revoked: boolean }> {
    const res = await this.signedFetch(`${this.apiUrl}/keys/${encodeApiPathSegment(keyId)}`, {
      method: 'DELETE',
      authOptions: { useApiKey: false },
    });
    if (!res.ok) throw new Error(await responseError(res));
    return res.json();
  }

  /** Authenticate one request; a wallet signature covers this exact method, URL and body. */
  private async signedFetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      authOptions?: { useApiKey?: boolean };
    },
  ): Promise<Response> {
    const { authOptions, ...request } = init;
    const method = request.method ?? 'GET';
    const headers = await this.authHeaders(
      { method, url, body: request.body },
      request.headers,
      authOptions,
    );
    // Callers pass only the trusted constructor API base plus encoded path/query data.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    return fetch(url, { ...request, method, headers });
  }

  private async authHeaders(
    request: AgentSignatureRequest,
    extra?: Record<string, string>,
    opts: { useApiKey?: boolean } = {},
  ): Promise<Record<string, string>> {
    const headers = { ...(extra ?? {}) };
    if ((opts.useApiKey ?? true) && this.apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      return headers;
    }

    const walletClient = this.walletClient;
    const account = walletClient?.account;
    if (!headers['X-Agent-Signature'] && walletClient && account) {
      try {
        headers['X-Agent-Signature'] = await createAgentSignatureHeader(
          {
            address: account.address,
            signMessage: (message) => walletClient.signMessage({ account, message }),
          },
          request,
        );
      } catch {
        // Some browser wallet clients may not expose signMessage here. The
        // request can still proceed and let the API return the auth challenge.
      }
    }
    return headers;
  }
}

export function createOpenAITools(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'check_domain_availability',
        description: 'Check if a domain name is available for registration',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Domain name to check' },
            tld: { type: 'string', description: 'TLD (e.g. xyz, com, ai)', default: 'xyz' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'quote_registration',
        description:
          'Get pricing quote for registering an AI agent identity. Domain, DNS, email, SSL certification, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional.',
        parameters: {
          type: 'object',
          properties: {
            preferredName: { type: 'string', description: 'Preferred domain name' },
            tld: { type: 'string', description: 'TLD', default: 'xyz' },
            registerBasename: {
              type: 'boolean',
              description: 'Also register Basename. Set false to skip Basename cost.',
              default: true,
            },
            basenameLabel: {
              type: 'string',
              description: 'Optional alternate Basename label. Omit to use preferredName.',
            },
            registerEns: {
              type: 'boolean',
              description: 'Also register ENS name. Set false to skip ENS cost.',
              default: false,
            },
            ensLabel: {
              type: 'string',
              description: 'Optional alternate ENS label. Omit to use preferredName.',
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
              enum: ['included', 'starter', 'pro', 'enterprise'],
              description: 'Premium Plan to buy with registration. Defaults to included.',
              default: 'included',
            },
            years: { type: 'number', description: 'Registration years', default: 1 },
          },
          required: ['preferredName'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'register_agent_identity',
        description:
          'Register a new AI agent identity. Domain, DNS, email, SSL certification, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional.',
        parameters: {
          type: 'object',
          properties: {
            preferredName: { type: 'string', description: 'Domain name' },
            tld: { type: 'string', description: 'TLD', default: 'xyz' },
            registerBasename: {
              type: 'boolean',
              description: 'Register Basename. Set false to skip Basename cost.',
              default: true,
            },
            basenameLabel: {
              type: 'string',
              description: 'Optional alternate Basename label. Omit to use preferredName.',
            },
            registerEns: {
              type: 'boolean',
              description: 'Register ENS. Set false to skip ENS cost.',
              default: false,
            },
            ensLabel: {
              type: 'string',
              description: 'Optional alternate ENS label. Omit to use preferredName.',
            },
            ownerAddress: {
              type: 'string',
              description:
                'Optional EVM address that receives the AgentID NFT. Omit to use the paying wallet.',
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
            dnsTarget: {
              type: 'string',
              description: 'Optional initial endpoint URL or IP to point the domain at.',
            },
            premiumPlan: {
              type: 'string',
              enum: ['included', 'starter', 'pro', 'enterprise'],
              description: 'Premium Plan to buy with registration. Defaults to included.',
              default: 'included',
            },
            years: { type: 'number', description: 'Registration years', default: 1 },
          },
          required: ['preferredName'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'search_agents',
        description: 'Search for registered AI agents',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query' },
            framework: { type: 'string', description: 'Filter by framework' },
            limit: { type: 'number', description: 'Max results', default: 20 },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'send_agent_email',
        description: 'Send text-only email from an agent primary email or active alias',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject' },
            text: { type: 'string', description: 'Plain-text email body' },
            fromAddress: {
              type: 'string',
              description: 'Optional primary email or active alias to send from',
            },
          },
          required: ['agentId', 'to', 'subject', 'text'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'list_agent_email',
        description: 'List an agent email messages and active primary/alias addresses',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            limit: { type: 'number', description: 'Max messages', default: 20 },
          },
          required: ['agentId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'delete_agent_email',
        description: 'Permanently delete one email message from an agent inbox',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            messageId: { type: 'string', description: 'Email message ID (UUID)' },
          },
          required: ['agentId', 'messageId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'update_primary_email',
        description:
          'Change one agent primary email username. The old primary address stops receiving new mail.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            username: { type: 'string', description: 'New local-part, e.g. agent or support' },
          },
          required: ['agentId', 'username'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'create_email_alias',
        description:
          'Create an extra receive-and-send email alias. Requires available paid-plan alias capacity.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            username: { type: 'string', description: 'Alias local-part, e.g. billing' },
          },
          required: ['agentId', 'username'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'delete_email_alias',
        description: 'Delete one active email alias from an agent',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            emailAddress: { type: 'string', description: 'Full alias address to delete' },
          },
          required: ['agentId', 'emailAddress'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'get_renewal_status',
        description:
          'Get renewal vault status for an agent, including exact next renewal amount, purchase snapshot, vault balance, shortfall, renewal date, and auto-renew state',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          },
          required: ['agentId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'fund_renewal_vault',
        description:
          'Deposit USDC from the connected wallet into one AgentID renewal vault. Anyone can fund; only the owner can withdraw or enable auto-renew. Call get_renewal_status first and normally use its shortfallUsdc value.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            amountUsdc: {
              type: 'string',
              description: 'USDC amount to deposit, with up to 6 decimals.',
            },
          },
          required: ['agentId', 'amountUsdc'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'enable_auto_renew',
        description:
          'Enable RenewalVault auto-renew for an agent. Requires the walletClient to be the AgentID NFT owner wallet.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          },
          required: ['agentId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'reconfigure_ssl',
        description:
          'Rebuild the managed SSL hostname and sync the required DNS validation records for an existing agent. Use this if SSL is pending, failed, or needs a refresh.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          },
          required: ['agentId'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'set_registry_visibility',
        description:
          'Hide or show an agent in the public AgentDomain registry. Hiding requires an active paid Premium Plan.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            registryHidden: {
              type: 'boolean',
              description:
                'true hides the agent from public registry/search; false makes it public',
            },
          },
          required: ['agentId', 'registryHidden'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'schedule_service_plan_renewal',
        description: 'Choose the exact Premium Plan SKU for the next identity renewal',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
            plan: {
              type: 'string',
              enum: ['included', 'starter', 'pro', 'enterprise'],
            },
            planSku: {
              type: 'string',
              description: 'Exact SKU, including Enterprise email volume tier',
            },
          },
          required: ['agentId', 'plan', 'planSku'],
        },
      },
    },
  ];
}

export function createAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return [
    {
      name: 'check_domain_availability',
      description: 'Check if a domain name is available for registration',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Domain name to check' },
          tld: { type: 'string', description: 'TLD (e.g. xyz, com, ai)', default: 'xyz' },
        },
        required: ['name'],
      },
    },
    {
      name: 'quote_registration',
      description:
        'Get pricing quote for registering an AI agent identity. Domain, DNS, email, SSL certification, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional.',
      input_schema: {
        type: 'object',
        properties: {
          preferredName: { type: 'string', description: 'Preferred domain name' },
          tld: { type: 'string', description: 'TLD', default: 'xyz' },
          registerBasename: {
            type: 'boolean',
            description: 'Also register Basename. Set false to skip Basename cost.',
            default: true,
          },
          basenameLabel: {
            type: 'string',
            description: 'Optional alternate Basename label. Omit to use preferredName.',
          },
          registerEns: {
            type: 'boolean',
            description: 'Also register ENS name. Set false to skip ENS cost.',
            default: false,
          },
          ensLabel: {
            type: 'string',
            description: 'Optional alternate ENS label. Omit to use preferredName.',
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
            enum: ['included', 'starter', 'pro', 'enterprise'],
            description: 'Premium Plan to buy with registration. Defaults to included.',
            default: 'included',
          },
          years: { type: 'number', description: 'Registration years', default: 1 },
        },
        required: ['preferredName'],
      },
    },
    {
      name: 'register_agent_identity',
      description:
        'Register a new AI agent identity. Domain, DNS, email, SSL certification, AgentID NFT orchestration, and platform fee are included by default. Basename and ENS are optional.',
      input_schema: {
        type: 'object',
        properties: {
          preferredName: { type: 'string', description: 'Domain name' },
          tld: { type: 'string', description: 'TLD', default: 'xyz' },
          registerBasename: {
            type: 'boolean',
            description: 'Register Basename. Set false to skip Basename cost.',
            default: true,
          },
          basenameLabel: {
            type: 'string',
            description: 'Optional alternate Basename label. Omit to use preferredName.',
          },
          registerEns: {
            type: 'boolean',
            description: 'Register ENS. Set false to skip ENS cost.',
            default: false,
          },
          ensLabel: {
            type: 'string',
            description: 'Optional alternate ENS label. Omit to use preferredName.',
          },
          ownerAddress: {
            type: 'string',
            description:
              'Optional EVM address that receives the AgentID NFT. Omit to use the paying wallet.',
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
          dnsTarget: {
            type: 'string',
            description: 'Optional initial endpoint URL or IP to point the domain at.',
          },
          premiumPlan: {
            type: 'string',
            enum: ['included', 'starter', 'pro', 'enterprise'],
            description: 'Premium Plan to buy with registration. Defaults to included.',
            default: 'included',
          },
          years: { type: 'number', description: 'Registration years', default: 1 },
        },
        required: ['preferredName'],
      },
    },
    {
      name: 'search_agents',
      description: 'Search for registered AI agents',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query' },
          framework: { type: 'string', description: 'Filter by framework' },
          limit: { type: 'number', description: 'Max results', default: 20 },
        },
      },
    },
    {
      name: 'send_agent_email',
      description: 'Send text-only email from an agent primary email or active alias',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          text: { type: 'string', description: 'Plain-text email body' },
          fromAddress: {
            type: 'string',
            description: 'Optional primary email or active alias to send from',
          },
        },
        required: ['agentId', 'to', 'subject', 'text'],
      },
    },
    {
      name: 'list_agent_email',
      description: 'List an agent email messages and active primary/alias addresses',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          limit: { type: 'number', description: 'Max messages', default: 20 },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'delete_agent_email',
      description: 'Permanently delete one email message from an agent inbox',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          messageId: { type: 'string', description: 'Email message ID (UUID)' },
        },
        required: ['agentId', 'messageId'],
      },
    },
    {
      name: 'update_primary_email',
      description:
        'Change one agent primary email username. The old primary address stops receiving new mail.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          username: { type: 'string', description: 'New local-part, e.g. agent or support' },
        },
        required: ['agentId', 'username'],
      },
    },
    {
      name: 'create_email_alias',
      description:
        'Create an extra receive-and-send email alias. Requires available paid-plan alias capacity.',
      input_schema: {
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
      description: 'Delete one active email alias from an agent',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          emailAddress: { type: 'string', description: 'Full alias address to delete' },
        },
        required: ['agentId', 'emailAddress'],
      },
    },
    {
      name: 'get_renewal_status',
      description:
        'Get renewal vault status for an agent, including exact next renewal amount, purchase snapshot, vault balance, shortfall, renewal date, and auto-renew state',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'fund_renewal_vault',
      description:
        'Deposit USDC from the connected wallet into one AgentID renewal vault. Anyone can fund; only the owner can withdraw or enable auto-renew. Call get_renewal_status first and normally use its shortfallUsdc value.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          amountUsdc: {
            type: 'string',
            description: 'USDC amount to deposit, with up to 6 decimals.',
          },
        },
        required: ['agentId', 'amountUsdc'],
      },
    },
    {
      name: 'enable_auto_renew',
      description:
        'Enable RenewalVault auto-renew for an agent. Requires the walletClient to be the AgentID NFT owner wallet.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'reconfigure_ssl',
      description:
        'Rebuild the managed SSL hostname and sync the required DNS validation records for an existing agent. Use this if SSL is pending, failed, or needs a refresh.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'set_registry_visibility',
      description:
        'Hide or show an agent in the public AgentDomain registry. Hiding requires an active paid Premium Plan.',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
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
      description: 'Choose the exact Premium Plan SKU for the next identity renewal',
      input_schema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'AgentDomain agent ID (UUID)' },
          plan: {
            type: 'string',
            enum: ['included', 'starter', 'pro', 'enterprise'],
          },
          planSku: {
            type: 'string',
            description: 'Exact SKU, including Enterprise email volume tier',
          },
        },
        required: ['agentId', 'plan', 'planSku'],
      },
    },
  ];
}

export async function runAgentDomainTool(
  ad: AgentDomain,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'check_domain_availability':
      return ad.checkAvailability(args.name as string, { tld: (args.tld as string) ?? 'xyz' });
    case 'quote_registration':
      return ad.quote({
        preferredName: args.preferredName as string,
        tld: (args.tld as string) ?? 'xyz',
        registerBasename: (args.registerBasename as boolean) ?? true,
        basenameLabel: args.basenameLabel as string | undefined,
        registerEns: (args.registerEns as boolean) ?? false,
        ensLabel: args.ensLabel as string | undefined,
        emailEnabled: true,
        emailUsername: args.emailUsername as string | undefined,
        premiumPlan: args.premiumPlan as ServicePlanKey | undefined,
        years: (args.years as number) ?? 1,
      });
    case 'register_agent_identity':
      return ad.register({
        preferredName: args.preferredName as string,
        tld: ((args.tld as string | undefined) ?? 'xyz') as RegistrationParams['tld'],
        registerBasename: (args.registerBasename as boolean) ?? true,
        basenameLabel: args.basenameLabel as string | undefined,
        registerEns: (args.registerEns as boolean) ?? false,
        ensLabel: args.ensLabel as string | undefined,
        emailEnabled: true,
        emailUsername: args.emailUsername as string | undefined,
        premiumPlan: args.premiumPlan as ServicePlanKey | undefined,
        years: (args.years as number) ?? 1,
        autoRenew: (args.autoRenew as boolean) ?? false,
        dnsTarget: args.dnsTarget as string | undefined,
        ownerAddress: args.ownerAddress as Address | undefined,
        wallet: args.wallet as Address | undefined,
      });
    case 'search_agents':
      return ad.search({
        q: args.q as string,
        framework: args.framework as string,
        capability: args.capability as string,
        limit: (args.limit as number) ?? 20,
      });
    case 'send_agent_email':
      return ad.sendEmail(args.agentId as string, {
        to: args.to as string | string[],
        fromAddress: args.fromAddress as string | undefined,
        subject: args.subject as string,
        text: args.text as string,
        replyTo: args.replyTo as string | undefined,
      });
    case 'list_agent_email':
      return ad.listEmail(args.agentId as string, { limit: (args.limit as number) ?? 20 });
    case 'delete_agent_email':
      return ad.deleteEmailMessage(args.agentId as string, args.messageId as string);
    case 'update_primary_email':
      return ad.updatePrimaryEmail(args.agentId as string, args.username as string);
    case 'create_email_alias':
      return ad.createEmailAlias(args.agentId as string, args.username as string);
    case 'delete_email_alias':
      return ad.deleteEmailAlias(args.agentId as string, args.emailAddress as string);
    case 'list_dns_records':
      return ad.listDnsRecords(args.agentId as string);
    case 'create_dns_record':
      return ad.createDnsRecord(args.agentId as string, readDnsRecordArgs(args) as DnsRecordInput);
    case 'update_dns_record':
      return ad.updateDnsRecord(
        args.agentId as string,
        args.recordId as string,
        readDnsRecordArgs(args),
      );
    case 'delete_dns_record':
      return ad.deleteDnsRecord(args.agentId as string, args.recordId as string);
    case 'get_renewal_status':
      return ad.getRenewalStatus(args.agentId as string);
    case 'fund_renewal_vault':
      return ad.fundRenewalVault(args.agentId as string, args.amountUsdc as string);
    case 'withdraw_renewal_vault':
      return ad.withdrawFromVault(args.agentId as string, args.amountUsdc as string);
    case 'enable_auto_renew':
      return ad.setAutoRenew(args.agentId as string, true);
    case 'reconfigure_ssl':
      return ad.reconfigureSsl(args.agentId as string);
    case 'get_service_plan':
      return ad.getServicePlan(args.agentId as string);
    case 'purchase_service_plan':
      return ad.purchaseServicePlan({
        agentId: args.agentId as string,
        plan: args.plan as Exclude<ServicePlanKey, 'included'>,
      });
    case 'set_registry_visibility':
      return ad.setRegistryVisibility(
        args.agentId as string,
        Boolean(args.registryHidden ?? args.hidden),
      );
    case 'schedule_service_plan_renewal':
      return ad.scheduleServicePlanRenewal(args.agentId as string, {
        plan: args.plan as ServicePlanKey,
        planSku: args.planSku as ServicePlanSku,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function readDnsRecordArgs(args: Record<string, unknown>): Partial<DnsRecordInput> {
  const record =
    args.record && typeof args.record === 'object'
      ? (args.record as Record<string, unknown>)
      : args;
  return {
    type: record.type as DnsRecord['type'] | undefined,
    name: record.name as string | undefined,
    value: record.value as string | undefined,
    data: record.data as DnsRecordData | undefined,
    ttl: record.ttl as number | undefined,
    priority: record.priority as number | null | undefined,
  };
}

function assertDnsRevision(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(
      'DNS apply requires the 64-character baseRevision returned by a fresh preview.',
    );
  }
}

export function formatAgentDomainToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: string;
      code?: string;
      details?: unknown;
    };
    const detail = body.message ?? body.error;
    const code = body.code ?? body.error;
    const retryAfter =
      body.details && typeof body.details === 'object'
        ? (body.details as { retryAfterSeconds?: number }).retryAfterSeconds
        : undefined;
    const detailsMessage = detailsToMessage(body.details);
    const parts = [`HTTP ${res.status}`];
    if (code) parts.push(`[${code}]`);
    if (detail) parts.push(`: ${detail}`);
    if (detailsMessage && detailsMessage !== detail) parts.push(`: ${detailsMessage}`);
    if (retryAfter) parts.push(`(retry after ${retryAfter}s)`);
    return parts.join('');
  } catch {
    return `HTTP ${res.status}`;
  }
}

function detailsToMessage(details: unknown): string | null {
  if (!details) return null;
  if (typeof details === 'string') return details;
  if (typeof details !== 'object') return String(details);
  const record = details as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  try {
    return JSON.stringify(details);
  } catch {
    return null;
  }
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a as Address) === getAddress(b as Address);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}
