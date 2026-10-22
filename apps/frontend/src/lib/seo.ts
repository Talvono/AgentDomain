import type { Metadata } from 'next';
import { BRAND_ASSETS, BRAND_SOCIAL_IMAGE } from '@/lib/brand-assets';

export const SITE_URL = 'https://agentdomain.app';
export const SITE_NAME = 'AgentDomain';
export const TITLE_TEMPLATE = `${SITE_NAME} | %s`;
export const DEFAULT_DESCRIPTION =
  'AgentDomain is the agent-native identity and communications infrastructure. Built for developers, people guiding agents, and permissioned autonomous workflows.';

export const SOCIAL_IMAGE = BRAND_SOCIAL_IMAGE;

export const STATIC_INDEXABLE_ROUTES = [
  '/',
  '/ai-agent-identity',
  '/domains-for-ai-agents',
  '/email-for-ai-agents',
  '/dns-for-ai-agents',
  '/domain-registration-api',
  '/x402-agent-payments',
  '/onchain-agent-identity',
  '/autonomous-agent-renewals',
  '/integrations/mcp',
  '/integrations/coinbase-agentkit',
  '/register',
  '/registry',
  '/verify',
  '/privacy',
  '/terms',
] as const;

export function absoluteUrl(path = '/'): string {
  return new URL(path, SITE_URL).toString();
}

export function brandedTitle(title: string): string {
  return title.startsWith(SITE_NAME) ? title : `${SITE_NAME} | ${title}`;
}

export function createSitemapXml(
  entries: ReadonlyArray<{ loc: string; lastmod?: string }>,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(({ loc, lastmod }) => {
      const lastmodTag = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : '';
      return `  <url><loc>${escapeXml(loc)}</loc>${lastmodTag}</url>`;
    }),
    '</urlset>',
  ].join('\n');
}

export function createPageMetadata(options: {
  title: string;
  description: string;
  path: string;
  canonical?: string;
  index?: boolean;
  image?: typeof SOCIAL_IMAGE;
}): Metadata {
  const canonical = options.canonical ?? absoluteUrl(options.path);
  const image = options.image ?? SOCIAL_IMAGE;
  const index = options.index ?? true;
  const socialTitle = brandedTitle(options.title);

  return {
    title: { absolute: socialTitle },
    description: options.description,
    alternates: { canonical },
    robots: index
      ? { index: true, follow: true }
      : {
          index: false,
          follow: true,
          googleBot: { index: false, follow: true },
        },
    openGraph: {
      title: socialTitle,
      description: options.description,
      siteName: SITE_NAME,
      type: 'website',
      url: canonical,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description: options.description,
      images: [{ url: image.url, alt: image.alt }],
    },
  };
}

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function homepageJsonLd() {
  const organizationId = `${SITE_URL}/#organization`;
  const websiteId = `${SITE_URL}/#website`;
  const applicationId = `${SITE_URL}/#software`;

  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': organizationId,
      name: SITE_NAME,
      url: SITE_URL,
      logo: absoluteUrl(BRAND_ASSETS.markPng),
      sameAs: ['https://github.com/Talvono/AgentDomain'],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': websiteId,
      url: SITE_URL,
      name: SITE_NAME,
      description: DEFAULT_DESCRIPTION,
      publisher: { '@id': organizationId },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      '@id': applicationId,
      name: SITE_NAME,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      publisher: { '@id': organizationId },
      offers: {
        '@type': 'Offer',
        price: '3.90',
        priceCurrency: 'USD',
        description: 'Annual platform fee per agent; domain and optional name costs are separate.',
      },
    },
  ];
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
