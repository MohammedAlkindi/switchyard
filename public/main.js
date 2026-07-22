"use strict";
/**
 * Switchyard landing page behavior.
 *
 * Three jobs, nothing more: copy buttons on the install commands, the
 * interlocking-diagram animation (signal aspects cycling in sync with a
 * caption, commit dots traveling the agent tracks), and scroll reveals.
 * All motion respects prefers-reduced-motion.
 */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/* ---------- copy buttons ---------- */
for (const btn of document.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', () => {
        const text = btn.dataset.copy;
        if (!text)
            return;
        void navigator.clipboard.writeText(text).then(() => {
            const original = btn.textContent;
            btn.textContent = 'Copied';
            btn.classList.add('copied');
            window.setTimeout(() => {
                btn.textContent = original;
                btn.classList.remove('copied');
            }, 1600);
        });
    });
}
/* ---------- scroll reveals ---------- */
const revealed = document.querySelectorAll('.reveal');
if (reducedMotion.matches || !('IntersectionObserver' in window)) {
    for (const el of revealed)
        el.classList.add('on');
}
else {
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.classList.add('on');
                observer.unobserve(entry.target);
            }
        }
    }, { rootMargin: '0px 0px -8% 0px' });
    for (const el of revealed)
        observer.observe(el);
}
/** The three verdicts `fleet check` actually reports, in signal order. */
const STATES = [
    {
        aspect: 'green',
        tag: 'CLEAN',
        text: 'no conflicting work between agents — junction clear, merges may proceed',
        proceed: true,
    },
    {
        aspect: 'red',
        tag: 'CONFLICTS',
        text: 'src/api/routes.ts touched by claude and codex — will conflict · merge held',
        proceed: false,
    },
    {
        aspect: 'amber',
        tag: 'UNCOMMITTED',
        text: 'codex has unsaved edits — simulation cannot see them · failing closed',
        proceed: false,
    },
];
const STATE_MS = 5200;
function setupDiagram() {
    const lampFor = {
        red: document.querySelector('#lamp-red'),
        amber: document.querySelector('#lamp-amber'),
        green: document.querySelector('#lamp-green'),
    };
    const captionTag = document.getElementById('caption-tag');
    const captionText = document.getElementById('caption-text');
    const trackClaude = document.querySelector('#track-claude');
    const trackCodex = document.querySelector('#track-codex');
    const dotClaude = document.querySelector('#dot-claude');
    const dotCodex = document.querySelector('#dot-codex');
    if (!captionTag || !captionText || !trackClaude || !trackCodex || !dotClaude || !dotCodex) {
        return;
    }
    let stateIndex = 0;
    function applyState(state) {
        for (const aspect of ['red', 'amber', 'green']) {
            lampFor[aspect]?.classList.toggle(`lit-${aspect}`, aspect === state.aspect);
        }
        if (captionTag && captionText) {
            captionTag.textContent = state.tag;
            captionTag.className = `caption-tag tag-${state.aspect}`;
            captionText.textContent = state.text;
        }
    }
    applyState(STATES[0]);
    // Reduced motion: hold the diagram on its green, explanatory state.
    if (reducedMotion.matches)
        return;
    window.setInterval(() => {
        stateIndex = (stateIndex + 1) % STATES.length;
        applyState(STATES[stateIndex]);
    }, STATE_MS);
    /* Commit dots travel each agent track; at a red or amber aspect they stop
       short of the junction instead of joining main — the diagram tells the
       same story the CLI does. */
    const lengthClaude = trackClaude.getTotalLength();
    const lengthCodex = trackCodex.getTotalLength();
    // The junction sits at the end of each agent path; holding dots wait here.
    const HOLD_AT = 0.86;
    const SPEED = 0.000055; // path fractions per ms — a calm, shunting pace
    const dots = [
        { el: dotClaude, path: trackClaude, length: lengthClaude, t: 0, offsetMs: 0 },
        { el: dotCodex, path: trackCodex, length: lengthCodex, t: 0.45, offsetMs: 900 },
    ];
    // Only animate while the diagram is actually on screen.
    let yardVisible = true;
    const yard = document.querySelector('.yard');
    if (yard && 'IntersectionObserver' in window) {
        new IntersectionObserver((entries) => {
            for (const entry of entries)
                yardVisible = entry.isIntersecting;
        }).observe(yard);
    }
    let last = performance.now();
    function frame(now) {
        const dt = now - last;
        last = now;
        if (!yardVisible) {
            requestAnimationFrame(frame);
            return;
        }
        const proceed = STATES[stateIndex].proceed;
        for (const dot of dots) {
            const next = dot.t + dt * SPEED;
            if (!proceed && dot.t < HOLD_AT && next >= HOLD_AT) {
                dot.t = HOLD_AT; // held at the home signal
            }
            else {
                dot.t = next >= 1 ? 0 : next;
            }
            const point = dot.path.getPointAtLength(dot.t * dot.length);
            dot.el.setAttribute('cx', String(point.x));
            dot.el.setAttribute('cy', String(point.y));
            dot.el.style.opacity = document.hidden ? '0' : '1';
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}
setupDiagram();
