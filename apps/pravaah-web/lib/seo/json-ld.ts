import { BASE_URL, SITE_CONFIG, isPlaceholder } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";

/**
 * Structured data for the organisation and the site.
 *
 * The legal entity name is a placeholder until the user supplies it
 * (PRODUCT.md records it as unverified), so `legalName` is omitted rather
 * than emitted with bracket text — publishing a placeholder into structured
 * data would be asserting it as fact to a search engine.
 */
export function organisationJsonLd(): Record<string, unknown> {
  const { entityName } = SITE_CONFIG.legal;

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_CONFIG.name,
    url: BASE_URL,
    description: SITE_CONFIG.tagline,
    ...(isPlaceholder(entityName) ? {} : { legalName: entityName }),
  };
}

export function websiteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_CONFIG.name,
    url: BASE_URL,
    inLanguage: "en",
  };
}

/** Applying is a procedure with an ordered, non-optional sequence. */
export function howToApplyJsonLd(
  steps: ReadonlyArray<{ label: string; action: string }>,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "How to apply for a MyPravaah reputation passport",
    description:
      "The identity checks required to be verified on the India–Singapore corridor, in the order the product enforces them.",
    url: `${BASE_URL}${ROUTES.HOW_TO_APPLY}`,
    step: steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.label,
      text: step.action,
    })),
  };
}
