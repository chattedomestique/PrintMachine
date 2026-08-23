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

- [ ] Airplane mode → launch from the home screen → the app fully boots and is usable
- [ ] Redeploy a visible change → relaunch → the new version appears

> Both of these are automatable only up to a point. CI proves the precache
> manifest contains the real hashed assets; it cannot prove iOS honours it.

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
