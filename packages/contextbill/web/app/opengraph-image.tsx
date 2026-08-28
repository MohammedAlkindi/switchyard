import { ImageResponse } from 'next/og';

/**
 * The social card, drawn at build time rather than checked in as a PNG, so it
 * cannot drift from the palette in globals.css.
 *
 * It repeats the landing page's argument: one fixed amber block on every row
 * beside a varying one. Tokens are written literally because this renders in a
 * separate context that never sees the stylesheet.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'contextbill: what your AI agents cost at API rates';

const BG = '#FAFAF9';
const INK = '#16150F';
const INK_2 = '#5A574E';
const PLATE = '#14130F';
const AMBER = '#C0761F';
const STEEL = '#3D8DB8';

const WORK = [46, 21, 9, 33, 14, 25];
const FIXED = 34;

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: BG,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 26,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: INK_2,
              marginBottom: 28,
            }}
          >
            contextbill
          </div>
          <div style={{ fontSize: 82, color: INK, lineHeight: 1.05, maxWidth: 900 }}>
            Know what your AI agents cost at API rates.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 30, color: INK_2, maxWidth: 520, lineHeight: 1.35 }}>
            You pay for the same context on every turn. This shows you how much.
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: PLATE,
              borderRadius: 22,
              padding: 26,
              width: 430,
            }}
          >
            {WORK.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, height: 20 }}>
                <div style={{ width: `${FIXED * 3.4}px`, background: AMBER, borderRadius: 4 }} />
                <div style={{ width: `${w * 3.4}px`, background: STEEL, borderRadius: 4 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
