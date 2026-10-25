/**
 * Request-bound agent signatures (`X-Agent-Signature` v2).
 *
 * Header: `v2:<address>:<timestampMs>:<nonce>:<signature>`. The wallet signs an
 * EIP-191 message that binds the API audience, HTTP method, canonical request target,
 * SHA-256 of the exact body bytes, the timestamp and a single-use random nonce. The API
 * accepts each (wallet, nonce) once within five minutes, so every request needs a
 * fresh signature: never cache or reuse a header.
 */

import { sha256 } from 'viem';

/** Audience bound by every signature sent to an agentdomain.app API host. */
export const AGENT_SIGNATURE_AUDIENCE = 'agentdomain.app';

/** Minimal signer: a viem account, wallet client adapter or any EIP-191 signer. */
export interface AgentSignatureSigner {
  address: string;
  signMessage(message: string): Promise<string>;
}

export interface AgentSignatureRequest {
  method: string;
  url: string | URL;
  /** Exact body bytes sent with the request; omit for requests without a body. */
  body?: string | Uint8Array | null;
}

/** RFC 3986 unreserved-only percent encoding, identical in every client language. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical request target: each path segment decoded then strictly re-encoded, and
 * query pairs strictly encoded and sorted by name then value.
 */
export function canonicalAgentRequestTarget(url: URL): string {
  const path = url.pathname
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');
  const pairs = [...url.searchParams].map(
    ([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const,
  );
  pairs.sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = pairs.map(([name, value]) => `${name}=${value}`).join('&');
  return query ? `${path}?${query}` : path;
}

/** agentdomain.app for every platform host; any other host signs its exact name. */
export function agentSignatureAudience(host: string): string {
  const lower = host.toLowerCase();
  return lower === AGENT_SIGNATURE_AUDIENCE || lower.endsWith(`.${AGENT_SIGNATURE_AUDIENCE}`)
    ? AGENT_SIGNATURE_AUDIENCE
    : lower;
}

export function buildAgentSignatureMessage(input: {
  audience: string;
  method: string;
  target: string;
  bodySha256: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    'AgentDomain API request',
    'version: 2',
    `audience: ${input.audience}`,
    `method: ${input.method.toUpperCase()}`,
    `target: ${input.target}`,
    `body-sha256: ${input.bodySha256}`,
    `timestamp: ${input.timestamp}`,
    `nonce: ${input.nonce}`,
  ].join('\n');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of the exact body bytes (UTF-8 for strings); empty when absent. */
export function agentRequestBodySha256(body?: string | Uint8Array | null): string {
  const bytes =
    body === undefined || body === null
      ? new Uint8Array()
      : typeof body === 'string'
        ? new TextEncoder().encode(body)
        : body;
  return sha256(bytes, 'hex').slice(2);
}

/** 128-bit random nonce as 32 lowercase hex characters. */
export function createAgentSignatureNonce(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Sign one request and return the `X-Agent-Signature` header value. */
export async function createAgentSignatureHeader(
  signer: AgentSignatureSigner,
  request: AgentSignatureRequest,
  options: { timestamp?: number; nonce?: string } = {},
): Promise<string> {
  const url = new URL(request.url);
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? createAgentSignatureNonce();
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new TypeError('Agent signature nonce must be 32 hex.');
  const message = buildAgentSignatureMessage({
    audience: agentSignatureAudience(url.host),
    method: request.method,
    target: canonicalAgentRequestTarget(url),
    bodySha256: agentRequestBodySha256(request.body),
    timestamp,
    nonce,
  });
  const signature = await signer.signMessage(message);
  return `v2:${signer.address}:${timestamp}:${nonce}:${signature}`;
}
