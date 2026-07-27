import type { MetadataRoute } from "next";

import { BASE_URL } from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date().toISOString();

  const entries: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: "monthly", priority: 1 },
    {
      url: `${BASE_URL}${ROUTES.HOW_TO_APPLY}`,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}${ROUTES.SECURITY}`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}${ROUTES.LEGAL.RULES}`,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE_URL}${ROUTES.LEGAL.PRIVACY}`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}${ROUTES.LEGAL.TERMS}`,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  return entries.map((entry) => ({ ...entry, lastModified: now }));
}
