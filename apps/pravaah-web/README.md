# pravaah-web

The public marketing and information site for Pravaah. It explains what the
product is, how consent and data movement work, how to apply, what protects you,
and links to the mobile app. It holds no user data, has no authentication, and
talks to no backend.

Runs on **port 3000** (`pravaah-admin` is 3001).

## Commands

```bash
npm run dev        # next dev  — http://localhost:3000
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

From the repo root, `npm run dev` runs every app through Turborepo.

## Pages

| Route | Purpose |
|---|---|
| `/` | Introduction — the problem, how data reaches us, the chain of trust |
| `/how-to-apply` | The real identity-check sequence, per corridor |
| `/security` | How the credential resists forgery; what we do *not* claim |
| `/privacy` | What is collected, why, for how long, and how you delete it |
| `/rules` | Product rules in plain English — eligibility, failures, revocation |
| `/terms` | The legal agreement |
| `/get-app/[[...path]]` | App handoff. Pre-launch state today; deep-link + store fallback once published |
| `/robots.txt`, `/sitemap.xml` | Generated from `lib/constants/routes.ts` |

## Layout

```
app/
  (main)/          marketing routes — home, how-to-apply, security
  (legal)/         long-form documents — privacy, rules, terms
  get-app/         app handoff (deep link + store fallback)
  layout.tsx       fonts, root metadata, JSON-LD, direction contract
lib/
  config/site.ts   URLs, store plumbing, legal placeholders — single source of truth
  constants/       routes and navigation
  content/         page content as data (checks, chain, security features)
  seo/             metadata builders and structured data
  styles/          Tailwind v4 tokens
ui/
  engraving/       guilloche, microtext, security thread — generated geometry
  primitives/      Legend, DataField, Button, StatusMark
  layout/          Header, Footer, SiteLayout, DocumentShell
  motion/          SmoothScroll (Lenis, wheel only)
  home/ apply/ security/ app-link/    per-page sections
```

Route groups own the chrome (`export { SiteLayout as default }`), so no page
mounts the header or footer itself.

## Scrolling

`ui/motion/SmoothScroll.tsx` wraps Lenis and is scoped to **wheel smoothing
only**. Three constraints are load-bearing — read the file's comment before
changing any of them:

- It is never constructed under `prefers-reduced-motion: reduce`, and it watches
  the preference live.
- Mounting stamps `data-lenis` on `<html>`, which turns off the CSS
  `scroll-behavior: smooth` so the two do not animate the same position at once.
- Lenis 1.x lerps real scroll position via `window.scrollTo`, which is why the
  security thread's `animation-timeline: view()` still works. Do not convert it
  to a transform wrapper.

Hash links are deliberately **left to next/link and the browser**. Intercepting
them requires beating next/link to the click, which in practice means a
capture-phase listener that stops propagation — and that kills every React
`onClick` on the link (including the mobile menu's close handler), breaks
cross-page anchors, and breaks the skip link's focus move. An eased jump is not
worth those regressions.

The mobile menu calls `stopSmoothScroll()` while open: `overflow: hidden` alone
does not stop Lenis, which drives `window.scrollTo` directly.

## Design

`DESIGN.md` is authoritative. The visual world is **security engraving — the
face of a banknote**, chosen because a banknote is state-issued trust made
portable and carried by the bearer, which is Pravaah's mechanism exactly. Every
note feature on `/security` maps to a real product mechanism.

Product truth lives in `PRODUCT.md`. Read both before changing copy or visuals.

## Content rules

Three constraints this site is built to keep. Breaking one is a correctness bug,
not a style preference.

1. **Roadmap is labelled as roadmap.** M0 (identity) and M1 (consent + data) are
   in service; everything else is in development. `StatusMark` renders this, and
   `lib/content/chain.ts` carries the `status` field that drives it.
2. **Unverified specifics are visible placeholders.** Legal entity, address,
   grievance officer, DPO and security contacts are unset. They live in
   `SITE_CONFIG.legal` and render through `<ReplaceBeforeLaunch>` so they cannot
   ship silently. `organisationJsonLd()` omits rather than publishes them.
3. **The apply sequence must not drift.** `lib/content/corridor-checks.ts`
   mirrors `REQUIRED_CHECKS` in `apps/pravaah-rn/src/features/kyc/flow.ts`. If
   the flow changes there, change it here — this page promises an order.

## Before launch

- [ ] Fill `SITE_CONFIG.legal` in `lib/config/site.ts` — entity name, registered
      address, grievance officer, privacy and security contacts.
- [ ] Have counsel review `/terms` and `/privacy`. Terms deliberately ships
      without liability, indemnity, governing-law or fee clauses; those are legal
      choices, not drafting ones.
- [ ] Set `NEXT_PUBLIC_SITE_URL` to the real origin.
- [ ] When the app is published, set `NEXT_PUBLIC_ANDROID_STORE_URL` and/or
      `NEXT_PUBLIC_IOS_STORE_URL`. `/get-app` switches from its pre-launch state
      to the deep-link handoff automatically — no code change.
- [ ] Add `app/favicon.ico` and an OG image.
- [ ] For iOS/Android deep links, serve
      `/.well-known/apple-app-site-association` and
      `/.well-known/assetlinks.json` for `com.pravaah.app`.
