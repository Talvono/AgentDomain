import { z } from 'zod';
import { ENTERPRISE_EMAIL_TIERS, SERVICE_PLAN_KEYS } from './constants.js';
import type { Address, Hex } from 'viem';
import type { ServicePlanSku } from './types.js';
import { isServicePlanSkuForPlan } from './utils.js';
export { dnsBatchSchema, dnsImportSchema, dnsRecordSchema, dnsRecordTypeSchema } from './dns.js';

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalMetadataString = (maxLength: number) =>
  z.preprocess(emptyStringToUndefined, z.string().trim().max(maxLength).optional());

const optionalMetadataUrl = (maxLength: number) =>
  z.preprocess(emptyStringToUndefined, z.string().trim().url().max(maxLength).optional());

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((v) => v as Address);

export const registrationResultSchema = z.object({
  registrationId: z.string().optional(),
  agentId: z.string().min(1),
  nftTokenId: z.number().int().nonnegative(),
  domain: z.string().min(1),
  basename: z.string().nullable(),
  ensName: z.string().nullable(),
  txHash: z
    .string()
    .regex(/^0x[0-9a-f]*$/i)
    .transform((value) => value as Hex),
  sslStatus: z.string(),
  estimatedReadyAt: z.string(),
  metadataUri: z.string(),
  provisioningStatus: z.enum(['completed', 'processing', 'recovery_required']).optional(),
  provisioningMessage: z.string().optional(),
  renewalSnapshot: z
    .object({
      version: z.literal(1),
      capturedAt: z.string(),
      years: z.number(),
      currency: z.literal('USDC'),
      autoRenewTotalUsdc: z.string(),
      autoRenewTotalAtomic: z.string(),
      fullServiceTotalUsdc: z.string().nullable(),
      fullServiceTotalAtomic: z.string().nullable(),
      items: z.array(
        z.object({
          key: z.enum(['domain', 'platform', 'premium_plan', 'ssl', 'email', 'basename', 'ens']),
          label: z.string(),
          name: z.string().optional(),
          selected: z.boolean(),
          provisioned: z.boolean(),
          includedInAutoRenew: z.boolean(),
          amountUsdc: z.string().nullable(),
          amountAtomic: z.string().nullable(),
          source: z.enum(['spaceship', 'agentdomain', 'ses', 'basenames', 'ens']),
          note: z.string().optional(),
        }),
      ),
      warnings: z.array(z.string()),
    })
    .optional(),
});

const registrationProgressObjectSchema = z.object({
  registrationId: z.string().min(1),
  status: z.enum([
    'processing',
    'completed',
    'action_required',
    'failed',
    'refunded',
    'awaiting_payment',
  ]),
  statusUrl: z.string().min(1),
  domain: z.string().min(1),
  agentId: z.string().nullable(),
  paymentStatus: z.enum(['unknown', 'pending', 'settled', 'not_charged', 'refunded']),
  paymentReference: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .optional(),
  stage: z.enum([
    'payment',
    'domain',
    'dns',
    'ssl',
    'email',
    'basename',
    'ens',
    'mint',
    'finalizing',
    'complete',
  ]),
  messageCode: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  revision: z.number().int().nonnegative(),
  estimatedDurationSeconds: z.number().finite().nonnegative().nullable(),
  pollAfterSeconds: z.number().finite().positive(),
  completionEventId: z.string().nullable(),
  result: registrationResultSchema
    .extend({
      txHash: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/i)
        .transform((value) => value as Hex),
      sslStatus: z.enum(['active', 'external']),
    })
    .nullable()
    .optional(),
});

export const registrationProgressSchema = registrationProgressObjectSchema.refine(
  (value) => value.result == null || value.status === 'completed',
  { message: 'A result is only available for completed registrations', path: ['result'] },
);

export const registrationAcceptedSchema = registrationProgressObjectSchema.partial().extend({
  registrationId: z.string().min(1),
  status: z.literal('processing'),
  statusUrl: z.string().min(1),
  domain: z.string().min(1),
  paymentStatus: z.literal('settled'),
  pollAfterSeconds: z.number().finite().positive(),
  result: z.null().optional(),
});

export const registrationListResultSchema = z.object({
  items: z.array(registrationProgressSchema),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
});

/** Only authoritative on a paid-request 4xx response other than HTTP 408. */
export const registrationPaymentRejectionSchema = z
  .object({
    code: z.string().refine((value) => value.trim().length > 0, 'A rejection code is required'),
    message: z
      .string()
      .refine((value) => value.trim().length > 0, 'A rejection message is required'),
    error: z.string().optional(),
    paymentSubmission: z
      .object({ status: z.literal('rejected'), settlementAttempted: z.literal(false) })
      .strict(),
  })
  .strict()
  .refine((value) => value.error === undefined || value.error === value.code, {
    message: 'The error alias must exactly match the rejection code',
    path: ['error'],
  });

export const domainLabelSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens',
  );

export const emailUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/,
    'Use lowercase letters, numbers, dot, underscore, plus, or hyphen',
  )
  .refine((value) => !value.includes('..'), 'Email username cannot contain consecutive dots');

export const emailAddressChangeSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(['alias-create', 'alias-delete', 'primary-rename']),
    target: z.string().email().max(254),
    phase: z.enum([
      'pending',
      'fenced',
      'applying',
      'uncertain',
      'rejected',
      'native_applied',
      'projected',
      'completed',
      'cancelled',
    ]),
  })
  .strict();

export const emailAddressChangeResultSchema = z
  .object({
    change: emailAddressChangeSchema,
  })
  .strict();

export const emailAddressChangeStatusSchema = z.union([
  emailAddressChangeSchema,
  z.object({ phase: z.literal('unavailable') }).strict(),
]);

export const emailServiceStatusSchema = z.union([
  z.object({ state: z.literal('provider-managed') }).strict(),
  z.object({ state: z.literal('unchecked') }).strict(),
  z
    .object({
      state: z.enum(['ready', 'pending']),
      checkedAt: z.string().datetime(),
      reason: z.string().optional(),
    })
    .strict(),
]);

export const emailAddressSummarySchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  emailAddress: z.string().email(),
  kind: z.enum(['primary', 'alias']),
  status: z.enum(['active', 'deleted']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const primaryEmailUpdatedSchema = z.object({
  inbox: z.unknown(),
  addresses: z.array(emailAddressSummarySchema),
  message: z.string(),
});
export const emailAliasCreatedSchema = z.object({
  address: emailAddressSummarySchema,
  addresses: z.array(emailAddressSummarySchema),
});
export const emailAliasDeletedSchema = z.object({
  deleted: z.literal(true),
  addresses: z.array(emailAddressSummarySchema),
});

export type EmailAddressChange = z.infer<typeof emailAddressChangeSchema>;
export type EmailAddressChangeResult = z.infer<typeof emailAddressChangeResultSchema>;
export type EmailAddressChangeStatus = z.infer<typeof emailAddressChangeStatusSchema>;
export type EmailServiceStatus = z.infer<typeof emailServiceStatusSchema>;
export type PrimaryEmailUpdateResult =
  z.infer<typeof primaryEmailUpdatedSchema> | EmailAddressChangeResult;
export type EmailAliasCreateResult =
  z.infer<typeof emailAliasCreatedSchema> | EmailAddressChangeResult;
export type EmailAliasDeleteResult =
  z.infer<typeof emailAliasDeletedSchema> | EmailAddressChangeResult;

export const tldSchema = z.enum(['xyz', 'com', 'ai', 'org', 'io', 'net', 'co', 'app']);

export const registrationParamsSchema = z
  .object({
    preferredName: domainLabelSchema,
    tld: tldSchema,
    registerBasename: z.boolean().default(true),
    basenameLabel: domainLabelSchema.optional(),
    registerEns: z.boolean().default(false),
    ensLabel: domainLabelSchema.optional(),
    ownerAddress: addressSchema.optional(),
    emailEnabled: z.boolean().default(true),
    emailUsername: emailUsernameSchema.default('agent'),
    premiumPlan: z.enum(SERVICE_PLAN_KEYS).default('included'),
    premiumPlanSku: z
      .union([
        z.enum(['included', 'starter', 'pro']),
        z
          .string()
          .refine(
            (value) =>
              value.startsWith('enterprise-') &&
              ENTERPRISE_EMAIL_TIERS.includes(Number(value.slice(11)) as never),
          )
          .transform((value) => value as ServicePlanSku),
      ])
      .optional(),
    years: z.number().int().min(1).max(10).default(1),
    autoRenew: z.boolean().default(false),
    dnsTarget: z.string().optional(),
    metadata: z
      .object({
        name: optionalMetadataString(120),
        description: optionalMetadataString(1000),
        imageUri: optionalMetadataUrl(2048),
        framework: optionalMetadataString(80),
        capabilities: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
        x402Endpoint: optionalMetadataUrl(2048),
        socials: z.record(z.string(), z.string().trim().max(2048)).optional(),
      })
      .optional(),
    wallet: addressSchema,
    turnstileToken: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!isServicePlanSkuForPlan(value.premiumPlan, value.premiumPlanSku))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['premiumPlanSku'],
        message: 'premiumPlanSku must match premiumPlan',
      });
  });

export const searchQuerySchema = z.object({
  q: z.string().optional(),
  framework: z.string().optional(),
  capability: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
