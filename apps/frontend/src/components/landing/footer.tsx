/* eslint-disable @next/next/no-html-link-for-pages -- Public pages use full navigation to avoid shipping router JavaScript. */

import { BrandMark } from '@/components/brand/brand-mark';

export function Footer() {
  return (
    <footer className="defer-offscreen mt-16 border-t border-border/50 bg-background/30 py-10 sm:mt-24 sm:py-12">
      <div className="container">
        <div className="mb-10 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <h4 className="font-semibold mb-3 text-sm">Product</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="/register" className="hover:text-foreground">
                  Register
                </a>
              </li>
              <li>
                <a href="/registry" className="hover:text-foreground">
                  Registry
                </a>
              </li>
              <li>
                <a href="/dashboard" className="hover:text-foreground">
                  Dashboard
                </a>
              </li>
              <li>
                <a href="/#pricing" className="hover:text-foreground">
                  Pricing
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Identity</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="/ai-agent-identity" className="hover:text-foreground">
                  AI agent identity
                </a>
              </li>
              <li>
                <a href="/domains-for-ai-agents" className="hover:text-foreground">
                  Agent domains
                </a>
              </li>
              <li>
                <a href="/onchain-agent-identity" className="hover:text-foreground">
                  Onchain identity
                </a>
              </li>
              <li>
                <a href="/autonomous-agent-renewals" className="hover:text-foreground">
                  Autonomous renewals
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Infrastructure</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="/email-for-ai-agents" className="hover:text-foreground">
                  Agent email
                </a>
              </li>
              <li>
                <a href="/dns-for-ai-agents" className="hover:text-foreground">
                  Programmable DNS
                </a>
              </li>
              <li>
                <a href="/domain-registration-api" className="hover:text-foreground">
                  Registration API
                </a>
              </li>
              <li>
                <a href="/x402-agent-payments" className="hover:text-foreground">
                  x402 payments
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Developers</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="https://docs.agentdomain.app" className="hover:text-foreground">
                  Documentation
                </a>
              </li>
              <li>
                <a href="https://docs.agentdomain.app/sdk/mcp/" className="hover:text-foreground">
                  MCP integration
                </a>
              </li>
              <li>
                <a
                  href="https://docs.agentdomain.app/frameworks/agentkit/"
                  className="hover:text-foreground"
                >
                  Coinbase AgentKit
                </a>
              </li>
              <li>
                <a href="https://github.com/Talvono/AgentDomain" className="hover:text-foreground">
                  GitHub
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-3 text-sm">Legal &amp; Company</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="/" className="hover:text-foreground">
                  Home
                </a>
              </li>
              <li>
                <a href="/terms" className="hover:text-foreground">
                  Terms of Service
                </a>
              </li>
              <li>
                <a href="/privacy" className="hover:text-foreground">
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="https://x.com/AgentDomainApp" className="hover:text-foreground">
                  X (Twitter)
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col items-center justify-between border-t border-border/40 pt-8 text-center md:flex-row md:text-left">
          <a href="/" aria-label="AgentDomain home" className="flex items-center gap-2">
            <BrandMark variant="transparent" />
            <span className="text-sm font-semibold">AgentDomain</span>
          </a>
          <p className="text-xs text-muted-foreground mt-4 md:mt-0">
            © {new Date().getFullYear()} AgentDomain. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
