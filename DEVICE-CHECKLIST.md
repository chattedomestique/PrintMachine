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
      good with its × or with the first drag on the sheet
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
      size before the double tap; the same on a print with a photo, where the
      preview takes a moment to redraw after the first tap
- [ ] Drag a press slider → the preview keeps up, and the grain does **not**
      visibly re-randomise
- [ ] One slider drag is one undo step; adding a plate is its own step
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
      about 98 MB, for the length of the blit) and the file shows the photo,
      upright
- [ ] A transparent PNG: paper shows through where it is transparent
- [ ] Remove the photo → Undo: it comes back (not bare paper, no alert)
- [ ] A print saved by an older build (its photo cut to 2048 px) shows the
      "saved at reduced size" note in Photo › File

> The photo is stored and decoded whole, at any size: nothing here should ever
> show a photo cut down on import. What bounds a saved print is the export
> canvas, by area (16.7 MP, `MAX_AREA`, the most a browser canvas is
> guaranteed to hold; WebKit's limit is an area, and there is no edge cap).
> Saving above it would need tiled rendering and a JavaScript encoder, which
> are not built.

## Save

- [ ] More says the size before the tap ("Saves 2419×3024" for a 12 MP photo
      on 4:5), and why when it is not the photo's own pixels; VoiceOver reads
      Save as "Save 2419×3024 JPEG"
- [ ] Tap Save → within a moment Save reads "Saving", a toast repeats the size,
      and a card above the dock reads "Pressing 3024×3780, plate 1 of 2" and
      moves on, with Cancel; the preview holds still and nothing else answers
      a tap
- [ ] Cancel mid-press → back to Save, no error, nothing saved
- [ ] A press that takes more than a second → Save reads "Share" and the card
      "3024×3780 is ready (… MB)" → tap Share → the native share sheet appears
      → Save Image → the file **is** in Photos, at the size More said (check it
      in Photos' info panel)
- [ ] Expect that second tap on every save: no press at a photo's own
      resolution finishes within the second that would share at once (even a
      print with no photo is 2880×3600; it takes over 4 s on a desktop). A
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
- [ ] Same phone, largest text size, a 24 MP photo on its own Original sheet
      (the longest reason: "capped at 16.7 MP …"), Save: while it presses, the
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
      smaller W'×H' copy instead?" (a canvas came back blank, or memory ran
      out): note the device, both sizes and the reason; Save smaller → the file
      in Photos is W'×H', and the confirmation says so. Nothing is saved until
      Save smaller is tapped
- [ ] The saved file has **no** selection crosshair in it (the thirds guides are
      gone; the crosshair is the one editing aid left, and it must never print)
- [ ] File size: a few MB, in proportion to the pixels (a 12 MP photo on 4:5:
      about 2-7 MB as JPEG); PNG several times that
- [ ] Memory, the hard gate a desktop cannot give (`measure-alloc.mjs` counts
      it; desktop memory is not a phone's): with Safari's Web Inspector
      attached (Timelines > Memory), Save a 12 MP portrait on 4:5 with the
      second ink on — the page's peak stays under about 450 MB (the count is
      359 MB: typed arrays, both canvases and the decoded photo), and the tab
      is not reloaded
- [ ] The heaviest print the budget allows: a 4096x4096 photo on 1:1, three
      plates, two with a second ink and one with a backing — Save completes
      without a tab reload (counted: 558 MB at peak)

> Expect megabytes, not the ~300 KB the playbook cites for photographs: the
> print is saved at the photo's own pixels, and a halftone screen over paper
> grain is close to worst-case for JPEG's DCT. Dropping quality to compensate
> smears the dots, which is the one thing this app exists to render, so the
> size stands.

Saving at full resolution (none of these can be automated):

- [ ] 12 MP photo, default document, Save: completes without a tab reload; the
      saved file's pixel size equals what More said; Photos shows 2419×3024
      (or whatever More said)
- [ ] Two Saves in a row: both complete, both files are the size More said
- [ ] Save in Low Power Mode: completes (slower is fine)
- [ ] Time from the tap to the share sheet, written down with the device and
      the size, so a slower build shows
- [ ] A square 4096×4096 photo (16.8 MP, the ceiling exactly) on 1:1: Save
      survives, or shows the explicit smaller-copy question, never a reload
- [ ] The share sheet appears after a press of more than 10 seconds (the
      "Share" tap is there for when the first tap's activation has run out;
      check that it works)
- [ ] Import a HEIC straight from the camera roll
- [ ] An EXIF-rotated portrait (a photo taken holding the phone upright) is
      upright in the preview and in the saved file

## Limits to settle on a device

- [ ] **The canvas ceiling is an area.** The app has no edge cap, only the
      16.7 MP area (`MAX_AREA`; the 4096 edge is Borders' number, and
      WebKit's documented limit is an area). On an iPhone, with Safari's Web
      Inspector attached, run this in the console on the deployed app:

      ```js
      for (const [w, h] of [[4729, 3547], [7092, 2364], [2364, 7093]]) {
        const c = document.createElement('canvas'); c.width = w; c.height = h
        const g = c.getContext('2d'); g.fillStyle = 'rgb(1, 2, 3)'; g.fillRect(w - 1, h - 1, 1, 1)
        console.log(w, h, [...g.getImageData(w - 1, h - 1, 1, 1).data].join()); c.width = 0
      }
      ```

      4729×3547 is a 24 MP 4:3 photo on its own sheet (the area ceiling);
      7092×2364 and 2364×7093 are the widest and the tallest prints the area
      allows (3:1 and 1:3 sheets). Each should print `1,2,3,255`. If one
      does not, Save still cannot fail quietly (the same probe runs before
      every press, and a blank canvas gets the smaller-copy question), but
      write down the device and the size: the README's Limits paragraph is
      wrong for it, and the planner needs that device's limit.
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
