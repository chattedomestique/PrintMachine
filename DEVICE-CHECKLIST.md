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

## Save

- [ ] Save → the native share sheet appears → Save Image → the file **is** in Photos
- [ ] A confirmation appears after saving
- [ ] Cancel the share sheet → no error toast
- [ ] The saved file has **no** selection crosshair in it (the thirds guides are
      gone; the crosshair is the one editing aid left, and it must never print)
<!-- WP2: the export becomes native resolution; this size line changes with it. -->
- [ ] File size is sane — hundreds of KB, not multi-MB

> Expect ~600 KB rather than the ~300 KB the playbook cites for photographs. A
> halftone screen over paper grain is close to worst-case for JPEG's DCT: it is
> high-frequency detail everywhere. Dropping quality to compensate smears the
> dots, which is the one thing this app exists to render, so the size stands.

## Both themes

- [ ] Switch iOS between light and dark → the app follows, and the accent stays
      legible against both
- [ ] Enable Reduce Motion → panel and toggle transitions stop
