import type { Metadata } from "next";

import { BASE_URL, SITE_CONFIG } from "@/lib/config/site";

export const ROOT_METADATA: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    template: "%s · MyPravaah",
    default: "MyPravaah — prove yourself once, and keep the proof",
  },
  description:
    "An AI financial-journey copilot for thin-file Indian borrowers: one Account Aggregator consent instead of a document chase, a credit answer that carries its reasons, and a reputation receipt you own and can show the next lender. Consent-based, explainable, and deletable at any moment.",
  applicationName: SITE_CONFIG.name,
  keywords: [
    "thin-file credit India",
    "explainable credit decision",
    "Account Aggregator India",
    "AI financial copilot",
    "Hindi loan assistant",
    "portable credit reputation",
    "reputation receipt",
    "consent-based financial data",
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
    title: "MyPravaah — prove yourself once, and keep the proof",
    description:
      "Refused a loan with no reason given? MyPravaah turns the history you already have into an answer with its reasons, and a receipt you own.",
  },
  twitter: {
    card: "summary_large_image",
    title: "MyPravaah — prove yourself once, and keep the proof",
    description:
      "Refused a loan with no reason given? MyPravaah turns the history you already have into an answer with its reasons, and a receipt you own.",
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
