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

### The photo is the paper

A photo behind the type is not a sprite drawn onto the canvas. It replaces the
**ground** — the base colour every transparent ink multiplies down from. That
falls out of the compositor already reading paper as `rgb × shade`, and it is
why type genuinely overprints a photo rather than sitting on top of it: pink
over a white highlight goes bright, pink over a dark area goes deep.

"Paper over the photo" is how much of the stock's colour and tooth veils the
image. At 0 the print lands straight on the photo; at 1 the photo takes on the
paper's tint and grain the way printing on toned stock actually does. With no
photo the control is inert and the arithmetic collapses back to exactly what
the app drew before.

**Print the photo** runs it through the same press as the type — separated to
one ink by luminance, then roughened, worn, screened and misregistered. It gets
its own plate index rather than reusing the first: sharing a seed would
misregister the photo and the type *identically*, which reads as perfect
register, the one thing a Riso never has.

Separation is darkness, not brightness — ink is what gets added to paper, so
black wants full coverage and white none. Highlight dropout is a *rescale*
rather than a subtraction, so lifting the highlights out leaves the shadows as
black as they were; subtracting dims the whole image, which is the same "turned
the opacity down" mistake the wear passes exist to avoid.

#### Two presses, because a photo and a headline want different ones

The press settings are a `PressProfile`, and a document holds two — one for the
type, one for the photo. A screen coarse enough to read as *print* on a poster
word turns a photograph into mud; wear tuned to tear a letterform pleasantly
just reads as damage across a face. The first cut shared one profile, and every
change made for one ruined the other.

The Press and Wear tabs carry a **Type / Photo** switch, shared between them so
that moving from one tab to the other does not silently drop a photo edit onto
the type's pass. The seed is deliberately *not* per-profile: it is one sheet
going through one machine, so both passes vary together.

Documents written before the split carried the press fields at the top level.
They are lifted into both profiles on load, so a saved print reopens looking
exactly as it did and can be dialled apart from there.

#### Type that reads across the whole photograph

Type in one ink over a photograph is unreadable by construction: the image runs
from paper-white to solid, and no single transparent ink has contrast against
both ends. Black type disappears into the shadows; light type disappears into
the highlights.

So the pass switches ink by what is underneath it — a **split fountain driven
by the image** rather than by position across the drum. The type is pressed
*once* and then split by the mask, so the letterforms stay coherent; pressing
twice would misregister the halves against each other and tear every glyph
straddling the boundary.

Three things make it actually work:

- **The mask is thresholded on blurred luminance.** A photograph is full of
  local contrast — a bright speck in a shadow, a dark seam across a highlight —
  and thresholding raw pixels makes the ink flicker letter by letter, which is
  harder to read than either colour alone. Blurring lets the mask follow the
  large shapes the eye is judging against.
- **The switch is screened, not faded.** The mask starts soft so a glyph
  crossing the boundary does not change colour mid-stem, and is then run
  through the *same screen or dither the press is already using*. A soft mask
  left soft makes both inks print at partial coverage through the transition —
  which is an opacity crossfade wearing a print's clothes, and is exactly why
  the switch point read as a fade. Screened, each ink lands at full strength
  and the changeover breaks into dots the way a two-colour job actually does.
- **The photo is knocked back to paper under the second ink** — a transparent
  light ink over solid black is still solid black, so without this the second
  ink buys nothing.

Two things about that knockout took a second pass to get right, and both
turned reversed type to mush in the first cut:

- It is cut from the **unpressed tone**, not from the screened coverage.
  Knocking out with the halftone leaves the photo standing in every gap between
  the type's own dots, so the light ink prints onto a still-black ground. A
  stencil has a solid hole in it.
- It is applied **after the photo's press**, not before. Cutting it beforehand
  let the photo's own roughening, screening and misregistration carry the hole
  away from the glyphs it was meant to clear.

The hole is also **trapped** — spread a couple of pixels past the glyph, then
cut back to hard. Nothing on a press lands twice in the same place, so a
knockout cut exactly to the artwork shows a dark fringe the moment anything
shifts. Keeping the blurred skirt instead of cutting back gives the opposite
failure: a halo of bare paper round every reversed word, a glow rather than a
trap.

### Dithering as a real choice

Thirteen algorithms, because they are genuinely different textures rather than
one slider: Jarvis is smooth and slow, Burkes fast and contrasty, Sierra-Lite
coarse and cheap, and clustered-dot the only ordered pattern that still reads
as a *printing* screen rather than a computer effect — it grows one blob per
cell the way a real screen does instead of scattering isolated pixels.

**Dot size** matters as much as the algorithm. At one pixel per cell any of
these is invisible at export resolution and reads as flat tone; the chunky
duplicator look lives at several pixels per cell. It is implemented by
dithering a reduced grid and expanding the result, so every algorithm coarsens
the same way rather than each needing its own notion of size — and the
reduction *averages* rather than samples, or the dither tracks the noise
instead of the artwork.

### Per-word misprints

Bleed and offset are properties of a **plate**, not of a pixel: bleed is where
the stencil's threshold sits, offset is where the paper landed. So a word given
either comes off the main plate and goes through the press separately — which
is also exactly how a real second hit on one word would behave.

Words sharing a setting share a plate, so they tear and land together. Each
group gets its own registration seed, which is what makes an offset word land
somewhere the rest of the line did not. Both values are deltas on the layer's
press, so the global controls still move everything.

#### Nothing is ever stretched

The scale factor is the same on both axes, always. That is asserted directly —
across five source aspects, four zoom levels and four positions, the drawn
rectangle's aspect must equal the source's — rather than inferred from how a
render looks, because a squash of a few percent is invisible in a thumbnail and
obvious in a print.

It is *cover*, not contain: at 1 the photo fills the sheet and the overflow is
cropped, so a full-bleed print has no letterbox bars.

#### Bare sheet is paper, not black

Pan a photo off the trim and the uncovered strip has to print as paper. The
first cut printed it **black**, because `getImageData` hands untouched pixels
back as transparent *black* and reading the colour without the alpha takes the
zeros at face value. The ground is now the photo composited over white with the
veil forced fully on where there is no photo, which is bit-for-bit the paper
the app draws with no photo at all — there is a test asserting exactly that
equality.

#### Why the bytes are not in localStorage

Its quota is about 5 MB of *string*, and base64 inflates binary by a third; one
phone photo blows it and the throw takes the whole save with it. Photos live in
IndexedDB as Blobs, and the document keeps only the id and placement, so the two
stores can be written independently and a torn write costs a photo rather than
the print. Imports are downscaled to a 2048px long edge first — a 12-megapixel
photo decoded at full size is ~48 MB of RGBA, and holding two of those is the
iOS eviction path §4.2 exists to prevent.

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

### Justify by words, or by letters

Filling the measure means putting slack somewhere, and there are two honest
answers. **Justify by words** puts it beside the spaces: the words themselves
stay exactly as set and the gaps between them open up. **Justify by letters**
shares it across every gap, which is the solid rectangular block of type — and
which necessarily letterspaces a short line.

Words is the default, because a short line rendered as `S L O W  D O W N` is
rarely what anyone wanted. The choice appears under Alignment only while
justify is selected: it does nothing in any other mode, and putting it directly
beneath the control that switches it on beats leaving it inert in the panel.

A line with no spaces — one word on its own line — has no word gap to open.
Words mode leaves it at its natural width and parks it against a margin, left
or right by the "Lines of one word" control.

The first attempt spread its letters instead, reasoning that a line short of
the measure reads as a bug. That was worse: `go` printed as `g` at one margin
and `o` at the other, and `slow` came out as `s l o w` across the full column.
Tearing a word in half to satisfy a rectangle is never the right trade. Letters
mode still spreads a lone word, because there the spreading *is* the effect.

Tested: a lone word keeps exactly its natural letter gaps and width, sits at
whichever margin is chosen, and still spreads under letters mode.

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

### The sheet is sized by whichever axis binds

The preview stretched while the export came out correct — the same layout, one
of them lying. The export re-renders offscreen and never touches the page CSS,
so the distortion was purely in how the sheet element was sized.

The obvious spelling looks right and is not:

```css
height: 100%; width: auto; aspect-ratio: 4 / 5; max-width: 100%;
```

A definite height wins, `max-width` clamps the width, and `aspect-ratio` is
dropped rather than honoured — there is no error, the box is simply the wrong
shape. On a phone that squashed a 4:5 sheet to roughly 0.52:1.

The sheet now takes the *smaller* of the two fits — the container's width, or
the width that lets its full height fit — with the height following from the
aspect ratio, so both constraints hold at once and neither axis is ever clamped
alone. `container-type: size` on the wrapper is what makes `cqw`/`cqh` resolve
against the space the sheet is actually given.

### Why the preview drops resolution while you drag

The press is a dozen full-image passes per plate, so its cost goes with the
pixel count. A full-height preview frame measured over half a second on a
throttled phone profile — which meant dragging a slider froze the main thread,
and a frozen main thread makes *everything* feel broken: the drag, the scroll
behind it, the next tap. The picture keeping up is not the point; the thread
staying free is.

So while a value is still moving the preview renders at a fraction of the
height, and the full-quality frame lands once it settles. That is only safe
because every spatial quantity is already expressed against `REFERENCE_HEIGHT`,
so a smaller render is the same print at lower fidelity rather than a different
one — there is a test asserting the aspect matches at both heights.

Two things that are easy to get wrong here:

- **A cache per resolution.** The paper field, the noise fields and the
  rasterised glyphs are all keyed on size, so a single cache would be thrown
  away and rebuilt on every switch between draft and full — most of what the
  draft was meant to save.
- **A floor between draft frames.** `requestAnimationFrame` will ask for one
  every frame, and even a draft render is tens of milliseconds; without a floor
  the thread stays saturated and the *input* stutters even though the picture
  keeps up. The preview follows a drag at a comfortable rate instead of every
  tick, which is the normal bargain for an expensive filter.

Measured before and after on the same throttled profile, dragging a press
slider: 90th-percentile frame time went from **595 ms to 41 ms**. The export is
untouched — it always renders at reference height with its own cache.

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
justification, letter and word tracking, word-selectable background boxes, an
imported photo as the printing ground (plain or run through the press),
undo/redo, persistence, and save via the share sheet.

Photos only — **video is not in yet**. A JPEG cannot hold one, so it needs a
decision about what Save produces, and `MediaRecorder` on iOS Safari is limited
enough that it would have to be proven on a device rather than assumed.

Photo separation is currently to a **single ink**. Multi-ink colour separation —
the two- and three-colour Riso photo — is the obvious next step.

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
