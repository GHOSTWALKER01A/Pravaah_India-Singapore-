# Design

<!-- impeccable:design-schema 1 -->

Scope: the Pravaah **mobile app**. This file records how the committed world in
`apps/pravaah-web/DESIGN.md` is translated to native, and every rule that is specific to a
touch surface. The web file owns the world itself; where a value appears in both, the web file
is the origin and this one records the native adjustment and why it was necessary.

## Visual world

**Security engraving — the face of a banknote.** Inherited, not re-chosen.

The web surface is the *sheet*: one scroll, read once, in Persuade mode. The app is in
**Operate** mode — the holder is doing work — so the world translates from a page into an
object and a set of instruments:

| Note feature | Web surface | App surface |
|---|---|---|
| The note's obverse | An illustration of the credential | **The Passport screen is the note.** A real object with field, guilloche, serial, seal and latent panel |
| Security thread | Draws down the capture column as it scrolls | **The step rail.** One unbroken line with a seal per step, impressed in gold as far as the holder has got. Vertical wherever a full sequence is shown at once (the check list, the consent phases); a horizontal tick scale at the head of an individual step screen, where a vertical rail would compete with the task itself |
| Latent image (tilt to reveal) | Resolves at the base of the column | **The score.** Revealed by press-and-hold on the passport; the number is the latent image |
| Intaglio field | Alternating drenched regions | Committed regions: the passport, the tab bar, primary actions, and the corridor panels |
| Second-colour counters | The word under pressure | Revoke, delete, decline, failure — carmine, and nothing else uses it |
| Serial number | The credential's identity | The Pravaah ID, mono and wide-tracked, long-press to copy |
| Microtext | The audit trail under the surface | Real text at the microtext size: assurance lines, retention terms, model provenance |
| Guilloche rosette | Generated geometry | Generated `react-native-svg` geometry: the passport's corner medallion, the base interference band, the tab bar's top rule, and the first-run seal. Widths are measured with `onLayout`, never assumed |
| Multi-language panel | The cross-border holder | Currently only the two-letter corridor stamp (`IN`, `SG`, `IN ↔ SG`). **Under-delivered and known:** on a real Indian or Singaporean note this device is genuinely multi-script, and nothing in the app is. It is deliberately not faked with decorative script the product cannot actually localise into — when the app gains real i18n, this is where it belongs |

Refused defaults, named so they stay refused: the stock Expo tab bar with emoji glyphs; a
single vertical stack of same-size `backgroundElement` cards used as every screen's structure;
the indigo-primary-on-white fintech app; and the neon-on-near-black "premium" crypto wallet
that a dark-mode banknote could easily collapse into.

## Colour

Strategy: **Committed**, inherited. One saturated field colour carries whole regions. Intaglio
is never an accent scattered over neutral.

Both themes are fully authored and follow the OS, because the use scene demands it: a
mid-range Android held one-handed, outdoors in daylight *and* in a dim room at night, often
after a rejection. The web has no toggle because a printed object has none; a phone does have
an ambient-light problem, and pretending otherwise would fail the scene. There is still no
in-app theme switch — the OS is the only control.

**Light — rag.** The note as a printed object in daylight. Rag paper substrate, intaglio owning
whole panels.

**Dark — the note under UV.** Not an inversion. The ground drops below the field
(`#06120E`) so the intaglio field becomes the *luminous* object rather than the backdrop, and
the security features that only appear under ultraviolet — thread, latent panel, seal — carry
the gold. The passport is the brightest, most saturated thing on the screen in both themes,
which is what makes it read as possessed rather than displayed.

```
                     light (rag)   dark (UV)     verified
ground               #EEEFE7       #06120E       15.5:1 / 16.5:1 vs ink
groundSunk           #E2E5D9       #03090A       recessed wells, inputs
panel                #F5F6F0       #0E3B2E       raised engraved panel
field                #0E3B2E       #0E3B2E       the committed field — same in both
fieldDeep            #082018       #061B14       deepest press impression
fieldMid             #1A5A45       #1A5A45       engraved line work, keylines on field
ink                  #101911       #EEEFE7       15.51 / 16.48
inkDim               #4C5C50       #A8C4B6       6.14 / 10.21
inkFaint             #55635A       #8CA79A       4.62 / 6.26   (microtext floor)
carmine              #A81F3C       #F0788D       6.20 / 7.07
latent               #7A5A1E       #C79A46       5.48 / 7.40   (meaningful gold)
latentLine           #B08434       #B08434       decorative guilloche only, no information
cleared              #0E3B2E       #54BE97       10.77 / 8.35  (a passed check)
onField              #EEEFE7       #EEEFE7       10.77 on field
onFieldDim           #A8C4B6       #A8C4B6       6.67 on field
onFieldLatent        #D9AE5A       #D9AE5A       6.03 on field
onFieldCarmine       #F0788D       #F0788D       4.62 on field
ruleOnField          #38695A       #38695A       1.98 on field — keyline, both themes
```

`cleared` is why the status system needs a token rather than reusing `field`: on the
dark ground the field is 1.53:1, invisible. So a cleared check resolves to the field's own hue
lifted into legibility — still unmistakably intaglio, readable on the ground and on the panel.
`ruleOnField` exists for the same reason in reverse: in dark mode `panel` *is* `field`, so a
keyline tinted for the sheet disappears, and a line pressed into a dark plate catches the light
rather than losing it.

**All 86 pairs are machine-verified.** `node scripts/verify-contrast.mjs` reads this palette out
of `src/theme/tokens.ts` and exits non-zero on any failure; the ratios quoted here are its
output, not estimates.

**Two golds, and the distinction is load-bearing.** `latentLine` (#B08434) is 2.93:1 on rag —
it may only draw guilloche, rules and thread, where it carries no information. Anything a user
must *read or act on* uses `latent`, which clears 4.5:1 on every ground it is used against.
This is the one place the web's single `--latent` token had to split for native, because on
rag the web only ever used gold on the intaglio field.

**Status semantics come from the note's own two-colour system**, replacing the inherited
success-green / warning-amber / danger-red / info-blue rainbow, which had four unrelated hues
competing with a green brand field:

- **field (intaglio)** — `PASSED VERIFIED ACTIVE COMPLETED`. Mark: a filled seal.
- **latent (gold)** — `IN_PROGRESS PENDING IN_REVIEW MANUAL_REVIEW ACTION_REQUIRED PARTIAL PAUSED`. Mark: an open seal; animated only while genuinely in flight.
- **carmine** — `FAILED REJECTED REVOKED`. Mark: a struck seal. `REVOKED` is carmine because
  the second colour is *the word under pressure*, not because revoking is a bad outcome — in
  this product it is the money-shot.
- **inkDim** — `NOT_STARTED EXPIRED`. Mark: a hollow seal.

Status is never carried by colour alone: every state has a distinct seal shape and a label.

**Score bands are denominations.** A note series distinguishes value by colour, so the five
bands run as a real perceptual ramp *toward the field* — earning your way into the note.
Deliberately no red at the bottom: a `FAIR` score is a starting point, not a rejection, and the
old palette styled it like a failure.

```
              light      dark       on-ground contrast
POOR          #5F6B63    #A9B6AC    4.81 / 9.06    stone
FAIR          #6A5691    #B49FDA    5.41 / 8.10    lavender
GOOD          #245F84    #74B4DC    5.96 / 8.45    fluorescent blue
VERY_GOOD     #1A5A45    #54BE97    7.00 / 8.35    intaglio mid
EXCELLENT     #0E3B2E    #8FE0B8    10.77 / 12.29  the field itself
```

Every pair above is verified numerically in both themes, including bands on both grounds and
all three text tiers on the field. No pair ships unverified.

## Type

The three faces from the note's world, loaded via `@expo-google-fonts`:

- **Bodoni Moda** — the engraved denomination. Screen titles, the score value, the passport
  name. Native cap: **40sp**, not the web's 6rem; a phone measure cannot carry a didone larger
  than that without wrapping mid-word.
- **Archivo** — legends and body. The engraver's gothic legend is `Archivo_600SemiBold`,
  uppercase, `letterSpacing` ≈ 0.18em at its size.
- **Azeret Mono** — serials, check identifiers, dates, amounts, data-field values. Measurement
  only, never a costume for "technical".

**The one honest substitution:** the web's engraver's gothic uses Archivo's variable `wdth`
axis at 112–125. React Native cannot set font variation axes, and no static Archivo Expanded
family is published, so the native legend is `600SemiBold` + uppercase + tracking. The
recognisable trait — a wide, tracked, all-caps issuing line — survives; the width axis does
not. Do not attempt to fake it by scaling glyphs.

**Eight faces ship, and only eight.** `BodoniModa` 500/600, `Archivo` 400/500/600/700,
`AzeretMono` 500/600 — 707 kB total. They are imported by weight subpath
(`@expo-google-fonts/archivo/500Medium`), never from the package root: each family's root
`index.js` requires all 18 of its weights, which put ~2.7 MB of unused TTF in the bundle when
first built. Verified against `expo export` output. Adding a weight means adding a subpath
import, not switching to a root import.

Android renders Bodoni and Azeret Mono visibly lighter than iOS at the same nominal weight, so
`platformFamily()` promotes those two one step on Android. Without it the two platforms look
like two different designs.

**Native type rules the web file has no need for:**

- Sizes are `sp`-equivalent and **must scale with the OS font setting**. `allowFontScaling` is
  never set to `false` on content. The one exception is the passport serial, which is capped
  with `maxFontSizeMultiplier` because it is a fixed-width object that must not reflow.
- One legend per region, not an eyebrow over every block. The legend is the note's issuing
  line; scattering it everywhere is grammar nobody chose.
- Mono runs `fontVariant: ['tabular-nums']` so digits do not jitter while a value animates.

## Composition

**The screen is a sheet, not a stack of cards.** The single biggest failure of the incumbent
app was one `gap: 24` column of identically-sized filled cards on all 22 screens. Containers
come from the note and are chosen by role:

- **Field region** — drenched intaglio, owns its full bleed to the screen edges. The passport,
  the tab bar, the corridor panel.
- **Engraved panel** — hairline keyline, corner notch, ground fill. For grouped terms and
  assurance blocks. Never nested inside another panel.
- **Data-field grid** — legend label left, mono value right, hairline rules between. The
  default for anything that is a set of facts, replacing the card list.
- **Thread list** — the security thread down the left with step marks on it. The default for
  anything that is a *sequence*: KYC checks, consent phases.
- **Well** — a recessed inset (`groundSunk`) for inputs and code cells.

Ordered numbering is earned only where the order is information the reader needs: the
per-corridor KYC sequence, and the consent approve → fetch → ready phases. Nowhere else.

Screen frame: edge-to-edge with real window insets, horizontal gutter 20, a collapsing
title, and the scroll's bottom padding accounting for the custom tab bar.

## Motion

**One authored moment, translated: the tilt-reveal.** On the web, the thread draws down the
capture column as it scrolls. On a phone the note is in your hand, so the same gesture is
literal — **press and hold the passport and the latent panel resolves**: the guilloche shifts,
the thread brightens, and the score surfaces. It is the only place in the app where an
interaction reveals content rather than navigating, and it is what makes the passport an object.

The rest of motion is instrument feedback, not decoration:

- **Press** — `scale 0.97` on a spring, plus a hairline darkening of the pressed surface. Never
  `opacity: 0.6`, which was the incumbent's only press state everywhere and reads as disabled.
- **Haptics** — `expo-haptics`, tied to meaning and used sparingly: light on tab change and
  segment change, medium on a step completing, success on `VERIFIED`, warning on a failed
  check, and a single heavy tick on the revoke confirmation. Never on ordinary taps.
- **Tab change** — the gold thread indicator slides on a spring; the icon's engraved fill
  crossfades. Android additionally gets its native ripple.
- **Value arrival** — the score counts up to its value while the confidence band opens
  *outward from that value* to its true width. Driven through `useAnimatedProps` on a
  non-editable `TextInput`, so the interpolation stays on the UI thread instead of setting
  React state sixty times a second. Two invariants: the band never animates *narrower* than
  truth at any frame (so no minimum-width floor), and the count is hidden from assistive tech —
  the meter's own label states the final value once.
- **Errors** — a two-cycle horizontal shake on the OTP field, 3px amplitude. Nothing else
  shakes.

Exponential ease-out from an already-visible default. **Nothing is hidden waiting for an
observer.** Under Reduce Motion every animation above collapses to its final state instantly,
and the latent panel is simply resolved from mount — the reveal is never a gate on content the
holder cannot open.

The score axis is deliberately **linear, not a dial**, and that is a correctness decision
rather than a shortfall: it lets the confidence interval sit on the same axis and at the same
scale as the value. On an arc the interval becomes a second ring the eye reads as ornament, and
the whole position of the score surface is that thin data must visibly produce a wide band.

## Rules

- No emoji anywhere in the product UI. Iconography is the engraved SVG set, drawn in the
  note's own grammar. This was the incumbent's most visible failure: emoji in the tab bar,
  the rail flags, the onboarding list, and every empty state.
- No gradient text. Emphasis is weight, size, the field, or the second colour.
- Guilloche and microtext are **real generated geometry and real text** — never a raster
  texture, never lorem, and never laid over a region that has not earned it.
- Carmine is reserved. If a screen uses carmine for anything other than revocation, deletion,
  decline or failure, that is a bug.
- `latentLine` never carries information. `latent` never drops below 4.5:1 on its ground.
- No card holds another card. If content needs a panel inside a panel, the outer container was
  the wrong choice.
- **A keyline is never hard-coded from the palette.** `Panel` and `Field` publish whether their
  fill is the intaglio field, and `Rule`/`VRule` read it. This is not tidiness: in dark mode
  `panel` *is* `field`, so a sheet-tinted rule on a plate is 1.01:1 — invisible. Every hairline,
  every data-field divider and the corner notch depend on that context being correct.
- **A wash is a text ground, so it is verified as one.** `verify-contrast.mjs` composites the
  `rgba()` washes against every surface they can sit on. A low-alpha wash of a bright hue is
  banned in dark mode: it lightens whatever is beneath it, so the same token reads differently
  on the sheet and on a plate.
- Sandbox affordances (mock AA approval, demo liveness tokens, the Singpass persona picker)
  are always visibly labelled as sandbox and styled as instruments, never as production UI.
- Every touch target ≥48dp with ≥8dp separation, on both platforms.
- The confidence interval travels with the score everywhere the score appears.
