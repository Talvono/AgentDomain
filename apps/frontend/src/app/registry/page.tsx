import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav } from '@/components/landing/public-nav';
import { Footer } from '@/components/landing/footer';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getPublicBackend } from '@/lib/backend-client';
import { shortAddress, timeAgo } from '@/lib/utils';
import { SUPPORTED_FRAMEWORKS } from '@agentdomain/shared/constants';
import { createPageMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

const PAGE_SIZE = 12;

type RegistrySearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<RegistrySearchParams>;
}): Promise<Metadata> {
  const params = searchParams ? await searchParams : {};
  const q = readParam(params.q);
  const framework = readParam(params.framework);
  const capability = readParam(params.capability);
  const page = Math.max(1, Number(readParam(params.page) ?? '1') || 1);
  const filtered = Boolean(q || framework || capability);
  const path = page > 1 ? `/registry?page=${page}` : '/registry';

  return createPageMetadata({
    title: page > 1 ? `Public Agent Registry - Page ${page}` : 'Public AI Agent Registry',
    description:
      'Discover active AI agent identities by domain, framework, capability, and public x402 endpoint.',
    path: filtered ? '/registry' : path,
    index: !filtered,
  });
}

async function getRegistry(opts: {
  q?: string;
  framework?: string;
  capability?: string;
  page: number;
}) {
  const result = await getPublicBackend().registry({
    q: opts.q,
    framework: opts.framework,
    capability: opts.capability,
    limit: PAGE_SIZE,
    offset: (opts.page - 1) * PAGE_SIZE,
  });
  return {
    ...result,
    items: result.items.map((agent) => {
      return {
        id: agent.id,
        domain: agent.domain,
        basename: agent.basename,
        ensName: agent.ensName,
        walletAddress: agent.walletAddress,
        framework: agent.framework,
        description: agent.description ?? 'Agent identity registered on AgentDomain.',
        capabilities: agent.capabilities,
        x402Endpoint: agent.x402Endpoint,
        supportTier: agent.supportTier,
        createdAt: agent.createdAt,
      };
    }),
  };
}

export default async function RegistryPage({
  searchParams,
}: {
  searchParams?: Promise<RegistrySearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const q = readParam(params.q);
  const framework = readParam(params.framework);
  const capability = readParam(params.capability);
  const page = Math.max(1, Number(readParam(params.page) ?? '1') || 1);
  const result = await getRegistry({ q, framework, capability, page });
  const items = result.items;

  return (
    <main className="min-h-screen bg-background">
      <PublicNav />

      <section className="container py-10 sm:py-16">
        <div className="mb-8 sm:mb-12">
          <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
            Public Agent Registry
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
            Discover agents by domain, capability, framework, and x402 endpoint.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-muted-foreground sm:gap-4">
            <Badge variant="success">
              {result.total} {result.total === 1 ? 'agent' : 'agents'}
            </Badge>
            <span>Page {page}</span>
          </div>
        </div>

        <form className="mb-8 grid gap-3 rounded-md border border-border/60 bg-card/70 p-4 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
          <input
            name="q"
            aria-label="Search agents"
            defaultValue={q}
            placeholder="Search domain, wallet, metadata"
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <select
            name="framework"
            aria-label="Framework"
            defaultValue={framework}
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          >
            <option value="">Any framework</option>
            {SUPPORTED_FRAMEWORKS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input
            name="capability"
            aria-label="Capability"
            defaultValue={capability}
            placeholder="Capability"
            className="h-10 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
          <Button type="submit">Search</Button>
        </form>

        {items.length === 0 ? (
          <Card className="premium-surface">
            <CardContent className="py-16 text-center">
              <p className="text-muted-foreground">
                No agents found.{' '}
                <Link href="/register" className="text-primary hover:underline">
                  Register one.
                </Link>
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {items.map((agent) => (
              <Link key={agent.id} href={`/agents/${agent.id}`}>
                <Card className="interactive-surface premium-surface h-full">
                  <CardContent className="flex h-full flex-col gap-4 p-4 sm:p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar seed={agent.domain} />
                        <div className="min-w-0">
                          <div className="wrap-anywhere font-semibold">{agent.domain}</div>
                          {agent.basename && (
                            <div className="wrap-anywhere text-xs font-mono text-muted-foreground">
                              {agent.basename}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {agent.framework && <Badge variant="outline">{agent.framework}</Badge>}
                        {agent.supportTier === 'enterprise' && (
                          <Badge variant="success">Enterprise</Badge>
                        )}
                      </div>
                    </div>

                    <p className="line-clamp-3 text-sm text-muted-foreground">
                      {agent.description}
                    </p>

                    {agent.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {agent.capabilities.slice(0, 4).map((capability) => (
                          <Badge key={capability} variant="secondary">
                            {capability}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{shortAddress(agent.walletAddress)}</span>
                      <span>{timeAgo(agent.createdAt)}</span>
                    </div>
                    {agent.x402Endpoint && (
                      <div className="wrap-anywhere rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
                        {agent.x402Endpoint}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between gap-4">
          {page <= 1 ? (
            <Button variant="outline" disabled>
              Previous
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={buildRegistryHref({ q, framework, capability, page: page - 1 })}>
                Previous
              </Link>
            </Button>
          )}
          {!result.hasMore ? (
            <Button variant="outline" disabled>
              Next
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href={buildRegistryHref({ q, framework, capability, page: page + 1 })}>
                Next
              </Link>
            </Button>
          )}
        </div>
      </section>

      <Footer />
    </main>
  );
}

function Avatar({ seed }: { seed: string }) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash << 5) - hash + seed.charCodeAt(i);
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 60) % 360;
  return (
    <div
      className="h-10 w-10 flex-shrink-0 rounded-full"
      style={{
        background: `linear-gradient(135deg, hsl(${h1}, 70%, 55%), hsl(${h2}, 70%, 55%))`,
      }}
    />
  );
}

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function buildRegistryHref(opts: {
  q?: string;
  framework?: string;
  capability?: string;
  page: number;
}) {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.framework) params.set('framework', opts.framework);
  if (opts.capability) params.set('capability', opts.capability);
  if (opts.page > 1) params.set('page', String(opts.page));
  const query = params.toString();
  return query ? `/registry?${query}` : '/registry';
}
