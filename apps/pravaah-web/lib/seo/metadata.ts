import type { Metadata } from "next";

import { BASE_URL, SITE_CONFIG } from "@/lib/config/site";

export const ROOT_METADATA: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    template: "%s · MyPravaah",
    default: "MyPravaah — a financial reputation that crosses the border with you",
  },
  description:
    "MyPravaah turns the financial history you built in one country into a signed credential you own and can present in another. Consent-based, explainable, and deletable at any moment.",
  applicationName: SITE_CONFIG.name,
  keywords: [
    "financial reputation passport",
    "cross-border credit history",
    "Account Aggregator India",
    "migrant credit score",
    "India Singapore corridor",
    "portable credit history",
    "consent-based financial data",
    "verifiable credential finance",
  ],
  authors: [{ name: SITE_CONFIG.name, url: BASE_URL }],
  creator: SITE_CONFIG.name,
  publisher: SITE_CONFIG.name,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_CONFIG.name,
    url: BASE_URL,
    locale: "en_IN",
    title: "MyPravaah — a financial reputation that crosses the border with you",
    description:
      "Your credit history dies at the airport. MyPravaah turns it into a credential you own and can present anywhere.",
  },
  twitter: {
    card: "summary_large_image",
    title: "MyPravaah — a financial reputation that crosses the border with you",
    description:
      "Your credit history dies at the airport. MyPravaah turns it into a credential you own and can present anywhere.",
  },
  formatDetection: { telephone: false, address: false, email: false },
};

/**
 * Per-page metadata. Kept in one place so titles, descriptions and canonicals
 * cannot drift apart across route groups.
 */
export function pageMetadata(options: {
  title: string;
  description: string;
  path: string;
  /** Documents are indexable but should not compete with the marketing pages. */
  noIndex?: boolean;
}): Metadata {
  const { title, description, path, noIndex } = options;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: `${title} · MyPravaah`, description, url: `${BASE_URL}${path}` },
    twitter: { title: `${title} · MyPravaah`, description },
    ...(noIndex ? { robots: { index: false, follow: true } } : {}),
  };
}
