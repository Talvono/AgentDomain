import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';

export function Hero() {
  return (
    <section className="hero-premium-shell relative overflow-hidden border-b border-border/70">
      <div className="container relative pb-4 pt-10 sm:pb-14 sm:pt-16 md:pb-16 md:pt-20">
        <div className="mx-auto max-w-4xl text-center">
          <Badge
            variant="outline"
            className="mb-5 inline-flex max-w-full items-center gap-2 border-border/80 bg-card/60 px-3 py-1.5 text-left text-foreground shadow-sm sm:mb-6 sm:px-4"
          >
            <Sparkles className="h-3 w-3 text-orange-600" />
            <span className="wrap-anywhere text-xs">Powered by Base, x402, and Coinbase</span>
          </Badge>

          <h1 className="wrap-anywhere text-balance text-3xl font-bold tracking-normal sm:text-5xl md:text-7xl">
            Agent-native identity and{' '}
            <span className="gradient-text">communications infrastructure</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-balance text-base text-muted-foreground sm:mt-6 sm:text-lg md:text-xl">
            Programmable identity and communication infrastructure for AI agents. Built for
            developers using APIs and SDKs, people guiding agents, and permissioned autonomous
            workflows.
          </p>

          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:mt-10 sm:flex-row sm:items-center sm:gap-4">
            <Button asChild size="xl" className="group w-full sm:w-auto">
              <Link href="/register">
                Register an agent
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="xl" className="w-full sm:w-auto">
              <Link href="https://docs.agentdomain.app">Read the docs</Link>
            </Button>
          </div>

          <div className="mx-auto mt-8 grid max-w-md grid-cols-1 gap-4 text-left sm:mt-10 sm:grid-cols-3">
            <CodePreview />
          </div>
        </div>
      </div>
    </section>
  );
}

function CodePreview() {
  return (
    <div className="sm:col-span-3">
      <div className="code-surface overflow-hidden rounded-lg border p-1 md:backdrop-blur">
        <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2">
          <div className="h-2.5 w-2.5 rounded-full bg-orange-700/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-orange-500/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-stone-500/70" />
          <span className="ml-3 font-mono text-xs text-muted-foreground">register.ts</span>
        </div>
        <pre
          className="overflow-hidden whitespace-pre-wrap break-words p-4 text-left font-mono text-[11px] leading-5 sm:hidden"
          aria-label="Mobile SDK registration example"
        >
          <code>
            <span className="text-stone-700">import</span>{' '}
            <span className="text-stone-950">{'{ AgentDomain }'}</span>{' '}
            <span className="text-stone-700">from</span>{' '}
            <span className="text-orange-700">{`'@agentdomain/sdk'`}</span>;{'\n\n'}
            <span className="text-stone-700">const</span> ad ={' '}
            <span className="text-stone-700">new</span>{' '}
            <span className="text-stone-950">AgentDomain</span>({'{ '}walletClient, publicClient
            {' }'});
            {'\n\n'}
            <span className="text-stone-700">const</span> identity ={' '}
            <span className="text-stone-700">await</span> ad.
            <span className="text-stone-950">register</span>({'{'}
            {'\n  '}preferredName: <span className="text-orange-700">{`'example'`}</span>,{'\n  '}
            tld: <span className="text-orange-700">{`'com'`}</span>,{'\n  '}
            registerBasename: <span className="text-orange-800">true</span>,{'\n  '}
            registerEns: <span className="text-orange-800">true</span>,{'\n  '}
            years: <span className="text-orange-800">1</span>,{'\n  '}
            autoRenew: <span className="text-orange-800">true</span>,{'\n  '}
            emailEnabled: <span className="text-orange-800">true</span>,{'\n'}
            {'}'});{'\n\n'}
            <span className="text-muted-foreground">{`// -> example.com | example.base.eth | example.eth | agent@example.com`}</span>
          </code>
        </pre>
        <pre
          className="mobile-scroll hidden p-4 text-left font-mono text-xs leading-relaxed sm:block"
          role="region"
          aria-label="SDK registration example"
          tabIndex={0}
        >
          <code>
            <span className="text-stone-700">import</span>{' '}
            <span className="text-stone-950">{'{ AgentDomain }'}</span>{' '}
            <span className="text-stone-700">from</span>{' '}
            <span className="text-orange-700">{`'@agentdomain/sdk'`}</span>;{'\n\n'}
            <span className="text-stone-700">const</span> ad ={' '}
            <span className="text-stone-700">new</span>{' '}
            <span className="text-stone-950">AgentDomain</span>({'{ '}walletClient, publicClient
            {' }'});
            {'\n\n'}
            <span className="text-stone-700">const</span> identity ={' '}
            <span className="text-stone-700">await</span> ad.
            <span className="text-stone-950">register</span>({'{'}
            {'\n  '}preferredName: <span className="text-orange-700">{`'example'`}</span>,{'\n  '}
            tld: <span className="text-orange-700">{`'com'`}</span>,{'\n  '}
            registerBasename: <span className="text-orange-800">true</span>,{'\n  '}
            registerEns: <span className="text-orange-800">true</span>,{'\n  '}
            years: <span className="text-orange-800">1</span>,{'\n  '}
            autoRenew: <span className="text-orange-800">true</span>,{'\n  '}
            emailEnabled: <span className="text-orange-800">true</span>,{'\n'}
            {'}'});{'\n\n'}
            <span className="text-muted-foreground">{`// -> example.com | example.base.eth | example.eth | agent@example.com`}</span>
          </code>
        </pre>
      </div>
    </div>
  );
}
