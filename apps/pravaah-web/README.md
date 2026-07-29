# pravaah-web

The public marketing and information site for MyPravaah. It explains what the
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
| `/` | Introduction — the problem, how data reaches us, what you hold, the chain of trust |
| `/what-is-built` | The build record: all eight modules at depth, the decisions, the runnable checks |
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
  (main)/          marketing routes — home, what-is-built, how-to-apply, security
  (legal)/         long-form documents — privacy, rules, terms
  get-app/         app handoff (deep link + store fallback)
  layout.tsx       fonts, root metadata, JSON-LD, direction contract
lib/
  config/site.ts   URLs, store plumbing, STAGE, legal placeholders — single source of truth
  constants/       routes and navigation
  content/         page content as data
    chain.ts         the M0–M7 modules, their status and their rail status
    modules.ts       build facts, surfaces, evidence commands, decisions, refusals
    corridor-checks.ts  the identity sequence, mirrored from the app
    security.ts      note-feature → mechanism ledger, protections, stated gaps
  seo/             metadata builders and structured data
  styles/          Tailwind v4 tokens
ui/
  engraving/       guilloche, microtext, security thread — generated geometry
  primitives/      Legend, DataField, Button, StatusMark + RailMark
  layout/          Header, Footer, SiteLayout, DocumentShell
  motion/          SmoothScroll (Lenis, wheel only)
  home/ built/ apply/ security/ app-link/    per-page sections
```

Route groups own the chrome (`export { SiteLayout as default }`), so no page
mounts the header or footer itself.

## Scrolling

`ui/motion/SmoothScroll.tsx` wraps Lenis and is scoped to **wheel smoothing
only**. Five constraints are load-bearing — read the file's comment before
changing any of them:

- It is never constructed under `prefers-reduced-motion: reduce`, and it watches
  the preference live.
- Mounting stamps `data-lenis` on `<html>`, which turns off the CSS
  `scroll-behavior: smooth` so the two do not animate the same position at once.
- Lenis 1.x lerps real scroll position via `window.scrollTo`, which is why the
  security thread's `animation-timeline: view()` still works. Do not convert it
  to a transform wrapper.
- **`lerp`, never `duration` + `easing`.** Duration mode restarts its tween from
  zero on every wheel event, so under sustained wheeling the eased tail is never
  reached and the page appears to plateau and lurch. `lerp` accumulates, which is
  the correct model for continuous input.
- **The limit must stay true.** Lenis clamps to a limit it measured, and a stale
  limit is indistinguishable from a broken page — the sheet stops partway down
  and further wheeling does nothing. `resize()` is called on `load`, on
  `document.fonts.ready`, on orientation change, and after every client-side
  navigation.
- **`stopInertiaOnNavigate`.** Clicking a link mid-glide otherwise leaves Lenis
  animating toward a target measured on the page you just left, so the new route
  arrives already drifting and ignores the first wheel gesture. Lenis's own
  handler is bubble-phase on the window and calls only `reset()` — it does not
  preventDefault or stopPropagation, which is why it is safe here and a
  hand-rolled listener would not be.

`anchors` is deliberately left **off**. next/link already scrolls to the hash,
and enabling it would have both of them animating the same position.

### `overflow: clip`, never `overflow: hidden`

This is a correctness rule on this site, not a preference. Per CSS overflow, an
element with one axis set to `hidden` computes the **other** axis to `auto` — so
`overflow-x: hidden` silently makes the element a scroll container. Two things
break when that happens:

1. `animation-timeline: view()` resolves against the nearest scroll-container
   ancestor. Under `hidden` on `<body>` or on a section, the page's one authored
   motion was being driven by a box that never scrolls.
2. Lenis measures its scroll limit against a nested scroller and stops the page
   partway down.

`clip` clips identically and never creates a scroll box. Every clipped section on
the site uses it.

### Paint cost

Scroll-driven animations run per frame, so they may only touch composited
properties. `latent-resolve` once animated `letter-spacing`, which reflowed the
document on every scroll frame — and the sheet carries several
thousand-segment guilloche paths that then had to repaint with it. Keep those
keyframes to `opacity`, `filter` and `transform`. Guilloche sample counts scale
with lobe count and are already at the point where more segments change no
pixels; `.engraved` puts the rosettes in their own paint container.

Hash links are deliberately **left to next/link and the browser**. Intercepting
them requires beating next/link to the click, which in practice means a
capture-phase listener that stops propagation — and that kills every React
`onClick` on the link (including the mobile menu's close handler), breaks
cross-page anchors, and breaks the skip link's focus move. An eased jump is not
worth those regressions.

The mobile menu calls `stopSmoothScroll()` while open: `overflow: hidden` alone
does not stop Lenis, which drives `window.scrollTo` directly. The panel also
carries `data-lenis-prevent`, which is how Lenis is told to leave a nested
scroller's wheel events alone.

## The mark

`ui/engraving/Seal.tsx` generates the guilloche rosette seal — the official mark,
documented in `brand/README.md`. It is generated rather than imported because the
display master is 48KB of path data, and because an `<img>` gives up
`currentColor`, which the mark needs: it is struck in the field colour on rag and
in gold on the field.

Its constants are the ones in `brand/build.mjs`, duplicated a third time in
`apps/pravaah-rn/src/components/ui/logo.tsx`. **Change one, change all three.**
Do not fold it into `Guilloche` — that generator's seed and band count are dials a
section may turn for ornament, and sharing an implementation would mean retuning
a corner medallion silently restrikes the logo.

Three optical cuts, picked from the size the mark is *shown* at, never the file
size: `display` ≥128px, `standard` 44–128px, `small` ≤44px. The header uses the
small cut at 26px, the footer the standard cut at 48px.

## Design

`DESIGN.md` is authoritative. The visual world is **security engraving — the
face of a banknote**, chosen because a banknote is state-issued trust made
portable and carried by the bearer, which is MyPravaah's mechanism exactly. Every
note feature on `/security` maps to a real product mechanism.

Product truth lives in `PRODUCT.md`. Read both before changing copy or visuals.

## Content rules

Four constraints this site is built to keep. Breaking one is a correctness bug,
not a style preference.

1. **The stage comes from `STAGE`, and both halves are always stated.** All eight
   modules are built and verified; none of it is a live financial service. No page
   may put the stage into its own prose — the previous version hardcoded
   "identity and consent in service · scoring and passport in development" into a
   footer, a hero, a close, two legal documents and the app page, and every one of
   those was wrong for as long as it took to build the other six modules.
   `STAGE` lives in `lib/config/site.ts`.
2. **Module stage and rail stage are separate axes.** `StatusMark` renders whether
   the module is built; `RailMark` renders whether its regulated third party is
   the real one (`sandbox` for M0/M1/M4/M5/M6, `none` for M2/M3/M7). Collapsing
   them into one badge is the specific dishonesty available here. Both fields live
   on `ChainLink` in `lib/content/chain.ts`.
3. **Unverified specifics are visible placeholders.** Legal entity, address,
   grievance officer, DPO and security contacts are unset. They live in
   `SITE_CONFIG.legal` and render through `<ReplaceBeforeLaunch>` so they cannot
   ship silently. `organisationJsonLd()` omits rather than publishes them.
4. **The apply sequence must not drift.** `lib/content/corridor-checks.ts`
   mirrors `REQUIRED_CHECKS` in `apps/pravaah-rn/src/features/kyc/flow.ts`. If
   the flow changes there, change it here — this page promises an order.

A claim of the form "this works" belongs on `/what-is-built` with a command
beside it. `EVIDENCE` in `lib/content/modules.ts` holds them, and every command
in it must actually exist in the repository — a figure or a command a reader
cannot run is worse than saying nothing.

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
- [ ] Add an OG image. `app/icon.svg` is in place — the small cut of the seal
      struck on the intaglio field, matching `apps/pravaah-admin/app/icon.svg`
      except for that background, which is there because gold on transparent
      disappears against dark browser chrome.

      One honest caveat: the seal's strokes are a fixed fraction of its box, so
      at a 16px tab they land under half a device pixel and the figure reads as a
      faint smudge on green rather than as a rosette. `brand/README.md` warns
      about exactly this failure. A legible tab icon needs a **fourth, heavier
      cut** — fewer rings and a much thicker line, following the same
      thins-the-stack-as-it-shrinks principle as the other three. That is a brand
      decision and belongs in `brand/build.mjs`, not in an override here.
- [ ] For iOS/Android deep links, serve
      `/.well-known/apple-app-site-association` and
      `/.well-known/assetlinks.json` for `com.pravaah.app`.
