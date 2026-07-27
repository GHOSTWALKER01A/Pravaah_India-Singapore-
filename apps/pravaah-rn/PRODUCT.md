# Product

<!-- impeccable:product-schema 1 -->

Scope: the **Pravaah mobile app** (`apps/pravaah-rn`). Product truth shared with the whole
system is recorded once in `apps/pravaah-web/PRODUCT.md` and inherited here; this file records
what is specific to the app surface. Where the two touch the same fact, the web file is
authoritative and this one must not contradict it.

## Platform

adaptive

One Pravaah identity on both operating systems, with each platform's manners honoured: iOS
keeps its edge-swipe back, system materials behind bars, and Dynamic Type; Android keeps
Material ripple, the predictive Back gesture, and correct window insets edge-to-edge. The
`web` target exists only as an Expo development convenience and is not a shipped surface.

## Users

Inherited: **the individual holder ("Ravi")** — a person who built a real financial life on
one side of the India ↔ Singapore corridor and is now a stranger on the other side.

What is specific to the app, and what the web surface never has to handle:

- **The web page persuades; the app is where the work actually happens.** By the time someone
  opens the app they have already decided Pravaah might be real. They are now doing labour:
  typing a PAN, holding their face still for a liveness challenge, leaving for DigiLocker and
  coming back, approving a consent on a third party's screen.
- **The scene is worse than the website's.** A mid-range Android, one hand, often at night,
  often after a rejection, often on metered mobile data with an unreliable connection. Some
  steps take them out of the app entirely and hope they return.
- **Failure is emotionally loaded.** A declined check is not a form error; it reads as the new
  country rejecting them again. Every failure state must name the problem, name the recovery,
  and never imply the person is at fault when the system is.
- **The app is used rarely and then intensely.** Onboarding is a one-time 4-minute push;
  afterwards the app is opened to check a score, show a credential, or revoke a consent.

## Product Purpose

The app is the holder's side of the credential: the place they **earn** the passport (M0
identity, M1 consent), **read** it (M2 score, explained), and **control** it (revoke, delete).

Success for this surface: a first-time user completes verification in one sitting without
needing help, understands what each check is for before they do it, can resume without loss
after a force-quit or a trip to DigiLocker, and can revoke a consent in under three taps and
believe the deletion happened.

## Positioning

Inherited and unchanged: **the credential is held by the user, not by us**, and the data
arrives over India's regulated Account Aggregator rail — never a bank password, never
screen-scraping.

The app-specific consequence: the passport must present as an object the user **possesses**,
not a dashboard record we grant them a view of. Any composition that reads "your account
status with us" contradicts the product.

## Operating Context

The real, implemented surfaces the app must serve (source of truth for the sequence is
`src/features/kyc/flow.ts` + `check-labels.ts`, and `src/features/consent/`):

**Auth.** Phone + country code → 6-digit OTP (SMS autofill, 30s resend cooldown) →
first-run onboarding → the app.

**Identity (M0), status-driven and resume-safe.** `GET` status returns `overallStatus`,
`country`, `checks[]`, `verifiedName`, `nextStep`; the client derives the next screen from
`REQUIRED_CHECKS[country]`. India rail: PAN → Aadhaar OKYC via DigiLocker → bank penny-drop
→ liveness → face match → sanctions. Singapore rail: Singpass Myinfo → liveness → face match
→ sanctions. Liveness, face match and sanctions are shared by both rails. A name mismatch
routes to human review, never an auto-reject; `IN_REVIEW` is polled so a reviewer's decision
lands without the user refreshing.

**Consent & data (M1).** Purpose presets → an explicit single "I agree" gate → consent
created → approval on the Account Aggregator's own hosted screen (deep-link return via
`parvaahrn://consent-return`) → encrypted fetch → feature sets ready. Dashboard lists every
consent with live status; revoke deletes the fetched data immediately and irreversibly.

**Score (M2).** Six states, each with a different next action: `COMPUTED`, `NO_CONSENT`,
`INSUFFICIENT_DATA`, `PENDING`, `EXPIRED`, `FAILED`. A computed score carries a value on a
300–900 scale, a band, a **confidence interval**, per-factor contributions, counterfactual
improvement tips, and the model name + version that priced it. Plus score history and an
optional, clearly-separated fairness self-report.

**Out-of-app excursions the design must survive.** DigiLocker (`Linking.openURL`), the
Account Aggregator approval page (`WebBrowser.openAuthSessionAsync`), and Singpass. Each can
return late, never, or with the app force-quit in between.

## Capabilities and Constraints

- **Expo SDK 54 / React Native 0.81.5 / expo-router 6**, typed routes and the React Compiler
  both enabled. `AGENTS.md` requires checking the versioned Expo docs before writing RN code.
- **Monorepo install is fragile and pinned.** Root `.npmrc` sets `legacy-peer-deps=true`;
  root `overrides` pin `react-native@0.81.5`, `react-native-screens@~4.16.0`,
  `react-native-safe-area-context@~5.6.0`; `metro.config.js` sets
  `resolver.disableHierarchicalLookup = true` so the app resolves a single `react@19.1.0`.
  Adding dependencies is a real risk and must be deliberate.
- **Deliberately lean by convention:** `fetch` not axios, React Context not react-query, TS
  types not zod. Approved for the design layer: `react-native-reanimated@4.1.1` (already a
  dependency, previously unused), `react-native-svg`, `expo-haptics`, and the three
  `@expo-google-fonts` families. `react-native-worklets` requires a Babel plugin, so a
  `babel.config.js` is mandatory for animation to run at all.
- **Not published.** No App Store or Play Store listing. Sandbox providers (mock AA screen,
  demo liveness tokens, in-app persona picker for Singpass) are reachable in dev and must be
  visibly labelled as sandbox, never dressed as production.
- **In-memory token storage.** `tokenManager` does not yet persist to `expo-secure-store`;
  this is a known documented gap, not a design decision.
- **Undecided / must not be invented:** launch date, pricing, licence status, certifications,
  partner names, user counts.

## Brand Commitments

- Name **Pravaah** (Sanskrit — *flow*). The package slug is `parvaah-rn` and the deep-link
  scheme `parvaahrn://`; both are misspellings that are load-bearing in code and must not be
  "corrected". User-facing text is always *Pravaah*.
- The app inherits pravaah-web's committed visual world — **security engraving, the face of a
  banknote** — rather than establishing its own. See `DESIGN.md`.
- Voice: plain English, short sentences, no jargon without an inline definition. Explain the
  rail; never hide behind it.
- **Pravaah ID** (`PVH-XXXX-XXXX-XXXX`) is the user's public identifier. The internal row UUID
  is never displayed. The ID is presented as something to read aloud or quote, so it is set in
  the mono face, wide-tracked, and selectable for long-press copy.

## Evidence on Hand

- `PRAVAAH-EXPLAINED-SIMPLE.md` (repo root) — authoritative plain-English product narrative.
- `apps/pravaah-web/DESIGN.md` — the committed visual world this app inherits.
- `src/features/kyc/flow.ts`, `check-labels.ts`, `gestures.ts` — the real check sequence,
  human labels, and liveness gesture set.
- `src/features/consent/consent-meta.ts` — the real purpose presets and FI-type copy.
- `src/features/score/score-meta.ts` — the real band cutoffs, states, and confidence copy.
- **Absent, must not be fabricated:** store listings, screenshots presented as shipped
  product, testimonials, and any score or user figure not returned by the API.

## Product Principles

1. **The user is doing labour, so remove every avoidable tap and never lose their progress.**
   Resume-safety is a design requirement, not an edge case.
2. **Tell them what a step is for before asking them to do it.** Consent is informed or it is
   not consent.
3. **A failure is about the system, not the person.** Name the problem, name the recovery,
   route borderline cases to review rather than rejection.
4. **The passport is possessed, not granted.** It must read as an object in the user's hand.
5. **Honesty over flattery in the number.** The confidence interval travels with the score
   everywhere it appears, including summaries; thin data must visibly produce a wide band.

## Accessibility & Inclusion

Treated as requirements, not aspirations:

- **WCAG 2.2 AA contrast is the floor** in both light and dark. Every token pair in
  `DESIGN.md` is verified numerically, not by eye.
- **Text scales with the OS setting.** No layout may break or clip at large accessibility
  sizes; the tab bar and buttons grow rather than truncate.
- **Touch targets ≥48dp** with ≥8dp separation — the Android floor, applied on both platforms
  because the hardware scene is a mid-range Android.
- **Reduce Motion is honoured** everywhere: the authored motion degrades to an instant,
  fully-legible state, never to hidden content.
- **Screen readers**: every control names its action; status is conveyed by label and shape,
  never by colour alone; decorative geometry is hidden from the accessibility tree.
- **English as a second or third language**: short sentences, no unexplained acronym. FIP,
  FIU, AA and OKYC each get an inline plain-English gloss at first use.
- **Legibility must survive a bright screen outdoors and a dim one at night** — the reason
  both themes are fully authored rather than one being an inverted afterthought.
