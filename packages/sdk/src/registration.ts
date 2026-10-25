import {
  getAddress,
  type Account,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
} from 'viem';
import { z } from 'zod';
import {
  registrationAcceptedSchema,
  registrationListResultSchema,
  registrationPaymentRejectionSchema,
  registrationProgressSchema,
  registrationResultSchema,
  type RegistrationAccepted,
  type RegistrationListResult,
  type RegistrationProgress,
  type RegistrationResult,
} from '@agentdomain/shared';
import type { RegisterArgs } from './index.js';
import { createAgentSignatureHeader, type AgentSignatureRequest } from './agent-signature.js';

export type {
  RegistrationAccepted,
  RegistrationListResult,
  RegistrationProgress,
} from '@agentdomain/shared';

export interface RegistrationRequestOptions {
  signal?: AbortSignal;
  /** Expected authenticated payer, not a credential. Required for session-only clients. */
  expectedPayer?: Address;
  /** Request/submit deadline. Defaults to 60 seconds; never causes payment resubmission. */
  timeoutMs?: number;
}

export interface RegistrationWaitOptions extends RegistrationRequestOptions {
  /** Wait deadline, including status requests. Defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface RegistrationListOptions extends RegistrationRequestOptions {
  limit?: number;
  offset?: number;
}

/** Non-secret recovery coordinates, not payment proof or authorization. */
export interface RegistrationHandle {
  registrationId: string | null;
  statusUrl: string | null;
  domain: string;
  startedAt: string;
  endedAt: string;
  payerAddress?: Address;
  /** Optional server-supplied reference. Never used as authentication. */
  paymentIdentifier?: string;
}

export type RegistrationPendingReason =
  | 'timeout'
  | 'aborted'
  | 'transport_unknown'
  | 'status_unavailable'
  | 'invalid_response'
  | 'action_required'
  | 'awaiting_payment'
  | 'not_found'
  | 'ambiguous_recovery'
  | 'incomplete_recovery'
  | 'completion_result_unavailable';

export class RegistrationPendingError extends Error {
  readonly code = 'REGISTRATION_PENDING';

  constructor(
    readonly reason: RegistrationPendingReason,
    readonly handle: RegistrationHandle,
    readonly progress?: RegistrationProgress,
    options?: ErrorOptions,
  ) {
    super(
      `Registration outcome is pending or unknown (${reason}). Read registration status with the payer wallet; do not submit another payment.`,
      options,
    );
    this.name = 'RegistrationPendingError';
  }
}

export class RegistrationFailedError extends Error {
  readonly code = 'REGISTRATION_FAILED';

  constructor(readonly progress: RegistrationProgress) {
    super(`Registration ${progress.registrationId} is ${progress.status}: ${progress.messageCode}`);
    this.name = 'RegistrationFailedError';
  }
}

export class RegistrationPaymentRejectedError extends Error {
  readonly code = 'REGISTRATION_PAYMENT_REJECTED';
  readonly settlementAttempted = false;

  constructor(
    readonly serverCode: string,
    message: string,
    readonly handle: RegistrationHandle,
  ) {
    super(message);
    this.name = 'RegistrationPaymentRejectedError';
  }
}

class RegistrationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Registration request returned HTTP ${status}`);
  }
}

class RegistrationProtocolError extends Error {}
class RegistrationTransportError extends Error {}

const REQUEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 10 * 60_000;
/** A request signature must reach the API well inside its five-minute validity. */
const SIGNATURE_SIGNING_LIMIT_MS = 4 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const REGISTRATION_LIST_DEFAULT_LIMIT = 20;
const REGISTRATION_LIST_MAX_LIMIT = 50;
const RECOVERY_PAGE_SIZE = REGISTRATION_LIST_MAX_LIMIT;
const RECOVERY_MAX_PAGES = 10;

const actionRequiredHandleSchema = z.object({
  registrationId: z.string().min(1),
  status: z.literal('action_required'),
  statusUrl: z.string().min(1),
  domain: z.string().min(1).optional(),
});

interface RegistrationClientOptions {
  apiUrl: string;
  walletClient?: WalletClient<Transport, Chain, Account>;
  network: 'base' | 'base-sepolia';
  authentication?: 'signature' | 'session';
  expectedPayer?: Address;
  createPaymentHeaders: (
    response: Response,
    wallet: WalletClient<Transport, Chain, Account>,
  ) => Promise<Record<string, string>>;
}

export class RegistrationClient {
  constructor(private readonly options: RegistrationClientOptions) {}

  async submit(
    args: RegisterArgs,
    options: RegistrationRequestOptions = {},
  ): Promise<RegistrationAccepted | RegistrationResult> {
    const wallet = args.wallet ?? this.options.walletClient?.account?.address;
    if (!wallet)
      throw new Error('Registration requires args.wallet or a connected wallet account.');
    if (
      this.options.walletClient &&
      this.options.walletClient.account.address.toLowerCase() !== wallet.toLowerCase()
    ) {
      throw new Error('The connected wallet must be the registration payer.');
    }
    let handle: RegistrationHandle = {
      registrationId: null,
      statusUrl: null,
      domain: `${args.preferredName}.${args.tld ?? 'xyz'}`.toLowerCase(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      payerAddress: getAddress(wallet),
    };
    let unresolvedPost = false;
    let paymentSubmitted = false;
    const body = JSON.stringify({
      ...args,
      wallet,
      tld: args.tld ?? 'xyz',
      registerBasename: args.registerBasename ?? true,
      registerEns: args.registerEns ?? false,
      emailEnabled: true,
      emailUsername: args.emailUsername ?? 'agent',
      premiumPlan: args.premiumPlan ?? 'included',
      years: args.years ?? 1,
      autoRenew: args.autoRenew ?? false,
    });
    const scope = deadline(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const expectedPayer = this.expectedPayer(options.expectedPayer, wallet);
      const registerUrl = this.url('/agents/register');
      // Each POST carries its own single-use signature over this exact body.
      const sign = () =>
        this.signedHeaders(scope.signal, expectedPayer, {
          method: 'POST',
          url: registerUrl,
          body,
        });
      const send = (auth: Record<string, string>, paymentHeaders: Record<string, string> = {}) =>
        withinSignal(scope.signal, () => {
          unresolvedPost = true;
          return fetch(registerUrl, {
            method: 'POST',
            headers: {
              ...auth,
              'Content-Type': 'application/json',
              Prefer: 'respond-async',
              ...paymentHeaders,
            },
            body,
            credentials: this.credentials(),
            redirect: 'error',
            signal: scope.signal,
          });
        });
      let response = await send(await sign());
      if (response.status === 402) {
        unresolvedPost = false;
        if (!this.options.walletClient)
          throw new Error('Registration requires a walletClient to authorize x402 payment.');
        if (this.options.network !== 'base')
          throw new Error('AgentDomain x402 payments are supported only on Base mainnet.');
        const paymentHeaders = await withinSignal(scope.signal, () =>
          this.options.createPaymentHeaders(response, this.options.walletClient!),
        );
        const paidAuth = await sign();
        // Exactly one paid POST follows an explicit challenge. No transport retry is safe here.
        paymentSubmitted = true;
        response = await send(paidAuth, paymentHeaders);
      }
      const data: unknown = await withinSignal(scope.signal, () => response.json());
      handle = this.handleFromResponse(data, handle);
      if (
        paymentSubmitted &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      ) {
        const rejected = registrationPaymentRejectionSchema.safeParse(data);
        if (rejected.success) {
          unresolvedPost = false;
          throw new RegistrationPaymentRejectedError(
            rejected.data.code,
            rejected.data.message,
            handle,
          );
        }
      }
      if (
        response.status >= 500 ||
        response.status === 408 ||
        (!response.ok && (paymentSubmitted || handle.registrationId))
      ) {
        throw new RegistrationPendingError('transport_unknown', handle);
      }
      unresolvedPost = false;
      if (!response.ok) throw new RegistrationHttpError(response.status);
      if (paymentSubmitted && data && typeof data === 'object' && 'paymentSubmission' in data) {
        throw new RegistrationPendingError('invalid_response', handle);
      }
      if (response.status === 200) {
        const parsed = registrationResultSchema.safeParse(data);
        if (!parsed.success || parsed.data.domain.toLowerCase() !== handle.domain)
          throw new RegistrationPendingError('invalid_response', handle);
        return parsed.data;
      }
      const actionRequired = actionRequiredHandleSchema.safeParse(data);
      if (response.status === 202 && actionRequired.success) {
        try {
          this.assertStatusUrl(actionRequired.data);
          if (
            actionRequired.data.domain &&
            actionRequired.data.domain.toLowerCase() !== handle.domain
          ) {
            throw new RegistrationProtocolError('Registration domain mismatch.');
          }
        } catch (error) {
          throw new RegistrationPendingError('invalid_response', handle, undefined, {
            cause: error,
          });
        }
        const progress = registrationProgressSchema.safeParse(data);
        throw new RegistrationPendingError(
          'action_required',
          handle,
          progress.success ? progress.data : undefined,
        );
      }
      const parsed = registrationAcceptedSchema.safeParse(data);
      if (
        response.status !== 202 ||
        !parsed.success ||
        parsed.data.domain.toLowerCase() !== handle.domain
      ) {
        throw new RegistrationPendingError('invalid_response', handle);
      }
      try {
        this.assertStatusUrl(parsed.data);
      } catch (error) {
        throw new RegistrationPendingError('invalid_response', handle, undefined, { cause: error });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof RegistrationPendingError || !unresolvedPost) throw error;
      handle = { ...handle, endedAt: new Date().toISOString() };
      throw new RegistrationPendingError(
        pendingReason(scope.signal, 'transport_unknown'),
        handle,
        undefined,
        { cause: error },
      );
    } finally {
      scope.dispose();
    }
  }

  async get(id: string, options: RegistrationRequestOptions = {}): Promise<RegistrationProgress> {
    if (!id) throw new Error('A registration ID is required.');
    const data = await this.read(`/registrations/${encodeApiPathSegment(id)}`, options);
    const parsed = registrationProgressSchema.safeParse(data);
    if (!parsed.success)
      throw new RegistrationProtocolError('Invalid registration status response.');
    const progress = parsed.data;
    if (progress.registrationId !== id)
      throw new RegistrationProtocolError('Registration status identity mismatch.');
    this.assertStatusUrl(progress);
    return progress;
  }

  async list(options: RegistrationListOptions = {}): Promise<RegistrationListResult> {
    const limit = options.limit ?? REGISTRATION_LIST_DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > REGISTRATION_LIST_MAX_LIMIT ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error('Registration list requires limit 1-50 and a nonnegative integer offset.');
    }
    const data = await this.read(`/registrations?limit=${limit}&offset=${offset}`, options);
    const parsed = registrationListResultSchema.safeParse(data);
    if (!parsed.success) throw new RegistrationProtocolError('Invalid registration list response.');
    const result = parsed.data;
    if (result.items.length > limit)
      throw new RegistrationProtocolError('Registration list exceeds the requested page size.');
    for (const item of result.items) this.assertStatusUrl(item);
    return result;
  }

  async wait(
    registration: string | RegistrationAccepted | RegistrationProgress | RegistrationHandle,
    options: RegistrationWaitOptions = {},
  ): Promise<RegistrationResult> {
    let handle = this.toHandle(registration);
    if (!handle.registrationId) throw new RegistrationPendingError('transport_unknown', handle);
    const scope = deadline(options.signal, options.timeoutMs ?? WAIT_TIMEOUT_MS);
    let progress: RegistrationProgress | undefined;
    const payer = this.options.walletClient?.account.address.toLowerCase();
    try {
      const expectedPayer = this.expectedPayer(options.expectedPayer, handle.payerAddress);
      handle = { ...handle, payerAddress: expectedPayer };
      if (
        typeof registration !== 'string' &&
        'status' in registration &&
        registration.status === 'processing'
      ) {
        await delay(pollDelay(registration.pollAfterSeconds), scope.signal);
      }
      while (true) {
        if (this.options.walletClient?.account.address.toLowerCase() !== payer) {
          throw new RegistrationPendingError('status_unavailable', handle, progress);
        }
        try {
          progress = await this.get(handle.registrationId!, {
            signal: scope.signal,
            expectedPayer,
          });
          scope.signal.throwIfAborted();
        } catch (error) {
          if (
            !scope.signal.aborted &&
            (error instanceof RegistrationTransportError ||
              (error instanceof RegistrationHttpError &&
                (error.status === 408 || error.status === 429 || error.status >= 500)))
          ) {
            await delay(
              error instanceof RegistrationHttpError
                ? (error.retryAfterMs ?? POLL_INTERVAL_MS)
                : POLL_INTERVAL_MS,
              scope.signal,
            );
            continue;
          }
          throw error;
        }
        if (handle.domain && progress.domain.toLowerCase() !== handle.domain.toLowerCase()) {
          throw new RegistrationPendingError('invalid_response', handle, progress);
        }
        handle = { ...this.toHandle(progress), payerAddress: expectedPayer };
        if (progress.status === 'failed' || progress.status === 'refunded')
          throw new RegistrationFailedError(progress);
        if (progress.status === 'action_required' || progress.status === 'awaiting_payment') {
          throw new RegistrationPendingError(progress.status, handle, progress);
        }
        if (progress.status === 'completed') {
          const result = progress.result;
          if (!result)
            throw new RegistrationPendingError('completion_result_unavailable', handle, progress);
          if (
            result.agentId !== progress.agentId ||
            result.domain.toLowerCase() !== progress.domain.toLowerCase() ||
            (result.registrationId !== undefined &&
              result.registrationId !== progress.registrationId) ||
            progress.stage !== 'complete' ||
            !progress.completedAt
          )
            throw new RegistrationPendingError('invalid_response', handle, progress);
          return result;
        }
        await delay(pollDelay(progress.pollAfterSeconds), scope.signal);
      }
    } catch (error) {
      if (error instanceof RegistrationPendingError || error instanceof RegistrationFailedError)
        throw error;
      throw new RegistrationPendingError(
        pendingReason(
          scope.signal,
          error instanceof RegistrationProtocolError ? 'invalid_response' : 'status_unavailable',
        ),
        handle,
        progress,
        { cause: error },
      );
    } finally {
      scope.dispose();
    }
  }

  /** Read-only discovery after a lost response. Never authorizes or resubmits payment. */
  async recover(
    handle: RegistrationHandle,
    options: RegistrationRequestOptions = {},
  ): Promise<RegistrationProgress> {
    const expectedPayer = this.expectedPayer(options.expectedPayer, handle.payerAddress);
    const start = Date.parse(handle.startedAt);
    const end = Date.parse(handle.endedAt);
    if (
      typeof handle.domain !== 'string' ||
      !handle.domain.trim() ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start
    ) {
      throw new Error('Recovery requires an exact domain and a valid submission time interval.');
    }
    const matchesHandle = (value: RegistrationProgress) => {
      const created = Date.parse(value.startedAt);
      return (
        value.domain.toLowerCase() === handle.domain.toLowerCase() &&
        created >= start &&
        created <= end
      );
    };
    const scope = deadline(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const matches = new Map<string, RegistrationProgress>();
    let total: number | undefined;
    try {
      if (handle.registrationId) {
        if (handle.statusUrl)
          this.assertStatusUrl({
            registrationId: handle.registrationId,
            statusUrl: handle.statusUrl,
          });
        const current = await this.get(handle.registrationId, {
          signal: scope.signal,
          expectedPayer,
        });
        if (!matchesHandle(current)) throw new RegistrationPendingError('invalid_response', handle);
        return current;
      }
      for (let page = 0; page < RECOVERY_MAX_PAGES; page++) {
        const result = await this.list({
          limit: RECOVERY_PAGE_SIZE,
          offset: page * RECOVERY_PAGE_SIZE,
          signal: scope.signal,
          expectedPayer,
        });
        if (total !== undefined && result.total !== total) {
          throw new RegistrationPendingError('incomplete_recovery', handle);
        }
        total = result.total;
        for (const item of result.items) {
          if (matchesHandle(item)) {
            matches.set(item.registrationId, item);
          }
        }
        if (matches.size > 1) throw new RegistrationPendingError('ambiguous_recovery', handle);
        if (!result.hasMore) {
          const match = matches.values().next().value;
          if (!match) throw new RegistrationPendingError('not_found', handle);
          const current = await this.get(match.registrationId, {
            signal: scope.signal,
            expectedPayer,
          });
          if (!matchesHandle(current)) {
            throw new RegistrationPendingError('incomplete_recovery', handle);
          }
          return current;
        }
      }
      throw new RegistrationPendingError('incomplete_recovery', handle);
    } catch (error) {
      if (error instanceof RegistrationPendingError) throw error;
      throw new RegistrationPendingError(
        pendingReason(
          scope.signal,
          error instanceof RegistrationProtocolError ? 'invalid_response' : 'status_unavailable',
        ),
        handle,
        undefined,
        { cause: error },
      );
    } finally {
      scope.dispose();
    }
  }

  private url(path: string): string {
    return `${this.options.apiUrl.replace(/\/$/, '')}${path}`;
  }

  private assertStatusUrl(value: Pick<RegistrationProgress, 'registrationId' | 'statusUrl'>): void {
    const expected = new URL(
      this.url(`/registrations/${encodeApiPathSegment(value.registrationId)}`),
    );
    const received = new URL(value.statusUrl, expected);
    if (received.href !== expected.href)
      throw new RegistrationProtocolError(
        'Registration status URL does not match this API and registration.',
      );
  }

  private handleFromResponse(data: unknown, handle: RegistrationHandle): RegistrationHandle {
    const id =
      data && typeof data === 'object' && 'registrationId' in data ? data.registrationId : null;
    const paymentIdentifier =
      data && typeof data === 'object' && 'paymentIdentifier' in data
        ? data.paymentIdentifier
        : null;
    return {
      ...handle,
      registrationId: typeof id === 'string' && id ? id : null,
      statusUrl:
        typeof id === 'string' && id
          ? this.url(`/registrations/${encodeApiPathSegment(id)}`)
          : null,
      endedAt: new Date().toISOString(),
      ...(typeof paymentIdentifier === 'string' && /^0x[0-9a-f]{64}$/i.test(paymentIdentifier)
        ? { paymentIdentifier }
        : {}),
    };
  }

  private toHandle(
    value: string | RegistrationAccepted | RegistrationProgress | RegistrationHandle,
  ): RegistrationHandle {
    if (typeof value !== 'string' && 'endedAt' in value) return value;
    const id = typeof value === 'string' ? value : value.registrationId;
    const now = new Date().toISOString();
    return {
      registrationId: id,
      statusUrl: this.url(`/registrations/${encodeApiPathSegment(id)}`),
      domain: typeof value === 'string' ? '' : value.domain,
      startedAt: typeof value === 'string' ? now : (value.startedAt ?? now),
      endedAt: now,
    };
  }

  private async read(path: string, options: RegistrationRequestOptions): Promise<unknown> {
    const expectedPayer = this.expectedPayer(options.expectedPayer);
    const url = new URL(this.url(path));
    url.searchParams.set('expectedPayer', expectedPayer);
    const scope = deadline(options.signal, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const headers = await this.signedHeaders(scope.signal, expectedPayer, {
        method: 'GET',
        url: url.toString(),
      });
      try {
        const response = await withinSignal(scope.signal, () =>
          // Trusted constructor base + encoded ID/query; server status URLs are checked, never fetched.
          // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
          fetch(url.toString(), {
            headers,
            credentials: this.credentials(),
            cache: 'no-store',
            redirect: 'error',
            signal: scope.signal,
          }),
        );
        if (!response.ok)
          throw new RegistrationHttpError(
            response.status,
            retryAfterDelay(response.headers.get('Retry-After')),
          );
        const authenticatedWallet = response.headers.get('X-Authenticated-Wallet');
        if (
          !authenticatedWallet ||
          authenticatedWallet.toLowerCase() !== expectedPayer.toLowerCase()
        ) {
          throw new RegistrationProtocolError(
            'Registration response authenticated payer mismatch or missing identity header.',
          );
        }
        return await withinSignal(scope.signal, () => response.json());
      } catch (error) {
        if (error instanceof RegistrationHttpError || error instanceof RegistrationProtocolError)
          throw error;
        if (error instanceof SyntaxError)
          throw new RegistrationProtocolError('Invalid registration response JSON.', {
            cause: error,
          });
        throw new RegistrationTransportError('Registration status transport unavailable.', {
          cause: error,
        });
      }
    } finally {
      scope.dispose();
    }
  }

  private credentials(): RequestCredentials {
    return this.options.authentication === 'session' ||
      (!this.options.authentication && !this.options.walletClient)
      ? 'include'
      : 'omit';
  }

  private expectedPayer(explicit?: Address, handlePayer?: Address): Address {
    const requested =
      explicit ?? this.options.expectedPayer ?? this.options.walletClient?.account.address;
    if (requested && handlePayer && getAddress(requested) !== getAddress(handlePayer)) {
      throw new Error('Expected payer does not match the registration handle.');
    }
    const value = handlePayer ?? requested;
    if (!value) throw new Error('Registration status requires expectedPayer or a walletClient.');
    const payer = getAddress(value).toLowerCase() as Address;
    if (
      this.credentials() === 'omit' &&
      (!this.options.walletClient ||
        this.options.walletClient.account.address.toLowerCase() !== payer)
    ) {
      throw new Error('The connected signing wallet must match expectedPayer.');
    }
    return payer;
  }

  /** Sign one request; v2 signatures are single-use, so they are never cached. */
  private async signedHeaders(
    signal: AbortSignal,
    expectedPayer: Address,
    request: AgentSignatureRequest,
  ): Promise<Record<string, string>> {
    signal.throwIfAborted();
    const wallet = this.options.walletClient;
    if (this.options.authentication === 'session' || !wallet) return {};
    const account = wallet.account;
    const timestamp = Date.now();
    const header = await withinSignal(signal, () =>
      createAgentSignatureHeader(
        {
          address: account.address.toLowerCase(),
          signMessage: (message) => wallet.signMessage({ account, message }),
        },
        request,
        { timestamp },
      ),
    );
    if (Date.now() >= timestamp + SIGNATURE_SIGNING_LIMIT_MS || Date.now() < timestamp) {
      throw new Error('Registration request signature expired while signing.');
    }
    if (wallet.account.address.toLowerCase() !== expectedPayer.toLowerCase()) {
      throw new Error('The signing wallet changed during authentication.');
    }
    return { 'X-Agent-Signature': header };
  }
}

/** Keep identifiers in one URL segment; URL parsers normalize even percent-encoded dot segments. */
export function encodeApiPathSegment(value: string): string {
  if (value === '.' || value === '..')
    throw new TypeError('API identifiers must not be dot segments.');
  return encodeURIComponent(value);
}

/** Resolve once before signing or sending any request; never repair a base URL after payment. */
export function normalizeApiBaseUrl(value: string): string {
  if (!value.trim()) throw new TypeError('apiUrl must not be empty.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    if (typeof globalThis.location === 'undefined') {
      throw new TypeError(
        'Relative apiUrl requires a browser location; provide an absolute HTTPS URL.',
      );
    }
    try {
      url = new URL(value, globalThis.location.href);
    } catch {
      throw new TypeError('apiUrl is not a valid URL.');
    }
  }
  const localHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      'apiUrl must use HTTPS (or explicit localhost HTTP), without credentials, query, or fragment.',
    );
  }
  return url.href.replace(/\/+$/, '');
}

function pendingReason(
  signal: AbortSignal,
  fallback: RegistrationPendingReason,
): RegistrationPendingReason {
  if (!signal.aborted) return fallback;
  return signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted';
}

function pollDelay(seconds: number): number {
  // Never turn a malformed hint into a tight polling loop or an overflowing JS timer.
  if (!Number.isFinite(seconds) || seconds <= 0) return POLL_INTERVAL_MS;
  return Math.max(POLL_INTERVAL_MS, Math.min(2_147_483_647, seconds * 1000));
}

function retryAfterDelay(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? pollDelay(seconds) : undefined;
}

function deadline(parent: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('timeoutMs must be a positive integer no greater than 2147483647.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Registration deadline exceeded', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function withinSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
