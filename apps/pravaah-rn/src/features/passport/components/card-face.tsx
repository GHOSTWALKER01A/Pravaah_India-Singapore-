import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { SvgXml } from 'react-native-svg';

import { Family, platformFamily } from '@/theme';

/**
 * The physical card, drawn as an object.
 *
 * A metal-card treatment — faceted engraving, a gold keyline, an embossed credential number,
 * a chip and contactless mark — rendered in PRAVAAH's own world rather than the ruby-and-gold
 * of the reference: deep intaglio green with latent gold. That is not a recolour for its own
 * sake. The whole design system commits to one field colour and exactly two accents beyond it
 * (carmine for the word under pressure, latent gold for thread, seals and guilloche), and a
 * ruby card would be the app's only object that belongs to a different brand.
 *
 * The mark is the ROSETTE — the guilloche figure the app already uses for its seals and
 * medallions — not a generic diamond. It is Pravaah's symbol, and drawing it here is what
 * makes the card read as the same issuer as the note in the wallet.
 *
 * ── Everything is in a 856 × 540 viewBox ──
 * That is ISO/IEC 7810 ID-1 in TENTHS OF A MILLIMETRE (85.6 × 54.0 mm). So every coordinate
 * below is a real physical measurement: the chip is 9.6 mm wide because that is roughly what
 * an EMV chip is. It scales to any rendered width without a single magic pixel, and the same
 * numbers can be handed to a print vendor.
 *
 * ── Why this is a facsimile, not an interface ──
 * The card face does NOT scale with the OS font size, and its text is hidden from screen
 * readers behind one description. It is a picture of a physical object whose character
 * positions are fixed — growing the type would misrepresent it and overflow the fixed aspect
 * ratio. Every fact printed here is also present as real, accessible, scaling text in the
 * panels below it on the card screen.
 */

/** ISO/IEC 7810 ID-1, in tenths of a millimetre. */
const CARD_W = 856;
const CARD_H = 540;
export const CARD_ASPECT = CARD_W / CARD_H;

/** 3.18 mm corner radius — the ID-1 specification. */
const RADIUS = 32;

/**
 * The QR window on the back, as fractions of the card.
 *
 * Exported as fractions so the screen can lay the SERVER-rendered QR over it exactly at any
 * width. The QR is not redrawn here: it comes from one encoder shared by the wallet, the
 * console and the print vendor, and a second implementation would be a second chance for a
 * card that scans in one place and not another.
 */
const QR = { x: 56 / CARD_W, y: 168 / CARD_H, size: 248 / CARD_W };

interface CardArtwork {
  band: string | null;
  bandAccent: string;
}

export interface CardFaceProps {
  /** Measured width of the card in device pixels. */
  width: number;
  credentialNumber: string;
  artwork: CardArtwork;
  mrz: { line1: string; line2: string; line3: string };
  issuedAt: string;
  expiresAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
   Shared ornament
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The engraved ground: gradient field, faceted hairlines, sheen, and the gold keyline.
 *
 * The facets are generated rather than tiled with `<Pattern>`. A pattern would be fewer
 * elements, but its support varies across react-native-svg versions and a silently-missing
 * texture is exactly the kind of "works on my machine" difference this card cannot afford.
 * Forty-odd explicit hairlines are cheap and render identically everywhere.
 */
/**
 * Both facet families are module CONSTANTS, not memos.
 *
 * They were `useMemo(…, [])` — a computation over nothing but the card's fixed dimensions,
 * re-derived once per mounted `Ground`. Hoisted out they are computed exactly once for the
 * process, which is strictly better than anything either `useMemo` or the compiler can do
 * inside a component.
 *
 * Two opposing diagonal families at 30- and 42-unit pitch: the interference between them is
 * what the eye reads as a faceted metal surface rather than as stripes.
 */
const FACETS = diagonals(30, (offset) => `M${offset} ${CARD_H} L${offset + CARD_H} 0`);
const COUNTER_FACETS = diagonals(42, (offset) => `M${offset} 0 L${offset + CARD_H} ${CARD_H}`);

function diagonals(pitch: number, line: (offset: number) => string): string {
  const lines: string[] = [];
  for (let offset = -CARD_H; offset < CARD_W + CARD_H; offset += pitch) {
    lines.push(line(offset));
  }
  return lines.join(' ');
}

function Ground({ gradient }: { gradient: string }) {
  return (
    <>
      <Rect width={CARD_W} height={CARD_H} rx={RADIUS} fill={`url(#${gradient})`} />

      {/* Facets, clipped by the card's own rounded rect via the parent Svg's viewBox. */}
      <G opacity={0.5}>
        <Path d={FACETS} stroke="#B08434" strokeWidth={0.9} fill="none" opacity={0.3} />
        <Path
          d={COUNTER_FACETS}
          stroke="#B08434"
          strokeWidth={0.9}
          fill="none"
          opacity={0.2}
        />
      </G>

      {/* Sheen: a broad highlight top-left and a pooled shadow bottom-right. Two ellipses,
          because a metal card catches light across its whole face rather than in a hotspot. */}
      <Ellipse cx={200} cy={90} rx={520} ry={300} fill="#EEEFE7" opacity={0.045} />
      <Ellipse cx={760} cy={520} rx={340} ry={230} fill="#082018" opacity={0.4} />

      {/* The inner keyline — the design system's hairline, in gold. */}
      <Rect
        x={18}
        y={18}
        width={CARD_W - 36}
        height={CARD_H - 36}
        rx={RADIUS - 10}
        fill="none"
        stroke="url(#cardGold)"
        strokeWidth={1.6}
        opacity={0.6}
      />
    </>
  );
}

/**
 * The gold and field gradients.
 *
 * The gold ramp runs highlight → mid → shade → mid again, which is what makes a flat fill
 * read as METAL: a single colour reads as paint. Every stop is drawn from the theme's real
 * gold tokens (`onFieldLatent` #D9AE5A as the readable mid, `latentLine` #B08434 as the
 * decorative deep) rather than invented, so the card cannot drift away from the app's gold.
 */
function CardDefs({ id }: { id: string }) {
  return (
    <Defs>
      <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        <Stop offset="0" stopColor="#12452F" />
        <Stop offset="0.42" stopColor="#0E3B2E" />
        <Stop offset="0.68" stopColor="#1A5A45" />
        <Stop offset="1" stopColor="#082018" />
      </LinearGradient>
      <LinearGradient id="cardGold" x1="0" y1="0" x2="1" y2="1">
        <Stop offset="0" stopColor="#F2E2AE" />
        <Stop offset="0.3" stopColor="#D9AE5A" />
        <Stop offset="0.54" stopColor="#8A6524" />
        <Stop offset="0.76" stopColor="#E4C87A" />
        <Stop offset="1" stopColor="#B08434" />
      </LinearGradient>
      <LinearGradient id="cardStrip" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor="#0A2A20" />
        <Stop offset="1" stopColor="#04120D" />
      </LinearGradient>
    </Defs>
  );
}

/** Nested rings at rotating phase. Pure, so the compiler memoises the call on its arguments. */
function rosettePaths(
  cx: number,
  cy: number,
  radius: number,
  rings: number,
  petals: number,
): string[] {
  const steps = Math.max(160, petals * 22);
  return Array.from({ length: rings }, (_, ring) => {
    const k = ring / Math.max(1, rings - 1);
    const r = radius * (1 - k * 0.3);
    const amp = radius * 0.17 * (1 - k * 0.25);
    const phase = k * Math.PI;
    let d = '';
    for (let i = 0; i <= steps; i += 1) {
      const t = (i / steps) * Math.PI * 2;
      const rr = r + amp * Math.cos(petals * t + phase);
      const x = cx + rr * Math.cos(t);
      const y = cy + rr * Math.sin(t);
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return `${d}Z`;
  });
}

/**
 * The rosette — Pravaah's engraved mark.
 *
 * The same interference figure `guilloche.tsx` draws for seals and medallions, reproduced here
 * because a card must carry the issuer's own mark. Nested rings at rotating phase are what
 * produce engraving rather than a flower outline.
 */
function Rosette({
  cx,
  cy,
  radius,
  rings = 6,
  petals = 11,
}: {
  cx: number;
  cy: number;
  radius: number;
  rings?: number;
  petals?: number;
}) {
  const paths = rosettePaths(cx, cy, radius, rings, petals);

  return (
    <G opacity={0.42}>
      {paths.map((d, index) => (
        <Path key={index} d={d} stroke="#B08434" strokeWidth={0.8} fill="none" />
      ))}
    </G>
  );
}

/**
 * Embossed text: the same string drawn twice, the lower copy offset by one unit in a dark tone.
 *
 * How a real card's raised characters catch light — the shadow sits below and right of the
 * face. Cheap, and the single detail that most separates "printed" from "embossed".
 */
function Embossed({
  x,
  y,
  children,
  fontSize,
  fontFamily,
  letterSpacing,
  fill,
  anchor = 'start',
}: {
  x: number;
  y: number;
  children: string;
  fontSize: number;
  fontFamily: string;
  letterSpacing: number;
  fill: string;
  anchor?: 'start' | 'end' | 'middle';
}) {
  const common = {
    fontSize,
    fontFamily,
    letterSpacing,
    textAnchor: anchor,
  } as const;
  return (
    <>
      <SvgText x={x + 1.5} y={y + 1.5} fill="#04120D" opacity={0.55} {...common}>
        {children}
      </SvgText>
      <SvgText x={x} y={y} fill={fill} {...common}>
        {children}
      </SvgText>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Front
   ──────────────────────────────────────────────────────────────────────────── */

export function CardFront({
  width,
  credentialNumber,
  artwork,
  mrz,
  expiresAt,
}: CardFaceProps) {
  const height = width / CARD_ASPECT;
  const sans = platformFamily(Family.sansSemi);
  const sansMedium = platformFamily(Family.sansMedium);
  const mono = platformFamily(Family.monoSemi);

  const holder = holderFromMrz(mrz.line3);
  const band = artwork.band ? artwork.band.replace(/_/g, ' ') : '—';

  return (
    <View
      // ONE description, and the descendants hidden: a screen reader reading forty SVG text
      // fragments off a card picture is noise. The same facts are accessible text below.
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Pravaah Financial Reputation Passport card, front. Credential number ${credentialNumber}. Reputation tier ${band}. Valid until ${formatMonthYear(expiresAt)}.`}
      importantForAccessibility="yes"
      style={[styles.card, { width, height }]}
    >
      <Svg width={width} height={height} viewBox={`0 0 ${CARD_W} ${CARD_H}`}>
        <CardDefs id="cardFieldFront" />
        <Ground gradient="cardFieldFront" />

        {/* The mark, bled off the top-right corner as engraving rather than as a logo. */}
        <Rosette cx={742} cy={128} radius={172} />

        {/* Masthead */}
        <SvgText
          x={56}
          y={96}
          fontSize={42}
          fontFamily={sans}
          letterSpacing={11}
          fill="url(#cardGold)"
        >
          PRAVAAH
        </SvgText>
        <SvgText
          x={58}
          y={126}
          fontSize={14}
          fontFamily={sansMedium}
          letterSpacing={5}
          fill="#D9AE5A"
        >
          FINANCIAL REPUTATION PASSPORT
        </SvgText>

        {/* EMV-style contact pad. Decorative — this card's chip is an NFC tag, not a contact
            chip — but it is the single strongest visual cue that the object is a card. */}
        <G>
          <Rect x={56} y={170} width={96} height={74} rx={12} fill="url(#cardGold)" />
          <Path
            d="M56 195 L152 195 M56 219 L152 219 M88 170 L88 244 M120 170 L120 244"
            stroke="#7A5A1E"
            strokeWidth={1.2}
            fill="none"
            opacity={0.65}
          />
          <Rect
            x={88}
            y={195}
            width={32}
            height={24}
            fill="none"
            stroke="#7A5A1E"
            strokeWidth={1.2}
            opacity={0.65}
          />
        </G>

        {/* Contactless mark — this one is REAL: the card carries an NTAG216. */}
        <G stroke="#E4C87A" strokeWidth={3} fill="none" strokeLinecap="round">
          <Path d="M180 190 A 16 16 0 0 1 180 224" />
          <Path d="M192 180 A 26 26 0 0 1 192 234" />
          <Path d="M204 170 A 36 36 0 0 1 204 244" />
        </G>

        {/* The credential number, embossed. Grouped as it is printed — a human reads it in
            fours, and the dashes of the canonical form are the grouping. */}
        <Embossed
          x={56}
          y={330}
          fontSize={38}
          fontFamily={mono}
          letterSpacing={6}
          fill="url(#cardGold)"
        >
          {credentialNumber.replace(/-/g, ' ')}
        </Embossed>

        {/* Field grid */}
        <SvgText x={56} y={382} fontSize={13} fontFamily={sans} letterSpacing={3.4} fill="#D9AE5A">
          VALID THRU
        </SvgText>
        <SvgText x={56} y={410} fontSize={20} fontFamily={mono} letterSpacing={1.5} fill="#EEEFE7">
          {formatMonthYear(expiresAt)}
        </SvgText>

        <SvgText
          x={800}
          y={382}
          fontSize={13}
          fontFamily={sans}
          letterSpacing={3.4}
          fill="#D9AE5A"
          textAnchor="end"
        >
          REPUTATION TIER
        </SvgText>
        {/* The band, accented in ITS OWN colour — the one place on the card where a colour
            other than field or gold appears, because the tier is the card's value. */}
        <SvgText
          x={800}
          y={412}
          fontSize={24}
          fontFamily={sans}
          letterSpacing={2.4}
          fill={artwork.bandAccent}
          textAnchor="end"
        >
          {band}
        </SvgText>

        {/* Holder, embossed along the base as a card carries it. */}
        <Embossed
          x={56}
          y={488}
          fontSize={30}
          fontFamily={sansMedium}
          letterSpacing={4.4}
          fill="#EEEFE7"
        >
          {holder}
        </Embossed>
      </Svg>
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Back
   ──────────────────────────────────────────────────────────────────────────── */

export function CardBack({
  width,
  credentialNumber,
  mrz,
  issuedAt,
  expiresAt,
  qrSvg,
  verifyUrl,
}: CardFaceProps & { qrSvg: string | null; verifyUrl: string | null }) {
  const height = width / CARD_ASPECT;
  const sans = platformFamily(Family.sansSemi);
  const mono = platformFamily(Family.mono);
  const monoSemi = platformFamily(Family.monoSemi);

  // The QR window, positioned from the same fractions the frame is drawn at.
  const qrLeft = width * QR.x;
  const qrTop = height * QR.y;
  const qrSize = width * QR.size;
  const framePad = qrSize * 0.06;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Pravaah card, back. Scan or tap to start a verification. Nothing is shared until you approve it on this phone.`}
      style={[styles.card, { width, height }]}
    >
      <Svg width={width} height={height} viewBox={`0 0 ${CARD_W} ${CARD_H}`}>
        <CardDefs id="cardFieldBack" />
        <Ground gradient="cardFieldBack" />

        {/* Magnetic strip. Edge to edge, as a real one is, with a gold hairline top and bottom
            so it reads as an inlaid band rather than a black rectangle. */}
        <G>
          <Rect x={0} y={62} width={CARD_W} height={92} fill="url(#cardStrip)" />
          <Rect x={0} y={62} width={CARD_W} height={2} fill="url(#cardGold)" opacity={0.65} />
          <Rect x={0} y={152} width={CARD_W} height={2} fill="url(#cardGold)" opacity={0.65} />
        </G>

        {/* The gold frame the QR sits inside. Drawn here, filled by the overlay below. */}
        <Rect
          x={QR.x * CARD_W - 10}
          y={QR.y * CARD_H - 10}
          width={QR.size * CARD_W + 20}
          height={QR.size * CARD_W + 20}
          rx={14}
          fill="#F7F4EA"
          stroke="url(#cardGold)"
          strokeWidth={5}
        />
        <SvgText
          x={QR.x * CARD_W + (QR.size * CARD_W) / 2}
          y={QR.y * CARD_H + QR.size * CARD_W + 44}
          fontSize={14}
          fontFamily={sans}
          letterSpacing={3.4}
          fill="#D9AE5A"
          textAnchor="middle"
        >
          SCAN TO VERIFY
        </SvgText>

        {/* Right column. The reference SVG put a decorative BARCODE here; that is replaced by
            the real TD1 machine-readable zone. A drawn barcode implies scannability it does
            not have, whereas this zone genuinely parses and every check digit in it verifies —
            and a three-line MRZ is what the ICAO standard actually puts on an ID-1 card. */}
        <G>
          <SvgText x={356} y={200} fontSize={13} fontFamily={sans} letterSpacing={3.4} fill="#D9AE5A">
            MACHINE READABLE ZONE
          </SvgText>
          {[mrz.line1, mrz.line2, mrz.line3].map((line, index) => (
            <SvgText
              key={index}
              x={356}
              y={228 + index * 26}
              fontSize={17}
              fontFamily={monoSemi}
              letterSpacing={1.1}
              fill="#EEEFE7"
              opacity={0.92}
            >
              {line}
            </SvgText>
          ))}
        </G>

        {/* Tap to verify */}
        <G stroke="#E4C87A" strokeWidth={2.6} fill="none" strokeLinecap="round">
          <Path d="M362 336 A 11 11 0 0 1 362 360" />
          <Path d="M372 328 A 19 19 0 0 1 372 368" />
        </G>
        <SvgText x={396} y={356} fontSize={19} fontFamily={sans} letterSpacing={3} fill="url(#cardGold)">
          TAP TO VERIFY
        </SvgText>
        <SvgText x={356} y={392} fontSize={15} fontFamily={mono} letterSpacing={0.4} fill="#EEEFE7">
          {shortUrl(verifyUrl)}
        </SvgText>

        <SvgText x={356} y={432} fontSize={13} fontFamily={sans} letterSpacing={2.6} fill="#D9AE5A">
          {`ISSUED ${formatMonthYear(issuedAt)}`}
        </SvgText>
        <SvgText x={356} y={456} fontSize={13} fontFamily={sans} letterSpacing={2.6} fill="#D9AE5A">
          {`EXPIRES ${formatMonthYear(expiresAt)}`}
        </SvgText>
        <SvgText x={356} y={480} fontSize={13} fontFamily={mono} letterSpacing={0.8} fill="#A8C4B6">
          {credentialNumber}
        </SvgText>

        {/*
          Microtext footer.
          The reference read "SOVEREIGN FINANCIAL REPUTATION · REPUBLIC OF INDIA". That is
          deliberately NOT reproduced: Pravaah is not a sovereign issuer, and printing a
          state's name on a privately-issued credential is a false claim of official
          provenance — the kind that makes a document a forgery rather than a product. What
          replaces it is true, and says the two things a stranger holding this card most needs
          to know.
        */}
        <SvgText
          x={CARD_W / 2}
          y={516}
          fontSize={12}
          fontFamily={sans}
          letterSpacing={2.6}
          fill="#B08434"
          textAnchor="middle"
          opacity={0.85}
        >
          ISSUED BY PRAVAAH ON THE HOLDER&apos;S CONSENT · NOT A GOVERNMENT DOCUMENT
        </SvgText>
      </Svg>

      {/* The real QR, from the server's encoder, laid into its gold frame. */}
      {qrSvg ? (
        <View
          pointerEvents="none"
          style={[
            styles.qrOverlay,
            { left: qrLeft, top: qrTop, width: qrSize, height: qrSize, padding: framePad },
          ]}
        >
          <SvgXml xml={qrSvg} width="100%" height="100%" />
        </View>
      ) : null}
    </View>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read the holder's name off the MRZ.
 *
 * The name is taken from the machine-readable zone rather than fetched separately, because the
 * MRZ is what is actually PRINTED on the card — so the embossed line and the machine-readable
 * line cannot disagree. `SURNAME<<GIVEN<NAMES` is the ICAO format; filler becomes spaces.
 */
function holderFromMrz(line3: string): string {
  const [surname = '', given = ''] = line3.split('<<');
  const clean = (part: string) => part.replace(/</g, ' ').trim();
  const name = `${clean(given)} ${clean(surname)}`.replace(/\s+/g, ' ').trim();
  return name || 'CARDHOLDER';
}

/** `MM / YY`, the form a card prints an expiry in. */
function formatMonthYear(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '— / —';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = String(date.getUTCFullYear() % 100).padStart(2, '0');
  return `${month} / ${year}`;
}

/** Host + path, without the scheme or the opaque reference token. */
function shortUrl(url: string | null): string {
  if (!url) return 'pravaah.app/verify';
  const withoutScheme = url.replace(/^https?:\/\//, '');
  // The card's own reference is already encoded in the QR; printing it in readable text would
  // hand it to anyone who photographs the card.
  return withoutScheme.replace(/\/verify\/card\/.*$/, '/verify');
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    // A metal card has weight. The shadow is what stops it reading as a flat coloured panel.
    elevation: 6,
    shadowColor: '#04120D',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  qrOverlay: { position: 'absolute', backgroundColor: '#F7F4EA', borderRadius: 8 },
});
