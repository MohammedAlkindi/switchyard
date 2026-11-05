import { ImageResponse } from 'next/og';

/**
 * The social card, drawn at build time rather than checked in as a PNG.
 *
 * It repeats the landing page's argument: one fixed block on every row beside a
 * varying one.
 *
 * ## These literals are a mirror of :root, and the mirroring is manual
 *
 * This file used to claim it "cannot drift from the palette in globals.css".
 * That was false the day it was written. Satori renders in its own context and
 * never sees the stylesheet, so every value here is a literal — and three of
 * them (`#14130F` as a plate, `#C0761F`, `#3D8DB8`) existed in no `:root` at
 * all. The card was the last dark surface in a product that is light on every
 * route, drawn in two colours the product does not own.
 *
 * Every constant below is now copied from `app/globals.css`, named after the
 * token it copies, and has to be updated by hand when that token moves. Saying
 * so is the honest version of the guarantee the old comment offered.
 *
 * ## Why the two series are not just two hues
 *
 * The old pair measured **1.03:1 against each other** (relative luminance
 * 0.2426 amber against 0.2350 steel). In greyscale, in print, or to a viewer
 * with achromatopsia the chart was one solid bar and its entire argument
 * disappeared — while looking fine on the monitor it was picked on.
 *
 * The pair here is the landing page's, chosen for luminance separation rather
 * than hue: --spot at 0.1597 and --ink at 0.0074, a 21.5x gap, which is
 * **3.65:1** between the two series and 5.01:1 / 18.29:1 against the --panel
 * they are drawn on. Both clear the 3:1 that WCAG 1.4.11 asks of a graphic
 * carrying meaning, and they stay separated with hue removed entirely.
 *
 * Luminance is still not the only channel: each series is named in the legend,
 * so the card reads without relying on any visual distinction at all.
 *
 * *Reversing it:* if either colour changes, re-derive both numbers against the
 * surface the bars sit on. A pair that fails this is not a subtle regression,
 * it is a chart with one series missing.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt =
  'contextbill: what your AI agents cost at API rates. Six turns of one session, each billed for the same fixed block of context before any work happens.';

// Mirrored by hand from :root in app/globals.css.
const BG = '#FAFAF9'; // --bg
const PANEL = '#FFFFFF'; // --panel
const SINK = '#F4F3F1'; // --sink
const HAIR = '#E6E4E0'; // --hair
const INK = '#16150F'; // --ink
const INK_2 = '#5A574E'; // --ink-2
const INK_3 = '#6E6A61'; // --ink-3
const SPOT = '#B4531B'; // --spot

const WORK = [46, 21, 9, 33, 14, 25];
const FIXED = 34;
const SCALE = 3.4;

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 12, height: 12, borderRadius: 3, background: color }} />
      <div style={{ fontSize: 19, color: INK_3 }}>{label}</div>
    </div>
  );
}

/**
 * Two columns, copy left and the artifact right, which is the landing hero's
 * own arrangement. The previous version stacked them and the card outgrew its
 * canvas the moment the legend was added: the ledger's bottom rows and the
 * whole supporting sentence rendered below 630px and were simply cut off, with
 * nothing failing. Satori clips silently, so this file is only correct if
 * somebody has looked at the PNG it produces.
 */
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: BG,
          display: 'flex',
          alignItems: 'center',
          gap: 48,
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div
            style={{
              fontSize: 24,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: INK_2,
              marginBottom: 24,
            }}
          >
            contextbill
          </div>
          <div style={{ fontSize: 62, color: INK, lineHeight: 1.06 }}>
            Know what your AI agents cost at API rates.
          </div>
          <div style={{ fontSize: 26, color: INK_2, lineHeight: 1.4, marginTop: 26 }}>
            You pay for the same context on every turn. This shows you how much.
          </div>
        </div>

        {/* The same report window the landing page draws, on the same surfaces:
            a --panel body under a --sink title bar, --hair between them, and
            the product's ambient lift so the panel reads as raised rather than
            dissolving into --bg. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: PANEL,
            border: `1px solid ${HAIR}`,
            borderRadius: 12,
            boxShadow: '0 20px 52px rgba(22, 21, 15, .13)',
            width: 400,
          }}
        >
          <div
            style={{
              display: 'flex',
              background: SINK,
              borderBottom: `1px solid ${HAIR}`,
              padding: '12px 20px',
              fontSize: 17,
              color: INK_3,
            }}
          >
            one session, six turns
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 22 }}>
            {WORK.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, height: 20 }}>
                <div style={{ width: FIXED * SCALE, background: SPOT, borderRadius: 3 }} />
                <div style={{ width: w * SCALE, background: INK, borderRadius: 3 }} />
              </div>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
              borderTop: `1px solid ${HAIR}`,
              padding: '16px 22px 18px',
            }}
          >
            <Legend color={SPOT} label="context you never typed" />
            <Legend color={INK} label="the work you asked for" />
          </div>
        </div>
      </div>
    ),
    size,
  );
}
