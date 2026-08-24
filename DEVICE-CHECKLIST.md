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
- [ ] Arrow keys nudge the selected plate (attach a keyboard, or use a Mac)
- [ ] Type a long string → fit-to-width keeps it on the sheet
- [ ] Drag a press slider → the preview keeps up, and the grain does **not**
      visibly re-randomise
- [ ] One slider drag is one undo step; adding a plate is its own step
- [ ] Background the app for 5 minutes → return → the document is still there
- [ ] Force-quit and relaunch → the document is still there

## Save

- [ ] Save → the native share sheet appears → Save Image → the file **is** in Photos
- [ ] A confirmation appears after saving
- [ ] Cancel the share sheet → no error toast
- [ ] The saved file has **no** guides and **no** selection crosshair in it
- [ ] File size is sane — hundreds of KB, not multi-MB

> Expect ~600 KB rather than the ~300 KB the playbook cites for photographs. A
> halftone screen over paper grain is close to worst-case for JPEG's DCT: it is
> high-frequency detail everywhere. Dropping quality to compensate smears the
> dots, which is the one thing this app exists to render, so the size stands.

## Both themes

- [ ] Switch iOS between light and dark → the app follows, and the accent stays
      legible against both
- [ ] Enable Reduce Motion → panel and toggle transitions stop
