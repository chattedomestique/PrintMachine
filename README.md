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
npm run verify          # the gate: lint + typecheck + check-css + test + build
npm run verify:offline  # proves the build boots with no network (a PAGES=1 build)
npm run verify:geometry # the dock holds still; 44px targets; 200% text; the app bar
PAGES=1 npm run build   # production build for the GitHub Pages sub-path
npm run sync:styleguide # re-vendor the style guide from ../styleguide
```

```sh
npm run measure:fidelity  # Save keeps every pixel of the photo (fails under a gate)
npm run measure:alloc     # what an export holds, per output pixel (fails over 35 B/px)
npm run measure:export    # export time and desktop memory (informational)
npm run build && npm run check:save   # the save flow in the built app, tapped
npm run build && npm run check:touch  # tap-to-select on the sheet, touched
```

The four that can fail run in CI after `verify`, `verify:offline` and
`verify:geometry`, with the harness's parity gate (`npm run harness -- --out
p.json --no-hashes --parity 1000`: the preview's entry point and the export's
give the same bytes); `measure:export` runs there too, for the record (see
"Every pixel of the photo, measured" and "What an export holds").

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
  styles/    the app's own CSS over the style guide: index.css (app facts),
             editor.css (the planes), dock.css (the panels), shell.css.
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
  torn, bled tone and its own registration offset, which `pressPlate` hands to
  `cutKnockout` (`engine/knockout.ts`) rather than the knockout roughening the
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
so no sheet is a sliver. `sheetAspect` is the one place a sheet becomes a
number, and everything downstream — the cover fit, the pan limits, Fit, the
preview and the export — takes that number.

At the height where the sheet holds the photo at its own pixels, the blit is
**snapped**: drawn at exactly the photo's size, at a whole-pixel offset, kept
inside the travel that still covers the sheet (`snapRect`). Centred, the 4:5
crop of a 12 MP photo sits half a pixel off the grid, and a bilinear blit at a
half-pixel offset blurs every pixel into its neighbour: measured, 0.753 of the
original's Laplacian energy unsnapped, 1.000 snapped. A zoomed photo snaps the
same way at its own native height. "Holds the photo at its own pixels" means a
scale within 2.5 px of 1:1 over the sheet's shorter side (`SNAP_PX`): the
planner's native height can land up to a pixel and a half past 1:1 across the
sheet's shorter side on the app's sheets, so on a tall sheet whose width binds
(a 2268x4032 photo on its own sheet at 113% is drawn at 1.0005) a tolerance
taken over the height let a resample of every pixel through. A test plans real
and random photo sizes on every sheet the app makes, at exactly 100% and at
every zoom to 400%, and the planner's random photos on any aspect zoomed past
100%, and checks that each native plan is drawn at the photo's own pixels, at
a whole-pixel offset. The claim stops there on purpose: on a fixed landscape
sheet, which the app does not make, the native width at exactly 100% can be a
pixel or two wider than the photo (3001x2251 on 3:2 plans 3002x2001), the
photo at its own size would not cover it, and the blit stays a cover-fit
resample; such a sheet would need the planner to fit its width to the photo's
first, and a test pins the case. A preview is 1:1
when the photo lands on it at its own size (a photo no larger than the
preview, or one zoomed to that point), and snaps then too; a blit that is not
1:1 (a large photo's preview at 100%, a small photo enlarged to the reference
height) is left alone.

#### The photo always covers the sheet

Panning is limited to where the photo still covers the sheet: its centre can
move until one of its edges reaches the trim, and no further. That limit is
enforced **where the sheet is drawn** (`coverRect` clamps whatever placement it
is handed), and again by every edit that moves the photo, zooms it or changes
the sheet's shape, so the stored value is honest too. The second place matters
because a pan that is legal on one sheet is not on another: push a landscape
photo to one side on a square sheet, switch to 4:5, and without it a strip of
bare sheet would print. A property test throws random sheet changes (Original
among them), pans, zooms and replaced photos at the document and checks the
sheet stays covered after every one.

The compositor still treats a transparent ground pixel as paper rather than
black — `getImageData` hands untouched pixels back as transparent *black*, and
the first cut printed exactly that. Panning can no longer uncover the sheet, but
the same path carries the knockout under the second ink (the photo's alpha goes
down there) and a transparent PNG's own transparency, and there is a test that
uncovered ground is bit-for-bit the paper the app draws with no photo at all.

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

The size limits belong to canvases, not to a stored file, so they live where
canvases are made:

- **The preview** decodes a *working copy* sized to what it shows
  (`previewArea`, `features/media/decode.ts`). At 100% that is 4 MP (2048 x
  2048 by area, so its long edge is never under 2048 px: never smaller than the
  copy the app used to keep); a 24 MP photo held decoded for a one-megapixel
  preview would be 98 MB of a phone's memory for pixels nobody sees. Zoomed in
  to crop, the copy grows in tiers that double (8.4 MP, then 16.8 MP, the
  canvas ceiling, or the whole photo if it is smaller), so the preview shows
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
  24 MP photo on its own sheet at 400% saves 2400x1800; at 100%, 4729x3547).
  Nothing reads the copy's size: the cover fit, the pan and the export all use
  the photo's true size from the document, and the copy is drawn scaled into
  the same rectangle, so the preview places the photo exactly where the print
  does.
- **Save** decodes the *original*, in full (4 bytes a pixel of the photo, about
  98 MB for 24 MP), and closes it the moment the photo is in the ground, so the
  print is drawn from the original's pixels, never from the preview's copy.
- **The export canvas** is the one ceiling a photo can meet: 16.7 MP of area
  (`MAX_AREA`, `engine/exportPlan.ts`), the most a browser canvas is guaranteed
  to hold, and no edge cap. A print whose photo would land above it pixel for
  pixel (a 24 MP photo on its own Original sheet) is the one resample, made at
  Save and stated before the tap; the stored photo keeps every pixel, and the
  same photo on a 4:5 sheet saves at its own 3427x4284. Saving above the
  ceiling would need tiled rendering and a JavaScript encoder, which are not
  built.

Photos saved by an older build are the 2048 px copies it made; the originals
are gone. Such a photo (no `native` flag, a long edge of exactly 2048) carries
a note in the Photo tool's File tab: "This photo was saved at reduced size by an older
version. Choose it again for full resolution."

**A photo cannot silently drop out of a print.** If the stored image is missing
or cannot be decoded, the Photo tool's File tab says so ("This photo could not
be loaded. Choose it again.") for as long as it is true, and so does Save,
whichever tool is open: Save cannot be pressed, its name carries the sentence,
and the status card above the dock shows the same sentence as an alert, with
Choose again. Nothing is ever saved as the type on bare paper.

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
by the same `cutKnockout` the second ink uses. Without it a pale block over a
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
never at the preview's: the height at which the photo lands on the sheet pixel
for pixel. A 12 MP landscape photo on 4:5 saves at 2419×3024, the same photo
upright at 3024×3780, a 24 MP iPhone capture on 4:5 at its own 3427×4284. A
photo with fewer pixels than the reference height is enlarged rather than the
print made smaller (never under 1800 px tall); a print with no photo saves at
3600 px tall. The one ceiling is the export canvas's area, 16.7 MP: a 24 MP
photo on its own Original sheet saves at 4729×3547, and says so.

It says so **before** the tap. The More sheet's first row reads "Saves
2419×3024", and when the print is not the photo's own pixels, why, in numbers:
"photo is 1600×1200: upscaled 1.5x", or "capped at 16.7 MP, the most a browser
canvas is guaranteed to hold; photo is 5712×4284". Save's own name carries the
size ("Save 2419×3024 JPEG"), the toast repeats size and reason the moment a
save starts, and the confirmation repeats the size. Save itself stays one word,
so the app bar never wraps. Nothing falls back to a smaller file: a press that
fails stops, with the reason and the numbers, and a smaller copy is only ever
one the person chose.

A print at the photo's own resolution is seconds of work on a phone, so Save
is a flow (`features/shell/useSave.ts`, a state machine with no UI in it):

- **Pressing.** Save reads **Saving** before any work starts (two painted
  frames), and the status card above the dock says "Pressing 3024×3780, plate
  2 of 3", with **Cancel**. The press runs through `renderPrintAsync`, which
  runs the very stages the preview runs and yields to the page between them,
  so the progress paints and Cancel works, up to the file itself: a Cancel
  tapped while the file is being encoded (a second or more on a phone) leaves
  no file. The preview stops rendering meanwhile (a full-size press and a
  preview frame never hold their buffers together), and the rest of the page
  is inert (the status card and its Cancel aside), keyboard undo included, so
  the document cannot change under the press and the file is the print on
  screen. The two entry points print the same bytes
  at the same height: `npm run harness -- --out p.json --no-hashes --parity
  1000` renders every harness document through both and fails if any differs.
- **Sharing.** The share sheet needs the tap that opens it to be recent, and a
  press outlasts it. A press that finished within a second of the tap would
  share at once, but at a photo's own resolution none does (a print with no
  photo, 2880×3600, takes over 4 s on a desktop): Save becomes **Share** and
  the card says "3024×3780 is ready (6.2 MB)", a fresh tap that shares the file
  already made (the card's × lets it go). A share that fails keeps the file and
  the button: in a home-screen app it never falls through to a download, which
  on iOS navigates to the image and takes the app with it. On a desktop with
  no share sheet the file downloads.
- **The file.** JPEG at quality 0.95 (measured on the harness fixture: 1.20x
  to 1.37x the bytes of 0.92, for cleaner dot edges). Below quality 1.0
  browsers store JPEG colour at half resolution (4:2:0), the one loss a quality
  setting cannot remove, so **Save lossless PNG** is in the More sheet.
- **Too big for this device.** Over its limit an iOS canvas does not throw: it
  hands back a blank one, and the print would come out as empty paper. So both
  of the press's canvases are proved at full size before any work — a sentinel
  pixel (rgb 1, 2, 3) written at the last pixel and read back (`fitsCanvas`,
  `engine/export.ts`) — and a canvas that fails, an encoder that returns
  nothing, or memory running out is one error, `CanvasLimitError`, with the
  plan in it. Save then asks, in numbers and with the reason: "This device
  couldn't press 2419×3024 (a canvas that size came back blank). Save a
  smaller 1814×2268 copy instead?" (a reason in the browser's own words — "Out
  of memory" — is shown as it came, so a fault that is not about size cannot
  hide behind the offer). The copy offered is the
  largest that proves itself here, stepping down by three quarters of the
  height at a time (the sheet's shape kept) and never under 600 px; when none
  does, it says this device cannot save the print. Nothing is pressed until the
  person picks Save smaller, and the confirmation names what was saved
  ("Saved 1814×2268, a smaller copy").
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
| 2268x4032 (a tall 16:9), zoomed to 113% | Original | 2008x3569 | 1.0000 | 1.0000 | 0 |
| *control: drawn half a pixel off* | 4:5 | 2419x3024 | 0.79 | 0.927 | |
| *control: from a 2048 px copy (the old import)* | 4:5 | 2419x3024 | 0.13 | 0.875 | |

The gates are a Laplacian energy (the finest detail, which any resampling takes
down) of at least 0.98 of the original's and a correlation of at least 0.999,
with the file the size the plan says and the stored photo the picked file byte
for byte; the two controls are the ways this app used to draw a photo, and the
script fails if either passes. The same 5712x4284 photo on its own Original
sheet meets the one ceiling and is saved at 4729x3547, saying "capped
at 16.7 MP, the most a browser canvas is guaranteed to hold; photo is
5712×4284". A JPEG whose EXIF says to rotate it saves upright, a PNG's
transparent hole prints as paper (never black), a document whose stored photo
is gone is refused rather than printed on bare paper, and the default print
and two documents of small type correlate with themselves at twice the height
("The same print at every size"): 0.97 or better, except type at 20%, held to
0.95.

`scripts/check-save.mjs` taps the same flow in the built app: a 12 MP photo on
4:5 (Save reads Saving and the card offers Cancel within 100 ms, the card
counts the press, the file is the size the More sheet and Save's name
promised), a device whose canvases come back blank
above 5 MP (the smaller-copy question before anything is pressed, then that
file), a tab closed mid-press (the notice at the next launch, its choices
waiting, and saying so, until the photo is back), a stored photo
deleted (the card and Save say so, and no file), a Cancel tapped while the file is
encoded (no file, with a share sheet or without) and Ctrl+Z pressed during a
press (the document stays as it was, and the file is that print).

### What an export holds

An export at a photo's own resolution is 11-17 MP, so every sheet-sized buffer
is 45-67 MB of a phone's memory, and an iPhone evicts a tab that holds too
much. `scripts/measure-alloc.mjs` counts it exactly: it runs the export path in
node with every typed-array constructor wrapped and, at each sheet-sized
allocation, collects the garbage and reads back what is still live — the same
on every run, unlike a browser's resident memory. Its gate is 35 bytes per
output pixel.

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
  made once per render and every pass works in them, to the same numbers (the
  shift walks the sheet in the direction it moves, so it never overwrites a
  pixel it still has to read). The knockout is cut straight into the running
  bytes, and the second ink's light half takes the coverage's own buffer.
- **Nothing the canvas holds is held twice.** The sheet is printed a band of
  rows at a time into one band-sized buffer, and each band is put on the
  canvas, instead of a full-size copy being put at the end; the knockout
  takes the photo's alpha down as each pixel is printed, instead of on a copy
  of the photo; a glyph raster's alpha is read a band at a time.
- **Let go as soon as done.** Once the plates are pressed the workspace, the
  ground's luminance and the switch mask are dropped, and an export's glyph
  canvas is emptied (its width set to 0), before the print and the encode.
- **The ground's luminance on a small grid.** The second ink decides each
  glyph's ink from the photo's luminance blurred across about a word — a
  radius of 500 px on a 12 MP export, the press's slowest pass and a
  sheet-sized float held through every plate, for a field with nothing finer
  than a few hundred pixels in it. It is now blurred on a grid of cells a
  sixteenth of the radius across and read back bilinearly. Measured on the
  harness photo: the switch and the knockout move on under 0.12% of the
  pixels and nothing else moves. Under Grain the switch is error diffusion,
  which re-dithers its whole mixing band at any change in its input: the same
  ink density (to 0.1%), a different arrangement of the grains there.
- **Faster, and it never stops the page for long.** The vertical blur now
  walks the sheet by rows with a running sum per column (a column walk was a
  cache miss per pixel, most of the press's time on a wide sheet; the sums are
  the same additions in the same order, so the bytes are too), and the press
  yields to the page inside each pass as well as between them, so the progress
  keeps painting and Cancel is taken within a stage.

Measured (`node scripts/measure-alloc.mjs`, `node scripts/measure-export.mjs`;
before the diet -> after):

| Case | Sheet | Typed arrays, peak | With canvases and the decoded photo | Chromium time | Chromium RSS |
|---|---|---|---|---|---|
| 1. 12 MP portrait, 4:5, second ink | 3024x3780 | 68.4 -> 23.4 B/px | 76 -> 31 B/px (359 MB) | 12.5 -> 5.8 s | +707 -> +311 MB |
| 2. 3 plates, 4 passes, 4096x4096 | 16.8 MP | 92.7 -> 25.3 | 101 -> 33 (558 MB) | 39.2 -> 11.9 s | +1094 -> +491 MB |
| 3. No photo | 2880x3600 | 44.5 -> 15.4 | 53 -> 23 (243 MB) | 7.8 -> 3.8 s | +388 -> +278 MB |
| 4. Grain, 4096x4096 | 16.8 MP | 68.1 -> 23.3 | 76 -> 31 (524 MB) | 21.7 -> 8.0 s | +1104 -> +394 MB |
| 5. A legacy print, 5 plates, 2 backings | 16.8 MP | 112.0 -> 29.3 | 120 -> 37 (625 MB) | 65.6 -> 18.7 s | +1484 -> +445 MB |

The gate is the typed-array column (35 B/px, cases 1-4); desktop Chromium's
memory is informational (V8 frees short-lived buffers far more eagerly than an
iPhone's JavaScriptCore), and the phone's own is a DEVICE-CHECKLIST item. The
legacy five-plate print (kept whole: see "The plate budget") costs 16% more
than the worst print the budget allows, well inside the margin.

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
the glyphs and therefore on the machine's fonts: 0.9706 on one machine, 0.9644
on the CI runner. Before the scale fixes the same document read 0.77. Below the
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
`scripts/check-css.mjs` is the honest subset of the style guide's own lint
(which lints the style guide's source tree and is not vendored) that a file
can show — no blur or backdrop filter, no blurred shadow written as a number,
no colour literal (the symbols' SVG masks aside), no font size in px, no
`outline: none` without a replacement, no `!important`, no button, input,
select or textarea without a class of its own anywhere in a selector. It runs
its own cases first, so a check that has stopped catching what it names fails
before the app's files are read. What only a render can judge (contrast, the
look) is the screenshots'.

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
while it is on screen. That port reads a few of the style guide's button-private properties,
which is why the vendored commit is pinned and why a sync must be followed by
`npm run verify:geometry`.

**What the gates check, and what they cannot.** `check-css` (in `verify`) holds
the app's CSS to the style guide's rules a file can show; `verify:geometry`
holds the dock to its one geometry, every control to a 44 px target it owns,
200% text to no clipped words and the app bar to one row (see "The dock"). Both
run in CI. None of them sees colour: contrast is the style guide's own,
verified in its repository for the `default` palette and not re-run here, and
the app adds no colour of its own (the inks and stocks are data, shown with
their names). None of them is an iPhone: Safari's real touch slop, VoiceOver's
reading order, Larger Text past 200%, the safe areas and the home-screen app
are DEVICE-CHECKLIST items. And none of them has taste: the review screenshots
(`npm run verify:geometry -- --shots <dir>`, read beside Border Studio's at
the same widths) are where a screen that passes and still looks wrong is
caught.

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
scrolls sideways. Border Studio's README claims such a suite and has no file
for it; this one is a file, and it checks more:

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
  that toast up, ready, and the photo that could not be loaded. Cancel, Share,
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
document's own defaults, never retyped (a test holds them equal). A panel with
several settings shows one at a time: tap its name, or swipe up from it, for
the others (Border Studio 4860519). Size, Rotation and Position have two
ranges: the slider spans where people work (10–100%, ±45°, the sheet) while a
pinch, the keys, a nudge and a typed value reach the whole range (1200%,
±180°, 30% past the trim); the thumb then pins at the end and the value shows
the truth.

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
it.

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

`engine/` must never import from `state/`, `ui/`, or `features/`, and must never
touch React or the DOM beyond a canvas context handed to it. That constraint is
what lets the export path re-render a fresh, overlay-free frame with the exact
same code the preview uses. `ui/` knows nothing about riso and imports nothing
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
  table, not a colour picked off the photo; presets and seeds are features
  this app's verdict does not keep. More holds what Save makes, the offline
  state and the lossless PNG.
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
  only when the tool it describes changes); Border Studio's fades after 2.8 s
  with `aria-hidden`, which no screen reader hears. It also says what the open
  tool's gestures do.
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

Nothing is down-rezzed: a photo is stored as it was picked and a print is
saved at the photo's own pixels, up to the one ceiling below, and says so when
it is not. The one lossy step in a saved file is JPEG's own: below quality 1.0
a browser stores colour at half resolution (4:2:0). **Save lossless PNG**, in
More, is the lossless path.

A saved print is a few megabytes, in proportion to its pixels (on the harness
fixture: 1.9 MB for 2419×3024, 2.8 MB for 3024×3780, against the ~300 KB the
playbook cites for a photograph). A halftone screen over paper grain is close
to worst case for JPEG — high-frequency detail in every block — and lowering
the quality to compensate smears the dots, so the size stands as a deliberate
trade. PNG, the lossless choice, is several times larger again.

**Limits.**

- **16.7 MP.** The export canvas, by area (`MAX_AREA`, 16,777,216 px), is the
  one ceiling: a print above it would need tiled rendering and a JavaScript
  encoder, which are not built (the follow-up, if a print bigger than 16.7 MP
  is ever wanted). The number is Borders', which also caps an edge at 4096;
  WebKit's documented canvas limit is an area, so this app has no edge cap,
  and nothing at all applies at import. It is not yet verified on an iPhone.
  A wrong guess cannot break Save quietly: every canvas the press uses is
  proved with a sentinel pixel first, and a canvas that comes back blank gets
  the smaller-copy question, in numbers. The DEVICE-CHECKLIST experiment
  probes the widest and tallest canvases the ceiling allows on a device.
- **Colour.** A wide-gamut (Display P3) photo is converted to sRGB when it is
  decoded; the engine, its canvases and the file are sRGB. That is a gamut
  loss, not a resolution one.
- **Metadata.** The file is a canvas encode: no ICC profile and no EXIF. The
  photo's orientation is applied to the pixels; the camera's metadata is not
  copied.
- **Unverified on a device** (claims for an iPhone to settle, in
  DEVICE-CHECKLIST.md): how much memory a tab may hold, whether the share
  sheet still opens after a press of several seconds (the second tap is there
  for when it does not), Safari's JPEG chroma, EXIF orientation on the oldest
  supported iOS, and Blobs kept in IndexedDB across launches.

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

