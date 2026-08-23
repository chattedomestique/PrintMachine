# Print Machine

Type in, Risograph print out. A single-screen, installable, iOS-first PWA that
renders text as an authentic multi-colour Riso print — real ink colours, angled
halftone screens, misregistration, ink mottle and paper tooth — and saves the
result straight to the camera roll via the share sheet.

**Deployed:** https://chattedomestique.github.io/PrintMachine/

## What "authentic" means here

A halftone filter is not a Riso. The things that actually make a print read as
printed, all of which this engine models:

| Effect             | Why it matters                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Angled screens     | Each ink gets its own screen angle. The interference between them is the rosette your eye reads as "printed". |
| Misregistration    | A real Riso pulls each colour on a separate pass and the paper never lands twice in the same place. This is the single biggest tell. |
| Subtractive overprint | Riso ink is transparent. Pink over blue is purple, not pink. Alpha compositing gets this wrong. |
| Ink mottle         | Drum ink lays down unevenly — low-frequency blotch plus speckle dropout.                          |
| Paper tooth        | The stock is not white and not smooth.                                                            |
| Density ceiling    | Riso ink never reaches full black. Capping density is what keeps it from looking like inkjet.      |
| Torn edges         | The master is a thermal stencil burned as a coarse raster, then ink is forced through it into paper fibre. Nothing in that chain makes a clean curve. |
| Misprints          | Drum streaks, ink drag along the feed direction, and patches where ink never transferred at all.  |

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

```sh
npm run lint       # ESLint, must exit 0
npm run typecheck  # tsc --noEmit
npm test           # Vitest, engine only
npm run build      # production build
PAGES=1 npm run build   # production build for the GitHub Pages sub-path
```

Icons are generated, not hand-drawn — `node scripts/gen-icons.mjs` redraws the
whole set from the same overprint math the app uses.

## Architecture

```
src/
  engine/    pure, framework-free canvas + typed-array maths. No React, no DOM
             events, no state. This is the product, and the only thing tested.
  state/     one settings reducer + Context over a coalescing undo/redo hook.
  ui/        token-driven, app-agnostic primitives.
  features/  app-aware composition — the only layer that knows what the app is.
  styles/    tokens.css (the design system) + index.css.
```

### Why fading is dots, not opacity

The compositor reads coverage as ink transmittance, so anything that scales
coverage *after* screening thins the ink film — a half-covered pixel renders as
half-strength ink, which is grey, and looks exactly like turning an opacity
slider down. Ink that fails to transfer does not go grey: the dots that print
are still full-strength pigment, there are simply fewer and smaller of them.

So every wear pass runs on the **tone**, before the screen. A failing region
then visibly breaks up into halftone rather than dimming. There is a test that
screens heavily-worn tone at zero dot softness and asserts the result is
strictly binary — no partial ink film anywhere — plus one that demonstrates the
opposite ordering producing the mid-tones it must not.

### How the edge tearing works

Not "add noise to the edge" — that gives a fuzzy edge, which is a different
thing and reads as a blur. Instead the glyph is softened into a wide gradient
and then cut back to hard with a threshold that itself wanders across the
image. Where the threshold noise runs high the edge bites inward; where it runs
low the ink bulges out. The result is a *hard* edge in the *wrong place* by a
varying amount, which is what a burned stencil actually produces.

### Touch

Gestures are scoped per control rather than left to the browser's guess.
Sliders take `touch-action: none` so a thumb drag with any vertical component
moves the value instead of scrolling the drawer; horizontal strips (swatches,
segmented controls, tabs, the plate strip) take `pan-x` so a swipe along one
cannot drift into a vertical scroll; the scrolling panel takes `pan-y` with
contained overscroll so a flick off its end never bounces the page behind it.

On the sheet: drag to move, two-finger pinch to scale and rotate, double-tap to
centre. A finger lifting mid-pinch re-seeds the gesture from the remaining one,
so the layer keeps panning instead of jumping. Every gesture writes the same
layer fields the sliders write, and arrow keys / +- / brackets mirror all of it
for keyboards.

### Layout

The controls are a fixed overlay, not a flow sibling. Their live height is
measured with a `ResizeObserver` and published as `--overlay-h`, which the
canvas reserves as bottom padding — so the sheet is always as large as it can
be, re-measuring as panels open and close. Tapping the open tab collapses the
drawer entirely for a full-height sheet.

`engine/` must never import from `state/`, `ui/`, or `features/`, and must never
touch React or the DOM beyond a canvas context handed to it. That constraint is
what lets the export path re-render a fresh, overlay-free frame with the exact
same code the preview uses.

## Deliberate deviations from the playbook

- **TypeScript, not the JS that Borders used.** The playbook makes TS strict the
  default (§2.1) and `tsc --noEmit` is in the CI gate.
- **p5.riso is ported, not depended on.** The library
  ([Sam Lavigne & Tega Brain](https://github.com/antiboredom/p5.riso)) is the
  right reference, but it isn't on npm, it requires all of p5.js, and its
  `halftoneImage()` allocates two buffers at 2× width *and* 2× height — at export
  size that is the iOS eviction path §4.2 exists to prevent. The ink table is
  lifted verbatim with credit and the screening/dithering is reimplemented as
  pure typed-array code, per §1.3 ("use the best algorithm, the best port — note
  the provenance and move on") and §14 ("don't add heavy dependencies").
- **Neutral gray chrome, not the playbook's warm `#F1EBE2`.** This app's job is
  showing what ink looks like on paper; tinted chrome shifts how the inks read.
  The one accent is Riso Fluorescent Pink.
- **`verify` also runs on pull requests**, not just pushes to `main`. §11.1 wants
  the CI gate hung on the PR; the §16.7 template only triggers on push.
- **Deploys to a `gh-pages` branch, not the OIDC Pages pipeline.** §2.1/§11.2
  prefer `configure-pages`/`deploy-pages` with `contents: read`, specifically to
  avoid handing a third-party action `contents: write`. This repo instead builds
  in CI and pushes `dist/` to `gh-pages` with `peaceiris/actions-gh-pages`,
  because every other PWA in this collection deploys that way and has its Pages
  source set to that branch. One deployment model across all of them is worth
  more than the narrower token scope. The `verify` gate is unchanged, and
  `deploy` publishes the artifact `verify` produced rather than rebuilding, so
  what ships is byte-for-byte what was checked.

## Status

Working: multi-plate type, the full press and wear model, forced paragraph
justification, undo/redo, persistence, and save via the share sheet. Text is the
first input; photo intake runs through the same separate → screen → misregister
→ overprint pipeline and lands next.

**Forced justification** stretches every line — including the last — to the
width of the widest line in the block, spacing between *characters* rather than
words. Justifying to an arbitrary measure instead of the widest line is what
makes the gap go negative and pulls glyphs on top of each other; there is a test
for that.

**Not yet verified on a real device.** The precache manifest demonstrably
contains the real hashed assets, and the `<a download>` save branch is proven in
a headless browser — but "boots in airplane mode from the home screen" and "the
share sheet actually puts the file in Photos" are claims only an iPhone can
settle. See `DEVICE-CHECKLIST.md`.

Export weighs in around 600 KB rather than the ~300 KB the playbook cites for
photographs. A halftone screen over paper grain is close to worst case for
JPEG — high-frequency detail in every block. Lowering quality to compensate
smears the dots, so the size stands as a deliberate trade.
