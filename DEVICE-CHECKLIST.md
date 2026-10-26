# Device checklist

Some things cannot be automated and have to be checked on a real iPhone,
against the **deployed URL**, before calling a build done. Localhost proves
nothing about a sub-path deploy.

Run this before every meaningful release.

## Install

- [ ] Add to Home Screen → the icon is the real PNG, not a blurry screenshot
- [ ] Launches standalone, with no Safari chrome
- [ ] Status bar text is legible against the app's top edge in **both** themes
- [ ] Nothing collides with the notch or the home indicator
- [ ] Browser UI tint matches the app (`theme-color`: #F5F5F5 light, #0E0E0E
      dark, the style guide's canvas)

## Offline

**Order matters, and getting it wrong looks identical to a broken app.** An iOS
home-screen PWA has to be launched at least once *while online* before it will
ever open offline. Adding to the home screen from Safari is not enough — the
standalone instance has to run once with a network to install its worker and
finish precaching. Straight from "Add to Home Screen" into airplane mode gives
you "No internet connection" every time, no matter how correct the build is.

So:

- [ ] Add to Home Screen
- [ ] **Launch from the home-screen icon while still online**
- [ ] Open More (the ••• in the app bar) and wait for "Works offline" — that
      is the app saying it has finished precaching and will open offline (the
      first time it happens, a toast says "Ready to open offline" too)
- [ ] *Now* airplane mode → launch from the home screen → it fully boots and is usable
- [ ] Redeploy a visible change → relaunch online once → the new version appears

> `npm run verify:offline` proves the build itself: it serves `dist/` at the
> real Pages sub-path, installs the worker, cuts the network and cold-launches
> in a fresh tab, and it runs in CI. What it cannot prove is that iOS honours
> any of it, which is what this section is for.
>
> "Works offline" is only as honest as the precache manifest — it reports that
> the worker finished caching whatever it was handed. A truncated manifest
> would still say it. That case is what the CI check exists to catch.

## Edit

- [ ] Open each tool (Type, Ink, Photo, Press) and each of its tabs: the sheet
      stays exactly where it is and the same size; nothing in the dock scrolls
      at the standard text size; every control is comfortably tappable with a
      thumb (no near misses between neighbours)
- [ ] Tap the open tool again → its panel closes and the sheet grows to the
      full height
- [ ] Tap targets, with a thumb: a setting's value (Size's "90%") opens the
      number pad and its name (Line height, with its chevrons) the list of
      settings, never the slider just under them; the [−] and [+] beside a
      slider never catch the name or value above; the sheet's select and the
      plate button open on any tap inside their frame
- [ ] Ink › Over photo: tap Off, Second ink and Backing in turn → the control
      stays exactly where it is while the rows under it change
- [ ] Tap a plate on the sheet (RISO) → the plate button names it and its
      crosshair moves to it; nothing moves and Undo stays as it was
- [ ] Put a finger on a plate that is not selected and drag → that plate
      moves with the finger in the same touch, and the other stays put; drag
      from bare paper → the selected plate moves; nothing eats the taps
- [ ] A small caption (Size about 20%) is easy to pick with a thumb, including
      a touch just beside it
- [ ] Double-tap on the selected plate (or on bare paper) re-centres it and
      zeroes its turn; a double tap on a plate that is not selected only picks
      it (RISO keeps its −4° and its place)
- [ ] The first photo brings a hint over the dock; it names the photo's
      gestures while Photo is open and the type's otherwise, and it goes for
      good with its × or with the first drag on the sheet; with VoiceOver on,
      it is read when it appears and when the tool changes, not again after
      a save
- [ ] Photo tool open: drag and pinch the photo — it zooms 100–400% and stops
      at its edges, never showing bare paper round it; switch the sheet shape
      in Photo › Sheet and it still covers the sheet
- [ ] The first photo opens on Sheet: Original, the photo's own shape — a
      landscape photo gives a landscape sheet that fits the screen without
      distortion; Remove the photo → the sheet is 4:5 again
- [ ] Arrow keys nudge the selected plate (attach a keyboard, or use a Mac)
- [ ] Type a long string → tap Fit → it sits on the sheet, and the next pinch
      or slider touch starts from that size (no jump)
- [ ] Type › Size: drag the slider end to end with a thumb — 10% to 100%, and a
      small drag makes a small change at the 10% end (not half the size per
      pixel); [−] and [+] move it one percent; tap the value and type 240 →
      240%; pinch past 100% → the thumb stays at the end and the readout says
      the real value (e.g. 240%), and [−] then reads 239%; double-tap the track
      anywhere → 40% (not where the finger was), and one Undo → back to the
      size before the double tap (wait a moment after any drag first: a drag
      released under half a second before the first tap goes with it); the same on a print with a photo, where the
      preview takes a moment to redraw after the first tap; change the
      typeface, then double-tap ON the thumb (the first tap may nudge it and
      back) → 40%, and one Undo takes back only the reset (the typeface stays)
- [ ] Drag a press slider → the preview keeps up, and the grain does **not**
      visibly re-randomise
- [ ] One slider drag is one undo step; adding a plate is its own step; a
      drag that comes back to where it started, or a double tap on a slider
      already at its default, adds no step: one Undo still takes back the
      change made before it (from a fresh launch, Undo stays unavailable)
- [ ] Re-roll → a different sheet (tear, mottle, registration); Undo brings the
      previous one back
- [ ] Background the app for 5 minutes → return → the document is still there
- [ ] Force-quit and relaunch → the document is still there

## Photo

- [ ] Choose a photo straight from the camera roll (a 24 MP capture): it
      imports, the right way up, with no "reduced size" note; a HEIC the
      browser cannot open says "That image could not be read." rather than
      failing silently
- [ ] Pan and zoom that 24 MP photo for a minute: no tab reload (the preview
      holds a working copy sized to the zoom: 4 MP at 100%, at most 16.8 MP,
      67 MB, zoomed far in; never the 98 MB original)
- [ ] Zoom a 12 MP photo on 4:5 to 300% and let go: within a moment the
      preview sharpens (the photo is decoded again, whole) and reads as crisp
      as the photo itself; back at 100% nothing reloads
- [ ] Save it: completes without a tab reload (Save decodes the original,
      about 98 MB, until its last rows are in the print) and the file shows
      the photo, upright
- [ ] A transparent PNG: paper shows through where it is transparent
- [ ] Remove the photo → Undo: it comes back (not bare paper, no alert)
- [ ] A print saved by an older build (its photo cut to 2048 px) shows the
      "saved at reduced size" note in Photo › File

> The photo is stored and decoded whole, at any size: nothing here should ever
> show a photo cut down on import, and nothing caps a saved print: it is
> pressed in bands and written as it is pressed, at the photo's own pixels
> whatever their number. What bounds a save is the phone's memory (section
> "Native resolution at any size", below).

## Save

- [ ] More says the size before the tap ("Saves 2419×3024" for a 12 MP photo
      on 4:5), and why when it is not the photo's own pixels; VoiceOver reads
      Save as "Save 2419×3024 JPEG"
- [ ] Tap Save → within a moment Save reads "Saving", a toast repeats the size,
      and a card above the dock reads "Pressing 3024×3780: loading the photo",
      then (with a second ink) "...: reading the photo", then "Pressing
      3024×3780, 0%" and on in percent, then "...: writing the file", with
      Cancel; the preview holds still and nothing else answers a tap
- [ ] Cancel mid-press → back to Save, no error, nothing saved
- [ ] A press that takes more than a second → Save reads "Share" and the card
      "3024×3780 is ready (… MB)" → tap Share → the native share sheet appears
      → Save Image → the file **is** in Photos, at the size More said (check it
      in Photos' info panel)
- [ ] Expect that second tap on every save: no press at a photo's own
      resolution finishes within the second that would share at once (even a
      print with no photo is 2880×3600; it takes about 3 s on a desktop). A
      save that ends on "Share" is not a bug; one whose share sheet does not
      open from that tap is
- [ ] Home-screen app: dismiss or break the share sheet → "Share" is still
      there; the app never navigates to the image
- [ ] More › Save lossless PNG → the same flow, a .png file in Photos
- [ ] Right after choosing a photo, Save cannot be tapped and the card reads
      "Loading the photo…" until the photo is in the preview (a quick decode
      shows no card at all)
- [ ] At 320 px wide (an iPhone SE) and at the largest text size, the app bar
      stays one row: Save becomes an icon rather than wrapping
- [ ] Same phone, largest text size, a 1600×1200 photo on its own Original
      sheet zoomed to 300% (the longest reason a real document gives: "photo
      is 1600×1200 at 300% zoom: upscaled 4.5x"), Save: while it presses, the
      card's Cancel is on screen and stops the press; when Save reads Share,
      no card covers it and one tap on it opens the share sheet. Again with
      the Photo tool open
- [ ] A confirmation appears after saving, with the pixel size
- [ ] Cancel the share sheet → no error toast
- [ ] Swipe the app away (or let iOS evict it) while it reads "Pressing …" →
      reopen it → a dialog reads "The last save, 2419×3024, did not finish."
      with Try again, Save smaller (1814×2268) and Cancel; Try again completes;
      a launch after that one says nothing
- [ ] If Save ever says "This device couldn't press W×H (reason). Save a
      smaller W'×H' copy instead?" (a canvas came back blank, memory ran out
      at the smallest band, or the photo could not be decoded whole): note the
      device, both sizes and the reason; Save smaller → the file in Photos is
      W'×H', and the confirmation says so. Nothing is saved until Save smaller
      is tapped
- [ ] The saved file has **no** selection crosshair in it (the thirds guides are
      gone; the crosshair is the one editing aid left, and it must never print)
- [ ] File size: megabytes, in proportion to the pixels (a 12 MP photo on 4:5:
      about 2-7 MB as JPEG; a 40 MP photo on its own sheet: 15 to 30 MB for a
      real photograph, 11 to 38 MB between a smooth photo and pure noise); PNG
      several times that
- [ ] Memory, the hard gate a desktop cannot give (`measure-alloc.mjs` counts
      it; desktop memory is not a phone's): with Safari's Web Inspector
      attached (Timelines > Memory), Save a 12 MP portrait on 4:5 with the
      second ink on — the page's peak stays under about 450 MB (the count is
      160 MB: typed arrays, the canvases, the decoded photo and the file,
      pressed in bands), and the tab is not reloaded
- [ ] The heaviest print the budget allows: a 4096x4096 photo on 1:1, three
      plates, two with a second ink and one with a backing — Save completes
      without a tab reload (counted: 201 MB at peak)

> Expect megabytes, not the ~300 KB the playbook cites for photographs: the
> print is saved at the photo's own pixels (15 to 30 MB for a 40 MP
> photograph), with every colour sample kept (4:4:4), and a halftone screen
> over paper grain is close to worst-case for JPEG's DCT. Dropping quality to
> compensate smears the dots, which is the one thing this app exists to
> render, so the size stands.

Saving at full resolution (none of these can be automated):

- [ ] 12 MP photo, default document, Save: completes without a tab reload; the
      saved file's pixel size equals what More said; Photos shows 2419×3024
      (or whatever More said)
- [ ] Two Saves in a row: both complete, both files are the size More said
- [ ] Save in Low Power Mode: completes (slower is fine)
- [ ] Time from the tap to the share sheet, written down with the device and
      the size, so a slower build shows
- [ ] A square 4096×4096 photo (16.8 MP) on 1:1: Save completes at
      4096×4096, or shows the explicit smaller-copy question, never a reload
- [ ] The share sheet appears after a press of more than 10 seconds (the
      "Share" tap is there for when the first tap's activation has run out;
      check that it works)
- [ ] Import a HEIC straight from the camera roll
- [ ] An EXIF-rotated portrait (a photo taken holding the phone upright) is
      upright in the preview and in the saved file

## Native resolution at any size

A print is pressed in bands of rows, its type and any resampled photo drawn on a
grid of tiles (at most 4096 px wide and 2^22 pixels), and written into the file
band by band (README "Saving at the photo's own pixels", "What an export
holds"). What only a phone can settle:

- [x] **The device spike**, run three times on 2026-10-25 on an iPhone (iOS
      18.7, in the Claude app's in-app browser: WKWebView, Safari's WebKit;
      430x932 CSS px, DPR 3, 4 cores). Measured: the page's own synthetic
      7728x5152 JPEG decoded in 277, 306 and 258 ms, first drawn in 55, 50
      and 47 ms, the tab kept; a 1:1 blit of it identical across two tile
      origins with smoothing off and with it 'high'; a cropped decode of an
      EXIF-rotated JPEG landing on the requested rect of the upright image at
      orientations 1, 3, 6 and 8; every canvas font up to 12,000 px honoured;
      the sentinel pixel read back at 4096x1024, 4096x512, 2048x2048 and
      4096x4096; the JPEG encoder at 62, 65 and 62 ms/MP (R 0.49, 0.52 and
      0.49 against this repository's reference machine); and (second and
      third runs) a CompressionStream write resolving only once its chunk is
      taken, 20 of 20 round trips exact. The tile grid and the per-band blit
      of a photo at its own pixels are built on the blit row, Save's one held
      decode of the original on the decode row, and the lossless PNG's reuse
      of its batches on the compressor row.
      The page is `scripts/device-spike/spike.html` (self-contained, no
      network request; it carries the Independent JPEG Group's README, which
      their licence asks for wherever the encoder's source goes, so it can be
      published as a private page on its own).
- [x] **The spike with a real 40 MP camera file.** Third run: the user's own
      camera photo, portrait and EXIF-rotated, 5152x7728 (39.8 MP), decoded
      upright in 438 ms and first drawn in 61 ms, the tab kept (line (a)
      "your photo": PASS); a 1:1 blit of it identical across two tile origins
      with smoothing off and with it 'high'. What the spike cannot show (a
      full Save of such a photo: its peak memory, the share sheet with the
      file, the time from the tap to "Share", backgrounding) is in the items
      below.
- [ ] **Save a 40 MP JPEG.** Import a 7728x5152 photo (and an 8064x6048 48 MP
      camera-app JPEG, and a 9504x6336 one if one exists) from the camera roll;
      Save on Original: the file is 7728x5152 (or the photo's own size). No tab
      reload; note the device, the time from the tap to "Share", and whether
      the full decode (`createImageBitmap`, 159 to 241 MB) is what fails when
      something does. WebKit makes the decode's buffer at full size and, if it
      cannot, rejects with "Cannot create an image buffer from the argument to
      createImageBitmap": write down the message the device gives. If it
      fails, "This device couldn't press ... (...)" must appear with a smaller
      copy, never a reload.
- [ ] **Peak memory.** Safari Web Inspector (Timelines > Memory) during a 40 MP
      save on Original: the peak stays under about 350 MB; during a 61 MP save
      under about 450 MB; the worst legal press (grain at screen 36,
      misregistration 30) at 61 MP under about 540 MB. `measure-alloc` holds
      what it counts (the typed arrays, the canvases, the decoded photo and
      the file's bound) under those: 321, 410 and 491 MB measured. Write down
      the phone's own peak beside them; what the browser holds besides is
      what only a phone shows.
- [ ] **Tile canvases.** In the console on the deployed app, for [4096, 1024],
      [4096, 512] and [2048, 2048], write a sentinel pixel at the last pixel
      and read it back:

      ```js
      for (const [w, h] of [[4096, 1024], [4096, 512], [2048, 2048]]) {
        const c = document.createElement('canvas'); c.width = w; c.height = h
        const g = c.getContext('2d'); g.fillStyle = 'rgb(1, 2, 3)'; g.fillRect(w - 1, h - 1, 1, 1)
        console.log(w, h, [...g.getImageData(w - 1, h - 1, 1, 1).data].join()); c.width = 0
      }
      ```

      Each should print `1,2,3,255` (the device spike read these back in the
      Claude app's WebKit view). The export never makes a canvas wider than
      4096 or larger than 2^22 pixels (a glyph tile; a photo's band canvas is
      at most 4096 x a band, about 2 MP), and every one is proved this way
      before a press.
- [ ] **Font clamp.** A 61 MP portrait photo on its own sheet (9504 px tall),
      type at 120%: the glyphs in the file are as wide as the preview shows
      them, not 17 to 38% narrower (the device spike read every font up to
      12,000 px honoured; type over 9216 px is drawn scaled anyway).
- [ ] **Share sheet with a big file.** A 20 to 40 MB JPEG (a 40 MP save) and a
      PNG of 70 MB or more (Save lossless PNG): the card reads "... is ready
      (N MB)", the tap on Share opens the sheet, Save Image puts the file in
      Photos at the pixel size More said. Also AirDrop and Files. Note any size
      at which the share fails.
- [ ] **JPEG colour.** Open a saved file at 100% in Photos on a saturated
      halftone (the pink ink): no colour smear at the dot edges; the colours
      match the preview (no ICC profile in the file: untagged is sRGB).
- [ ] **Time.** Write down, per device: 12 MP, 24 MP and 40 MP+ saves, from the
      tap to "Share", and in Low Power Mode. Measured on this repository's
      reference machine (desktop Chromium): 15.1 s for a 40 MP save on
      Original, 379 ms a megapixel (README "What an export holds"). The device
      spike measured only the phone's encoder (62 to 65 ms a megapixel on its
      halftone image, R 0.49 to 0.52) and estimated a 40 MP save at about 16
      to 17 s from it (33 s x R, the 33 s an estimate for the reference
      machine from before its save was measured).
- [ ] **Backgrounding and the screen.** Start a 40 MP save and let the screen
      auto-lock (the Wake Lock should keep it on: iOS 16.4 and later); then
      switch to another app for 10 s and return: either it finished, or the
      "did not finish" notice shows; never a corrupt file.
- [ ] **A killed tab at 61 MP.** If iOS evicts the tab mid-press, the next
      launch shows the notice with Try again and Save smaller.
- [ ] **PNG on an old iOS.** On iOS before 16.4 (no `CompressionStream`), More
      says "Save lossless PNG" with the size and "(about N MB)", and the file
      is a valid PNG that size; or skip if no such device exists.
- [ ] **Poster type across a tile seam.** A 40 MP print with type at 30% of the
      height, turned -4 degrees, opened at 100% in Photos across the rows
      1024, 2048, ...: no visible seam in a glyph's edge.
- [ ] **Settled preview sharpness.** On a 3x iPhone, compare the settled
      preview with the saved file viewed at the same on-screen size. If the
      preview reads visibly softer, build the recorded fallback: one idle
      re-render at `min(CSS height × DPR, 1800)` after the preview settles,
      run through `renderPrintAsync` with an `AbortSignal` that every new
      input aborts, so it never blocks a touch. It stays preview-only. The
      preview remains synchronous and inside its pixel budget until this item
      fails.

## Both themes

- [ ] Switch iOS between light and dark → the app follows (neutral grey chrome
      in both; the chosen tool, Save and the sliders in ink), and every word
      stays legible
- [ ] Enable Reduce Motion → panels and switches change without travelling
- [ ] Larger Text at its largest: the panel may scroll, nothing is cut off,
      and the sheet is still on screen
