import type { Metadata } from "next";
import type { ReactElement } from "react";

import {
  APP_IS_PUBLISHED,
  MOBILE_APP,
  STAGE,
  type AppPlatform,
} from "@/lib/config/site";
import { ROUTES } from "@/lib/constants/routes";
import { Container } from "@/ui/layout/Container";
import { Guilloche } from "@/ui/engraving/Guilloche";
import { AppHandoff } from "@/ui/app-link/AppHandoff";
import { ButtonLink } from "@/ui/primitives/Button";
import { DataField, DataFieldGrid } from "@/ui/primitives/DataField";
import { Legend } from "@/ui/primitives/Legend";

/**
 * The app link.
 *
 * One route handles both states, decided from config rather than from a flag
 * someone has to remember to flip: with no store URL set, this is an honest
 * pre-launch page; the moment `NEXT_PUBLIC_ANDROID_STORE_URL` or
 * `NEXT_PUBLIC_IOS_STORE_URL` is filled in, it becomes a deep-link handoff.
 *
 * The optional catch-all preserves an in-app destination, so a future link like
 * /get-app/consent/abc123 can open that screen directly once the app ships.
 */

export const metadata: Metadata = {
  title: "Get the app",
  description:
    "MyPravaah's mobile app is not yet published. Here is what is built, what is coming, and how to be sure you are looking at the real thing.",
  // A redirect surface should not compete with the pages that explain the
  // product, and a pre-launch page has nothing durable to rank for.
  robots: { index: false, follow: true },
};

export default async function GetAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const [resolvedParams, resolvedSearch] = await Promise.all([
    params,
    searchParams,
  ]);

  const appPath = resolvedParams.path?.join("/") ?? "";
  const fallback = parsePlatform(resolvedSearch.fallback);

  return (
    <section className="relative overflow-clip bg-intaglio py-20 text-reverse sm:py-28">
      <Guilloche
        seed={2}
        bands={6}
        className="absolute -right-40 top-1/2 h-[36rem] w-[36rem] -translate-y-1/2 text-latent-line/20 sm:-right-20"
      />

      <Container className="relative">
        <div className="max-w-2xl">
          {APP_IS_PUBLISHED ? (
            <>
              <h1 className="denomination text-[2.5rem] text-reverse sm:text-5xl">
                Opening the MyPravaah app
              </h1>
              <div className="mt-10">
                <AppHandoff appPath={appPath} fallback={fallback} />
              </div>
            </>
          ) : (
            <>
              <Legend className="text-latent">Not yet released</Legend>

              <h1 className="denomination mt-8 text-[2.5rem] text-reverse sm:text-6xl">
                The app isn&rsquo;t out yet.
              </h1>

              <p className="mt-8 text-base leading-relaxed text-reverse-dim sm:text-lg">
                MyPravaah is not on the App Store or Google Play. We would rather
                tell you that plainly than collect your email on a page dressed
                up as a download.
              </p>

              <p className="mt-5 text-base leading-relaxed text-reverse-dim sm:text-lg">
                <span className="text-reverse">
                  If you find an app claiming to be MyPravaah today, it is not
                  ours.
                </span>{" "}
                Nobody from MyPravaah will ever ask you for a banking password, a
                net-banking PIN, a UPI PIN, or a one-time password read out loud.
              </p>

              <p className="mt-5 text-base leading-relaxed text-reverse-dim sm:text-lg">
                The product itself is finished — all eight modules, verified end
                to end. What stands between that and a release is licensing, not
                engineering.
              </p>

              <div className="mt-12 border-t border-reverse/20 pt-9">
                <DataFieldGrid className="sm:grid-cols-2">
                  <DataField
                    label="Built"
                    value={`${STAGE.modulesBuilt} of ${STAGE.modulesTotal} modules`}
                  />
                  <DataField label="Licences held" value="None" />
                  <DataField label="Corridor" value="India ⟷ Singapore" />
                  <DataField
                    label="Deep link"
                    value={`${MOBILE_APP.deepLinkScheme}://`}
                  />
                </DataFieldGrid>
              </div>

              <div className="mt-12 flex flex-col gap-3 sm:flex-row sm:items-center">
                <ButtonLink href={ROUTES.WHAT_IS_BUILT} variant="reverse">
                  What is built
                </ButtonLink>
                <ButtonLink href={ROUTES.SECURITY} variant="quiet">
                  How data is protected
                </ButtonLink>
              </div>

              {appPath ? (
                <p className="legend mt-10 text-reverse-dim">
                  Destination held: {appPath}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Container>
    </section>
  );
}

function parsePlatform(
  value: string | string[] | undefined,
): AppPlatform | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "ios" || raw === "android" ? raw : undefined;
}
