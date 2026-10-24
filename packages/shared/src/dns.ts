import { z } from 'zod';

export const DNS_RECORD_TYPES = [
  'A',
  'AAAA',
  'ALIAS',
  'CAA',
  'CNAME',
  'HTTPS',
  'MX',
  'NS',
  'PTR',
  'SRV',
  'SVCB',
  'TLSA',
  'TXT',
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsServiceParam {
  key: string;
  value?: string;
}

export type DnsRecordData =
  | { address: string }
  | { target: string }
  | { flag: 0 | 128; tag: 'issue' | 'issuewild' | 'iodef'; value: string }
  | { priority: number; target: string; params: DnsServiceParam[] }
  | { priority: number; exchange: string }
  | { nameserver: string }
  | { pointer: string }
  | { priority: number; weight: number; port: number; target: string }
  | {
      usage: number;
      selector: number;
      matchingType: number;
      associationData: string;
    }
  | { text: string };

export interface DnsRecordInput {
  type: DnsRecordType;
  name: string;
  value?: string;
  data?: DnsRecordData;
  ttl?: number;
  priority?: number | null;
}

export interface DnsRecord extends DnsRecordInput {
  id: string;
  value: string;
  ttl: number;
  priority?: number | null;
  systemManaged?: boolean;
  purpose?: string | null;
}

export interface DnsCapabilities {
  provider: 'spaceship';
  supportedTypes: readonly DnsRecordType[];
  recordTypes: Record<DnsRecordType, DnsRecordTypeCapability>;
  ttl: { min: number; max: number; default: number };
  limits: {
    maxBatchRecords: number;
    maxImportBytes: number;
    maxJsonBytes: number;
  };
  warnings: Partial<Record<DnsRecordType, string>>;
}

export interface DnsCapabilityField {
  key: string;
  type: 'hostname' | 'ipv4' | 'ipv6' | 'integer' | 'select' | 'string' | 'hex' | 'serviceParams';
  required: boolean;
  min?: number;
  max?: number;
  options?: readonly (string | number)[];
}

export interface DnsRecordTypeCapability {
  fields: readonly DnsCapabilityField[];
  owner: {
    apex: boolean;
    wildcard: boolean;
    underscoreLabels: boolean;
  };
  constraints?: readonly string[];
}

const targetField = [{ key: 'target', type: 'hostname', required: true }] as const;
const serviceFields = [
  { key: 'priority', type: 'integer', required: true, min: 0, max: 65_535 },
  { key: 'target', type: 'hostname', required: true },
  { key: 'params', type: 'serviceParams', required: false },
] as const;

export const DNS_RECORD_CAPABILITIES: Record<DnsRecordType, DnsRecordTypeCapability> = {
  A: {
    fields: [{ key: 'address', type: 'ipv4', required: true }],
    owner: { apex: true, wildcard: true, underscoreLabels: false },
  },
  AAAA: {
    fields: [{ key: 'address', type: 'ipv6', required: true }],
    owner: { apex: true, wildcard: true, underscoreLabels: false },
  },
  ALIAS: {
    fields: targetField,
    owner: { apex: true, wildcard: false, underscoreLabels: false },
    constraints: ['Preferred instead of CNAME at the zone apex.'],
  },
  CAA: {
    fields: [
      { key: 'flag', type: 'select', required: true, options: [0, 128] },
      {
        key: 'tag',
        type: 'select',
        required: true,
        options: ['issue', 'issuewild', 'iodef'],
      },
      { key: 'value', type: 'string', required: true, min: 1, max: 256 },
    ],
    owner: { apex: true, wildcard: false, underscoreLabels: false },
  },
  CNAME: {
    fields: targetField,
    owner: { apex: false, wildcard: true, underscoreLabels: true },
    constraints: ['Cannot coexist with other record types at the same owner.'],
  },
  HTTPS: {
    fields: serviceFields,
    owner: { apex: true, wildcard: true, underscoreLabels: true },
    constraints: ['Priority 0 AliasMode records cannot include service parameters.'],
  },
  MX: {
    fields: [
      { key: 'priority', type: 'integer', required: true, min: 0, max: 65_535 },
      { key: 'exchange', type: 'hostname', required: true },
    ],
    owner: { apex: true, wildcard: false, underscoreLabels: false },
  },
  NS: {
    fields: [{ key: 'nameserver', type: 'hostname', required: true }],
    owner: { apex: false, wildcard: false, underscoreLabels: false },
    constraints: ['Apex nameserver delegation is managed through the registrar workflow.'],
  },
  PTR: {
    fields: [{ key: 'pointer', type: 'hostname', required: true }],
    owner: { apex: true, wildcard: false, underscoreLabels: false },
    constraints: ['Effective only when the zone is authoritative for the reverse namespace.'],
  },
  SRV: {
    fields: [
      { key: 'priority', type: 'integer', required: true, min: 0, max: 65_535 },
      { key: 'weight', type: 'integer', required: true, min: 0, max: 65_535 },
      { key: 'port', type: 'integer', required: true, min: 1, max: 65_535 },
      { key: 'target', type: 'hostname', required: true },
    ],
    owner: { apex: false, wildcard: false, underscoreLabels: true },
  },
  SVCB: {
    fields: serviceFields,
    owner: { apex: true, wildcard: true, underscoreLabels: true },
    constraints: ['Priority 0 AliasMode records cannot include service parameters.'],
  },
  TLSA: {
    fields: [
      { key: 'usage', type: 'select', required: true, options: [0, 1, 2, 3] },
      { key: 'selector', type: 'select', required: true, options: [0, 1] },
      {
        key: 'matchingType',
        type: 'select',
        required: true,
        options: [0, 1, 2],
      },
      { key: 'associationData', type: 'hex', required: true },
    ],
    owner: { apex: false, wildcard: false, underscoreLabels: true },
    constraints: ['DANE assurance requires DNSSEC validation.'],
  },
  TXT: {
    fields: [{ key: 'text', type: 'string', required: true, min: 1, max: 65_535 }],
    owner: { apex: true, wildcard: true, underscoreLabels: true },
  },
};

export type DnsBulkMode = 'merge' | 'replace';

export interface DnsChangePreview {
  dryRun: boolean;
  mode: DnsBulkMode;
  baseRevision: string;
  nextRevision: string;
  summary: {
    add: number;
    update: number;
    delete: number;
    unchanged: number;
    finalUserRecords: number;
  };
  changes: {
    add: DnsRecordInput[];
    update: Array<{ before: DnsRecord; after: DnsRecordInput }>;
    delete: DnsRecord[];
  };
  warnings: string[];
  records?: DnsRecord[];
}

export const dnsRecordTypeSchema = z.enum(DNS_RECORD_TYPES);

export const dnsRecordObjectSchema = z.object({
  type: dnsRecordTypeSchema,
  name: z.string().trim().min(1).max(253),
  value: z.string().min(1).max(65_535).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // No default: zod 4 would apply it inside optional() and reset TTL on partial updates;
  // the API applies its own default when a new record omits ttl.
  ttl: z.number().int().min(60).max(3600).optional(),
  priority: z.number().int().min(0).max(65_535).nullable().optional(),
});

export const dnsRecordSchema = dnsRecordObjectSchema.superRefine((record, ctx) => {
  if (record.value === undefined && record.data === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: 'Provide structured data or the legacy value field',
    });
  }
});

export const dnsBatchSchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  records: z.array(dnsRecordSchema).min(1).max(200),
  dryRun: z.boolean().default(true),
  baseRevision: z.string().length(64).optional(),
});

export const dnsImportSchema = z.object({
  zoneFile: z.string().min(1).max(262_144),
  mode: z.enum(['merge', 'replace']).default('merge'),
  dryRun: z.boolean().default(true),
  baseRevision: z.string().length(64).optional(),
});
