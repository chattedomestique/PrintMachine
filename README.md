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
npm run verify          # the gate: lint + typecheck + check-css + check-fonts + test + build
npm run verify:offline  # proves the build boots with no network (a PAGES=1 build)
npm run verify:geometry # the dock holds still; 44px targets; 200% text; the app bar
PAGES=1 npm run build   # production build for the GitHub Pages sub-path
npm run sync:styleguide # re-vendor the style guide from ../styleguide
```

```sh
npm run measure:fidelity  # Save keeps every pixel of the photo, up to 61 MP (fails under a gate)
npm run measure:alloc     # what an export holds, up to 61 MP (fails over a gate; FULL=1 adds the 61 MP worst press)
npm run measure:export    # export time and desktop memory (informational)
npm run build && npm run check:save   # the save flow in the built app, tapped
npm run build && npm run check:touch  # tap-to-select on the sheet, touched
npm run check:spike       # the device spike page still runs (see below)
npm run check:encode      # the save's JPEG and PNG encoders, decoded by Chromium (fails over a bound)
npm run check:parity-borders  # the frame against Border Studio's own frozen frames (fails outside a bound)
```

The seven that can fail run in CI after `verify`, `verify:offline` and
`verify:geometry`, with `check-bands` and the harness's gates (`npm run
harness -- --out p.json --no-hashes --parity 1000`: the preview's entry point
and the export's give the same bytes; `--chain`: the whole chain in Frosted,
from an imported photo to Save's file; `--frame-cost`: what the frame costs
the preview, "The frame is ground"); `measure:export` runs there too, for the
record (see "Every pixel of the photo, measured" and "What an export
holds").

`scripts/device-spike/spike.html` is a page for a phone, not part of the app:
one self-contained file, no network, that measures what only a device can
answer before prints are saved at the photo's own pixels at any size (the
decode of a 40 MP photo, whether a 1:1 blit is a copy, cropped decodes under
EXIF rotation, the largest canvas font, canvas sizes, and the JPEG encoder's
speed). It ends with a plain-text table to copy back, and carries the
Independent JPEG Group's README (its encoder is theirs in part; see
"Licences and provenance"), so it can be published on its own. `check:spike` runs it
in Chromium in CI so it cannot rot; the phone's numbers are what decide the
steps that wait on them (DEVICE-CHECKLIST, "Native resolution at any size").

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
             events, no state. This is the product, and most of what is tested.
  state/     the document: its schema and load-time normaliser, defaults,
             persistence, and one settings reducer + Context over a coalescing
             undo/redo hook. Tested in node like the engine.
  ui/        the style guide's elements as React components (Segmented, Tabs,
             Switch, SwatchSet, ActionSheet, the Slider and its parameter
             strip), app-agnostic: nothing in it knows what a print is.
  features/  app-aware composition — the only layer that knows what the app is.
  styles/    the app's own CSS over the style guide: fonts.css (Poster's
             face), index.css (app facts), editor.css (the planes), dock.css
             (the panels), shell.css.
  assets/    the one bundled typeface, Tanklager.woff (see "Fonts").
  vendor/    the style guide, vendored (never edited here; see "Design system").
```

Node has no 2D context, so everything after the type is rasterised and the
photo blitted is one pure stage (`printSheet`) that the tests drive directly.
What only a browser can do — set glyphs, draw the photo — is checked by
`scripts/harness/`, which renders frozen documents through the real
`renderPrint` in Chromium and compares a commit against its parent.

### Saved prints keep opening

Every stored document, whichever build wrote it, goes through one whitelist
normaliser (`state/normalize.ts`) driven by a schema (`state/fields.ts`). The
result is *built* from the defaults, copying across only fields the schema
lists, each checked against its own rule — a number finite and inside the
range any control could set, an ink, face or paper one that exists, a nullable
field null or valid. So a field a build removed leaves the document instead of
riding along forever, and every valid value a person chose survives, with the
named exceptions below. Spreading
the stored document over the defaults, which this replaced, kept every removed
field, and a `typeof`-of-the-default check would reset any field whose default
is null (a chosen second ink is a string, its default `null`).

Frozen documents written by older builds live in `state/__fixtures__/`, and the
tests load each one: it opens, normalising it twice changes nothing, no key
survives that the current model does not have, and no valid value is lost.
A print saved before the frame has no `frame` and opens with the template's,
whose width is 0: unframed, as it was saved. `legacy-normalized.json` is what
the last build before the frame made of each legacy document, and a test holds
the normaliser to it, plus that unframed frame; `merge-pre-frame.json` is a
print that build saved (a photo zoomed and panned on its own sheet, a second
ink, a backing, the press at the ends of its ranges), and `merge-frame-edges.json`
two framed ones with every frame field at both ends of its range.

Every feature under "Removed on purpose" is gone from old prints too: a print
that used one opens without it (the smear, a second press, a dither algorithm,
a box's padding). Beyond that, these are the only cases where an old print
opens changed (each has a test that says so):

- **A fitted line whose fit is over 1200%** (in practice a single glyph on a
  sheet wider than about 2:3) is stored at the largest size and prints
  smaller, by about 10-30% in the cases measured. The old fit was unclamped;
  the size range is not.
- **A plate hidden with plate opacity 0 prints**, at full strength. Plate
  opacity is cut, nothing else hides a plate, and dropping the plate would
  destroy work; delete it if it should go.
- **A photo hidden with photo opacity 0 shows**, as shot. Photo opacity is cut
  (fading the photo is the one thing it did), and the photo is the ground;
  remove it if it should go.
- **Word-picked boxes become one backing** behind every line of the plate, in
  the ink of the first box that printed (a box hidden at opacity 0, or whose
  word numbers the text no longer has, never printed and becomes nothing). A
  plate takes a backing or a second ink, so a plate that had both keeps the
  backing and stops switching ink over the photo.
- **A Poster plate is set in Tanklager Kompakt**, the face the app now
  bundles, where it was set in whatever the machine's system stack found:
  Impact on a desktop that has it, Helvetica Neue on an iPhone, which has no
  Impact. It is the one change of look in a stored print, on purpose (see
  "Fonts"). Nothing is rewritten: the plate keeps its face, its size and its
  Bold. Tanklager is condensed, so a line sized with Fit in Helvetica Neue
  spans less of the sheet than it did; tap Fit again to fill it. Bold on a
  Poster plate is kept and sets nothing (Poster is one weight). One
  exception: a print saved before Fit became a size (with Fit to width on)
  is converted to a size the first time it opens, measured in the face that
  is there then; on a first launch where the face takes more than its two
  seconds (a slow network, before it is cached), a Poster plate's size is
  measured in the phone's own face and kept, so it opens a little smaller
  than it fits in Tanklager (27% in the measured case): tap Fit to fill it
  again.

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

It prints the precache's size (entries and bytes), and it checks Poster's face
offline the way a launch from the home screen uses it, never by asking
`document.fonts.check`, which says yes when no such face is declared at all.
First, online, it serves the face a second late (half the app's wait) and
records every `measureText` and `fillText` in Poster's stack with the face's
status at that moment: the app must mount with the face loaded and measure
or draw nothing in Poster before it is (an app that mounts without waiting
measures 64 times in the fallback and fails). Then, in the cold offline tab,
`document.fonts.load` must answer with the face, loaded; a line set in
Poster's stack must measure differently from the same line in the stack
without the face (equal when the face never loaded), and the same as it
measured online; and the face's `o` must rise at most 0.9 of its `O` (see
"Fonts"). Built with the face left out of the precache, it fails each of
them.

**On iOS the build being correct is not sufficient.** A home-screen PWA has to
be launched once *while online* before it will ever open offline; going straight
from "Add to Home Screen" into airplane mode fails regardless. The More sheet
says when precaching has finished ("Works offline", with an icon, never a
colour alone), and the status region says it once when it happens, so that
state is visible before you are somewhere without signal rather than
discovered there. It is only as honest as the manifest, though — a truncated
one would still say it is ready, which is what the CI check is for.

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
  belongs depends on the photo and on the pair of inks. Every switch mask is
  screened at one angle, so a mask depends on its point alone: plates that
  share a point get the same mask, and moving one plate's point never moves
  another plate's dots.
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
  torn, bled tone and its own registration offset, which the plate's press
  hands to `cutKnockoutRows` (`engine/knockout.ts`, the one function that cuts
  every knockout, a backing's and a second ink's alike) rather than the
  knockout roughening the tone a second time. A hole a couple of pixels off
  the ink could only be covered by spreading it, which at text size swells
  every counter shut.

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
print the same ink, so moving the switch would change nothing, and the dock
does not offer it.

### The press: two screens, two kinds of wear

A Riso driver screens with dots or with grain, so the Press tool offers exactly
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

#### The Original sheet: the photo's own shape

The Sheet choice leads with **Original** — the photo's own shape, upright —
before 1:1, 4:5, 3:4 and 2:3, and the first photo opens on it. With the zoom
at 100% and no pan the photo then fills the sheet exactly, so the untouched
path neither crops nor resamples a pixel: a crop is something the person
chooses, not something the app does for them. Replacing the photo keeps the
sheet that was chosen (an Original sheet takes the new photo's shape);
removing the photo from an Original sheet leaves 4:5, since there is no shape
to take. A photo more extreme than 3:1 (a panorama) is cover-cropped to 3:1,
so no sheet is a sliver. `sheetAspect` (`engine/frame.ts`) is the one place
a sheet becomes a number, and the preview and the export size the sheet from
it. The photo is placed on the sheet's visible rectangle, the sheet inside its
frame (unframed, the whole sheet): the cover fit and the pan limits are
relative to that rectangle (`visibleAspect`, `layoutSheet`), and Fit is the
whole photo contained in it.

At the size where the sheet holds the photo at its own pixels, the blit is
**snapped**: drawn at exactly the photo's size, at a whole-pixel offset, kept
inside the travel that still covers the sheet (`snapRect`). Centred, the 4:5
crop of a 12 MP photo sits half a pixel off the grid, and a bilinear blit at a
half-pixel offset blurs every pixel into its neighbour: measured, 0.753 of the
original's Laplacian energy unsnapped, 1.000 snapped. A zoomed photo snaps the
same way at its own native size. "Holds the photo at its own pixels" means a
scale within 2.5 px of 1:1 over the sheet's shorter side (`SNAP_PX`): on a
tall sheet whose width binds (a 2268x4032 photo on its own sheet at 113% is
drawn at 1.0005) a tolerance taken over the height let a resample of every
pixel through. The planner steps the sheet's long side a pixel at a time (a
landscape sheet's width, any other's height), so the side that binds reaches
the photo's exactly: 3001x2251 on a fixed 3:2 sheet saves at 3001x2001, at
its own pixels (stepping the height made it 3002x2001, a pixel too wide for
the photo to cover, and resampled it). A test plans real and random photo
sizes on every sheet, the landscape ones included, at exactly 100% and at
every zoom to 400%, and the planner's random photos on any aspect zoomed past
100%, and checks that each native plan is drawn at the photo's own pixels, at
a whole-pixel offset. A preview is 1:1
when the photo lands on it at its own size (a photo no larger than the
preview, or one zoomed to that point), and snaps then too; a blit that is not
1:1 (a large photo's preview at 100%, a small photo enlarged to the reference
height) is left alone.

#### The photo always covers the sheet

Panning is limited to where the photo still covers what it is placed on, the
sheet's visible rectangle (the whole sheet unframed, the sheet inside its
frame otherwise): its centre can move until one of its edges reaches that
rectangle's edge, and no further. (Fit shows the whole photo inside the
rectangle and reads no pan; the stored one is kept, clamped as Crop would
show it.) That limit is enforced **where the sheet is drawn** (`coverRect`
clamps whatever placement it is handed), and again by every edit that moves
the photo, zooms it or changes the sheet's shape or frame, so the stored
value is honest too. The second place matters
because a pan that is legal on one sheet is not on another: push a landscape
photo to one side on a square sheet, switch to 4:5, and without it a strip of
bare sheet would print. A property test throws random sheet changes (Original
among them), pans, zooms and replaced photos at the document and checks the
sheet stays covered after every one, and another random frame and sheet
changes, checking the stored pan stays inside the visible rectangle's travel.

The compositor still treats a transparent ground pixel as paper rather than
black — `getImageData` hands untouched pixels back as transparent *black*, and
the first cut printed exactly that. Panning can no longer uncover the sheet, but
the same path carries the knockout under the second ink (the photo's alpha goes
down there) and a transparent PNG's own transparency, and there is a test that
uncovered ground is bit-for-bit the paper the app draws with no photo at all.
(Unframed. Inside a frame a transparent pixel of the photo shows the frame's
fill, which is bare paper only when the fill is Paper.)

#### The frame is ground, composed a band at a time

The frame is not a plate: the fill, the photo and its rounded corners are the
ground the ink prints on (`engine/frame.ts`). Every layout has three
rectangles: the sheet; the visible rectangle, the sheet inset by the border,
which the photo's zoom and pan are relative to and which lands on the photo
pixel for pixel; and the shown rectangle, where the photo is (the visible one
in Crop and on Original; in Fit the whole photo contained in it). Outside the
shown rectangle every pixel IS the fill: the border, and in Fit the matte
(the photo's ground is never read there). Inside it the photo is laid over
the fill in straight alpha, rounded once, its corners cut by the exact area
under Border Studio's curve (sqrt x + sqrt y = sqrt r, in closed form; tested
against a numerical integral). An opaque photo pixel away from the corners is
copied byte for byte, so a native save keeps every pixel of the photo inside
its frame. Paper is alpha 0, so the press prints the bare stock there; a
colour is opaque and takes the stock's veil when "Paper over the photo" is on.

The document stores the fill's choice, never a colour: the colour comes from
the photo's palette stored with it (`media.palette`), handed to the engine
beside the photo (`FrameInputs`); until it is there, the fill draws as Paper.
The palette is Border Studio's (`engine/palette.ts`, its `palette.js` at
597ce7a trimmed to the four colours the fill shows: the median cut, the most
photogenic cluster as the hero, the undertone for a grey hero's hue; Photo,
Deep, Muted and Comp, always all four even when two are the same hex). It is
made once a photo, the first time a frame shows on it, whatever the fill (so
the fill's four swatches have their colours before one is chosen, as Border
Studio's do; under Frosted it comes from the decode Frosted needs anyway),
from an 84 px area-averaged sample of one fixed decode of the photo (1024 px
on its long side, `features/media/frameSource.ts`), never from the preview's
copy, whose size moves with the zoom; it is stored with the photo
(`setPalette`, not an undo step, and the one thing that writes it; every
history entry that holds the photo takes it, so no Undo or Redo takes it
away and has the photo decoded again), so the preview, the save and every
reopen agree, and Save makes it first when a palette colour needs it, so a
press never starts without it. A photo whose frame source will not decode
is one state, kept with the photo until an attempt for it works (the photo
chosen again, or decoded again when an Undo brings it back): while the print
needs that source (a palette colour not yet stored, or Frosted) the frame
stays Paper, the status card and Save's name say the photo could not be
loaded (the words of a photo that is gone), and Save refuses it rather than
press a frame that is quietly bare (`check-save` step 10, with the decode
held back and failing, for a palette colour and for Frosted, and through a
Replace and an Undo); Paper, or a colour already stored with the photo,
saves as it shows.
Fed Border Studio's own recorded sample of its two block photos, and 36
photograph-like samples Border Studio's own `palette.js` keyed, the port
gives Border Studio's hex exactly (`palette.test.ts`).

Frosted is a border made of the photo itself (`engine/frost.ts`, Border
Studio's `drawFrostedBg`), with Blur its one setting (10 to 240). The frame's
source is cover-filled into a small FIELD of the sheet's shape, 480 px on its
long side (160 while a control is dragged), by an area average, blurred by
Border Studio's three box passes whose windows shrink at the edges (`blur.ts`,
the same passes the plates use, with an edge rule; the plates' are unchanged
to the byte) at a radius that scales with the field (14 at Blur 60, 44 at
240), and graded as Border Studio ships it (brightness x 0.85, then
saturation x 1.6 about Rec. 709 luma). The field's size is a function of the
sheet's shape alone, never of a rendered size, so the preview and the save
sample the same field; it stays in float, and each sheet pixel samples it
bilinearly (with Border Studio's 2% overscan) and is rounded to a byte once.
Rounding the field to bytes first would leave a stair as wide as a field
pixel (19 sheet pixels at 58 MP); here the only step is the one-level step
rounding must make. A photo with transparent pixels is blurred with its
alpha (each colour multiplied by it, and divided by the blurred alpha
after), so a transparent area takes the colour of the photo round it, never
black (Border Studio's canvas frosts it black); where no opaque pixel
reaches, it takes the photo's mean colour, and a photo with nothing opaque
frosts to Paper, as its colour fills are. The field is made by the page from
the photo's frame source and kept (a few, by photo, sheet shape and blur:
`features/media/frostField.ts`), never in the render cache, and a field made
for another shape or blur is not used (the border is Paper until the right
one is there). The photo cover-filled into the field's grid, before the
blur (the area average of the 1024 px source, most of a field's cost), is
kept too, by photo, sheet shape and field size, so a frame of a Blur drag
runs only the three passes and the grade: about 2 ms over a draft frame
with its field kept (it was 11 to 17 ms when each field was made whole). A
Width drag on Original changes the sheet's shape, so each of its frames
makes a cover as well. Save makes the field at 480 before it presses.

The preview composes the frame into its ground in place, and the export
composes it a band of rows at a time into a band buffer of its own
(`FramedGroundRows`, one band more than an unframed press holds), reading the
photo only for the rows it shows; each pixel is a function of its place and
its own photo pixel, so every band height gives the same bytes and the
preview's ground is the export's rows put together (`frame.test.ts`,
`frost.test.ts`, `banded.test.ts`, `frameRender.test.ts`; the harness's
`--bands`, `--parity` and `--file-parity` on five frame documents, one of
them Frosted; `check-bands` in CI on two, one of them at its native height,
so its photo is pressed from its own rows). A print without a frame (width
0, square corners, Crop) composes nothing and presses the bytes it always
did.

`node scripts/parity-borders.mjs` (in CI) renders Border Studio's own
frozen frames (`scripts/parity-borders/`: its preview canvas at 597ce7a, on
generated flat-block photos) through this engine and compares: the sheet's
size, the border and the matte every byte equal, the photo at its own pixels
every byte equal, and each rounded corner within a mean of 1.02 levels
(measured 0.24 to 0.81: the references are a canvas's antialiased clip, the
engine's corner the exact area). Frosted, at Blur 60 and 240, its field made
from the block photo's bytes through the app's own frame source: a mean of
0.48 and 0.49 levels against Border Studio's, a 99th percentile of 3 and 2
(held to 0.62 and 3.75; a radius not scaled with the field, the grade's
brightness or the overscan left out, or the passes clamped at the edges,
each fails it). `npm run harness -- --out c.json --no-hashes
--frame-cost` times the preview framed (a photo at its own size and a 12 MP
photo from its working copy, in Crop and in Fit, and in Frosted with its field
kept, settled and draft) against the same print unframed, what a person waits
for, and against the same framed render with the fill and the corners left
out (a test seam), the frame's own work: at most 1.10x settled and 1.25x
draft, each. Frosted with its field made again inside the render, from
the kept cover, through the page's own `frostFields` (each frame of a Blur
drag), is timed too, against the print unframed, and held to what it
measured x 1.25: 1.58x settled, 1.60x draft (it measured 1.12 to 1.26 and
1.21 to 1.28 over 8 runs; the passes and the grade are 8 to 27 ms over the
settled frame and 1.6 to 2.0 ms over the draft one). The draft bound fails a
Blur drag that makes the cover again each frame (2.67x and 3.32x measured);
the settled one does not see that (1.36x and 1.44x), nor the passes run
twice (1.27x to 1.36x settled, 1.43x to 1.50x draft): the made-again work is
a fifth of a settled render now, so a bound that saw its doubling would sit
within a few percent of a clean run's spread. A shared machine's
interference only ever adds time and comes in spells that can outlast a
document's rounds taken back to back, so the two documents at the two sizes
are measured round by round in turn (15 rounds, one render a sample), a
render's time is the mean of its three fastest samples (thirty in draft, ten
a round), and a document and size with a row over its bound is measured
again, up to twice, its samples pooled; it fails only if still over. On the
gate as it is now (Crop, Fit, Frosted kept and Frosted made again, both
documents at both sizes: 16 rows), 8 runs on one machine all passed, two of
them measuring one document and size again: against unframed, Crop 0.97 to
1.04, Fit 0.91 to 1.04 (under 1 in Fit, which draws the photo smaller),
Frosted 1.00 to 1.10; against the compose skipped, Crop 1.00 to 1.07, Fit
0.96 to 1.06, Frosted 1.02 to 1.10 (bound 1.10 settled, 1.25 draft). Before
Frosted, M2's gate (Crop and Fit only) passed 75 runs in three batches of
25, its verdicts 0.85 to 1.08 and 0.90 to 1.09. With the preview's compose
run ten times over, the gate fails (11 of its 16 rows: the four Frosted rows
with the field kept and the two draft made-again ones, a photo at its own
size's Crop and Fit at both sizes, the 12 MP photo's settled Crop; the 12 MP
photo's Fit stays in, its frame a flat matte round a photo a third of the
sheet, about 1% of the render, and so do its draft Crop, at 1.244, and the
settled made-again rows, whose bound is the looser); twenty times over fails
all 16.

#### The photo is stored exactly as it came

An import keeps the picked file's **bytes**: never resampled, never re-encoded,
at any size — a 24 MP iPhone capture is stored at 5712x4284, a transparent PNG
keeps its alpha. (Before this, every import was cut to a 2048 px long edge and
re-encoded as a JPEG, which is a down-rez of every photo, and a transparent PNG
came out black.) The one decode at import is to learn the photo's true size the
right way up (its EXIF orientation applied) and that the browser can read it at
all; there is no HEIC decoder, so a format the browser cannot open is refused
with "That image could not be read." A test holds the stored bytes equal to
the file's at every size, from 12 MP to 48 MP.

The size limits belong to canvases and memory, not to a stored file, so they
live where those are used:

- **The preview** decodes a *working copy* sized to what it shows
  (`previewArea`, `features/media/decode.ts`). At 100% that is 4 MP (2048 x
  2048 by area, so its long edge is never under 2048 px: never smaller than the
  copy the app used to keep); a 24 MP photo held decoded for a one-megapixel
  preview would be 98 MB of a phone's memory for pixels nobody sees. Zoomed in
  to crop, the copy grows in tiers that double (8.4 MP, then 16.8 MP, the
  preview's largest, or the whole photo if it is smaller), so the preview shows
  the photo at one copy pixel or more to each of its own pixels at any zoom: a
  fixed 4 MP copy of a 12 MP photo on 4:5 was stretched past 1:1 from 177% and
  2.26x at 400%. The photo is decoded again only when the zoom (or the
  sheet) has rested for 300 ms on a tier whose copy is not the one held:
  every change restarts the wait, so a drag from 100% to 400% decodes once,
  where it stops, and a zoom that leaves the held tier and comes back decodes
  nothing. The old copy is drawn until the new one lands (measured in the
  built app: at 300% the preview of a noise photo holds 7.2x the fine detail
  it did from the fixed copy). The largest copy is 67 MB, held
  through a save, but a save from that far in is small: the print shrinks with
  the zoom squared, since fewer of the photo's pixels land on the sheet (a
  24 MP photo on its own sheet at 400% saves 2400x1800; at 100%, 5712x4284).
  Nothing reads the copy's size: the cover fit, the pan and the export all use
  the photo's true size from the document, and the copy is drawn scaled into
  the same rectangle, so the preview places the photo exactly where the print
  does.
- **The frame's colours** come from a third decode, made once a photo when a
  frame first shows on it: the photo at 1024 px on its long side (or
  its own size, if smaller), read back and kept for that photo (2.8 MB for a
  3:2 photo). It waits for the preview's copy to land, and Save makes it, when
  it is missing, before it decodes the original, so it never runs beside
  either.
- **Save** decodes the *original*, in full (4 bytes a pixel of the photo, about
  98 MB for 24 MP, 159 MB for 40 MP), and closes it the moment its last rows
  are in the print, so the print is drawn from the original's pixels, never
  from the preview's copy. There is no export ceiling: the print is pressed a
  band of rows at a time and each band is written straight into the file
  ("Saving at the photo's own pixels"), so no canvas, array or file buffer is
  ever the sheet's size, and a 40 MP photo saves at its own 7728x5152.

Photos saved by an older build are the 2048 px copies it made; the originals
are gone. Such a photo (no `native` flag, a long edge of exactly 2048) carries
a note in the Photo tool's File tab: "This photo was saved at reduced size by an older
version. Choose it again for full resolution."

**A photo cannot silently drop out of a print.** If the stored image is missing
or cannot be decoded, the Photo tool's File tab says so ("This photo could not
be loaded. Choose it again.") for as long as it is true, and so does Save,
whichever tool is open: Save cannot be pressed, its name carries the sentence,
and the status card above the dock shows the same sentence as an alert, with
Choose again. The More sheet promises no size meanwhile: its first row says the
same sentence, and its PNG row is unavailable and shows none. Nothing is ever
saved as the type on bare paper.

#### Why the bytes are not in localStorage

Its quota is about 5 MB of *string*, and base64 inflates binary by a third; one
phone photo blows it and the throw takes the whole save with it. Photos live in
IndexedDB as Blobs, and the document keeps only the id and placement, so the two
stores can be written independently and a torn write costs a photo rather than
the print.

Remove and Replace do not delete a photo's bytes: Undo can bring the old photo
back and must find it there. Once per launch a sweep deletes the stored photos
the saved document does not reference — history does not outlive the page, so
after a relaunch nothing else can — but only those imported more than a day
ago, so an import landing mid-sweep, or another tab's not yet saved, is never
taken. Storage is bounded by a day's worth of replaced photos. One gap is
left: a second tab kept open for over a day can hold an undo step back to a
photo the sweep has since taken; undoing to it shows "This photo could not be
loaded" rather than printing bare paper.

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
by the same `cutKnockoutRows` the second ink uses. Without it a pale block over a
dark part of the photo would be invisible — a transparent yellow over black is
black — so the block prints on paper wherever it is, and reads the same over any
part of the picture.

A plate takes a backing **or** a second ink, never both. The second ink decides
each glyph's ink from the photo's luminance, but over a backing the real ground
is the block, so a light second ink chosen for a dark patch of photo would land
on the block and vanish. The Ink tool offers them as one choice — Over photo:
Off, Second ink, Backing — and the document rules hold it in the reducer and
the normaliser too.

Saved prints with word-picked boxes open with a backing in the ink of the
first box that printed: per-line instead of per-word, and, because a plate
takes one or the other, without the second ink the plate may also have had
(see "Saved prints keep opening"). Word numbers in a box never followed the
words when the text was edited, so an inserted word silently moved every box;
the backing has nothing to go stale.

### The plate budget

At most **3 text plates and 4 pressed passes** — a backing is a pass of its
own, while a second ink is pressed once and then split, so it counts once.
Every pass is a full press at export resolution, so the cap is what keeps the
worst export knowable on a phone. Over budget, Add and Backing are disabled and
the dock says why. A print saved with more plates keeps all of them: dropping
a plate would destroy work, and a slow save is recoverable.

### Type: one size, set as typed

**Size** is the em as a fraction of the sheet's height, and it is shown so that
a tenth of the sheet reads **100%** (`size x 1000`). The slider runs 10% to
100% in 1% steps — 90 positions, with captions and short lines (the old
readout's 1-4%, now 10-40%) on the first third of the travel instead of its
first two percent. A step changes the size by at most 10% of itself at the
small end, 1.9 px of travel on a 320 px phone (measured on the real track,
between its [−] and [+], by `scripts/verify-geometry.mjs`); the [−] and [+]
take one step each, and a tap on the value types an exact one. Bigger type is
still there: a pinch, the `+`/`-` keys (5% a press, never less than one step),
Fit and a typed value reach 1200%; past 100% the thumb pins at the end, the
readout shows the true value, and [−] steps down from it (240%, then 239%).
Dragging a pinned thumb jumps the size to where the finger lands, as any range
input does; a nudge, a typed value and a double-tap reset never do. A new
plate opens at 40%, which is also where a double-tap on the track resets; the
default print's headline is 90% and its stamp 60%, both inside the travel. The
stored unit did not change, so a saved print opens at exactly the size it was
(a saved 0.8 reads 800%).

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
(700 or 400), off and unavailable on Poster, which is one weight ("Poster is
one weight", under it). The faces are Poster, Grotesk, Serif and Mono.

### Fonts

**Poster is one bundled face, Tanklager Kompakt** (Ariel Martín Pérez, Tunera
Type Foundry, SIL Open Font License 1.1; one WOFF of 18,908 bytes in
`src/assets/fonts/`, from Border Studio's library, its notice and licence in
`public/licences.txt`). Poster's system stack led with Impact, which an
iPhone does not have, so on the owner's phone the default plate was set in
Helvetica Neue and on a desktop in Impact: the same print, two faces. A print
is now set in the same face on every phone, online and off (the face is
precached), with one exception a person can type: Tanklager has no dollar
sign, so a `$` on a Poster plate is set in the next face of the stack, the
phone's own (and so are characters a phone's first keyboard does not offer,
such as € £ © ™). Every other printable ASCII character, and the curly
quotes, dashes and ellipsis an iPhone types by default, are Tanklager's;
`check-fonts` requires them, names `$` as the one exception, and fails a
face that loses one more (its controls include the iPhone's apostrophe
removed). Of Border Studio's 52 faces, nine can set the letters, digits and
punctuation this app prints with a lowercase of their own and no ligatures,
and Tanklager is the one of the nine that is condensed and heavy, as the
stack meant Impact to be; it is the only one that came across. The other
three faces stay system stacks. Railroad Gothic, Border Studio's heavier
wood type, draws capitals only (its lowercase glyphs are capitals), and
choosing it instead would take more than its file: it ships as TrueType
(`ttf` added to the precache glob), its family name changed where Poster's
is written (`fonts.css`, `features/media/faces.ts`, `engine/types.ts`,
`scripts/face-checks.mjs`, `check-fonts.mjs`, `verify-offline.mjs`), and the
lowercase verdict dropped, which refuses it (its `o` measures 1.00 of its
`O`): the owner's alternative, at that cost.

It is one weight, so **Bold sets nothing on a Poster plate**, and the switch
says so: a bold made by the browser from the regular smears the glyphs
differently in each engine, so the press would differ between Chromium and an
iPhone. The stored Bold is kept, so a plate moved to another face keeps its
choice. A stored print's Poster plates keep their sizes; a line sized with
Fit in the old face may want Fit again (see "Saved prints keep opening").

**The face is in before anything measures.** The layout's advances, Fit, a tap
on a plate and the normaliser's one Fit conversion all measure text
synchronously, and a canvas measures and draws in a fallback while a face is
still loading. So `main.tsx` waits for the face (`features/media/faces.ts`)
before the document is read or the sheet drawn, for two seconds at most: a
face that fails or is slow never leaves a blank app, the app goes on in the
rest of Poster's stack, and if the face lands later the preview's glyph
rasters, keyed by a face generation (`render.ts` `ensureCache`), are set
again in it. `font-display: block`, weight 400 only, so nothing asks a browser
to fake a bold.

**The face is checked, not trusted.** `check-fonts` (in `npm run verify`)
reads the WOFF itself (its tables inflated and checksummed; `cmap` formats 4
and 12; `GSUB`'s features) and fails unless every printable ASCII
character and the iPhone keyboard's ‘ ’ “ ” – — … are mapped (but for the
one it names, `$`, which it prints as set in the phone's own face, with
€ £ © ™), each lowercase letter maps to a glyph of its own, and no ligature
feature (`liga clig calt dlig rlig`) is offered; four broken copies of the
face (lowercase unmapped, the iPhone's apostrophe unmapped, lowercase set in
the capitals, a `liga` added) must each fail it (`node
scripts/check-fonts.mjs --controls dir/` writes them out, and `node
scripts/check-fonts.mjs dir/liga.woff` checks one, or any other face). Its
lowercase rule is a pre-check only: Railroad Gothic passes it, its separate
lowercase glyphs being capitals. The real test is the ink: `verify-offline` measures `o`
against `O` in the browser (Tanklager: 0.68; a lowercase that is capitals:
1.00; fails over 0.9), with its verdict tested on measured heights it is
handed (`faces.test.ts`), since node cannot read the face's CFF outlines.

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

The wear defaults are tuned against poster type — an em of roughly 16% of the
sheet height (what the Size control shows as 160%). Applied unchanged to a
paragraph they destroy it: a 9px screen pitch on an 1800px sheet is about a
24 lpi screen where real Riso is nearer 100, so small letterforms get eaten by
their own halftone, and `bleed` fills the counters in a, e and o until the word
is a row of blobs.

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
against the space the sheet is actually given. The ratio is a number the sheet
is handed (`--sheet-ratio`, from `sheetAspect`), not one of a list of shapes,
so an Original sheet of any photo's proportions sizes the same way.

### Saving at the photo's own pixels

Save presses the print at the size the planner gives (`engine/exportPlan.ts`),
never at the preview's: the smallest sheet on which the photo lands pixel for
pixel, whatever the photo's size. A 12 MP landscape photo on 4:5 saves at
2419×3024, the same photo upright at 3024×3780, a 24 MP iPhone capture on 4:5
at its own 3427×4284 and on its own Original sheet at 5712×4284; a 40 MP
photo (7728×5152) at 7728×5152 on Original, 4122×5152 on 4:5 and 5152×5152 on
1:1; a 61 MP one (9504×6336) at 9504×6336 on Original. A photo with fewer
pixels than the reference height is enlarged rather than the print made
smaller (never under 1800 px tall); a print with no photo saves at 3600 px
tall. There is no ceiling: the print is pressed in bands and each band goes
straight into the file (`render.ts` `pressToSink`, the encoders in
`engine/encode/`), so nothing the sheet's size is ever made. (Until the band
engine, the export was one canvas and was capped at its area; a 40 MP photo
on its own sheet saved at 42% of its pixels.) The one limit left is the JPEG
format's own: 65,535 px a side, which only a photo wider than that meets;
Save then says so and offers the PNG, which has none.

"Lands pixel for pixel" depends on how the photo is placed. A cropped sheet
(4:5, 1:1...) is covered by the photo, so its plan is the smallest sheet on
which the photo's cover fit reaches 1:1 on the side that binds. An Original
sheet must HOLD the photo: the smallest sheet on which the whole photo fits at
its own pixels on both sides, so at 100% it saves every row and column of it.
(A cover lands a row early on a photo taller than 1:2, and a 4000x12000 photo
used to save at 4000x11999.) Zoomed past 100%, an Original sheet holds the
part of the photo the zoom shows on both sides, where the cover was at 1:1 on
one; so an Original print zoomed past 100% may save a pixel or two larger or
smaller than it did before the frame came in, both at the photo's own pixels:
larger where the cover's sheet was a row or a column short of holding it (a
4730x6159 photo at 200%: 2365x3079 then, 2365x3080 now), smaller where a
smaller sheet holds it too (7500x4203 at 200%: 3751x2102 then, 3750x2102
now). A test holds every such plan within 2 px a side of the old one, larger
only where the old one did not hold. The planner steps the sheet's long
side a pixel at a time, from an estimate up to the first size that lands
and back down to the smallest (`engine/exportPlan.ts`); a test holds it to a
scan from 1.
A floor, a smaller copy and the JPEG's edge are sized by the height, the
width following from the shape, as the preview is.

It says so **before** the tap. The More sheet's first row reads "Saves
2419×3024", and when the print is not the photo's own pixels, why, in numbers:
"photo is 1600×1200: upscaled 1.5x", or, zoomed in, "photo is 1600×1200 at
300% zoom: upscaled 4.5x" (the longest reason a real document gives). Save's
own name carries the size ("Save 2419×3024 JPEG"), the toast repeats size and
reason the moment a save starts, and the confirmation repeats the size. Save
itself stays one word, so the app bar never wraps. Nothing falls back to a
smaller file: a press that fails stops, with the reason and the numbers, and
a smaller copy is only ever one the person chose.

A print at the photo's own resolution is seconds of work on a phone, so Save
is a flow (`features/shell/useSave.ts`, a state machine with no UI in it):

- **Pressing.** Save reads **Saving** before any work starts (two painted
  frames), and the status card above the dock says what the press is doing,
  with **Cancel**: "Pressing 7728×5152: loading the photo" (the original's
  decode), "...: reading the photo" (its luminance, when a plate has a second
  ink), "Pressing 7728×5152, 43%" (the bands: the percent is the band reached
  of all of them) and "...: writing the file". The press runs through
  `pressToSink`, which runs the very stages the preview runs and yields to the
  page between them (after every plate of every band), so the progress paints
  and Cancel works, up to the file itself: a Cancel tapped while the file is
  being written leaves no file. While it presses, the app asks the screen to
  stay on (the Wake Lock, where there is one: iOS 16.4 and later), since a
  screen that sleeps suspends the page. The preview stops rendering meanwhile (a full-size press and a
  preview frame never hold their buffers together), and the rest of the page
  is inert (the status card and its Cancel aside), keyboard undo included, so
  the document cannot change under the press and the file is the print on
  screen. The two entry points print the same bytes at the same height on
  every sheet of one tile (up to 4.19 MP and at most 4096 px wide, which is
  every height the preview and the harness record): `npm run harness -- --out
  p.json --no-hashes --parity 1000` renders every harness document through
  both and fails if any differs. Above one tile the export rasterises type on
  the tile grid, which the preview never does, and a glyph that crosses a
  seam can differ at its antialiased edge (see "The glyphs and a resampled photo on a tile grid").
- **Sharing.** The share sheet needs the tap that opens it to be recent, and a
  press outlasts it. A press that finished within a second of the tap would
  share at once, but at a photo's own resolution none does (a print with no
  photo, 2880×3600, takes about 3 s on a desktop): Save becomes **Share** and
  the card says "3024×3780 is ready (6.2 MB)", a fresh tap that shares the file
  already made (the card's × lets it go). A share that fails keeps the file and
  the button: in a home-screen app it never falls through to a download, which
  on iOS navigates to the image and takes the app with it. On a desktop with
  no share sheet the file downloads.
- **The file.** A JPEG at quality 95 with every colour sample kept (4:4:4:
  full-resolution colour), written by the app's own encoder
  (`engine/encode/jpeg.ts`), band by band: a browser's own canvas encoder below
  quality 1.0 stores the colour at half resolution (4:2:0, measured in
  Chromium), which smears saturated ink at the dot edges, so it is not used.
  **Save lossless PNG** in the More sheet writes every pixel exactly
  (`engine/encode/png.ts`, compressed by the browser's `CompressionStream`;
  where there is none, iOS before 16.4, it is stored uncompressed, about 3
  bytes a pixel, and the PNG row says how big: "(about 120 MB)" at 40 MP).
- **Too big for this device.** Over its limit an iOS canvas does not throw: it
  hands back a blank one, and the print would come out as empty paper. The
  press makes no canvas wider than 4096 px or larger than 2^22 pixels (a tile)
  and one a band tall for the photo, and each is proved at the size the press
  will make it before any work — a sentinel pixel (rgb 1, 2, 3) written at its
  last pixel and read back (`fitsCanvas`, `engine/export.ts`). Memory that runs
  out for a typed array (a `RangeError`) anywhere in the press presses it again
  from the first band in bands half as tall (the same file, more slowly), up to
  four times, while the photo is still held. Only a `RangeError` is read that
  way: the engine's own checks (the tile ring, the encoders' sizes, a native
  plan laid out off the photo's own pixels) throw a plain `Error`, so a bug
  is said as itself, pressed once, never offered as a smaller copy. What
  still cannot be pressed — a
  canvas that comes back blank, memory out at the smallest band, or an original
  that cannot be decoded whole while a smaller decode of it can (the import
  already read it, so that is this device's memory) — is one error,
  `CanvasLimitError`, with the plan in it. Save then asks, in numbers and with
  the reason: "This device couldn't press 2419×3024 (a canvas came back blank).
  Save a smaller 1814×2268 copy instead?" (a reason in the browser's own words
  — "Out of memory" — is shown as it came, so a fault that is not about size
  cannot hide behind the offer). The copy offered is the largest that proves
  itself here, its canvases first and then its photo decoded at its size,
  stepping down by three quarters of the height at a time (the sheet's shape
  kept) and never under 600 px; when none does, it says this device cannot
  save the print. Proving a copy can take as long as a decode, and the card
  still offers Cancel meanwhile: a Cancel tapped then ends the save, with no
  question after it. A file that cannot be decoded at any size is a plain failure
  ("The photo could not be decoded to save: ..."), never an offer. Nothing is
  pressed until the person picks Save smaller; the copy's photo is decoded
  straight to the copy's size, once, and drawn at its own pixels; and the
  confirmation names what was saved ("Saved 1814×2268, a smaller copy").
- **A save that did not finish.** iOS evicts a tab that holds too much without
  a word, and the app restarts as if nothing happened. Save marks itself in
  `localStorage` before it decodes the photo (the height and the format) and
  clears the mark when it ends either way, so a launch that finds the mark
  says so: "The last save, 2419×3024, did not finish.", with **Try again**,
  **Save smaller (1814×2268)** and Cancel. It does not claim the device ran out
  of memory: a mark only says the save did not end.

### Every pixel of the photo, measured

"No down-rezzing at all" is a claim, so `scripts/measure-fidelity.mjs` checks
it on every CI run. In Chromium it takes generated photos through the real
import (into IndexedDB) and the real Save (`decodeOriginal`, `savePrint`), with
the type off and the paper veil off so that the print *is* the photo, and
compares each file with the part of the original the sheet shows, drawn at its
own pixels. A zone plate is the photo: rings that run up to 0.45 cycles per
pixel at the corners, where any resampling shows.

| Photo | Sheet | Saved | Laplacian energy | Correlation | Largest difference |
|---|---|---|---|---|---|
| 4032x3024 | Original | 4032x3024 | 1.0000 | 1.0000 | 0 |
| 4032x3024 | 4:5 | 2419x3024 | 1.0000 | 1.0000 | 0 |
| 6000x4500 (above the old 4096 cap) | 4:5 | 3600x4500 | 1.0000 | 1.0000 | 0 |
| 5712x4284 (an iPhone's 24 MP) | 4:5 | 3427x4284 | 1.0000 | 1.0000 | 0 |
| 5712x4284 | Original | 5712x4284 | 1.0000 | 1.0000 | 0 |
| 2268x4032 (a tall 16:9), zoomed to 113% | Original | 2008x3569 | 1.0000 | 1.0000 | 0 |
| 7728x5152 (40 MP) | Original | 7728x5152 | 1.0000 | 1.0000 | 0 |
| 7728x5152 | 4:5 | 4122x5152 | 1.0000 | 1.0000 | 0 |
| 7728x5152 (`FULL=1`) | 1:1 | 5152x5152 | 1.0000 | 1.0000 | 0 |
| 9504x6336 (61 MP) | 4:5 | 5069x6336 | 1.0000 | 1.0000 | 0 |
| *control: drawn half a pixel off* | 4:5 | 2419x3024 | 0.79 | 0.927 | |
| *control: from a 2048 px copy (the old import)* | 4:5 | 2419x3024 | 0.13 | 0.875 | |

The gates are a Laplacian energy (the finest detail, which any resampling takes
down) of at least 0.98 of the original's and a correlation of at least 0.999,
with the file the size the plan says, the stored photo the picked file byte
for byte, and Save's caption giving no reason; the two controls are the ways
this app used to draw a photo, and the script fails if either passes. Each
40 and 61 MP photo is saved a second time as Save saves it by default, a
JPEG, whose own header must say a baseline frame (SOF0) of the plan's size
with every component sampled 1x1 (4:4:4): 24.7 MB at 7728x5152 for this
zone plate, written in 12.2 s.

Framed, the photo still lands at its own pixels, and the gate says so pixel
by pixel: the 40 MP zone plate on its own sheet with the first photo's frame
and round corners (9016x6440, a 644 px frame), a 3000x2000 one in Fit on 4:5
(3652x4565, the photo at (326, 1283)) and that one's smaller copy at 60%
(2191x2739, the copy decoded at its contained 1799x1199 and drawn 1:1). In
each, inside the photo's rectangle and outside its corners, every byte is the
photo Save drew (38.2 million pixels at 40 MP: largest difference 0/255,
Laplacian 1.0000); every pixel of the frame and the matte is the fill's colour
(18.2 million at 40 MP); every corner pixel is the photo over the fill at the
corner's exact coverage, within the half level of one rounding; Fit's
rectangle holds the photo's shape to half a pixel; and the 40 MP framed print
saved as Save's JPEG is a 9016x6440 SOF0 sampled 4:4:4. Frosted at its
heaviest blur (240) on a 40 MP photo that fades over a smooth colour gradient
(case 16; a grey zone plate frosts to one flat grey, where nothing could
show): its field made from the stored file as Save makes it (about half a
second) is float (4 in a million of its values on a whole level, held under
1%: a field rounded to bytes before it is stretched, the stair this guards
against, has all of them there and fails); every one of the frame's 18.2
million pixels is that field sampled exactly, in float64 by the harness's
own code rather than the engine's sampler, and rounded once (a sampler that
rounds before it has finished mixing is off by a level at 2.2 million of
them, and fails); along the middle row of the left border the longest run
of one value is printed against the field's own (167, 644 and 177 px in
red, green and blue, against the same: green runs the whole border because
the gradient runs down, not across), but at this size the field moves under
a level across the 644 px border, so that run cannot tell a rounded field
from a float one, and the two checks before it are the gate; and it presses
in at most 1.25x the time of the same photo in a palette colour, pressed just
before it (one sample each, so a few percent of drift is in the ratio:
interleaved and repeated, the two measured 1.00x). A JPEG
whose EXIF says to rotate it saves upright, a PNG's
transparent hole prints as paper (never black), a document whose stored photo
is gone is refused rather than printed on bare paper, and the default print
and two documents of small type correlate with themselves at twice the height
("The same print at every size"): 0.97 or better, except type at 20%, held to
0.95.

`scripts/check-save.mjs` taps the same flow in the built app: a 12 MP photo on
4:5 (Save reads Saving and the card offers Cancel within 100 ms, the card
counts the press in percent and says when it writes the file, the file is the
size the More sheet and Save's name promised), a device whose canvases come
back blank wider than 2000 px (the smaller-copy question before anything is
pressed, then that file), a tab closed mid-press (the notice at the next
launch, its choices waiting, and saying so, until the photo is back), a stored
photo deleted (the card and Save say so, and no file), a Cancel tapped while
the file is written (no file, with a share sheet or without), Ctrl+Z pressed
during a press (the document stays as it was, and the file is that print),
where focus is while it presses, the gesture hint across two saves (its
card hides, its words are not read out again), and a 40 MP photo on Original
(More and Save promise 7728×5152; the percent moves; Cancel leaves no file;
Save again writes a 7728x5152 baseline JPEG sampled 4:4:4, read from its
header).

#### Test seams

The gates need a press slow enough to tap Cancel in, small tiles on a small
sheet, and a framed preview without its frame's work. Save reads
`globalThis.__PM_TEST__` once per press (`engine/export.ts`), the preview one
field of it once per framed render (`engine/render.ts`), and nothing else
reads it; absent, it does nothing:

- `finishDelayMs`: the file's writing waits this long after the last band
  (check-save and verify-geometry hold it 1.5 to 3 s, as a phone's can take);
- `onFinishStart`: called as the file's writing starts (check-save times its
  Cancel from it);
- `tileBudget: { edge, pixels }`: the tile grid's budget instead of 4096 and
  2^22;
- `skipFrameCompose`: the preview draws a framed photo into its rectangle and
  leaves the fill and the corners out, so the harness's `--frame-cost` can
  time the frame's own work against the same render without it.

### What an export holds

An export at a photo's own resolution is 11 to 61 MP (and more), so a
sheet-sized buffer would be 45 to 240 MB of a phone's memory, and an iPhone
evicts a tab that holds too much. So an export holds nothing the sheet's size
but the decoded photo itself. `scripts/measure-alloc.mjs` counts it exactly:
it runs the export path (`pressToSink` into the real JPEG encoder) in node
with every typed-array constructor wrapped and, at every allocation over a
threshold (a quarter of the sheet's pixels for the five older cases, 512 KiB
from case 6 on, where a quarter of 40 MP would miss every band and tile
array) and at every step of the press, collects the garbage and reads back
what is still live — the same on every run, unlike a browser's resident
memory. Its gates are below the tables.

- **No cache, no noise fields.** The preview keeps the paper's shade and the
  ink film's mottle as arrays, reused every frame. An export reads them where
  it prints them: the noise is a seeded lattice whose every value can be read
  directly (`ValueNoiseSampler`, `FbmSampler`), the paper a band of rows at a
  time, the mottle only on inked pixels, the tear's wander only on the edge.
  The numbers are the arrays' to the last bit (tested), so the preview and the
  print still agree byte for byte (`--parity`).
- **Bytes where a byte holds the value.** A glyph raster's tone is its alpha
  byte, kept as the byte (a quarter of a float, exactly the same value). A
  plate's screened coverage, the second ink's switch mask and the knockout are
  kept in bytes too: the mask is hard (0 or 255), and coverage rounds to
  within half a level, which moves the printed sheet by at most one level
  (mean 0.002 on the harness documents). That rounding is in the stages the
  preview shares, so the preview shows it too.
- **One workspace, every pass in place.** A plate used to make a dozen
  sheet-sized arrays of its own (the tone, the blur's ping-pong, the torn
  tone, density, wear, the shift, the knockout); now three float buffers are
  made once per render and every pass works in them, to the same numbers: the
  tear in the first, the worn tone in the second, the moved tone the screen
  reads in the third (the blur's other half until then). Each pass works on
  a window of rows sized to what it reads (`windowsFor`), so the same buffers
  serve a press of the whole sheet or of a band of it. The knockout is cut
  straight into the running bytes (`cutKnockoutRows`), the torn tone moved to
  the plate's offset as it is read rather than in place, so a window of it can
  serve more than one band and is never written; and the second ink's light
  half takes the coverage's own buffer.
- **No sheet-sized canvas, no sheet-sized file buffer.** The sheet is printed
  a band of rows at a time into one band-sized buffer, and each band goes
  straight into the encoder (`RowSink`), which keeps an 8-row strip (JPEG) or a
  few batches of 64 rows (PNG) and hands its file on in chunks: the file is
  never assembled in one buffer until it is a Blob, after the photo is let
  go. The knockout takes the photo's alpha down as each pixel is printed,
  instead of on a copy of the photo; every read-back of a canvas (glyphs, the
  photo) is done in pieces of at most a megabyte, straight into a buffer made
  once (`engine/readback.ts`).
- **Let go as soon as done.** Once the plates are pressed for the last time
  and the photo's last rows are read, the decoded photo is closed, the
  workspace, the ground's luminance, the switch mask and the tile rings are
  dropped, and an export's canvases are emptied (their width set to 0), before
  the last rows are printed and the file is finished.
- **Pressed in bands, the same bytes.** The print is pressed a band of rows
  at a time (`printSheet`'s `bandRows`; by default `bandHeight`: 2^21 output
  pixels over the sheet's width, at least 32 rows, so a preview, at most a
  megapixel, is one band, and a 12 MP export four to six): each band presses
  every plate, reading only the rows its stages reach (the tear's three blur
  passes, the shift, the grain's two cell rows of look-ahead: `windowsFor`),
  cuts its knockout and splits its second ink, and is printed. Every noise,
  screen and mask is keyed to the sheet's own rows, the grain carries its
  error from band to band (`GrainStream`), and the photo's luminance is
  gathered from every band before the first is pressed, so every band height
  prints the same bytes (`banded.test.ts` against the digests recorded
  before, and the harness's `--bands` through the export's entry, on the real
  tile grid and on forced 512x128 tiles; `scripts/check-bands.mjs` in CI);
  everything a band needs is made once, before the first, and no band
  allocates anything of 512 KiB or more (`banded.test.ts`): what a band does
  make is a few arrays a row long (the blur's column sums, per plate; the
  luminance's column lookup, per split plate) and a few floats. One set of
  numbers in a band can differ from the sheet's in its last bit: the tear's
  vertical blur keeps a float64 running sum per column, and a window's sums
  start on another row, so where they round (a blur of about 10 px or more:
  sheets over 6,000 px tall, dense with type) a blurred float can come out a
  bit apart, some of them inside the range the tear's threshold reads. The
  tear has turned every one measured into the same torn tone
  (`window.test.ts`, up to a blur of 20 px, a sheet 12,000 px tall), so the
  bytes are the same; re-seeding the sums on fixed rows of the sheet, at the
  price of a wider window, is the lever if one ever does not.
- **The glyphs and a resampled photo on a tile grid.** Two things in a print
  come off a canvas, and neither is the same bytes when the canvas moves: a
  glyph rasterised into a band of rows differs at its antialiased edge from
  the same glyph on one canvas (the rasteriser flattens a curve differently
  under another clip), and a photo drawn at a fraction of its size differs by
  a level here and there. So an export draws them on a FIXED grid of tiles
  (`engine/tiles.ts`: at most 4096 px wide and 2^22 pixels, so a 40 MP sheet
  is 2 x 6 tiles of 4096x1024), each tile a canvas of its own whose pixels
  depend on its place and nothing else, and every band takes its rows from a
  small ring of tile rows (`TileRowCache`, two rows per plate at the user's
  sizes), drawn once each. A sheet of one tile (up to 4.19 MP and 4096 wide:
  the preview, the reference sheet and every height the harness records) is
  drawn exactly as the whole sheet always was. On a bigger sheet, a glyph
  whose box crosses a seam between two tiles is rasterised by two clipped
  canvases, and its antialiased edge can differ from one canvas's, by a few
  levels and at a few isolated pixels by up to about 180, over the glyph's
  whole extent. It is a property of poster type, not of captions; measured
  (`run.mjs --seam`, the type's share, the photo drawn once): the 40 MP 4:5
  sheet (photo-second-ink at 5152, 4122x5152, 12 tiles) 0.232% of the inked
  pixels, 0.0028% by more than 128 levels; at 3000, 0.048%, 0.0013%; on forced
  512x128 tiles at 1000, 0.534%, 0.0098%; the default document at 3600, type
  at 20% at 3600 and a backing over the photo at 2400: 0 bytes. Every
  differing pixel, at any level, lies inside the box of a plate that crosses
  a seam (the seam report and `check-bands` fail on one that does not). A
  resampled photo on the grid differs by at most a level, on 0.06% of the
  bytes at 3000 (none at 2400, where the enlargement is exactly 2x). A photo
  at its own pixels (every native save) needs no grid: each band blits its
  own rows, smoothing off, which is a copy at any origin (the same bytes as
  one canvas, measured in Chromium and on an iPhone's WebKit by the device
  spike).
- **Type over 9216 px.** Chromium will not set a canvas font over 10,000 px
  (it clamps the size and draws the glyphs up to 38% too small), which 120%
  type passes on a sheet over 8,333 px tall. So type over `CANVAS_FONT_MAX`
  (9216 px) is measured and drawn at its size over k under `scale(k, k)`: the
  layout, advances, line height and backing at the full size, the canvas never
  over the cap (`check-bands` measures a 9,800 px 'O' both ways in every face:
  the same advance). At or under it nothing changes; no print a build before
  the band engine could make had type over 8,513 px.
- **The ground's luminance on a small grid.** The second ink decides each
  glyph's ink from the photo's luminance blurred across about a word — a
  radius of 500 px on a 12 MP export, the press's slowest pass and a
  sheet-sized float held through every plate, for a field with nothing finer
  than a few hundred pixels in it. It is now blurred on a grid of cells a
  sixteenth of the radius across and read back bilinearly. Measured on the
  harness photo: the switch and the knockout move on under 0.12% of the
  pixels and nothing else moves. Under Grain the switch is error diffusion,
  which re-dithers its whole mixing band at any change in its input: the same
  ink density (to 0.1%), a different arrangement of the grains there. Under a
  blur of 32 px (type under about 21 px: 10% on a sheet under 2,133 px tall)
  the cell is a pixel and the grid is the luminance itself, a sheet-sized
  float, with a second one while it is blurred. Pressed in bands it is
  gathered before the press makes its own buffers, so the two never coincide
  (`banded.test.ts`; case 10 below).
- **Faster, and it never stops the page for long.** The vertical blur now
  walks the sheet by rows with a running sum per column (a column walk was a
  cache miss per pixel, most of the press's time on a wide sheet; the sums are
  the same additions in the same order, so the bytes are too), and the press
  yields to the page inside each pass as well as between them, so the progress
  keeps painting and Cancel is taken within a stage.

Measured (`node scripts/measure-alloc.mjs`, `node scripts/measure-export.mjs`;
before the diet -> after it, one canvas encoded by the browser -> pressed in
bands into this app's encoder; the canvases are the largest tile and, for a
photo at its own pixels, the band it is blitted into; the decoded photo is
counted until its last rows are read; Chromium's resident memory is over the
moment before the press, the photo already decoded):

| Case | Sheet | Typed arrays, peak | With canvases, the decoded photo and the file | Chromium time | Chromium RSS |
|---|---|---|---|---|---|
| 1. 12 MP portrait, 4:5, second ink | 3024x3780 | 68.4 -> 23.4 -> 7.3 B/px | 76 -> 31 -> 14.0 B/px (160 MB) | 12.5 -> 5.8 -> 4.8 s | +707 -> +311 -> +183 MB |
| 2. 3 plates, 4 passes, 4096x4096 | 16.8 MP | 92.7 -> 25.3 -> 6.3 | 101 -> 33 -> 12.0 (201 MB) | 39.2 -> 11.9 -> 10.0 s | +1094 -> +491 -> +199 MB |
| 3. No photo | 2880x3600 | 44.5 -> 15.4 -> 6.4 | 53 -> 23 -> 8.2 (85 MB) | 7.8 -> 3.8 -> 3.2 s | +388 -> +278 -> +169 MB |
| 4. Grain, 4096x4096 | 16.8 MP | 68.1 -> 23.3 -> 5.1 | 76 -> 31 -> 10.8 (181 MB) | 21.7 -> 8.0 -> 7.0 s | +1104 -> +394 -> +185 MB |
| 5. A legacy print, 5 plates, 2 backings | 16.8 MP | 112.0 -> 29.3 -> 8.3 | 120 -> 37 -> 14.0 (235 MB) | 65.6 -> 18.7 -> 15.6 s | +1484 -> +445 -> +232 MB |

And the sizes the band engine made possible, every one a photo at its own
pixels (the file counted at 1.4 bytes an output pixel, so the number does
not depend on how well the test print compresses. 1.4 is what the app's
encoder writes for flat grey with ±32 levels of uniform noise. Real
photographs saved through the app write 0.54-0.70 clean, about 1.18 with ±16
levels of noise and 1.49 with ±32, so the bound covers photographs up to
about ±16 levels of noise per channel. A ±32-noise photograph adds about
4 MB at 40 MP; the synthetic fine-detail ground, 1.76 bytes a pixel, adds
about 14 MB and would put case 6 just over its gate; pure noise, 2.42, is no
photograph and would put case 6 at about 379 MB. The gate in brackets):

| Case | Sheet | Typed arrays, peak | With canvases, the decoded photo and the file | Chromium time: ms/MP (press + encoder) | Chromium RSS |
|---|---|---|---|---|---|
| 6. 40 MP on Original, the default document, second ink | 7728x5152 | 102.3 MB (125) | 338.6 MB (350) | 15.1 s: 379 (317 + 62) | +231 MB |
| 7. A 61 MP photo on 4:5, case 2's document | 5069x6336 | 115.2 MB (144) | 424.6 MB (450) | 17.3 s: 539 (473 + 65) | +211 MB |
| 7g. The same, under Grain | 5069x6336 | 117.3 MB (145) | 426.7 MB (450) | 17.6 s: 548 (482 + 66) | +215 MB |
| 8. 61 MP on Original, case 2's document, the worst legal press (Grain at pitch 36, misregistration 30, every plate's type at 0.16 of the height) | 9504x6336 | 172.1 MB (210) | 517.7 MB (540) | 37.0 s: 615 (553 + 62) | +268 MB |
| 9. A 48 MP 3:1 panorama on Original, the default document, second ink | 12000x4000 | 121.2 MB (150) | 400.0 MB (420) | 18.5 s: 386 (320 + 65) | +245 MB |
| 10. 3:1 on Original, type at 10%, second ink (the luminance at one cell a pixel) | 6399x2133 | 149.2 MB (185) | 245.1 MB (290) | 5.6 s: 410 (346 + 64) | +261 MB |

Framed, a photo at its own pixels inside the first photo's frame (round
corners, the photo's own colour) or the widest; the sheet grows by the frame
and, in Fit on a ratio not the photo's own, by much more, and every added
pixel is the frame's. Each is gated at what it measured x 1.25 and under a
ceiling that is not its own measurement: case 6's typed peak scaled by the
sheet's width, plus the decoded photo and the file, x 1.30
(`scripts/export-cases.mjs`); where measured x 1.25 is over it, the gate is
the ceiling:

| Case | Sheet | Typed arrays, peak | With canvases, the decoded photo and the file | Ceiling |
|---|---|---|---|---|
| 11. 40 MP on Original, the first photo's frame | 9016x6440 (58.1 MP) | 118.0 MB (147.5) | 379.1 MB (467) | 467.9 MB |
| 12. The same photo on 1:1 Fit | 9016x9016 (81.3 MP) | 120.1 MB (150) | 413.8 MB (510) | 510.1 MB |
| 13. 61 MP on Original, the widest frame | 13976x10808 (151 MP) | 147.5 MB (184) | 619.1 MB (773) | 828.6 MB |
| 14. A 40 MP portrait (5152x7728) on 16:9 Fit | 18414x10358 (191 MP) | 168.7 MB (210) | 613.6 MB (767) | 871.1 MB |
| 15. The same at the widest frame (memory only) | 31864x17924 (571 MP) | 262.2 MB (327) | 1238.8 MB (1548) | 1794.8 MB |
| 16. Case 11 in Frosted at Blur 240 (the frame source and the field held through the press) | 9016x6440 (58.1 MP) | 123.1 MB (154) | 384.2 MB (467) | 467.9 MB |

The frame adds one band buffer to the press (the framed ground's own); the
rest grows with the width as before, and slower than it, since a wider sheet
is pressed fewer rows at a time. Past 100 MP most of what a save holds is the
file (at 1.4 bytes a pixel, 800 MB at 571 MP) and the photo, so a very large
framed print is a matter of the phone's memory for its file, which the
caption's size says before the tap.

What the press holds grows with the sheet's WIDTH (its tile rings and band
buffers), not its height: a 4000x10000 photo on Original (a 4000x10000 sheet)
holds 109.2 MB of typed arrays at its peak against 107.4 MB for a 4000x5000
one under case 2's document (1.017 times), and 120.8 against 113.2 MB under
its worst press (1.068 times); framed, a 3618x6284 photo on Original (a
4666x7332 sheet) 120.8 MB against 120.1 MB for a 4000x3000 one (4666x3666,
1.006 times).

The gates (the script exits 1 over any): cases 1-4 at what they measured
once Save pressed into the encoder, x 1.25 (9.1, 7.8, 8.0 and 6.3 bytes of
typed arrays an output pixel; case 5 is recorded, not gated); cases 6-10 in
megabytes, the typed arrays and the whole, at the ceilings the band engine
was designed to or at what they measured x 1.25 where that is lower (case 7:
144); cases 11-16 as above; the same-width pairs at 1.15 times. Case 8
(81 s in node) and the framed 13 to 16 (209, 272, 807 and 93 s) run with
`FULL=1`; CI runs the rest, four processes at a time (4 min 51 s here with
the framed 11 and 12 and the framed pair, 3 min 39 s without them, on the
same day; 2 min 16 s without them on a faster one).
Desktop Chromium's memory is informational (V8 frees short-lived buffers far
more eagerly than an iPhone's JavaScriptCore), and the phone's own is a
DEVICE-CHECKLIST item. The legacy five-plate print (kept whole: see "The
plate budget") costs a third more typed memory than the worst print the
budget allows. At 40 MP and over, the largest single thing held is the
decoded photo (4 B a photo pixel: 159 MB at 40 MP, 241 MB at 61 MP), which
does not depend on the press.

**Time.** On this machine (4 vCPU, desktop Chromium, the harness's
synthetic photo): a 40 MP save on Original takes 15.1 s, 379 ms a megapixel
(the press 317, the JPEG encoder 62); the 61 MP photo on 4:5 under the
worst legal document 17.3 s (539: 473 and 65); the 61 MP worst press on
Original 37.0 s. The encoder's share depends on the picture: 62 to 71 ms a
megapixel on these prints, 112 on the device spike's noisy halftone. In the
built app (`check-save`), a 40 MP photo on Original is saved 15.0 s after
the tap. On a phone only the encoder has been measured: the device spike ran
it at 62, 65 and 62 ms a megapixel on its halftone test image on an iPhone
(iOS 18.7, the Claude app's in-app WebKit view), R 0.49, 0.52 and 0.49 of
the reference machine's 126; its estimate of a 40 MP save, 33 s x R, is 16
to 17 s, the 33 s being this machine's estimate from before the save was
measured here at 15.1 s. How long a save takes on a phone is a
DEVICE-CHECKLIST item.

A framed save costs what its sheet's megapixels cost: in one run of
`measure:export` (a slower day of this machine than the table above), the
40 MP photo framed on Original took 33.9 s for 58.1 MP, 584 ms a megapixel,
and on 1:1 Fit 46.9 s for 81.3 MP, 577, against 23.4 s and 587 for the same
photo unframed. On a phone the only whole-save figure is the device spike's
estimate, about 16 s at 40 MP: about 0.4 s a sheet megapixel, so about 23 s
for the framed 58 MP, 33 s at 81 MP and 76 s at 191 MP. These are estimates;
the app promises no time.

### The same print at every size

A print is rendered at many heights — the preview, the reference sheet of
1800 px, and a photo's own resolution when it is saved — so everything the
press draws is a fraction of the sheet, never a count of pixels. Four things
were pixels, and each made a larger render a different print:

- **Paper fibre** was a 3 px grain whose finest octave stopped at one pixel on
  every sheet: on a 3600 px sheet, half the size. It is 3 px at the reference
  height and grows with the sheet, finest octave included.
- **Dropout speckle** was one value per pixel of a seeded stream, so a larger
  sheet printed finer dust in a different pattern. A speck is now a cell of
  the sheet (a pixel at 1800, two at 3600), read from a coordinate hash, so it
  is the same dust anywhere and costs no memory.
- **The grain cell** was rounded to whole pixels (1.68 px became 2, 19% too
  big). It is exact now: pixel *x* belongs to cell `floor(x / cell)`.
- **The switch mask's screen origin** was a fixed few pixels.

At the reference height each of these is the value it always was; only the
speckle's pattern is new. The check is two-fold: in node, each field's
correlation length must grow in step with the height (within 15%); in the
browser harness, a render at twice the height, averaged back down, must
correlate with the render at the height (`npm run harness -- --out s.json
--no-hashes --scale default@1800`). From the reference height up, which is
every height a print is saved at, the default print and type at 40% correlate
at 0.97 or better, and type at 20% at 0.95 or better. At 20% the halftone
lattice is under 4 px at 1800, so how closely the two heights agree depends on
the glyphs: 0.9712 in Tanklager, Poster's bundled face (before it was bundled,
Poster fell back to each machine's fonts and read 0.9706 on one machine and
0.9644 on the CI runner). Before the scale fixes the same document read 0.77. Below the
reference height the preview is a lower-fidelity picture: a halftone for small
type is finer than a 900 px raster can draw, and a speck or a fibre stops at
one pixel.

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

The preview is sized by a **pixel budget**, not a height: a million pixels
settled and 78,400 while dragging, at most 1000 and 280 px tall. Its cost goes
with its pixels, and a fixed height made a landscape sheet cost its width over
its height more — an Original sheet for a panorama would have cost 3.75 times a
4:5 one. The budget is exactly the most expensive sheet before (1:1 at 1000 px),
so every portrait and square sheet renders exactly as it did, and a landscape
one renders shorter instead of dearer (4:3 at 1155x866, 3:1 at 1731x577). The
preview never feeds the export, and it is not sharper than 1000 px tall: on a
high-density screen the settled preview is a little softer than the saved
file, which is the trade that keeps a drag responsive.

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
untouched — it presses at the photo's own resolution, through its own entry
point, and keeps no cache at all: it reads the noise where it prints it (see
"What an export holds").

### Design system

The interface is built on the owner's style guide, vendored exactly as Border
Studio (the app this one follows) vendors it: `scripts/sync-styleguide.mjs`
copies the core CSS, the icon masks, the Archivo font and fourteen elements
(button, card, appbar, toolbar, tabs, segmented, slider, switch, swatch,
select, input, dialog, menu, spinner) into `src/vendor/styleguide/`, and the
layout-only scripts (core's `SG.fit`, the segmented control's fit, the
toolbar's paging, and the scrubber script only because the toolbar calls its
`SG.afterParse`) into `public/sg/`. `VERSION.md` records the commit
(`e38263e`). The copies are never edited here: `npm run sync:styleguide`
re-vendors them from a sibling checkout, and `npm run verify:geometry` then
proves the dock still holds still. The style guide's scripts that own state
(tabs, slider, dialog, menu) are not loaded: React owns that state, so their
keyboard patterns are in `ui/` instead (two owners of `aria-selected` fight).

The app's own CSS is unlayered, so it beats every `sg.*` layer without
`!important`, and so it holds no bare element rules (a `button {}` would strip
every button the style guide draws) and no colour literals: components read
the style guide's roles. `npm run verify` holds it to that:
`scripts/check-css.mjs` is a subset of the style guide's own lint (which
lints the style guide's source tree and is not vendored) — no blur or
backdrop filter, no gradient that blends (a hard-stop one, as for a meter or
a hatch, passes, as in the guide's lint), no blurred shadow written as a
number, no `drop-shadow()` or `text-shadow`, no colour literal (the symbols'
SVG masks aside), no font size in px, no `outline: none` without a
replacement, no `!important`, no button, input, select or textarea without a
class of its own anywhere in a selector. A subset: the guide's lint also reads
token use and line weights drawn with shadows, among others, which this does
not. It runs its own cases first, so a check that has stopped catching what it
names fails before the app's files are read. What only a render can judge
(contrast, the look) is the screenshots'.

The palette is the guide's `default`, the true neutral grey (`<html
data-palette="default">`): this app exists to judge ink and paper colour, and
chrome with a hue shifts how the inks read. The Riso pink is an ink, and the
app icon, never chrome. `theme-color` is the guide's
`--canvas`, resolved in a browser: #F5F5F5 light, #0E0E0E dark. The guide
needs a 2024 browser (`light-dark()`, `:has()`, container queries), which an
iOS-first PWA in 2026 has.

The editor is Border Studio's three planes (`styles/editor.css`, ported with
its `--ed-*` names): the stage, where the sheet sits; the tray, the dock one
step up, whose controls have no frames and do not lift; and the floating plane,
where whatever opens on top gets its frame back: the sheets and dialogs over a
scrim, the toast, the save's status card and the gesture hint just above the
dock. Those cards stack between the app bar and the dock and never reach past
either: the status card is nearest the dock, because it holds the one action
its state needs (Cancel, ×, Choose again), and on a small phone at large text
whatever does not fit gives way at the top, under the bar; the status card's
own words scroll before its action leaves the screen. A toast takes room only
while it is on screen. That port reads a few of the style guide's
button-private properties, which is why the vendored commit is pinned and why a
sync must be followed by `npm run verify:geometry`.

**What the gates check, and what they cannot.** `check-css` (in `verify`) holds
the app's CSS to the subset of the style guide's rules listed above;
`verify:geometry` holds the dock to its one geometry, every control to a 44 px
target it owns, 200% text to no clipped words and the app bar to one row (see
"The dock"). Both run in CI. None of them sees colour: contrast is the style
guide's own, verified in its repository for the `default` palette and not
re-run here, and the app adds no colour of its own (the inks and stocks are
data, shown with their names). None of them is an iPhone: Safari's real touch
slop, VoiceOver's reading order, Larger Text past 200%, the safe areas and the
home-screen app are DEVICE-CHECKLIST items. And none of them has taste: the
review screenshots (`npm run verify:geometry -- --shots <dir>`, read beside
Border Studio's at the same widths) are where a screen that passes and still
looks wrong is caught.

### The dock

Four tools — **Type, Ink, Photo, Press** — are a toolbar of toggle buttons,
not tabs: tapping the open tool closes its panel for a full-height sheet, and a
tab cannot be "none open". Each tool's panel is two bands of fixed height: a
head row (the plate button, on Type and Ink, then the sub-tabs) and a content
area of one options row, a hairline and one parameter strip (141 px). A feature
that does not fit is a sub-tab, never another row:

| Tool | Sub-tabs |
|---|---|
| Type | Text (the words) · Face (typeface, Bold) · Size (Fit, Size) · Space (alignment; line height, tracking) · Place (rotation, position) |
| Ink | Ink (the plate's ink, from the 77 in a dialog) · Over photo (Off, Second ink, Backing; the second ink and its Switch point, or the backing's ink) |
| Photo | Sheet (Original, 1:1, 4:5, 3:4, 2:3; paper over the photo) · Frame (zoom, position) · File (choose, replace, remove) |
| Press | Screen (halftone or grain; screen size) · Press (Re-roll; ink, misregistration, Edge, Wear) · Paper (the stock) |

The panel is the same height in every tool and every tab, so **the sheet never
changes size or place between them** (Border Studio fcd91ff). That is checked,
not assumed: `npm run verify:geometry` opens every tool, sub-tab and Over-photo
state at 320, 375, 393 and 430 px wide, with a 4:3, a 3:2 and a 1:3 photo, and
fails if the sheet moves by a pixel, if a panel overflows, or if the page
scrolls sideways. Each state is measured at rest, once its transitions and
animations have run out and its scrollers have stopped, never after a fixed
delay, so the frame it is measured at does not depend on the machine's speed
(a sheet caught mid-rise once failed CI, see the gate's `settle`). The one
state with a clock of its own, a save's first moments with its 2.4 s toast
up, is held there while it is measured: a press in progress keeps the main
thread busy, and a slow machine came to rest only after the toast had gone.
Nothing in the dock is clicked while it is still moving, and every state is
measured from the dock's start, which is then checked: a tab clicked while
its panel was still opening was partly outside the dock, the browser
scrolled the dock 12 px to reach it, and the dock stayed so, hiding the plate
button from eight states (so a fast and a slow machine counted 203 and 195
targets at 320 px). At 200% text a control below the dock's fold is still
scrolled to before it is clicked, as a person would, and the dock is put
back before the next state is measured; where the dock scrolls, each state's
targets are checked from its start and again from its end, so what lies
below the fold is checked too.
Border Studio's README claims such a suite and has no file for it; this one
is a file, and it checks more:

- **Targets** by the hit area each control still owns: from its centre, how
  far each way a tap lands on it (`elementFromPoint`), counting its `::after`
  hit area and losing whatever a neighbour covers — 44 px both ways for every
  enabled button, field, tab and menu row in the bar, the dock, the cards and
  each dialog. That is also the style guide's "8 px between targets": the gap
  is what lets two 36 px circles each own 44. The strip's name line is 36 px
  over the 44 px slider row, so its name and value grow their hit areas
  upward, into the gap over the strip (Border Studio's name and value, on
  the same geometry, own 40 px).
- **200% text** (`font-size: 200%` on `<html>`): every state and dialog with
  no text cut off by a clipping box, and no sideways scroll. The dock may
  scroll and the sheet shrink; nothing is lost.
- **The app bar** at every width from 320 to 430 px, at 100% and 200% text:
  one row of actions, Save's word on one line, nothing past the bar, and the
  layout steps full → compact → tight as it narrows (tight only when the
  title needs a second line).
- **The save states at 200% text** on a 320×640 and a 375×667 phone, with the
  dock closed and with the Photo tool open: a 5712×4284 photo on its own sheet
  (so the toast carries the longest reason the planner gives), pressing with
  that toast up (the press held at "loading the photo", its decode of the
  original waiting until the state is measured), ready, and the photo that
  could not be loaded. Cancel, Share,
  the card's × and Choose again each answer a tap at their centre, and the
  cards stay between the bar and the dock.

`--shots <dir>` writes the review set: every state, dialog and save state at
320 and 390 px in both themes, 200% text at 390, and the wire palette (the
style guide's squint test).

Every numeric setting is one strip: its name and value on one line (the value
a button: tap it to type an exact number, in the units you read — "50", not
"0.05" — with the whole range stated), and under them `[−] slider [+]`. The
[−] and [+] step once (the single-pointer alternative to dragging, WCAG 2.5.7)
and a double-tap on the track resets to the default, which is read from the
document's own defaults, never retyped (a test holds them equal). A tap on a
range input moves its thumb to the finger, so each tap of a double tap would
also do that: the second one's is ignored, so the reset stands, and the
first one's joins the reset in one undo step, so one Undo takes the double tap
back. The two taps are timed by when they touched (each event's own time), not
by when the page got to them: on a phone the preview's render after the first
tap can hold the second back (over a second with the CPU throttled 4x), and
it still counts, and still joins the first tap's step (`check:touch` does it
with real touch input, also on a CPU throttled 4x with the second tap handled
late). On a setting already at its default the double tap goes there and
back, so it leaves no undo step, and nor does a drag that ends where it
began. The reset joins only the step its first tap's move opened: when that
move left none (a press on the thumb that wobbled a step and came back), or
anything else became a step in between, the reset is a step of its own, so
one Undo never also takes back a step made before the double tap. A drag
released less than half a second before the first tap is still part of that
tap's step, and one Undo takes it back with the reset.

A panel with several settings shows one at a time: tap its name, or swipe up
from it, for the others (Border Studio 4860519). Size, Rotation and
Position have two ranges: the slider spans where people work (10–100%, ±45°,
the sheet) while a pinch, the keys, a nudge and a typed value reach the whole
range (1200%, ±180°, 30% past the trim); the thumb then pins at the end and
the value shows the truth.

The plate the panel edits is the button at the start of the head row of both
Type and Ink — one selection, reachable from the tool you edit in — and it
opens a sheet to switch plate, add one (with the reason when the budget is
spent) or remove this one. A second control a setting needs (the second ink
beside its Switch point) leads its strip instead of costing a row.
Explanations that used to sit under the controls are descriptions for screen
readers; the why is here, in this README.

### Touch

The sheet's surface takes `touch-action: none`, so its gestures are never the
browser's: drag to move, two-finger pinch to scale and rotate, double-tap to
centre. With the Photo tool open the same gestures pan and zoom the photo
instead (100–400%, never off the sheet), and double-tap fits it again. A finger
lifting mid-pinch re-seeds the gesture from the remaining one, so the layer
keeps panning instead of jumping. Every gesture writes the same fields the
parameter strips write, so each has a tap equivalent (Size, Rotation and
Position X/Y for type; Zoom and Position for the photo), and arrow keys / +- /
brackets mirror it for keyboards. The selected plate shows a crosshair on the
sheet — the one editing aid, and it never reaches a saved file.

**Tap a plate to pick it** (Border Studio's tap-to-select). A touch that lands
on a plate other than the selected one selects it — the same selection as the
plate button, and not an undo step — and the drag it starts moves that plate,
so the touch that picks a plate is the touch that moves it. A touch on
bare paper or photo moves the selected plate, as it always has. Which plate is
under a finger is `hitLayer` (engine/text.ts): each plate's line boxes, the
rectangles its backing would fill, read off the layout the glyphs are drawn
from and turned with the plate, so a tilted line is hit along its slant; the
topmost plate wins, as the last prints on top. A touch up to 12 px outside a
box still counts (a caption at a few percent of the sheet is a line a few
pixels tall under a fingertip several times that), and a touch inside one
plate's box always beats a touch beside another's. One finger has to travel
4 px before it moves anything, so a tap that picks a plate does not also nudge
it. A double tap whose first tap picks a plate only picks it: people tap twice
when the first tap seems not to take, and centring would throw away where the
plate was and its turn. Double-tap centres the plate that was already
selected, or the selected one from bare paper.

The plate the gesture moves is decided at the pointer-down, from the plate it
landed on, and its patches name that plate. Waiting for the selection to
re-render would start the drag from the previous plate's place and move it
(`features/editor/gesture.ts`, tested; `npm run check:touch` touches it in the
built app).

The first photo brings a short gesture hint saying what the sheet's
gestures do in the open tool (the photo with Photo open, the type otherwise).
It goes for good with its ×, or with the first gesture that moves something:
by then it has been learned, and while it shows it covers the foot of the
sheet.

A slider's input takes `touch-action: none`, so a drag with any vertical
component moves the value; nothing in the dock scrolls at 100% text (at large
text the panel may, rather than push the sheet off the screen).

### Layout

The dock is a fixed overlay, not a flow sibling. Its live height is measured
with a `ResizeObserver` (its border box: its safe-area padding counts) and
published as `--overlay-h` on the app and on `:root`, which the stage reserves
as bottom padding — so the sheet is always as large as it can be. The dock is
one height in every panel, so the only change is opening and closing it. The
stage has no transition of its own: while the panel slides open or shut the
sheet follows its measured height, and it is CSS-sized, so that costs no
render. On a wide screen the app is a phone-width column, centred.

Every part of the page is in a landmark, so a screen reader can go straight
to it: the app bar (banner), the sheet (main), the dock (a region named
Tools) and the cards over the stage (a region named Notifications, as the
style guide names its toast region; the offline state's words live there
too). What those cards say is announced through live regions that exist
before the words do — the toast's, and one for the gesture hint — because a
region born holding its words is not reliably read.

`engine/` must never import from `state/`, `ui/`, or `features/`, and must never
touch React or the DOM beyond a canvas context handed to it. That constraint is
what lets the export path re-render a fresh, overlay-free frame with the exact
same code the preview uses. Save keeps to it too: the press's canvases come
from a factory the page hands in (`SaveOptions.makeCanvas`), and the share
sheet and the download are the page's (`features/shell/page.ts`); the engine
returns a Blob. `src/engine/layering.test.ts` reads the engine's sources and
fails on an import from those folders or a `document`, `window` or
`navigator`. `ui/` knows nothing about riso and imports nothing
from `engine/`.

## Where this departs from Border Studio

The interface follows Border Studio (the owner's app this one is told to
match) as its PR #1 left it at 597ce7a: the same vendored style guide and
planes, the same dock of tools, sub-tabs, parameter strips and pickers, the
same value modal, action sheets, toast and app bar. What differs, and why:

- **No upload screen.** Border Studio starts on a photo picker; a print here
  exists without a photo (type on paper), so the app opens on the editor and
  the photo is chosen in Photo › File.
- **Pinch scales and turns the type; there is no inspect zoom.** Border Studio
  pinches the view outside Crop. Here a pinch on the sheet is the type's size
  and rotation (rotation is a feature; Border Studio has none), and a zoomed
  view would show a 1000 px preview the saved file does not have.
- **No snapping, grid or guides; no eye-dropper; no presets; no "New photo"
  seed modes; no canvas view modes in More; no build stamp.** The grid
  informed but never acted (cut with the thirds guides); inks are Riso's
  table, not a colour picked off the photo; presets and seeds were never
  this app's, and the restyle added no features (what the app keeps, and
  why, is under "Removed on purpose"). More holds what Save makes, the
  offline state and the lossless PNG.
- **The style guide's `default` palette, not `sand`** (below, under the
  playbook's deviations).
- **A native select for the sheet's shape** (five choices; Border Studio's
  crop ratios are chips), and the typefaces as a segmented control with Bold
  as its own B toggle (Border Studio lists fonts).
- **Tap-to-select picks with a slop** (12 px, the nearest plate, a touch
  inside a box beating one beside it) and a drag starts after 4 px, so a tap
  picks without moving; Border Studio hit-tests the exact box and moves on any
  pointermove. Type may be dragged 30% past the trim (Border Studio clamps to
  2-98%), so it can bleed.
- **The gesture hint stays until dismissed or used**, and is announced (again
  only when the tool it describes changes, never after a save: while the print
  is pressed its card hides and its words stay, `check:save` step 8); Border
  Studio's fades after 2.8 s with `aria-hidden`, which no screen reader hears.
  It also says what the open tool's gestures do.
- **Targets own 44 px everywhere.** Border Studio's parameter name and value
  own 40 px of height on the 36 px line over the slider; here their hit areas
  grow upward. Its hex field owns 40 of its 44 px the way the style guide's
  select does; here the sheet's select fills its frame.
- **The app bar's compact layout is reachable.** Border Studio's Save hit area
  hangs past its bar and SG.fit skips compact for tight at every narrow width;
  here the bar has room for it.
- **Over photo's choice does not move when chosen.** Border Studio centres
  every panel's rows, so a control whose choice adds rows (its Box tab) jumps
  under the finger; here that panel starts with its choice.
- **Save is two steps when a press is long** (Saving, then Share, with the
  file's size), with Cancel and a status card. Border Studio renders and
  shares in the one tap; a press at a photo's own pixels takes seconds, longer
  than a tap's permission to open the share sheet lasts. See "Saving at the
  photo's own pixels".
- **A drag that misses every plate moves the selected plate.** In Border
  Studio a one-finger drag off the text pans the inspect view (or, in Crop,
  the photo) and never moves a layer. There is no inspect view here (above),
  and a caption a few pixels tall is easier to drag from beside it than to
  land on, so a miss keeps what a drag on the sheet always did here.
- **Double tap.** On a plate that is not selected it only picks it, as a tap
  on text does in Border Studio. On the selected plate, or from bare paper, it
  centres the selected plate and zeroes its turn; Border Studio has no such
  gesture (its double tap resets the inspect view), and this app's type is
  placed and turned on the sheet, so a way back to the centre belongs there.
  With Photo open, a double tap fits the photo again, as Border Studio's does
  in Crop.
- **With the Photo tool open, a touch on type does not pick it.** Border
  Studio hit-tests text in every tool, Crop included, so a drag that starts on
  a line of text moves the text even while framing the photo. Here the
  photo's tool points every gesture at the photo: a headline usually covers
  much of it, and framing a photo under its type would otherwise be a hunt for
  bare patches. The plate button picks plates in Type and Ink.
- **"New plate" starts from the defaults, with no offer to copy a plate.**
  Border Studio's Add opens a sheet ("Start from defaults", "Or copy the
  settings of …"). Not ported: the restyle added no features (this app never
  had it, so the review that decided which features stay never weighed it),
  and with at most three plates, a new one ("NEW", a caption at 40% in the
  next unused ink) is a few taps from any other's settings.
- **Save, while it presses, shows the style guide's spinner in place of its
  icon, and "Saving" where there is room for a word (a ring alone in the
  compact bar).** Border Studio keeps its download icon beside the word and
  counts a video's percent on Save. Here the progress is in the status card,
  as the print's size and the percent of its bands pressed ("Pressing
  7728×5152, 43%"), with Cancel; with the icon kept, "Saving" overflowed
  the bar at 390 px and pushed Undo into the title. Both apps draw a busy Save
  without its fill (it is busy and unavailable).
- **The dock's head row has an 8 px gap, not 12,** and the plate button 8 px
  of side padding, so the plate button and two tab names fit at 320 px.
- **Checked by files.** Border Studio's README claims a regression suite for
  the photo's rectangle that is not in it; here that suite is a file
  (`verify-geometry.mjs`), with a CSS check and a touch check beside it.

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
- **The style guide's `default` palette, not Border Studio's `sand`.** Sand
  tints the stage (chroma 0.013) right around a sheet whose whole job is judging
  ink and stock colour; `default` is chroma 0, the style guide's own
  photo-editor reference. The Riso pink is an ink, not chrome (white on it is
  3.09:1, too little for a button's word anyway).
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
stock); an imported photo as the printing ground (stored exactly as imported,
shown as shot, on its own Original sheet or a 1:1, 4:5, 3:4 or 2:3 crop,
zoomed and panned within the sheet, paper over it or not); undo/redo,
persistence that opens every older save, and save via the share sheet. Four
tools — Type, Ink, Photo, Press — on the vendored style guide, in Border
Studio's dock: one geometry for every tool and tab, every numeric setting a
strip with a tap equivalent, a plate picked by tapping it on the sheet, and
gates that check it in CI (`check-css`, `verify:geometry`, `check:touch`).

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

**Down-rezzing, in numbers.** The photo itself never is: it is stored byte
for byte as picked, at any size. A print is saved at the photo's own pixels at
any size: a 12 MP photo on every sheet, a 24 MP iPhone photo at its own
5712×4284 on its own sheet, a 40 MP one at 7728×5152 (4122×5152 on 4:5,
5152×5152 on 1:1), a 61 MP one at 9504×6336. The default file is a JPEG at
quality 95 with its colour at full resolution (4:4:4), so its one loss is the
JPEG's own quantisation (on a real print at 7.2 MP: RMSE 2.17, the largest
error 35 levels, where a browser's 4:2:0 JPEG at the same quality errs by up
to 112 at the dot edges); **Save lossless PNG**, in More, keeps every pixel
exactly.

A saved print is megabytes, in proportion to its pixels and to the photo's
detail (measured with the app's own encoder: on the harness fixture 2.3 MB
for 2419×3024 and 3.5 MB for 3024×3780; at 40 MP, 7728×5152, 4.6 MB over a
smooth grey ramp and 39.7 MB over a photo with per-pixel noise over fine
detail, about a byte a pixel, which is what a detailed photograph comes to;
pure noise, which no camera writes, is 2.4 bytes a pixel, 96 MB; against the
~300 KB the playbook cites for a photograph). A halftone screen over paper grain is close
to worst case for JPEG — high-frequency detail in every block — and lowering
the quality to compensate smears the dots, so the size stands as a deliberate
trade. PNG, the lossless choice, is several times larger again.

**Limits.**

- **No size ceiling.** A print is pressed in bands and written as it is
  pressed, so its size is not bounded by any canvas: the press's canvases are
  at most 4096 px wide and 2^22 pixels (Borders' 4096 edge, which every
  browser has honoured; an iPhone read back a sentinel at 4096x1024,
  4096x512, 2048x2048 and 4096x4096 in the device spike), whatever the print.
  What bounds a save is the phone's memory: the decoded photo (4 bytes a
  pixel: 159 MB at 40 MP, 241 MB at 61 MP) and the press's buffers (about a
  hundred megabytes at 40 MP, "What an export holds"). A device that runs out
  gets the smaller-copy question, in numbers, never a quieter file. The only
  format limit is the JPEG's 65,535 px a side.
- **Colour.** A wide-gamut (Display P3) photo is converted to sRGB when it is
  decoded; the engine, its canvases and the file are sRGB. That is a gamut
  loss, not a resolution one.
- **Metadata.** The file carries no ICC profile (untagged is read as sRGB,
  which it is) and no EXIF. The photo's orientation is applied to the pixels;
  the camera's metadata is not copied.
- **Unverified on a device** (claims for an iPhone to settle, in
  DEVICE-CHECKLIST.md): a 40 MP photo SAVED on a phone (the device spike
  decoded a real 40 MP camera file, portrait and EXIF-rotated, upright in
  438 ms and drew it in 61 ms on an iPhone with iOS 18.7; no full Save has
  run there yet), how much memory a
  tab may hold during a 40 MP save, how long one takes, whether the share
  sheet still opens after a press of a minute (the second tap is there for
  when it does not), EXIF orientation on the oldest supported iOS, and Blobs
  kept in IndexedDB across launches.

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

## Licences and provenance

Print Machine's own code is written for it. One part is translated from
another project, and says so, and one typeface is bundled:

- **Tanklager Kompakt** (`src/assets/fonts/Tanklager.woff`), by Ariel Martín
  Pérez, Tunera Type Foundry (http://www.tunera.xyz/), under the SIL Open Font
  License 1.1, unmodified (copied from Border Studio's library, where it is
  credited the same way). The site ships the notice the font carries and the
  licence's full text in `public/licences.txt`, as the OFL asks of software
  that bundles a font.

- **The JPEG encoder's forward DCT** (`src/engine/encode/jpeg.ts`, and its
  copy in `scripts/device-spike/spike.html`) is `jpeg_fdct_float` from the
  Independent JPEG Group's `jfdctflt.c`, with the scale table from
  `jcdctmgr.c` (`aanscalefactor`) and the quality scaling from `jcparam.c`
  (`jpeg_quality_scaling`), libjpeg release 9f (14-Jan-2024), translated to
  TypeScript (and JavaScript) with the same statements in float64. What was
  changed is said in `jpeg.ts`'s header: the samples arrive as floats already
  level-shifted (the colour conversion keeps its fractions where libjpeg
  rounds to 8-bit samples), so jfdctflt.c's `- 8 * CENTERJSAMPLE` on the DC
  term is the conversion's `- 128`. **This software is based in part on the
  work of the Independent JPEG Group.** The IJG's README, with its copyright
  and no-warranty notice unaltered, is `src/engine/encode/IJG-README.txt`.
  The deployed site, whose Save writes every JPEG with this encoder, ships the
  same sentence and that README beside the app (`public/licences.txt`, served
  as `licences.txt`), the documentation the IJG's licence asks for where only
  the program is distributed.
  The rest of the encoder is written from ITU-T T.81 (the Annex K
  quantisation and Huffman tables are the standard's data); the DCT's
  algorithm is Arai, Agui and Nakajima's (Trans. IEICE E-71(11):1095), as
  described in Pennebaker and Mitchell's *JPEG Still Image Data Compression
  Standard*.

The encoder (`JpegEncoder`) writes baseline JPEG with every colour component
at full resolution (4:4:4) from rows pushed in any groups: the same bytes
however they arrive, no sheet-sized buffer. `scripts/check-encode.mjs`
decodes its files in Chromium and holds the error to bounds (at quality 95:
RMSE 0.68 on a gradient; 3.84, largest 26, on a saturated halftone, where
Chromium's own 4:2:0 file at 0.95 is 14.74, largest 77; 1.94, largest 33, on
a real print). The PNG encoder (`PngEncoder`, `src/engine/encode/png.ts`) is
written from ISO/IEC 15948, RFC 1950 and RFC 1951 alone: 8-bit RGB, each row
filtered with whichever of None, Sub, Up and Paeth weighs least (libpng's
heuristic), compressed by the browser's own `CompressionStream`, or, where
there is none (Safari before 16.4), stored uncompressed in deflate's stored
blocks (about 3 bytes a pixel, `storedSize`). check-encode decodes both to
the input exactly; compressed, its file is 0.69 to 0.72 times the size of
Chromium's own PNG of the same pixels. Save writes every file with them,
band by band (`savePrint`, `engine/export.ts`).

Both allocate once (`src/engine/encode/alloc.test.ts`, at 7728 px wide in
bands of 271): once made, the only arrays either makes are pieces of the
file it hands on. The JPEG's are its 256 KiB chunks. The PNG's filtered rows
go to the compressor in batches of 64 rows from a pool made with it, sized for
the band height it is told (`bandRows`: 6 batches, 8.9 MB, at 7728 px wide);
a batch is filled again once its write to the `CompressionStream` has
resolved, which the Compression Streams standard makes the moment the
compressor has read it. The standard requires that; Chromium is checked by
`check:encode`, WebKit by the device spike's compressor row (`(f)`: exact,
20 of 20 round trips, on an iPhone with iOS 18.7), and node's does not follow
it (it can resolve first and read later), so the
encoder also compares the zlib stream's closing Adler-32 with that of the
batches it handed over, and refuses the file rather than write a wrong one. A compressed chunk is handed on
between its IDAT header and CRC as it came, and a stored block is written in
place into the chunk handed on: neither is copied.
