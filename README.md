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
| Wear (ink mottle)  | Drum ink lays down unevenly — low-frequency blotch plus speckle dropout, on one control.           |
| Paper tooth        | The stock is not white and not smooth.                                                            |
| Density ceiling    | Riso ink never reaches full black. Capping density is what keeps it from looking like inkjet.      |
| Edge (torn edges)  | The master is a thermal stencil burned as a coarse raster, then ink is forced through it into paper fibre. Nothing in that chain makes a clean curve: the tear and the ink's bleed, on one control. |
| Backing as a plate | A block behind the type is its own plate in its own ink, so it screens, misregisters and wears like everything else — and the type overprints it into a third colour. |

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

### Saved prints keep opening

Every stored document, whichever build wrote it, goes through one whitelist
normaliser (`state/normalize.ts`) driven by a schema (`state/fields.ts`). The
result is *built* from the defaults, copying across only fields the schema
lists, each checked against its own rule — a number finite and inside the
range any control could set, an ink, face or paper one that exists, a nullable
field null or valid. So a field a build removed leaves the document instead of
riding along forever, and every valid value a person chose survives. Spreading
the stored document over the defaults, which this replaced, kept every removed
field, and a `typeof`-of-the-default check would reset any field whose default
is null (a chosen second ink is a string, its default `null`).

Frozen documents written by older builds live in `state/__fixtures__/`, and the
tests load each one: it opens, normalising it twice changes nothing, no key
survives that the current model does not have, and no valid value is lost.

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

"Paper over the photo" is a switch. On, the photo takes on the stock's tint
and grain the way printing on toned paper actually does, so the photo and the
type read as one printed sheet; off, the ink lands straight on the photograph's
own colour. With no photo the switch is inert and the arithmetic collapses back
to exactly what the app draws on bare paper.

The photo is never printed itself — no separation, no screen, no second press.
Halftoning the photograph is a different job ("riso a photo"); here it is the
ground, shown as shot, and the type is what goes through the press.

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
  through the *same screen or grain the press is already using*. A soft mask
  left soft makes both inks print at partial coverage through the transition —
  which is an opacity crossfade wearing a print's clothes, and is exactly why
  the switch point read as a fade. Screened, each ink lands at full strength
  and the changeover breaks into dots the way a two-colour job actually does.
  Each plate switches at its own **Switch point**, because where the change
  belongs depends on the photo and on the pair of inks; plates that share a
  point share one mask.
- **The photo is knocked back to paper under the second ink** — a transparent
  light ink over solid black is still solid black, so without this the second
  ink buys nothing.

Two things about that knockout took a second pass to get right, and both
turned reversed type to mush in the first cut:

- It is cut from the plate's **tone**, not from its screened coverage.
  Knocking out with the halftone leaves the photo standing in every gap between
  the type's own dots, so the light ink prints onto a still-black ground. A
  stencil has a solid hole in it.
- It is cut from the **same pressed outline** the ink lands on: the plate's own
  torn, bled tone and its own registration offset, which `pressPlate` hands to
  `knockoutMask` (`engine/knockout.ts`) rather than the knockout roughening the
  tone a second time. A hole a couple of pixels off the ink could only be
  covered by spreading it, which at text size swells every counter shut.

There is **no trap**. The hole travels with the plate, so there is nothing to
trap against — and what the eye reads as a reversed word is the *hole*, not the
ink: bare paper and a light ink are nearly the same colour, so the letterform
you see is the shape of the cut. Spreading it would not protect the letter, it
would fatten it. The cut is only hardened past the anti-aliased skirt.

**Keep this ink.** The second ink can be the plate's own ink. Then both halves
print that ink, and the photo is cut back to paper wherever it is darker than
the ink, so one colour reads across the whole photograph — the riso way, with
the ink still transparent. The choice comes first in the second-ink picker, and
it follows the plate when its ink changes. It has no Switch point: both halves
print the same ink, so moving the switch would change nothing, and the panel
does not offer it.

### The press: two screens, two kinds of wear

A Riso driver screens with dots or with grain, so the Press tab offers exactly
those: **Halftone** (round dots on an angled lattice, a different angle per
plate so the screens beat into a rosette) and **Grain** (Atkinson error
diffusion, which carries only 6/8 of the error and so blows out highlights and
crushes shadows — the crunchy duplicator look). One **Screen size** drives both:
the halftone's dot pitch, and a grain cell a third of it, so the 9 px default
screen gives the 3 px grain the press always shipped with. The grain is made by
dithering a reduced grid and expanding it, and the reduction *averages* rather
than samples, or the grain tracks the noise instead of the artwork. Dot shape
(round), dot softness (0.7 px) and the grain threshold (one half) are fixed:
research knobs, not choices a print needs.

The wear is the two things a person can name. **Edge** is "the letters are
ragged": the burned stencil's tear and the ink's bleed past it, which are the
same threshold pass, moved together at the ratio the press always shipped
with. **Wear** is "the ink is blotchy": drum mottle and speckle dropout, the
same failure at two grains, moved together the same way. At their defaults
both reproduce the shipped amounts exactly. **Ink** is the density ceiling and
**Misregistration** where each pass lands. **Re-roll** pulls another sheet: a
different tear, mottle, registration and paper grain from the same settings.

#### Nothing is ever stretched

The scale factor is the same on both axes, always. That is asserted directly —
across five source aspects, four zoom levels and four positions, the drawn
rectangle's aspect must equal the source's — rather than inferred from how a
render looks, because a squash of a few percent is invisible in a thumbnail and
obvious in a print.

It is *cover*, not contain: at zoom 1 the photo fills the sheet and the
overflow is cropped, so a full-bleed print has no letterbox bars. Zoom only goes
in, 100–400%: below the cover fit there would be bare sheet round the photo,
and no sensible size to export it at.

#### The photo always covers the sheet

Panning is limited to where the photo still covers the sheet: its centre can
move until one of its edges reaches the trim, and no further. That limit is
enforced **where the sheet is drawn** (`coverRect` clamps whatever placement it
is handed), and again by every edit that moves the photo, zooms it or changes
the sheet's shape, so the stored value is honest too. The second place matters
because a pan that is legal on one sheet is not on another: push a landscape
photo to one side on a square sheet, switch to 4:5, and without it a strip of
bare sheet would print. A property test throws random sheet changes, pans and
zooms at the document and checks the sheet stays covered after every one.

The compositor still treats a transparent ground pixel as paper rather than
black — `getImageData` hands untouched pixels back as transparent *black*, and
the first cut printed exactly that. Panning can no longer uncover the sheet, but
the same path carries the knockout under the second ink (the photo's alpha goes
down there) and a transparent PNG's own transparency, and there is a test that
uncovered ground is bit-for-bit the paper the app draws with no photo at all.

<!-- WP2: import resolution (the 2048 px downscale below) is rewritten in WP2. -->
#### Why the bytes are not in localStorage

Its quota is about 5 MB of *string*, and base64 inflates binary by a third; one
phone photo blows it and the throw takes the whole save with it. Photos live in
IndexedDB as Blobs, and the document keeps only the id and placement, so the two
stores can be written independently and a torn write costs a photo rather than
the print. Imports are downscaled to a 2048px long edge first — a 12-megapixel
photo decoded at full size is ~48 MB of RGBA, and holding two of those is the
iOS eviction path §4.2 exists to prevent.

### Backing, and why it knocks out

A plate can carry a **backing**: a solid block of ink behind each line of its
type, the line's ink (first letter to last, so an indent or a stray space is
not covered) plus 0.12 em all round, square-cornered. It is not a
rectangle drawn on top of the render. It is its own plate in its own ink, laid
down *before* the type and pushed through the identical roughen → wear → screen
→ misregister pipeline, so it tears and lands like everything else on the
sheet. The blocks are read off the same layout that places the glyphs, so a
block can never drift from its line at any size.

Because the inks are transparent, the type then genuinely overprints the block:
pink type on a yellow backing comes out red-orange. That is what a real second
pass does.

The photo is **knocked back to paper under the block's own pressed outline**,
by the same `knockoutMask` the second ink uses. Without it a pale block over a
dark part of the photo would be invisible — a transparent yellow over black is
black — so the block prints on paper wherever it is, and reads the same over any
part of the picture.

A plate takes a backing **or** a second ink, never both. The second ink decides
each glyph's ink from the photo's luminance, but over a backing the real ground
is the block, so a light second ink chosen for a dark patch of photo would land
on the block and vanish. The Ink panel offers them as one choice — Over the
photo: Off, Second ink, Backing — and the document rules hold it in the reducer
and the normaliser too.

Saved prints with word-picked boxes open with a backing in the first worded
box's ink: per-line instead of per-word, which is the one visible change. Word
numbers in a box never followed the words when the text was edited, so an
inserted word silently moved every box; the backing has nothing to go stale.

### The plate budget

At most **3 text plates and 4 pressed passes** — a backing is a pass of its
own, while a second ink is pressed once and then split, so it counts once.
Every pass is a full press at export resolution, so the cap is what keeps the
worst export knowable on a phone. Over budget, Add and Backing are disabled and
the panel says why. A print saved with more plates keeps all of them: dropping
a plate would destroy work, and a slow save is recoverable.

### Type: one size, set as typed

The text prints exactly as typed — there is no case switch (the keyboard asks
iOS for capitals already) and no hidden transform. The size is the size: **Fit**
is a one-shot action that measures the widest line and stores the size at which
it spans 92% of the sheet's width. It used to be a mode that scaled the type in
layout and never stored the result, so the slider, a pinch and the `+`/`-` keys
all started from a stale size and the first touch jumped. Now there is one size
and one source of truth; editing the text does not re-fit, tapping Fit again
does. `fitSize` is pure and takes the sheet's aspect as a number and the text
measure as an argument, so it is tested in node with a stand-in measure: the
widest line lands on 92% of the width to within a pixel at every render height.

The weight decision that matters over a photo is regular or bold — heavier
strokes survive the screen, the tear and the bleed — so it is a **Bold** switch
(700 or 400). The faces are Poster, Grotesk, Serif and Mono; all four are system
stacks, so nothing loads and everything works offline.

### Tracking and line height

**Letter tracking** letterspaces the layer. It lands on spaces as well as
letters, the way native `letter-spacing` does, so opening the type up widens
the gaps between words along with it rather than jamming the words together.

**Line height** is the leading. A stacked caps headline wants it tight; a
two-line caption in mixed case needs it open, or its descenders meet the next
line's ascenders.

Justification has to respect the tracking. It stretches lines by sharing slack
across the gaps, and measuring that slack from bare glyph widths throws the
placed gaps away and re-spreads them evenly. So the natural gaps are fed through
and justification adds to them.

### Justify: one rule per line

Filling the measure means putting slack somewhere, and each line gets the
honest answer for what it holds, with no setting:

- **A line with a space** justifies by its word gaps. The slack goes beside the
  spaces, so the words stay exactly as set — a short line never comes out as
  `S L O W  D O W N`.
- **A line without a space** spreads its letters. That is the solid poster
  stack: `PRINT` over `MACHINE`, both spanning the block.

Every line, the last included, ends at the widest line; a single glyph has no
gap to open and stays where it is. Under Justify a line is its ink, first letter
to last: a space before the first letter or after the last has no word on its
far side, so it is not a word gap, takes no slack and adds no width — `PRINT `
and ` PRINT` set exactly like `PRINT`, and a line of nothing but spaces stays
empty. This replaced two controls (Justify by words/letters, and a margin for
lines of one word) whose default left the default two-line stack unjustified.

What it gives up: a lone short word inside a block of sentences can no longer
be parked at a margin; it spreads across the measure. Lines break only where
you break them, so the way to avoid that is to break the line differently.

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

It has to reach the **wear** as well as the screen, and for a long time it did
not. Tear, bleed, screen pitch and registration all scaled to the type while
the wear stayed sized for the sheet. On a poster that is fine. On body copy the
blotch cell is about the height of a letter, so the wear stops texturing the
ink and starts eating the letterform.

That failure is particularly confusing because it looks exactly like a tear that
will not turn down — and turning the tear down was never going to touch it. It
shows up worst on reversed type, where every dropout speck is a hole punched
through a white letter on a dark ground rather than a bit of texture on paper.

The mottle field is generated once per sheet, so rather than regenerate it per
plate it is **strided** — read with a step larger than one, walking through the
same noise faster and so yielding proportionally finer blotch. There are tests
that finer detail really does raise the spatial frequency, and that full detail
is byte-identical to the old behaviour, because poster type was right all along.

Detail scaling is always on. A real press has one screen ruling per sheet
regardless of point size, but here the honest version mostly looks like a
mistake: the coarse screen and the wear eat small type.

### Why fading is dots, not opacity

The compositor reads coverage as ink transmittance, so anything that scales
coverage *after* screening thins the ink film — a half-covered pixel renders as
half-strength ink, which is grey, and looks exactly like turning an opacity
slider down. Ink that fails to transfer does not go grey: the dots that print
are still full-strength pigment, there are simply fewer and smaller of them.

So the wear runs on the **tone**, before the screen. A failing region then
visibly breaks up into halftone rather than dimming. There is a test that
screens heavily-worn tone at zero dot softness and asserts the result is only
bare paper or solid ink, with fewer dots than the clean tone and never a paler
one — plus one that demonstrates the opposite ordering producing the mid-tones
it must not.

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

<!-- WP2: export resolution ("always renders at reference height", below, and the export size in Status) is rewritten in WP2. -->
### Why the preview drops resolution while you drag

The press is several full-image passes per plate, so its cost goes with the
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

<!-- WP3: Touch and Layout are rewritten for the style guide's dock in WP3. -->
### Touch

Gestures are scoped per control rather than left to the browser's guess.
Sliders take `touch-action: none` so a thumb drag with any vertical component
moves the value instead of scrolling the drawer; horizontal strips (swatches,
segmented controls, tabs, the plate strip) take `pan-x` so a swipe along one
cannot drift into a vertical scroll; the scrolling panel takes `pan-y` with
contained overscroll so a flick off its end never bounces the page behind it.

On the sheet: drag to move, two-finger pinch to scale and rotate, double-tap to
centre. With the Photo tab open the same gestures pan and zoom the photo
instead (100–400%, never off the sheet), and double-tap fits it again. A finger
lifting mid-pinch re-seeds the gesture from the remaining one, so the layer
keeps panning instead of jumping. Every gesture writes the same layer fields
the sliders write, and arrow keys / +- / brackets mirror all of it for
keyboards. The selected plate shows a crosshair on the sheet — the one editing
aid, and it never reaches a saved file.

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

<!-- WP3: this list changes with the move to the style guide in WP3. -->
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

Working: up to three plates of type (face, Bold, size with a one-shot Fit, line
height, tracking, rotation, alignment with per-line justify), each in a real
Riso ink with an optional second ink or backing over the photo; the press
(halftone or grain, screen size, ink, misregistration, Edge, Wear, Re-roll,
stock); an imported photo as the printing ground (shown as shot, zoomed and
panned within the sheet, paper over it or not); undo/redo, persistence that
opens every older save, and save via the share sheet. Four tabs: Type, Ink,
Photo, Press.

Photos only — **video is not in yet**. A JPEG cannot hold one, so it needs a
decision about what Save produces, and `MediaRecorder` on iOS Safari is limited
enough that it would have to be proven on a device rather than assumed.

Lines break where you break them. There is no automatic wrapping yet, so a long
paragraph typed as one line stays one line and runs off the sheet until you tap
Fit (or size it down).

**Forced justification** stretches every line — including the last — to the
width of the widest line in the block: by its word gaps where it has any, by its
letters where it has none. Justifying to an arbitrary measure instead of the
widest line is what makes the gap go negative and pulls glyphs on top of each
other; there is a test for that.

**Not yet verified on a real device.** The precache manifest demonstrably
contains the real hashed assets, and the `<a download>` save branch is proven in
a headless browser — but "boots in airplane mode from the home screen" and "the
share sheet actually puts the file in Photos" are claims only an iPhone can
settle. See `DEVICE-CHECKLIST.md`.

Export weighs in around 600 KB rather than the ~300 KB the playbook cites for
photographs. A halftone screen over paper grain is close to worst case for
JPEG — high-frequency detail in every block. Lowering quality to compensate
smears the dots, so the size stands as a deliberate trade.

## Removed on purpose

The app does one job — risographic type on a photo — and every control left
earns its place by changing how the type reads or looks on the photo in a way
nothing else does. These went, and saved prints that used them still open
(each is converted or dropped by the normaliser, with a test per case):

- **Print the photo** (separating and halftoning the photograph, with its own
  ink, contrast and highlight dropout, its own second press `photoPress`, and
  the Type/Photo switch over the press controls). Halftoning the photo is "riso
  a photo", a different job, and the one feature whose purpose was to destroy
  the photo's pixels. The photo now shows as shot.
- **Photo opacity.** Fading the photo is a legibility crutch that degrades it;
  the second ink and the backing make the type readable without touching it.
- **Opaque ("Print over the photo").** Painting the ink over the photo broke
  the transparent-ink model. Rendered side by side, a second ink equal to the
  plate's own ink put the same share of pink pixels on a dark ground (64% and
  64%), by knocking the photo back to paper — so Opaque became "Keep this ink".
- **Word-picked boxes (the Box tab)**, their padding, corners and opacity. A box
  stored word numbers that silently moved to other words when the text was
  edited, and each box was another full press pass with no cap. It became the
  per-line backing.
- **Per-word misprints (the Words tab).** Misregistration and the edge already
  carry the second-hit look, and each word group was another full press pass.
- **The typewriter** and its ribbon: a second type engine for a look that is not
  riso. Mono plus tracking covers fixed pitch.
- **Woodcut and scribble**: relief printing and pen hatching, not riso.
- **Eleven more dither algorithms**, the dither threshold, five dot shapes and
  dot softness: clustered dither duplicated the halftone, Bayer is a computer
  pattern, and the rest are research knobs. Halftone and one Atkinson grain
  remain.
- **Midtones**: type tone is nearly binary; it moved ink pixels by about a
  fifth of a level.
- **Drum streaks, smear, roller banding and dropout patches** (the misprint
  passes): on the default print they changed between 0.01% and 0.67% of the
  pixels, while each cost a full pass per plate at export size. Smear also
  doubled the type over the photo.
- **Separate tear, bleed, tear scale, mottle and dropout sliders**: now Edge and
  Wear, two amounts at the ratios the press always shipped with.
- **The detail-scaling switch**: detail always scales, because off it eats small
  type.
- **Paper tooth and cloudiness sliders, and the seed number**: fixed fibre, and
  a Re-roll button — nobody types 12345.
- **Caps** (the keyboard already asks for capitals; saved caps text is
  uppercased once), **Rounded** (a fourth sans with no printed character of its
  own), the **weight** slider (now Bold), **word spacing** (`wordSpacing`; the
  justify rule opens word gaps on its own), **Justify by** and **Lines of one
  word** (now one per-line rule), and the **Fit to width** mode (now a one-shot
  Fit that stores its size).
- **Plate opacity** (it thinned ink to grey after the screen — the look the
  engine exists to avoid) and the **overprint preview chips** (the sheet already
  shows the overprint).
- **The thirds guides** and their header toggle: they informed but never acted.
  The selection crosshair stays.

