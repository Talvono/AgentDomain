import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { machineDocsIntegration } from './scripts/machine-docs.mjs';

const canonicalSite = 'https://docs.agentdomain.app';

export default defineConfig({
  site: canonicalSite,
  output: 'static',
  trailingSlash: 'always',
  build: {
    assets: '_assets',
  },
  vite: {
    build: {
      sourcemap: false,
    },
  },
  integrations: [
    starlight({
      title: 'AgentDomain Docs',
      titleDelimiter: '|',
      description: 'Programmable identity and communication infrastructure for AI agents.',
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-black.svg',
        alt: 'AgentDomain',
        replacesTitle: false,
      },
      favicon: '/brand/favicon-96.png',
      pagefind: true,
      disable404Route: true,
      lastUpdated: true,
      editLink: {
        baseUrl: 'https://github.com/Talvono/AgentDomain/edit/main/apps/docs/',
      },
      social: [
        {
          icon: 'github',
          label: 'AgentDomain on GitHub',
          href: 'https://github.com/Talvono/AgentDomain',
        },
      ],
      customCss: ['./src/styles/docs.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'sitemap', href: '/sitemap-index.xml' },
        },
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#0d6b67' },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: `${canonicalSite}/brand/agentdomain-docs-card.png`,
          },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:card', content: 'summary_large_image' },
        },
      ],
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Core concepts', slug: 'concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Registration', slug: 'guides/registration' },
            { label: 'x402 payments', slug: 'guides/x402-payments' },
            { label: 'DNS', slug: 'guides/dns' },
            { label: 'Email', slug: 'guides/email' },
            { label: 'SSL', slug: 'guides/ssl' },
            { label: 'Renewals', slug: 'guides/renewal' },
          ],
        },
        {
          label: 'SDK and tools',
          items: [
            { label: 'TypeScript SDK', slug: 'sdk/typescript' },
            { label: 'MCP server', slug: 'sdk/mcp' },
          ],
        },
        {
          label: 'Frameworks',
          items: [
            { label: 'Coinbase AgentKit', slug: 'frameworks/agentkit' },
            { label: 'ElizaOS', slug: 'frameworks/elizaos' },
            { label: 'LangChain', slug: 'frameworks/langchain' },
            { label: 'CrewAI', slug: 'frameworks/crewai' },
            { label: 'AutoGen', slug: 'frameworks/autogen' },
          ],
        },
        {
          label: 'API reference',
          items: [
            { label: 'API overview', slug: 'api-reference/overview' },
            { label: 'Registration', slug: 'api-reference/register' },
            { label: 'Agents', slug: 'api-reference/agents' },
            { label: 'DNS', slug: 'api-reference/dns' },
            { label: 'Email', slug: 'api-reference/email' },
          ],
        },
      ],
    }),
    sitemap({
      filter: (page) => !page.endsWith('/404/'),
    }),
    machineDocsIntegration(),
  ],
});
