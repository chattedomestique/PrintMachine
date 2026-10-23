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
- [ ] Browser UI tint matches the app (`theme-color`)

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
- [ ] Wait for the dot beside the wordmark to turn green — that is the app
      saying it has finished precaching and will open offline
- [ ] *Now* airplane mode → launch from the home screen → it fully boots and is usable
- [ ] Redeploy a visible change → relaunch online once → the new version appears

> `npm run verify:offline` proves the build itself: it serves `dist/` at the
> real Pages sub-path, installs the worker, cuts the network and cold-launches
> in a fresh tab, and it runs in CI. What it cannot prove is that iOS honours
> any of it, which is what this section is for.
>
> The green dot is only as honest as the precache manifest — it reports that
> the worker finished caching whatever it was handed. A truncated manifest
> would still turn it green. That case is what the CI check exists to catch.

## Edit

- [ ] Dragging the sheet moves the selected plate; nothing eats the taps
- [ ] Double-tap re-centres
- [ ] Photo tab open: drag and pinch the photo — it zooms 100–400% and stops at
      its edges, never showing bare paper round it; switch the sheet shape on
      the Photo tab and it still covers the sheet
- [ ] The first photo opens on Sheet: Original, the photo's own shape — a
      landscape photo gives a landscape sheet that fits the screen without
      distortion; Remove the photo → the sheet is 4:5 again
- [ ] Arrow keys nudge the selected plate (attach a keyboard, or use a Mac)
- [ ] Type a long string → tap Fit → it sits on the sheet, and the next pinch
      or slider touch starts from that size (no jump)
- [ ] Size slider: drag it end to end with a thumb — 10% to 100%, and a small
      drag makes a small change at the 10% end (not half the size per pixel);
      pinch past 100% → the thumb stays at the end and the readout says the
      real value (e.g. 240%)
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
      holds a 4 MP working copy, not the 98 MB original)
- [ ] Save it: completes without a tab reload (Save decodes the original,
      about 98 MB, for the length of the blit) and the file shows the photo,
      upright
- [ ] A transparent PNG: paper shows through where it is transparent
- [ ] Remove the photo → Undo: it comes back (not bare paper, no alert)
- [ ] A print saved by an older build (its photo cut to 2048 px) shows the
      "saved at reduced size" note in the Photo tab

> The photo is stored and decoded whole, at any size: nothing here should ever
> show a photo cut down on import. What bounds a saved print is the export
> canvas, by area (16.7 MP, `MAX_AREA`, the most a browser canvas is
> guaranteed to hold; WebKit's limit is an area, and there is no edge cap).
> Saving above it would need tiled rendering and a JavaScript encoder, which
> are not built.

## Save

- [ ] The line above the toolbar says the size before the tap ("Saves
      2419×3024" for a 12 MP photo on 4:5), and why when it is not the photo's
      own pixels
- [ ] Tap Save → within a moment the button reads Cancel and the line reads
      "Pressing 3024×3780, plate 1 of 2" and moves on; the preview holds still
- [ ] Cancel mid-press → back to Save, no error, nothing saved
- [ ] A press that takes more than a second → the button reads "Save to
      Photos (… MB)" → tap it → the native share sheet appears → Save Image →
      the file **is** in Photos, at the size the line said (check it in Photos'
      info panel)
- [ ] A quick press (no photo, or a small one) → the share sheet opens without
      a second tap
- [ ] Home-screen app: dismiss or break the share sheet → the "Save to Photos"
      button is still there; the app never navigates to the image
- [ ] PNG → the same flow, a .png file in Photos
- [ ] Right after choosing a photo, Save reads "Loading photo" until the photo
      is in the preview
- [ ] A confirmation appears after saving, with the pixel size
- [ ] Cancel the share sheet → no error toast
- [ ] Swipe the app away (or let iOS evict it) while it reads "Pressing …" →
      reopen it → a dialog reads "The last save, 2419×3024, did not finish."
      with Try again, Save smaller (1814×2268) and Cancel; Try again completes;
      a launch after that one says nothing
- [ ] If Save ever says "This device couldn't press W×H. Save a smaller W'×H'
      copy instead?" (a canvas came back blank, or memory ran out): note the
      device and both sizes; Save smaller → the file in Photos is W'×H', and the
      confirmation says so. Nothing is saved until Save smaller is tapped
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

## Both themes

- [ ] Switch iOS between light and dark → the app follows, and the accent stays
      legible against both
- [ ] Enable Reduce Motion → panel and toggle transitions stop
