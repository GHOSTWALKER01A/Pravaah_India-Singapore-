import type { MetadataRoute } from "next";

import { BASE_URL, MOBILE_APP } from "@/lib/config/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // The app-open route is a redirect surface, not a page. Indexing it
        // would put a bouncing URL in results.
        disallow: [MOBILE_APP.openPath],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
