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
| Boxes as plates    | A background box is its own plate in its own ink, so it screens, misregisters and wears like everything else — and the type overprints it. |

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

```sh
npm run verify         # the gate: lint + typecheck + test + build
npm run verify:offline # proves the build boots with no network
PAGES=1 npm run build  # production build for the GitHub Pages sub-path
```

`verify` is one script rather than four commands so that "it's green" means the
same thing locally as it does in CI. Running the steps by hand once let a
typecheck failure through, because `npm test` transpiles without type-checking
and a green test run looked like proof the whole chain passed.

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

### Offline, and why it is checked rather than inspected

N2 says "works offline" is a claim you must verify. It was previously verified
by reading the precache manifest and concluding it looked right — which is
inspection, and it is exactly how a broken offline story ships.

`npm run verify:offline` serves the built `dist/` at the real Pages sub-path,
waits for the service worker to install and claim, cuts the network, and cold
launches in a fresh tab — a reload can pass on memory cache alone. It runs in
CI. Serving at `/` instead would test a different app: the sub-path is exactly
where `navigateFallback` and the precache URLs go wrong, and it survives every
localhost test that skips it.

It is checked against two deliberate breakages: a missing worker, and a worker
that installs but precaches only the shell. The second is the failure the
playbook records — installable, and blank offline.

**On iOS the build being correct is not sufficient.** A home-screen PWA has to
be launched once *while online* before it will ever open offline; going straight
from "Add to Home Screen" into airplane mode fails regardless. The dot beside
the wordmark reports when precaching has finished, so that state is visible
before you are somewhere without signal rather than discovered there. It is only
as honest as the manifest, though — a truncated one would still turn it green,
which is what the CI check is for.

### Boxes, and why they are plates

A background box behind a word is not a rectangle drawn on top of the render.
It is its own plate, with its own ink and opacity, laid down *before* the type
and pushed through the identical roughen → wear → screen → misregister
pipeline. Anything less and it would be the one clean, undistressed rectangle
on an otherwise convincingly printed sheet.

Because the inks are transparent, the type then genuinely overprints the box:
pink type on a blue box comes out navy, and where two boxes overlap you get the
third colour. That is what a real second pass does.

Word positions come from the same layout pass that places the glyphs. A box
computed from one set of numbers while the glyphs are drawn from another drifts
apart, and drifts differently at every size — so there is one layout, and a
test asserting the engine's word grouping matches the plain whitespace split
the selection UI shows you.

### Two spacing controls, both global

**Letter tracking** letterspaces the layer. It lands on spaces as well as
letters, the way native `letter-spacing` does, so opening the type up widens
the gaps between words along with it rather than jamming the words together.

**Word tracking** is the extra on the gaps only, for when they should move
independently of the letters. Words keep their own widths; only the space
between them changes.

Justification has to respect that. It stretches lines by sharing slack across
the gaps, and measuring that slack from bare glyph widths throws the placed
gaps away and re-spreads them evenly — which silently converts word tracking
into letter tracking, leaving words no further apart than letters. So the
natural gaps are fed through and justification adds to them, keeping a word gap
wider than a letter gap by exactly the word tracking. There is a test, plus one
asserting lines still reach the measure, since "preserve the gaps" is also
satisfied by refusing to justify at all.

That is the whole model. An earlier version also had *per-word* tracking —
select individual words from a row of chips, letterspace just those. It was
removed: it answered a question nobody asked, and the selection UI was clutter
in a panel that should be sliders. Word-level selection still exists in exactly
one place, where it earns itself: choosing which words a background box sits
behind.

### Small type

The wear defaults are tuned against poster type — roughly 16% of the sheet
height. Applied unchanged to a paragraph they destroy it: a 9px screen pitch on
an 1800px sheet is about a 24 lpi screen where real Riso is nearer 100, so small
letterforms get eaten by their own halftone, and `bleed` fills the counters in
a, e and o until the word is a row of blobs.

So the press backs off with the rendered type size. `detailFactor` scales the
screen pitch, dot softness, edge roughness, bleed and misregistration together —
one factor, because moving them independently just trades which artefact
dominates. It is floored at 0.22 so small type still reads as *printed* rather
than resolving into clean vector, and it is `sqrt`-shaped so the fall-off is
gentle near poster size and steep where it matters.

A real press has one screen ruling per sheet regardless of point size, so
`detailScaling` can be switched off in the Press panel for that behaviour. It is
on by default because the honest version mostly looks like a mistake.

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
justification, letter and word tracking, word-selectable background boxes, undo/redo,
persistence, and save via the share sheet. Text is the first input; photo intake
runs through the same separate → screen → misregister → overprint pipeline and
lands next.

Lines break where you break them. There is no automatic wrapping yet, so a long
paragraph typed as one line stays one line and runs off the sheet unless
fit-to-width is on.

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
