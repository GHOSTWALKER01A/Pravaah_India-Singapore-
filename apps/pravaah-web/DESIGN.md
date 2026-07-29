# Design

<!-- impeccable:design-schema 1 -->

## Visual world

**Security engraving — the face of a banknote.**

A banknote is state-issued trust made portable and carried by the bearer. That is MyPravaah's
mechanism exactly: a credential whose value travels with the person holding it. The note's
own anti-forgery vocabulary maps one-to-one onto the product, which is why this world is
functional rather than decorative:

| Note feature | Product meaning |
|---|---|
| Guilloche / lathe-work rosette | Tamper evidence — the thing that cannot be redrawn |
| Latent image (tilt to reveal) | The score, revealed only to the holder |
| Microtext | The audit trail under the surface |
| Security thread | The chain of trust running unbroken through every module |
| Multi-language panel | The cross-border, multi-lingual holder |
| Serial number | The credential's identity |
| Second-colour counters | The value, stated where it must not be missed |

The refused defaults, named so they stay refused: the navy-gradient fintech landing page with
a floating phone mockup and a row of trust badges; and its predictable opposite, the stark
white Swiss grid with one accent.

## Colour

Strategy: **Committed** — one saturated field colour carries 30–60% of the surface. Intaglio
green owns whole regions; it is never an accent scattered over neutral.

The use scene decides light vs dark: a mid-range Android held one-handed, outdoors in daylight
and in a dim room at night. A note is a light object, so rag is the substrate — but the page
alternates drenched intaglio regions with rag regions so night reading is never a single
harsh field. There is no theme toggle; a printed object does not have one.

```
--rag          #EEEFE7   security rag paper — cool, faint green cast. Never cream.
--rag-shade    #E2E5D9   the second tone of the sheet
--ink          #101911   text on rag
--intaglio     #0E3B2E   the committed field colour
--intaglio-deep #082018  deepest press impression
--intaglio-mid #1A5A45   engraved line work, panel fills
--reverse      #EEEFE7   text on intaglio
--reverse-dim  #A8C4B6   secondary text on intaglio — tinted from the field hue, never gray
--carmine      #A81F3C   second-colour iris print: the word under pressure
--latent       #D0A24A   TEXT gold — legends, seals, emphasised display
--latent-line  #B08434   ORNAMENT gold — guilloche, thread, bands, keylines. Non-text only.
```

The two golds are split by job because one value cannot do both. The ink-true
#B08434 measures **3.68:1** on the field — verified against the built pages, not
estimated — which fails AA at legend (12px) and body (15px) sizes. So text uses
the lightened `--latent` and hairline ornament keeps the deeper `--latent-line`,
which is where the darker strike looks better anyway.

Verified on the rendered pages: ink/rag far above AA · reverse/intaglio 10.8:1 ·
reverse-dim/intaglio 6.6:1 · carmine/rag 6.3:1 · latent/intaglio 5.3:1 ·
latent/intaglio-deep 7.3:1. Every text pair clears AA at its actual size.

The rule that follows from this: **an opacity modifier on a gold means ornament.**
`text-latent-line/40` is line work; bare `text-latent` is type. Reversing that is
how the failure got in the first time.

## Type

Chosen as objects from the note's own world, not from category habit.

- **Bodoni Moda** — display. A true didone: high stroke contrast, flat unbracketed serifs.
  This is the engraved denomination and legend face. Display caps at 6rem maximum.
- **Archivo** (variable `wght` + `wdth`) — text and legends. At `wdth` 112–125, all-caps,
  tracked +0.18em it becomes engraver's gothic for issuing-authority lines and field labels.
  At normal width it is the body face.
- **Azeret Mono** — serials, check identifiers, dates, and data-field values. Used for
  measurement and machine-readable data only, never as a costume for "technical".

Body measure 62–72ch. Tracking floor -0.03em on display. More space above a heading than
below it.

## Composition

The page is a sheet, not a stack of cards. Containers come from the note: engraved panels
with a hairline keyline and a corner notch, guilloche medallions, the data-field grid, and
the multi-language panel. **Same-size icon-heading-text cards are not the page structure.**

The home page's spine is a **capture column**: scattered financial history at the top,
combed out through the consent gate in the middle, concentrated into one serialised
credential at the base. *Pravaah* is flow, and the scroll is that flow — the etymology is the
reason for the composition, not a line of copy. It used to be printed under the wordmark and
is not any more: the seal does that job of saying "you are in the right place" better than a
nine-pixel gloss competing with the name above it.

Ordered numbering is earned only where the order carries information the reader needs — the
M0→M7 chain (each step is impossible without the previous one) and the per-corridor KYC
sequence. Nowhere else.

## Motion

One authored moment, not scattered hover effects: **the tilt-reveal**. A note tilted to the
light resolves its latent image. On the web that is the security thread drawing down the
capture column as it scrolls, resolving the credential's latent panel at the base. Exponential
ease-out from an already-visible default — content is never hidden waiting for an observer.
Everything collapses to a static, fully legible sheet under `prefers-reduced-motion`.

Two rules the moment depends on, both of which it silently lost once:

- **A scroll-driven keyframe may only touch `opacity`, `filter` and `transform`.** It runs on
  every scroll frame, so a layout property in it reflows the whole document each time — and
  this sheet carries several thousand-segment guilloche paths that then repaint with it. The
  latent panel animated `letter-spacing` and that is what made a fast scroll hitch and stall.
- **`overflow: clip`, never `overflow: hidden`.** `hidden` on one axis computes the other to
  `auto`, which makes the element a scroll container — and `animation-timeline: view()`
  resolves against the nearest scroll-container ancestor. Under `hidden` the thread was being
  driven by a box that never scrolls, so the authored moment was not running at all.

## Rules

- Never gradient text; emphasis is weight, size, or the second colour.
- Guilloche and microtext are real generated geometry, never a raster texture and never
  decoration laid over a section that has not earned it.
- Every factual claim traces to something the system does. Unverified specifics ship as
  visibly marked placeholders, never as confident prose.
- The product's stage is rendered from `STAGE`, never written into a page's prose, and both
  halves of it always appear together: eight modules built, no licence held. See PRODUCT.md.
- A status badge that reads the same on every row is either the argument or it is noise.
  Keep it when the uniformity is the point (the chain: a reader expects roadmap and finds
  none); remove it when it is not (the security ledger, where it was eight identical marks
  implying there were exceptions to hunt for).
