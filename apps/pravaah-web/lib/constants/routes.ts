import { MOBILE_APP } from "@/lib/config/site";

export const ROUTES = {
  HOME: "/",
  HOW_TO_APPLY: "/how-to-apply",
  SECURITY: "/security",
  LEGAL: {
    PRIVACY: "/privacy",
    RULES: "/rules",
    TERMS: "/terms",
  },
  GET_APP: MOBILE_APP.openPath,
} as const;

/** Primary navigation. Order is the reading order a first-time visitor needs. */
export const NAV_ITEMS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "How it works", href: ROUTES.HOME + "#how-it-works" },
  { label: "How to apply", href: ROUTES.HOW_TO_APPLY },
  { label: "Security", href: ROUTES.SECURITY },
  { label: "Rules", href: ROUTES.LEGAL.RULES },
];

/**
 * Documents that share the sheet chrome and cross-link to each other in the
 * footer of every document page.
 */
export const DOCUMENTS: ReadonlyArray<{
  label: string;
  href: string;
  blurb: string;
}> = [
  {
    label: "Privacy",
    href: ROUTES.LEGAL.PRIVACY,
    blurb: "What we collect, why, how long we keep it, and how you delete it.",
  },
  {
    label: "Rules",
    href: ROUTES.LEGAL.RULES,
    blurb: "Who can apply, what is required, and what happens when a check fails.",
  },
  {
    label: "Terms",
    href: ROUTES.LEGAL.TERMS,
    blurb: "The agreement between you and Pravaah.",
  },
  {
    label: "Security",
    href: ROUTES.SECURITY,
    blurb: "How the credential resists forgery and how your data is protected.",
  },
];
