/**
 * The dock's geometry and the style guide's measurable rules, in the built
 * app. Exits 1 if any check fails.
 *
 *   npm run build && node scripts/verify-geometry.mjs [--width 320] [--shots <dir>]
 *
 * Border Studio's README claims "the regression suite checks the photo's
 * rectangle across every tool and tab", and no such file exists in it. This
 * is that file. In Chromium, at 320x640, 375x812, 393x852 and 430x932, with a
 * photo chosen through the real file input (a 4:3, a 3:2 and a 1:3 photo, each
 * on its own Original sheet in the frame a first photo gets, the shape and
 * the frame a first photo opens on), it opens every tool (Frame, Type, Ink,
 * Press) and every sub-tab, Frame › Border with Frosted chosen (its Blur in
 * the strip) as well as without, and every state of Ink > Over photo (Off,
 * Second ink, Keep this ink, Backing), and checks:
 *
 *  - the sheet: its rectangle is the same, to a pixel, in every one of those
 *    states at one viewport. The photo never changes size or place between
 *    tools and tabs (Border Studio fcd91ff: one dock geometry);
 *  - the panel never overflows at 100% text: the dock's scroller
 *    (.app__panel-inner) is not taller inside than out, and the page does not
 *    scroll sideways;
 *  - every state from the dock's start: the dock is put back there before a
 *    state is measured (a control below its fold is scrolled to before it is
 *    clicked) and must then still be there, its content area not scrolled,
 *    its tab strip not scrolled down (dockAtStart, probeDockScroll), so the
 *    set of targets measured does not depend on how the state was reached;
 *  - tap targets, as the hit area each control still OWNS: for every visible,
 *    enabled button, input, select, tab and menu row in the app bar, the dock
 *    and the cards over the stage (or, with a dialog open, in the dialog),
 *    how far from its centre a tap still lands on it, each way, by
 *    elementFromPoint. That counts its box, its ::after hit area (the style
 *    guide draws small circles at 36px with a 44px ::after), and loses
 *    whatever a neighbour covers, so it must be 44px across both ways. This is
 *    the style guide's own probe (its tests/a11y.mjs) measured as a run rather
 *    than at two points, so a hit area that grows one way only (the strip's
 *    name line, dock.css) is measured as it is. It is also how "8px between
 *    targets" is checked: that gap is what lets two 36px circles each own a
 *    44px target, and a neighbour closer than that takes part of it. A
 *    control scrolled partly out of its scroller (a tab in a row wider than
 *    the dock) is reached by scrolling and is skipped while it is; at 200%
 *    text, where the dock is shorter than some panels, each state is checked
 *    from the dock's start and from its end, so what lies below its fold is
 *    checked too (checkTargetsWholeDock); a disabled one is not a target;
 *  - the Size slider's travel on the real track: pixels per 1% step, and what
 *    one pixel of drag changes at the smallest size (how touchy the slider
 *    is, measured where a thumb meets it: at least 1.5 px a step);
 *
 * then, with the 4:3 photo, the value modal, the parameter sheet, the plate
 * sheet, the Ink dialog and More: the same target check, and no sideways
 * scroll. Then all of it again at 200% text (font-size: 200% on <html>):
 * every state and dialog, no text cut off by a clipping box (the style
 * guide's probeClipped: text inside a scroller is reachable, not cut), no
 * sideways scroll, targets as above. The dock may scroll at 200%; the sheet
 * may shrink. Last, the app bar at every width from 320 to 430 px in 5 px
 * steps, at 100% and 200% text: SG.fit's layout (full, then compact, then
 * tight) never gets richer as the bar gets narrower, tight only when the
 * title needs its second line, the bar's actions stay one row, Save's word
 * (when shown) is one line, and nothing in the bar reaches past it. Then the
 * save states on a small phone (320x640 and 375x667) at 200% text, where the
 * cards over the stage are taller than the room they have (checkSaveStates):
 * Cancel, Share, the card's × and Choose again each answer a tap, and the
 * cards stay between the bar and the dock.
 *
 * Then the Frame tool's own states, at every width, in light and dark, at
 * 100% and 200% text (eachFrameState): Border with its fill row (Photo, and
 * Frosted with its Blur), the ratio chips on a 4:5 sheet, Crop | Fit with Fit
 * chosen, Place and Border in Fit (their reasons on screen), and with the
 * photo removed Photo, Border (Width and Corners unavailable beside Choose
 * photo), Crop (Original unavailable) and Place. In each: the sheet holds
 * still among the states of one shape, no panel overflows at 100% text,
 * nothing is cut off at 200%, the page never scrolls sideways, and every
 * target owns 44px. And the chip rows (probeRowChips): each chip is scrolled
 * whole into its row in turn and must then own 44px both ways, so a chip past
 * the row's edge is measured too (the fill row's six, the ratio row's six);
 * a row that overflows scrolls sideways inside itself, to its last chip
 * shown whole, while the sheet does not move and the page does not scroll.
 * At 320 px both rows overflow, so the scroll is checked, never passed for
 * want of a row to scroll. At rest a row that scrolls is cut where the style
 * guide cuts one (its edge chip 30% to 60% shown, at least 24 px), and the
 * chip the keys reach from the tool's tabs draws its whole focus ring, no
 * clipping box cutting it (probeRowCut, probeFocusRing).
 *
 * Section 1 also runs the 4:3 photo with its frame taken away (Width to 0 by
 * the keys) and bare paper with no photo, through every state. The save
 * states (section 4) open More too: its actions and Cancel on screen as it
 * opens, its facts a named region the keyboard reaches when they scroll.
 * Then a very large print (section 6, checkLargePrint): a 40 MP photo on
 * 9:16 in Fit (190.7 MP) at 320x640 and 375x667 at 200% text and at 393x852,
 * every tool: the dock's line says its size whole and on screen, none of the
 * sheet is under it, every button over the stage is reachable, a touch at
 * the sheet's foot reaches the sheet (or the gesture hint, which has its ×,
 * while it shows), choosing Fit (past 100 MP) and Crop
 * again moves neither the tool's tabs nor Crop | Fit, and (at 393) a plate
 * dragged to the sheet's foot is moved again by a touch there.
 *
 * Every state is measured at rest: once its transitions and animations have
 * run out and its scrollers have stopped (settle), never on a fixed delay, so
 * the frame a state is measured at does not depend on the machine's speed.
 * The one state with a clock of its own, a save's first moments with its
 * 2.4 s toast up, is held still while it is measured (checkSaveStates). And
 * every click on the dock lands on a dock at rest (openTool). A target
 * covered at its centre is reported with what covers it, the scroll state of
 * the scrollers around it, its dialog's box and transform, and anything
 * still moving.
 *
 * The DOM contract it reads (src/features/shell/AppShell.tsx and the panels):
 * tool buttons `[data-tool]` with `aria-pressed`, the open panel
 * `.controls__section[data-tool]` with its `[role=tab][data-tab]`, the content
 * area `.controls__panel[data-sub]`, the scroller `.app__panel-inner`, the
 * sheet `.sheet`, the bar `.app__bar` with `data-fit`.
 *
 * --shots <dir> also writes the review set: at 320 and 390 px, light and
 * dark, the dock closed, every sub-tab and Over photo state, the five dialogs
 * and sheets, and the save states (pressing with Cancel, waiting for the
 * photo, ready to Share, the photo that could not be loaded, the smaller-copy
 * question, the save that did not finish); at 390 px with 200% text, every
 * state and dialog; at 390 px in the style guide's wire palette, light and
 * dark, the dock closed and each tool (the guide's squint test); and the save
 * states at 200% text as they are checked.
 *
 * The Chromium binary: CHROMIUM_PATH, or the first of the usual places.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p))
if (!existsSync(resolve(root, 'dist/index.html'))) {
  console.error('No dist/: run npm run build first.')
  process.exit(1)
}

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const SHOTS = arg('--shots')
const ONLY_WIDTH = arg('--width') ? Number(arg('--width')) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const VIEWPORTS = [
  [320, 640],
  [375, 812],
  [393, 852],
  [430, 932],
].filter(([w]) => ONLY_WIDTH === null || w === ONLY_WIDTH)

/** The dock's tools, in its order (src/features/controls/tools.ts). */
const TOOL_IDS = ['frame', 'type', 'ink', 'press']

/** Photos chosen through the file input: a camera's 4:3, a 3:2 and a 1:3. */
const PHOTOS = [
  [4032, 3024],
  [3000, 2000],
  [1000, 3000],
]

/** The widths of the review screenshots. */
const SHOT_WIDTHS = [
  [320, 640],
  [390, 844],
]

/** The small phones the save states are checked on at 200% text. */
const SAVE_VIEWPORTS = [
  [320, 640],
  [375, 667],
].filter(([w]) => ONLY_WIDTH === null || w === ONLY_WIDTH)

/** Where a very large print's line is checked: the small phones at 200%
 *  text, where room is least, and a common phone at 100%. */
const LARGE_VIEWPORTS = [
  [320, 640, 200],
  [375, 667, 200],
  [393, 852, 100],
].filter(([w]) => ONLY_WIDTH === null || w === ONLY_WIDTH)

const failures = []
const check = (ok, what) => {
  if (!ok) {
    console.log(`  FAIL ${what}`)
    failures.push(what)
  }
  return ok
}

const server = await preview({ root, preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' })
const APP = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath })

/**
 * Wait for the page to be at rest, then measure: no transition or animation
 * still running (a sheet still rising, the dock's panel still opening, a tab's
 * panel still sliding in), no scroller still moving, and then two painted
 * frames, so the overlay height is published and SG.fit has written its
 * layouts. Only motion with an end is waited for: the busy Save's spinner
 * turns for as long as the save runs.
 *
 * It used to be two frames and 60 ms, whatever was moving. The parameter sheet
 * rises for 320 ms, so the probe met it in flight, at whichever frame the
 * machine's speed made it land on. Held at each frame of that rise, the probe
 * fails at one, the fourth (66.7 ms in), with exactly the four failures CI
 * reported: at 200% text that frame puts Position Y's centre within half a
 * pixel of the screen's bottom edge, where elementFromPoint (it rounds to
 * whole pixels) finds nothing, and the probe called it covered. A target at
 * rest is what a person taps, so that is what is measured. If the page is
 * still moving after 5 s, that is a failure of its own, named.
 */
async function settle(page, where = 'the page') {
  const moving = await page.evaluate(atRest)
  check(moving === null, `${where}: still moving after 5 s (${moving}), measured anyway`)
}

/** The measurements of one state. */
const measure = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.sheet')?.getBoundingClientRect()
    const inner = document.querySelector('.app__panel-inner')
    return {
      sheet: r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) : null,
      overflow: inner ? inner.scrollHeight - inner.clientHeight : 0,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    }
  })

/* ── Page-side probes (run through page.evaluate, so self-contained) ── */

/** Resolves null once the page is at rest (see settle), or, after 5 s, with
 *  what is still moving. */
async function atRest() {
  const tag = (e) =>
    e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '?'
  const running = () =>
    document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
  const scrolled = () => {
    let s = ''
    const all = document.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) if (all[i].scrollTop || all[i].scrollLeft) s += `${i}:${all[i].scrollLeft},${all[i].scrollTop};`
    return s
  }
  const deadline = performance.now() + 5000
  const late = () => new Promise((r) => setTimeout(r, Math.max(0, deadline - performance.now())))
  for (;;) {
    const now = running()
    if (now.length && performance.now() < deadline) {
      await Promise.race([Promise.all(now.map((a) => a.finished.catch(() => undefined))), late()])
      continue
    }
    const before = scrolled()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))
    const still = running()
    if (!still.length && scrolled() === before) return null
    if (performance.now() >= deadline)
      return still.length
        ? still.map((a) => `${a.transitionProperty ?? a.animationName ?? 'an animation'} on ${tag(a.effect?.target)}${a.effect?.pseudoElement ?? ''}`).join(', ')
        : 'a scroller'
  }
}

/**
 * Every visible, enabled target in scope, and the hit area it owns through
 * its centre, horizontally and vertically. Scope: the open dialog, or the app
 * bar, the dock and the cards over the stage.
 *
 * `pass`: 'start' remembers what it measured, and 'end' (the dock scrolled to
 * its end) measures only what 'start' did not, so the two count each target
 * once.
 */
function probeTargets(pass = 'all') {
  if (pass === 'start') window.__gateSeen = new WeakSet()
  const seen = pass === 'end' ? (window.__gateSeen ?? new WeakSet()) : null
  const dialogs = [...document.querySelectorAll('dialog[open]')]
  const scopes = dialogs.length ? [dialogs[dialogs.length - 1]] : [...document.querySelectorAll('.app__bar, .app__overlay, .app__float')]
  const SEL =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=radio], [role=checkbox], [role=slider], [role=menuitem], [role=menuitemradio], [role=option]'
  const name = (e) =>
    e.tagName.toLowerCase() +
    (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') +
    (e.getAttribute('aria-label') ? ` [${e.getAttribute('aria-label').slice(0, 32)}]` : ` "${(e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)}"`)
  // Where a covered target is, so a failure explains itself: each scroller it
  // is in (how far scrolled, of how far it can go), its scope's box and
  // transform (a dialog still rising is not at rest), and anything moving.
  const box = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : '')
  const scrollOf = (n) =>
    `scrolled ${Math.round(n.scrollTop)} of ${n.scrollHeight - n.clientHeight} px down, ${Math.round(n.scrollLeft)} of ${n.scrollWidth - n.clientWidth} across`
  const context = (el, scope) => {
    const parts = []
    for (let n = el.parentElement; n && n !== scope; n = n.parentElement) {
      const ns = getComputedStyle(n)
      if (/^(auto|scroll)$/.test(ns.overflowY) || /^(auto|scroll)$/.test(ns.overflowX)) parts.push(`in ${box(n)} ${scrollOf(n)}`)
    }
    const b = scope.getBoundingClientRect()
    parts.push(
      `${box(scope)} at y ${Math.round(b.top)}..${Math.round(b.bottom)} of ${innerHeight}, transform ${getComputedStyle(scope).transform}, ${scrollOf(scope)}`,
    )
    const moving = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => `${a.transitionProperty ?? a.animationName ?? 'an animation'} on ${a.effect?.target ? box(a.effect.target) : '?'}${a.effect?.pseudoElement ?? ''}`)
    parts.push(moving.length ? `still moving: ${moving.join(', ')}` : 'nothing moving')
    return parts.join('; ')
  }
  const out = { measured: 0, scrolled: 0, disabled: 0, small: [] }
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('.sr-only, [hidden], [inert]')) continue
      // A native radio drawn by its label is 1px; the style guide's own probe
      // skips it the same way (the segmented and swatch radios cover their
      // labels and are measured).
      if (el.matches('input[type=radio], input[type=checkbox]') && r.width < 4) continue
      if (el.matches(':disabled, [aria-disabled="true"]')) {
        out.disabled++
        continue
      }
      // Measured from the dock's start already.
      if (seen?.has(el)) continue
      let clipped = false
      for (let n = el.parentElement; n && n !== scope.parentElement; n = n.parentElement) {
        const ns = getComputedStyle(n)
        if (ns.overflowX === 'visible' && ns.overflowY === 'visible') continue
        const b = n.getBoundingClientRect()
        if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) clipped = true
      }
      if (clipped) {
        out.scrolled++
        continue
      }
      if (pass === 'start') window.__gateSeen.add(el)
      out.measured++
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hits = (x, y) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true
        const t = document.elementFromPoint(x, y)
        return !!t && (t === el || el.contains(t))
      }
      const run = (dx, dy) => {
        let k = 0
        while (k < 40 && hits(cx + dx * (k + 1), cy + dy * (k + 1))) k++
        return k
      }
      if (!hits(cx, cy)) {
        const t = document.elementFromPoint(cx, cy)
        const by = t
          ? name(t)
          : `nothing: elementFromPoint finds no element there (it rounds to whole pixels; the screen is ${innerWidth}x${innerHeight})`
        out.small.push(`${name(el)}: covered at its centre (${cx.toFixed(1)}, ${cy.toFixed(1)}) by ${by}; ${context(el, scope)}`)
        continue
      }
      const w = Math.max(r.width >= 44 ? r.width : 0, run(-1, 0) + run(1, 0) + 1)
      const h = Math.max(r.height >= 44 ? r.height : 0, run(0, -1) + run(0, 1) + 1)
      if (w < 43.5 || h < 43.5) out.small.push(`${name(el)}: owns ${Math.round(w)}x${Math.round(h)} (drawn ${Math.round(r.width)}x${Math.round(r.height)})`)
    }
  }
  return out
}

/**
 * The dock's scrollers that are not at their start: its content area
 * (.app__panel-inner) scrolled either way, its tab strip scrolled down. (A tab
 * strip scrolled ACROSS is how a tab beyond the dock's width is reached, so
 * that is allowed.) A scrolled dock hides part of what is measured, and the
 * targets it puts partly outside are skipped, so a dock left scrolled makes
 * the set of targets measured depend on how the state was reached.
 */
function probeDockScroll() {
  const out = []
  const inner = document.querySelector('.app__panel-inner')
  if (inner && (inner.scrollTop > 0.5 || inner.scrollLeft > 0.5))
    out.push(`the dock (.app__panel-inner) is scrolled ${Math.round(inner.scrollTop)} px down, ${Math.round(inner.scrollLeft)} across`)
  for (const list of document.querySelectorAll('.app__panel-inner .tabs__list'))
    if (list.scrollTop > 0.5) out.push(`the tab strip of ${list.getAttribute('aria-label') ?? '?'} is scrolled ${Math.round(list.scrollTop)} px down`)
  return out
}

/** Text that a clipping box (overflow hidden or clip) cuts off: the style
 *  guide's probeClipped, which scrollWidth checks and axe do not see. Text in
 *  a scroller is reachable, ellipsis is deliberate, a 1px visually hidden
 *  box (Save's word when it is an icon) is not shown at all. */
function probeClipped() {
  const out = []
  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
  for (const box of document.querySelectorAll('*')) {
    const cs = getComputedStyle(box)
    if (!/^(clip|hidden)$/.test(cs.overflowX) && !/^(clip|hidden)$/.test(cs.overflowY)) continue
    if (box.closest('.sr-only, [hidden]')) continue
    const b = box.getBoundingClientRect()
    if (b.width <= 1 || b.height <= 1) continue
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let t; (t = walker.nextNode()); ) {
      if (!t.nodeValue.trim()) continue
      const host = t.parentElement
      const hs = getComputedStyle(host)
      if (hs.visibility === 'hidden' || hs.display === 'none' || host.closest('.sr-only, [aria-hidden="true"]') || hs.textOverflow === 'ellipsis') continue
      let hidden = false
      let scrollsX = false
      let scrollsY = false
      for (let n = host; n && n !== box; n = n.parentElement) {
        const nb = n.getBoundingClientRect()
        if (nb.width <= 1 && nb.height <= 1) hidden = true
        const ns = getComputedStyle(n)
        if (/^(auto|scroll)$/.test(ns.overflowX)) scrollsX = true
        if (/^(auto|scroll)$/.test(ns.overflowY)) scrollsY = true
      }
      if (hidden) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      for (const q of range.getClientRects()) {
        if (!q.width) continue
        const cutX = !scrollsX && /^(clip|hidden)$/.test(cs.overflowX) && (q.right > b.right + 1 || q.left < b.left - 1)
        const cutY = !scrollsY && /^(clip|hidden)$/.test(cs.overflowY) && (q.bottom > b.bottom + 1 || q.top < b.top - 1)
        if (cutX || cutY) {
          out.push(`"${t.nodeValue.trim().slice(0, 28)}" cut off by ${name(box)}`)
          break
        }
      }
    }
  }
  return [...new Set(out)]
}

/**
 * The chip row named `label` in the open panel: each chip scrolled into the
 * row in turn as a swipe leaves it (instantly, so nothing is caught
 * mid-scroll): at its snap position, its start at the row's scroll padding
 * (the style guide's chip row snaps, x proximity, so a scroll to anywhere
 * else is pulled to the nearest chip), or at the row's end; whether it then
 * shows whole, and the hit area it owns through its centre each way, as
 * probeTargets measures one (its box, its ::after, less what a neighbour
 * covers). Leaves the row scrolled to its last chip. Null when there is no
 * such row.
 */
async function probeRowChips(label) {
  const row = [...document.querySelectorAll('.app__panel-inner .chiprow')].find((r) => r.getAttribute('aria-label') === label)
  if (!row) return null
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const overflow = row.scrollWidth - row.clientWidth
  const pad = parseFloat(getComputedStyle(row).scrollPaddingInlineStart) || 0
  const chips = []
  for (const chip of row.querySelectorAll(':scope > .chip')) {
    const rr = row.getBoundingClientRect()
    let r = chip.getBoundingClientRect()
    if (r.left < rr.left - 0.5 || r.right > rr.right + 0.5) {
      const left = Math.min(overflow, Math.max(0, row.scrollLeft + (r.left - rr.left) - pad))
      row.scrollTo({ left, behavior: 'instant' })
      await painted()
    }
    r = chip.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    const whole = r.left >= box.left - 0.5 && r.right <= box.right + 0.5
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const hits = (x, y) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true
      const t = document.elementFromPoint(x, y)
      return !!t && (t === chip || chip.contains(t))
    }
    const run = (dx, dy) => {
      let k = 0
      while (k < 40 && hits(cx + dx * (k + 1), cy + dy * (k + 1))) k++
      return k
    }
    const at = hits(cx, cy)
    const w = at ? Math.max(r.width >= 44 ? r.width : 0, run(-1, 0) + run(1, 0) + 1) : 0
    const h = at ? Math.max(r.height >= 44 ? r.height : 0, run(0, -1) + run(0, 1) + 1) : 0
    chips.push({ id: chip.dataset.chip, whole, w: Math.round(w), h: Math.round(h), disabled: chip.getAttribute('aria-disabled') === 'true' })
  }
  return { overflow, scrolled: row.scrollLeft, chips }
}

/**
 * The chip row named `label` at rest (scrolled to its start): how much of the
 * first chip the row cuts shows, against its width (the style guide's cut:
 * 30% to 60% of it and at least 24 px), and the cut the row was given. Null
 * when there is no such row.
 */
async function probeRowCut(label) {
  const row = [...document.querySelectorAll('.app__panel-inner .chiprow')].find((r) => r.getAttribute('aria-label') === label)
  if (!row) return null
  row.scrollTo({ left: 0, behavior: 'instant' })
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const box = row.getBoundingClientRect()
  const clip = box.left + row.clientLeft + row.clientWidth
  const overflow = row.scrollWidth - row.clientWidth
  for (const chip of row.querySelectorAll(':scope > .chip')) {
    const r = chip.getBoundingClientRect()
    if (r.right > clip + 0.5) return { overflow, id: chip.dataset.chip, v: clip - r.left, w: r.width, grow: row.style.getPropertyValue('--_grow') || '0px' }
  }
  return { overflow, id: null, v: null, w: null, grow: row.style.getPropertyValue('--_grow') || '0px' }
}

/**
 * The focused element's keyboard ring, against every box that clips it: its
 * outline (width and offset, from the computed style) outside its rect, and
 * each ancestor that does not let overflow show, by its padding box. What
 * each cuts off the ring, top, right, bottom and left; empty when none does.
 */
function probeFocusRing() {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const cs = getComputedStyle(el)
  const out = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0)
  const r = el.getBoundingClientRect()
  const ring = { top: r.top - out, right: r.right + out, bottom: r.bottom + out, left: r.left - out }
  const cuts = []
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const as = getComputedStyle(a)
    if (as.overflowX === 'visible' && as.overflowY === 'visible') continue
    const b = a.getBoundingClientRect()
    const pad = { top: b.top + a.clientTop, left: b.left + a.clientLeft, right: b.left + a.clientLeft + a.clientWidth, bottom: b.top + a.clientTop + a.clientHeight }
    const cut = { top: pad.top - ring.top, right: ring.right - pad.right, bottom: ring.bottom - pad.bottom, left: pad.left - ring.left }
    if (Object.values(cut).some((v) => v > 0.5)) cuts.push(`${a.className || a.tagName}: ${Object.entries(cut).filter(([, v]) => v > 0.5).map(([k, v]) => `${k} ${v.toFixed(1)}px`).join(', ')}`)
  }
  return { focusVisible: el.matches(':focus-visible'), outline: `${cs.outlineWidth} at ${cs.outlineOffset}`, chip: el.dataset?.chip ?? null, cuts }
}

/** The app bar: its SG.fit layout, and whether it holds as one row. */
function probeBar() {
  const bar = document.querySelector('.app__bar')
  const b = bar.getBoundingClientRect()
  const actions = [...bar.querySelectorAll('.appbar__end > *')].map((e) => e.getBoundingClientRect())
  const centres = new Set(actions.map((q) => Math.round(q.top + q.height / 2)))
  const word = bar.querySelector('.app__save-word')
  const wb = word?.getBoundingClientRect()
  const range = document.createRange()
  if (word) range.selectNodeContents(word)
  const wordLines = word && wb.width > 1 ? new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size : 0
  const outside = [...bar.querySelectorAll('.appbar__title, .appbar__end > *')].filter((e) => {
    const q = e.getBoundingClientRect()
    return q.left < b.left - 0.5 || q.right > b.right + 0.5 || q.top < b.top - 0.5 || q.bottom > b.bottom + 0.5
  })
  const title = bar.querySelector('.appbar__title')
  const tr = document.createRange()
  tr.selectNodeContents(title)
  const titleLines = new Set([...tr.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size
  return { fit: bar.dataset.fit ?? null, rows: centres.size, wordLines, titleLines, outside: outside.length }
}

/* ── Driving the app ── */

/** A w x h JPEG made in the page and chosen through the real file input. */
async function choosePhoto(page, w, h) {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, '#2a5d9f')
      grad.addColorStop(1, '#f2b880')
      g.fillStyle = grad
      g.fillRect(0, 0, w, h)
      const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))
      c.width = 0
      return [...new Uint8Array(await b.arrayBuffer())]
    },
    [w, h],
  )
  await page.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
  await page.waitForFunction(
    ([w, h]) => {
      const m = JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media
      return m && m.width === w && m.height === h
    },
    [w, h],
    { timeout: 30_000 },
  )
  // The preview's copy has landed when Save stops waiting for it.
  await page.waitForFunction(() => !document.querySelector('.app__save[aria-disabled="true"]'), null, { timeout: 30_000 })
}

/**
 * Open a tool (a no-op when it is open), and return once the page is at rest.
 *
 * Every click on the dock lands on a dock at rest. Before a click, Playwright
 * scrolls its target into view; a tab clicked while its panel is still
 * opening is partly outside the dock, so the click scrolled the dock (12 px
 * at 200% text, the tab strip 8 px) and it stayed so: the plate button was
 * then partly outside the dock and skipped in eight states, a count that
 * changed from run to run (CI's 195 targets at 320 px against 203).
 */
/**
 * A very large print's line, as a person meets it (in the page): each of its
 * words on screen (inside the viewport and every clipping box around it, and
 * the line what a finger at the word's centre reaches), none of the sheet
 * under it, and the sheet between the bar and the dock. Over the stage, every
 * card's button is what a finger at its centre reaches, and a touch at the
 * sheet's foot reaches the sheet, or a card that can be put away.
 */
function probeLarge() {
  const line = document.querySelector('.app__large:not([hidden])')
  const sheet = document.querySelector('.sheet').getBoundingClientRect()
  const bar = document.querySelector('.app__bar').getBoundingClientRect()
  const dock = document.querySelector('.app__overlay').getBoundingClientRect()
  const reaches = (q, el) => {
    const h = document.elementFromPoint((q.left + q.right) / 2, (q.top + q.bottom) / 2)
    return !!h && el.contains(h)
  }
  const r1 = (v) => Math.round(v * 10) / 10
  const out = {
    text: line?.textContent ?? null,
    cut: [],
    over: 0,
    sheet: [sheet.left, sheet.top, sheet.right, sheet.bottom].map(r1),
    inView: sheet.height >= 1 && sheet.top >= bar.bottom - 0.5 && sheet.bottom <= dock.top + 0.5,
    unreached: [],
  }
  if (line) {
    const l = line.getBoundingClientRect()
    out.line = [l.left, l.top, l.right, l.bottom].map(r1)
    out.over = r1(Math.max(0, Math.min(l.right, sheet.right) - Math.max(l.left, sheet.left)) * Math.max(0, Math.min(l.bottom, sheet.bottom) - Math.max(l.top, sheet.top)))
    const clips = []
    for (let a = line.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clips.push(a.getBoundingClientRect())
    }
    const inside = (q, c) => q.top >= c.top - 0.5 && q.bottom <= c.bottom + 0.5 && q.left >= c.left - 0.5 && q.right <= c.right + 0.5
    const screen = { top: 0, left: 0, bottom: innerHeight, right: innerWidth }
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const re = /\S+/g
      let m
      while ((m = re.exec(n.textContent))) {
        const range = document.createRange()
        range.setStart(n, m.index)
        range.setEnd(n, m.index + m[0].length)
        const rects = [...range.getClientRects()]
        if (!rects.length || !rects.every((q) => inside(q, screen) && clips.every((c) => inside(q, c)) && reaches(q, line))) out.cut.push(m[0])
      }
    }
  }
  for (const b of document.querySelectorAll('.app__float .card .btn')) if (!reaches(b.getBoundingClientRect(), b)) out.unreached.push(b.getAttribute('aria-label') ?? b.textContent.trim())
  const foot = document.elementFromPoint((sheet.left + sheet.right) / 2, sheet.bottom - 4)
  const card = foot?.closest('.app__float .card')
  out.foot = foot?.closest('.sheet') ? 'the sheet' : card?.querySelector('.btn') ? 'a card that can be put away' : card ? `a card that cannot be put away (${card.className})` : (foot?.className || foot?.tagName)
  return out
}

/**
 * A print past LARGE_PRINT_MP, made the way the owner's photos make one (a
 * 40 MP photo matted on 9:16, Fit: 10358x18414, 190.7 MP), at `vw` x `vh` and
 * `text`% text, with the tools closed, on each Frame tab and in Type, Ink and
 * Press: its line says the size, the megapixels and that a phone may not
 * finish it, every word of it on screen, none of the sheet under it, the
 * sheet in view, every card's button over the stage reachable, a touch at
 * the sheet's foot reaching it (probeLarge). Then, the hint put away, a plate
 * dragged to the sheet's foot (where a story frame's caption goes) is picked
 * and moved there again by a touch.
 */
async function checkLargePrint(vw, vh, text) {
  const where = `${vw}x${vh} at ${text}% text, a very large print`
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(APP)
  await page.waitForSelector('.sheet canvas')
  if (text !== 100) await page.addStyleTag({ content: `html { font-size: ${text}% }` })
  await openTool(page, 'frame')
  await choosePhoto(page, 7728, 5152)
  await openTab(page, 'frame', 'crop')
  const crop = page.locator('.controls__panel[data-sub="crop"]')
  await crop.locator('[data-chip="9:16"]').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.aspect === '9:16')
  // Fit takes the print past 100 MP and its line comes; Crop takes it back
  // and the line goes. Neither moves the tool's tabs or Crop | Fit, at any
  // text size (the panel's scroll gives way by the line's height where its
  // bound does), so the control a finger just used stays under it. Chosen
  // in the page, as a tap on it would: no scroll first.
  const rows = () =>
    page.evaluate(() => {
      const top = (sel) => Math.round((document.querySelector(sel)?.getBoundingClientRect().top ?? NaN) * 10) / 10
      return { tabs: top('.controls__section[data-tool="frame"] [role=tab]'), mode: top('.controls__panel[data-sub="crop"] .segmented'), line: !!document.querySelector('.app__large:not([hidden])') }
    })
  const choose = async (mode) => {
    await page.evaluate((m) => document.querySelector(`.controls__section[data-tool="frame"] input[type=radio][value="${m}"]`).click(), mode)
    await page.waitForFunction((m) => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.frame?.mode === m, mode)
    await settle(page, `${where}, ${mode}`)
    return rows()
  }
  await settle(page, `${where}, 9:16`)
  const onCrop = await rows()
  const onFit = await choose('fit')
  const back = await choose('crop')
  check(
    !onCrop.line && onFit.line && !back.line && [onFit, back].every((r) => Math.abs(r.tabs - onCrop.tabs) <= 0.5 && Math.abs(r.mode - onCrop.mode) <= 0.5),
    `${where}: the tool's tabs or Crop | Fit moved as the print crossed 100 MP: Crop ${JSON.stringify(onCrop)}, Fit ${JSON.stringify(onFit)}, Crop again ${JSON.stringify(back)}`,
  )
  await choose('fit')
  const size = ((await page.locator('.app__save').getAttribute('aria-label')) ?? '').match(/^Save (\d+×\d+)/)?.[1] ?? '?'
  const states = [[null, null], ['frame', 'border'], ['frame', 'crop'], ['frame', 'place'], ['frame', 'photo'], ['type', null], ['ink', null], ['press', null]]
  for (const [tool, tab] of states) {
    const at = `${where}, ${tool ? `${tool}${tab ? ` › ${tab}` : ''}` : 'tools closed'}`
    if (!tool) await closeTools(page)
    else if (tab) await openTab(page, tool, tab)
    else await openTool(page, tool)
    await settle(page, at)
    const p = await page.evaluate(probeLarge)
    check(p.text !== null && p.text.includes(size) && /\d+\.\d MP/.test(p.text) && /a phone may not finish it/.test(p.text), `${at}: the line does not say ${size}, its megapixels and that a phone may not finish it: ${JSON.stringify(p.text)}`)
    check(p.cut.length === 0, `${at}: words of the line a person cannot see: "${p.cut.join(' ')}" (line ${JSON.stringify(p.line)})`)
    check(p.over === 0 && p.inView, `${at}: the line covers ${p.over} px² of the sheet ${JSON.stringify(p.sheet)}, or the sheet is not between the bar and the dock (${p.inView})`)
    check(p.unreached.length === 0, `${at}: buttons over the stage a finger cannot reach: ${p.unreached.join(', ')}`)
    check(p.foot === 'the sheet' || p.foot === 'a card that can be put away', `${at}: a touch at the sheet's foot reaches ${p.foot}`)
  }
  if (text === 100) {
    // A plate at the sheet's foot is picked and moved by a touch there.
    const hint = page.locator('.app__hint .btn')
    if (await hint.count()) await hint.click()
    await openTool(page, 'type')
    await settle(page, `${where}, Type`)
    const cdp = await ctx.newCDPSession(page)
    const drag = async (from, to) => {
      const pt = ({ x, y }) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) })
      for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt({ x: from.x + ((to.x - from.x) * k) / 8, y: from.y + ((to.y - from.y) * k) / 8 }) })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(700)
    }
    const plate = () => page.evaluate(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null').layers[0])
    const box = await page.evaluate(() => {
      const r = document.querySelector('.sheet').getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    const a = await plate()
    const on = (l) => ({ x: box.x + l.x * box.w, y: box.y + l.y * box.h })
    await drag(on(a), { x: on(a).x, y: box.y + 0.93 * box.h })
    const b = await plate()
    await drag(on(b), { x: on(b).x, y: on(b).y - 60 })
    const c = await plate()
    check(b.y > 0.88 && c.y < b.y - 0.05, `${where}: a plate dragged to the sheet's foot (y ${a.y.toFixed(3)} -> ${b.y.toFixed(3)}) and touched there is moved again (-> ${c.y.toFixed(3)})`)
    console.log(`${where}: a plate at the sheet's foot (y ${b.y.toFixed(3)}) moved by a touch there (-> ${c.y.toFixed(3)})`)
  }
  check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
  console.log(`${where}: ${size}, its line whole and off the sheet in ${states.length} states`)
  await ctx.close()
}

async function openTool(page, tool) {
  const btn = page.locator(`[data-tool="${tool}"][aria-pressed]`)
  if ((await btn.getAttribute('aria-pressed')) === 'true') return
  await btn.click()
  await page.waitForSelector(`.controls__section[data-tool="${tool}"]`)
  await settle(page, `opening ${tool}`)
}

async function openTab(page, tool, tab) {
  await openTool(page, tool)
  await page.locator(`.controls__section[data-tool="${tool}"] [role=tab][data-tab="${tab}"]`).click()
  await page.waitForSelector(`.controls__panel[data-sub="${tab}"]`)
  await settle(page, `opening ${tool} › ${tab}`)
}

async function closeTools(page) {
  const open = page.locator('[data-tool][aria-pressed="true"]')
  if (await open.count()) await open.first().click()
}

/** A fresh page at a viewport, a photo chosen, the hint dismissed. */
async function newPage({ width, height, scheme = 'light', photo = PHOTOS[0], init }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (init) await page.addInitScript(init)
  await page.goto(APP)
  await page.waitForSelector('.sheet canvas')
  if (photo) {
    await openTool(page, 'frame')
    await choosePhoto(page, ...photo)
    // The hint covers the foot of the sheet until it is dismissed.
    await page.locator('.app__hint .btn').click()
  }
  return { ctx, page, errors }
}

/**
 * Every tool, every sub-tab, every Over photo state, and Frame › Border with
 * Frosted chosen, in order, calling `visit(name)` in each. Leaves the second
 * ink on, the fill on Photo and the tools closed. Without a photo the states
 * a photo makes (the fill row, a second ink) are not there to visit; which
 * those are is decided by the document (`photo`), not by what the app shows,
 * so with a photo a state the app wrongly withholds fails, never skips.
 */
async function eachState(page, visit, { photo = true } = {}) {
  await closeTools(page)
  await visit('closed')
  for (const tool of TOOL_IDS) {
    await openTool(page, tool)
    const tabs = await page.locator(`.controls__section[data-tool="${tool}"] [role=tab]`).evaluateAll((els) => els.map((e) => e.dataset.tab))
    for (const tab of tabs) {
      await openTab(page, tool, tab)
      if (tool === 'ink' && tab === 'over') {
        // Every state of Over photo: the strip comes and goes with them.
        const over = page.locator('.controls__panel[data-sub="over"]')
        for (const mode of ['off', 'second', 'backing']) {
          await settle(page, `ink-over, before ${mode}`)
          // Without a photo a second ink has nothing to read: unavailable.
          if (!photo && mode === 'second') continue
          const off = await over.locator(`input[type=radio][value="${mode}"]`).isDisabled()
          if (!check(!off, `Ink › Over photo's ${mode} is unavailable${photo ? ' with a photo' : ''}`)) continue
          await over.locator(`input[type=radio][value="${mode}"]`).check({ force: true })
          await visit(`${tool}-${tab}-${mode}`)
          if (mode === 'second') {
            // Keep this ink has no Switch point (both halves would print the
            // same ink), so the strip gives way to a row.
            await over.locator('[data-ink-button]').first().click()
            await page.locator('dialog[open] input[type=radio][value="keep"]').check({ force: true })
            await page.locator('dialog[open] .dialog__actions .btn').click()
            await page.waitForSelector('dialog[open]', { state: 'detached' })
            await visit(`${tool}-${tab}-keep`)
            // Back to a second ink of its own, so the strip is there again.
            await over.locator('[data-ink-button]').first().click()
            await page.locator('dialog[open] input[type=radio][value="black"]').check({ force: true })
            await page.locator('dialog[open] .dialog__actions .btn').click()
            await page.waitForSelector('dialog[open]', { state: 'detached' })
          }
        }
        await settle(page, 'ink-over, before second')
        if (photo && !(await over.locator('input[type=radio][value="second"]').isDisabled())) await over.locator('input[type=radio][value="second"]').check({ force: true })
        continue
      }
      await visit(`${tool}-${tab}`)
      if (tool === 'frame' && tab === 'border' && photo && check((await page.locator('.controls__panel[data-sub="border"] .chiprow').count()) > 0, 'Frame › Border has no fill row with a photo')) {
        // Frosted adds Blur to the strip: the sheet must not move for it,
        // with Blur the setting on screen.
        const panel = page.locator('.controls__panel[data-sub="border"]')
        const fills = panel.locator('.chiprow')
        await fills.locator('[data-chip="frosted"]').click()
        await page.waitForFunction(() => document.querySelector('.chiprow [data-chip="frosted"]')?.getAttribute('aria-pressed') === 'true')
        await panel.locator('.paramstrip__pick').click()
        await page.locator('dialog[open] [data-key="blur"]').click()
        await page.waitForSelector('dialog[open]', { state: 'detached' })
        await page.waitForFunction(() => document.querySelector('.controls__panel[data-sub="border"] .paramstrip__pick')?.textContent?.includes('Blur'))
        await visit(`${tool}-${tab}-frosted`)
        await fills.locator('[data-chip="photo"]').click()
        await page.waitForFunction(() => document.querySelector('.chiprow [data-chip="photo"]')?.getAttribute('aria-pressed') === 'true')
      }
    }
  }
  await closeTools(page)
}

/**
 * The Frame tool's states, in order, calling `visit(name, shape)` in each,
 * `shape` naming the sheet's shape (the states of one shape must leave the
 * sheet where it is): with the first photo on its Original sheet, Border
 * (Photo) and Border with Frosted and its Blur; on 4:5, Crop, Crop in Fit,
 * Place and Border in Fit, Photo; the photo removed, Photo, Border, Crop and
 * Place. Crop is visited on Original first, then on 4:5. Leaves the page
 * without a photo, the tools closed.
 */
async function eachFrameState(page, visit) {
  const panel = (sub) => page.locator(`.controls__panel[data-sub="${sub}"]`)
  const pressed = (sub, chip) =>
    page.waitForFunction(
      ([sub, chip]) => document.querySelector(`.controls__panel[data-sub="${sub}"] [data-chip="${chip}"]`)?.getAttribute('aria-pressed') === 'true',
      [sub, chip],
    )
  await openTab(page, 'frame', 'border')
  await visit('frame-border', 'original')
  await panel('border').locator('[data-chip="frosted"]').click()
  await pressed('border', 'frosted')
  await panel('border').locator('.paramstrip__pick').click()
  await page.locator('dialog[open] [data-key="blur"]').click()
  await page.waitForSelector('dialog[open]', { state: 'detached' })
  await visit('frame-border-frosted', 'original')
  await panel('border').locator('[data-chip="photo"]').click()
  await pressed('border', 'photo')
  await openTab(page, 'frame', 'crop')
  // Crop on Original (Crop | Fit off, saying why), then on 4:5: the tab's
  // rows must not move between the two (section 5 holds them still).
  await visit('frame-crop-original', 'original')
  await panel('crop').locator('[data-chip="4:5"]').click()
  await pressed('crop', '4:5')
  await visit('frame-crop', '4:5')
  await panel('crop').locator('input[type=radio][value="fit"]').check({ force: true })
  await visit('frame-crop-fit', '4:5')
  for (const tab of ['place', 'border', 'photo']) {
    await openTab(page, 'frame', tab)
    await visit(`frame-${tab}-fit`, '4:5')
  }
  await panel('photo').locator('button', { hasText: 'Remove' }).click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.media === null)
  await visit('frame-photo-none', '4:5')
  for (const tab of ['border', 'crop', 'place']) {
    await openTab(page, 'frame', tab)
    await visit(`frame-${tab}-none`, '4:5')
  }
  await closeTools(page)
}

/**
 * The chip rows of the Frame state on screen, at `where`: every chip of each
 * row, scrolled whole into it in turn, owns 44px both ways; a row that
 * overflows scrolls inside itself to its last chip, shown whole, while the
 * sheet stays where it was (`sheet`) and the page does not scroll sideways.
 * Returns the rows that overflowed. Leaves each row at its start.
 */
async function checkChipRows(page, where, sheet) {
  const overflowed = []
  for (const label of ['Fill', 'Sheet ratio']) {
    // At rest, a row that scrolls is cut where the style guide cuts one.
    const cut = await page.evaluate(probeRowCut, label)
    if (!cut) continue
    if (cut.overflow > 0) {
      check(
        cut.v !== null && cut.v >= Math.max(23.5, 0.3 * cut.w - 0.5) && cut.v <= 0.6 * cut.w + 0.5,
        `${where}: at rest the ${label} row's edge chip ${cut.id} shows ${cut.v?.toFixed(1)} px of ${cut.w?.toFixed(1)} (30% to 60% of it and at least 24 px; the row's cut ${cut.grow})`,
      )
    }
    // The keys into the row (the tab stop after the tool's tabs): the chip
    // they reach draws its whole ring, nothing clipping it.
    await page.locator('.controls__section[data-tool="frame"] [role=tab][aria-selected="true"]').focus()
    await page.keyboard.press('Tab')
    await settle(page, `${where}, Tab into the ${label} row`)
    const ring = await page.evaluate(probeFocusRing)
    check(
      ring?.chip && ring.focusVisible && ring.cuts.length === 0,
      `${where}: the ${label} row's chip reached by Tab (${ring?.chip}, ring ${ring?.outline}${ring?.focusVisible ? '' : ', not focus-visible'}) is clipped: ${ring?.cuts.join('; ')}`,
    )
    await page.evaluate(() => document.activeElement?.blur())
    await settle(page, `${where}, the ${label} row after the keys`)
    const row = await page.evaluate(probeRowChips, label)
    if (!row) continue
    const enabled = row.chips.filter((c) => !c.disabled)
    check(row.chips.length === 6, `${where}: the ${label} row has ${row.chips.length} chips (6)`)
    for (const c of row.chips) check(c.whole, `${where}: the ${label} row's ${c.id} chip cannot be scrolled into view whole`)
    for (const c of enabled) check(c.w >= 43.5 && c.h >= 43.5, `${where}: the ${label} row's ${c.id} chip owns ${c.w}x${c.h} (44x44)`)
    if (row.overflow > 0) {
      overflowed.push(label)
      await settle(page, `${where}, the ${label} row scrolled`)
      const m = await measure(page)
      check(row.scrolled > 0, `${where}: the ${label} row overflows by ${row.overflow} px and did not scroll`)
      check(
        m.sheet && sheet && m.sheet.every((v, i) => Math.abs(v - sheet[i]) <= 1),
        `${where}: scrolling the ${label} row moved the sheet: ${JSON.stringify(m.sheet)} against ${JSON.stringify(sheet)}`,
      )
      check(m.sideways <= 0, `${where}: scrolling the ${label} row scrolls the page sideways by ${m.sideways} px`)
    }
    await page.evaluate((label) => {
      const r = [...document.querySelectorAll('.app__panel-inner .chiprow')].find((x) => x.getAttribute('aria-label') === label)
      r?.scrollTo({ left: 0, behavior: 'instant' })
    }, label)
    await settle(page, `${where}, the ${label} row back at its start`)
  }
  return overflowed
}

/** The sheets and dialogs, each opened and closed: `visit(name)` with each
 *  open. */
async function eachDialog(page, visit) {
  const close = async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog[open]', { state: 'detached' })
    await settle(page, 'a dialog closing')
  }
  await openTab(page, 'type', 'size')
  await page.locator('.controls__panel[data-sub="size"] .controls__value').click()
  await page.waitForSelector('dialog[open]')
  await visit('value-modal')
  await close()
  await openTab(page, 'type', 'place')
  await page.locator('.controls__panel[data-sub="place"] .paramstrip__pick').click()
  await page.waitForSelector('dialog[open]')
  await visit('picker')
  await close()
  await page.locator('.controls__section[data-tool="type"] .controls__layerbtn').click()
  await page.waitForSelector('dialog[open]')
  await visit('plates')
  await close()
  await openTab(page, 'ink', 'ink')
  await page.locator('.controls__panel[data-sub="ink"] [data-ink-button]').click()
  await page.waitForSelector('dialog[open]')
  await visit('ink-dialog')
  await close()
  await closeTools(page)
  await page.locator('.app__bar [aria-label="More"]').click()
  await page.waitForSelector('dialog[open]')
  await visit('more')
  await close()
}

/**
 * Every state is measured from the dock's start. At 200% text the dock is
 * shorter than some panels, and a control below its fold (the Ink › Over
 * photo strip's ink button) is scrolled to before the gate clicks it, as a
 * person would scroll to it; the dock then stays so, into the states after.
 * So the dock is put back at its start and the page let come to rest, and
 * then it must still be there (probeDockScroll). Returns whether it had to be
 * put back.
 */
async function dockAtStart(page, where) {
  const moved = await page.evaluate(() => {
    let moved = false
    const inner = document.querySelector('.app__panel-inner')
    if (inner && (inner.scrollTop || inner.scrollLeft)) {
      inner.scrollTop = 0
      inner.scrollLeft = 0
      moved = true
    }
    for (const list of document.querySelectorAll('.app__panel-inner .tabs__list')) {
      if (list.scrollTop) {
        list.scrollTop = 0
        moved = true
      }
    }
    return moved
  })
  if (moved) await settle(page, `${where}, the dock back at its start`)
  for (const d of await page.evaluate(probeDockScroll)) check(false, `${where}: ${d}`)
  return moved
}

/** Check the targets of the state on screen. */
async function checkTargets(page, where) {
  const t = await page.evaluate(probeTargets)
  for (const s of t.small) check(false, `${where}: a target under 44px: ${s}`)
  return t
}

/**
 * The same, from the dock's start and, where the dock scrolls (at 200% text
 * it is shorter than some panels), from its end too: what lies below the
 * dock's fold is a target as well, reached by scrolling. Each target counts
 * once. Leaves the dock at its start.
 */
async function checkTargetsWholeDock(page, where) {
  const t = await page.evaluate(probeTargets, 'start')
  for (const s of t.small) check(false, `${where}: a target under 44px: ${s}`)
  const room = await page.evaluate(() => {
    const inner = document.querySelector('.app__panel-inner')
    return inner && !document.querySelector('dialog[open]') ? inner.scrollHeight - inner.clientHeight : 0
  })
  if (room <= 1) return t
  await page.evaluate(() => {
    const inner = document.querySelector('.app__panel-inner')
    inner.scrollTop = inner.scrollHeight
  })
  await settle(page, `${where}, the dock at its end`)
  const end = await page.evaluate(probeTargets, 'end')
  for (const s of end.small) check(false, `${where}, the dock scrolled to its end: a target under 44px: ${s}`)
  await page.evaluate(() => {
    document.querySelector('.app__panel-inner').scrollTop = 0
  })
  await settle(page, `${where}, the dock back at its start`)
  // Skipped: the targets partly outside the dock at both ends (a tab in a
  // row wider than the dock, until it is scrolled across to).
  return { ...t, measured: t.measured + end.measured, scrolled: end.scrolled, atEnd: end.measured }
}

const shotName = (...parts) => parts.join('-').replace(/[^a-z0-9-]+/gi, '-') + '.png'

try {
  // ── 1. Every viewport, every photo, at 100% text ──
  // Each photo as a first photo is placed (in its frame); the first of them
  // with its frame taken away (Width to 0 by the keys, as every print saved
  // before the frame opens); and bare paper, no photo at all.
  const DOCS = [...PHOTOS.map((photo) => ({ photo })), { photo: PHOTOS[0], unframed: true }, { photo: null }]
  for (const [vw, vh] of VIEWPORTS) {
    for (const doc of DOCS) {
      const [pw, ph] = doc.photo ?? []
      const where = `${vw}x${vh}, ${doc.photo ? `a ${pw}x${ph} photo${doc.unframed ? ', unframed' : ''}` : 'no photo'}`
      const { ctx, page, errors } = await newPage({ width: vw, height: vh, photo: doc.photo })
      if (doc.unframed) {
        await openTab(page, 'frame', 'border')
        await page.locator('.controls__panel[data-sub="border"] input[type=range]').focus()
        await page.keyboard.press('Home')
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('printmachine:settings:v1') ?? 'null')?.frame?.width === 0, null, { timeout: 5_000 })
        await closeTools(page)
      }
      const states = []
      let targets = 0
      await eachState(page, async (name) => {
        await settle(page, `${where}, ${name}`)
        await dockAtStart(page, `${where}, ${name}`)
        states.push({ name, ...(await measure(page)) })
        targets += (await checkTargets(page, `${where}, ${name}`)).measured
        if (name === 'type-size' && vw === 320) {
          const travel = await page.evaluate(() => {
            const input = document.querySelector('.controls__panel[data-sub="size"] .slider__input')
            const thumb = parseFloat(getComputedStyle(input.closest('.slider')).getPropertyValue('--_thumb')) || 24
            const w = input.getBoundingClientRect().width
            const steps = Math.round((Number(input.max) - Number(input.min)) / Number(input.step))
            return { width: w, thumb, steps, pxPerStep: (w - thumb) / steps }
          })
          // At the smallest size (10%) one step is a tenth of the size.
          const perPx = 0.1 / travel.pxPerStep
          console.log(
            `  Size slider at 320 px: ${travel.width.toFixed(1)} px track, ${(travel.width - travel.thumb).toFixed(1)} px of travel, ` +
              `${travel.steps} steps, ${travel.pxPerStep.toFixed(2)} px a step; at 10% one pixel of drag is ${(perPx * 100).toFixed(1)}% of the size`,
          )
          check(travel.steps === 90, `${where}: the Size slider has 90 steps (has ${travel.steps})`)
          check(travel.pxPerStep >= 1.5, `${where}: a Size step is at least 1.5 px of travel (${travel.pxPerStep.toFixed(2)})`)
        }
      }, { photo: !!doc.photo })
      if (doc === DOCS[0]) {
        await eachDialog(page, async (name) => {
          await settle(page, `${where}, ${name}`)
          targets += (await checkTargets(page, `${where}, ${name}`)).measured
          const side = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
          check(side <= 0, `${where}: the page scrolls sideways by ${side} px with ${name} open`)
        })
      }

      // With every tool closed the sheet takes the dock's room as well: the
      // gesture for a full-height sheet. Every open state holds still.
      const open = states.filter((s) => s.name !== 'closed')
      // Every state the document makes is visited: with a photo, framed or
      // not, the fill row's Frosted and a second ink (and Keep) are there.
      const want = doc.photo ? 18 : 15
      check(open.length === want, `${where}: ${open.length} open states visited (${want}): ${open.map((s) => s.name).join(', ')}`)
      const first = open[0]
      for (const s of open) {
        const same = s.sheet && first.sheet && s.sheet.every((v, i) => Math.abs(v - first.sheet[i]) <= 1)
        check(same, `${where}: the sheet moved in ${s.name}: ${JSON.stringify(s.sheet)} against ${JSON.stringify(first.sheet)} in ${first.name}`)
        check(s.overflow <= 0.5, `${where}: the panel overflows by ${s.overflow} px in ${s.name}`)
        check(s.sideways <= 0, `${where}: the page scrolls sideways by ${s.sideways} px in ${s.name}`)
      }
      check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
      console.log(`${where}: ${open.length} open states, sheet ${JSON.stringify(first.sheet)}, ${targets} targets measured`)
      await ctx.close()
    }
  }

  // ── 2. 200% text, the 4:3 photo ──
  for (const [vw, vh] of VIEWPORTS) {
    const where = `${vw}x${vh} at 200% text`
    const { ctx, page, errors } = await newPage({ width: vw, height: vh })
    await page.addStyleTag({ content: 'html { font-size: 200% }' })
    let n = 0
    let targets = 0
    let returned = 0
    const visit = async (name) => {
      await settle(page, `${where}, ${name}`)
      if (await dockAtStart(page, `${where}, ${name}`)) returned++
      n++
      for (const c of await page.evaluate(probeClipped)) check(false, `${where}, ${name}: ${c}`)
      const side = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      check(side <= 0, `${where}, ${name}: the page scrolls sideways by ${side} px`)
      targets += (await checkTargetsWholeDock(page, `${where}, ${name}`)).measured
    }
    await eachState(page, visit)
    await eachDialog(page, visit)
    check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
    console.log(`${where}: ${n} states and dialogs, no text cut off, ${targets} targets measured (the dock put back at its start in ${returned})`)
    await ctx.close()
  }

  // ── 3. The app bar at every width ──
  {
    const ORDER = ['full', 'compact', 'tight']
    const { ctx, page } = await newPage({ width: 430, height: 900, photo: null })
    for (const text of [100, 200]) {
      if (text === 200) await page.addStyleTag({ content: 'html { font-size: 200% }' })
      const seen = []
      let last = -1
      for (let w = 430; w >= 320; w -= 5) {
        await page.setViewportSize({ width: w, height: 900 })
        await settle(page, `the app bar at ${w} px, ${text}% text`)
        const bar = await page.evaluate(probeBar)
        const at = `the app bar at ${w} px, ${text}% text`
        const rank = ORDER.indexOf(bar.fit)
        check(rank >= 0, `${at}: no layout (${bar.fit})`)
        check(rank >= last, `${at}: ${bar.fit} is richer than ${ORDER[last]} at a wider width`)
        check(bar.rows === 1, `${at}: its actions are on ${bar.rows} rows`)
        check(bar.wordLines <= 1, `${at}: Save's word wraps (${bar.wordLines} lines)`)
        check(bar.outside === 0, `${at}: ${bar.outside} of its parts reach past it`)
        // Tight differs from compact only in letting the title wrap: tight
        // with the title on one line means compact was refused for something
        // that is not the title (a hit area read as overflow, once).
        check(bar.fit !== 'tight' || bar.titleLines > 1, `${at}: tight, though the title is on one line (compact should fit)`)
        last = Math.max(last, rank)
        if (seen[seen.length - 1]?.fit !== bar.fit) seen.push({ fit: bar.fit, from: w })
      }
      console.log(`The app bar at ${text}% text: ${seen.map((s) => `${s.fit} from ${s.from} px`).join(', ')}`)
    }
    await ctx.close()
  }

  // ── 4. The save states on a small phone at 200% text ──
  for (const [vw, vh] of SAVE_VIEWPORTS) {
    for (const tool of [null, 'frame']) await checkSaveStates(vw, vh, tool)
  }

  // ── 5. The Frame tool's states: light and dark, 100% and 200% text ──
  for (const [vw, vh] of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      for (const text of [100, 200]) {
        const where = `${vw}x${vh}, ${scheme}, ${text}% text, Frame`
        const { ctx, page, errors } = await newPage({ width: vw, height: vh, scheme })
        if (text === 200) await page.addStyleTag({ content: 'html { font-size: 200% }' })
        const sheets = new Map()
        const overflowed = new Set()
        let n = 0
        let targets = 0
        const cropRows = new Map()
        await eachFrameState(page, async (name, shape) => {
          const at = `${where} › ${name}`
          await settle(page, at)
          await dockAtStart(page, at)
          n++
          const m = await measure(page)
          if (name === 'frame-crop-original' || name === 'frame-crop')
            cropRows.set(
              name,
              await page.evaluate(() => {
                const p = document.querySelector('.controls__panel[data-sub="crop"]')
                const top = (sel) => Math.round((p?.querySelector(sel)?.getBoundingClientRect().top ?? NaN) * 10) / 10
                return { panel: Math.round((p?.getBoundingClientRect().top ?? NaN) * 10) / 10, tabs: Math.round(document.querySelector('.controls__section[data-tool="frame"] [role=tab]')?.getBoundingClientRect().top * 10) / 10, ratio: top('.chiprow'), mode: top('.segmented') }
              }),
            )
          if (!sheets.has(shape)) sheets.set(shape, { name, sheet: m.sheet })
          const first = sheets.get(shape)
          // At 200% text the sheet may shrink to make room; at 100% it holds.
          if (text === 100) {
            check(
              m.sheet && first.sheet && m.sheet.every((v, i) => Math.abs(v - first.sheet[i]) <= 1),
              `${at}: the sheet moved: ${JSON.stringify(m.sheet)} against ${JSON.stringify(first.sheet)} in ${first.name}`,
            )
            check(m.overflow <= 0.5, `${at}: the panel overflows by ${m.overflow} px`)
          } else {
            for (const c of await page.evaluate(probeClipped)) check(false, `${at}: ${c}`)
          }
          check(m.sideways <= 0, `${at}: the page scrolls sideways by ${m.sideways} px`)
          targets += (await (text === 100 ? checkTargets(page, at) : checkTargetsWholeDock(page, at))).measured
          for (const label of await checkChipRows(page, at, m.sheet)) overflowed.add(label)
        })
        check(n === 12, `${where}: ${n} Frame states visited (12)`)
        // Choosing a ratio moves nothing in the Crop tab: its tabs, the ratio
        // row and Crop | Fit stand where they stood on Original.
        const [onOriginal, on45] = [cropRows.get('frame-crop-original'), cropRows.get('frame-crop')]
        check(
          onOriginal && on45 && Object.keys(on45).every((k) => Math.abs(on45[k] - onOriginal[k]) <= 0.5),
          `${where}: Frame › Crop moved between Original and 4:5: ${JSON.stringify(onOriginal)} against ${JSON.stringify(on45)}`,
        )
        // At 320 px both rows run past the dock's width: their scroll is
        // checked, not passed for want of a row to scroll.
        if (vw === 320) check(overflowed.has('Fill') && overflowed.has('Sheet ratio'), `${where}: the rows that overflowed: ${[...overflowed].join(', ') || 'none'} (both)`)
        check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
        console.log(`${where}: ${n} states, ${targets} targets measured, the chip rows that scroll: ${[...overflowed].join(', ') || 'none'}`)
        await ctx.close()
      }
    }
  }

  // ── 6. A very large print: its line ──
  for (const [vw, vh, text] of LARGE_VIEWPORTS) await checkLargePrint(vw, vh, text)

  // ── 7. The review screenshots ──
  if (SHOTS) {
    for (const [vw, vh] of SHOT_WIDTHS) {
      for (const scheme of ['light', 'dark']) {
        const { ctx, page } = await newPage({ width: vw, height: vh, scheme })
        const shoot = async (name) => {
          await settle(page, `screenshot ${vw} ${scheme} ${name}`)
          await page.waitForTimeout(250)
          await page.screenshot({ path: join(SHOTS, shotName(vw, scheme, name)) })
        }
        await eachState(page, shoot)
        await eachDialog(page, shoot)
        await ctx.close()
        await shootSaveStates(vw, vh, scheme)
      }
    }
    {
      const { ctx, page } = await newPage({ width: 390, height: 844 })
      await page.addStyleTag({ content: 'html { font-size: 200% }' })
      const shoot = async (name) => {
        await settle(page, `screenshot 390 200% ${name}`)
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(SHOTS, shotName(390, 'light', '200pct', name)) })
      }
      await eachState(page, shoot)
      await eachDialog(page, shoot)
      await ctx.close()
    }
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await newPage({ width: 390, height: 844, scheme })
      await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'wire'))
      await closeTools(page)
      await settle(page, `screenshot 390 ${scheme} wire closed`)
      await page.screenshot({ path: join(SHOTS, shotName(390, scheme, 'wire', 'closed')) })
      for (const tool of TOOL_IDS) {
        await openTool(page, tool)
        await settle(page, `screenshot 390 ${scheme} wire ${tool}`)
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(SHOTS, shotName(390, scheme, 'wire', tool)) })
      }
      await ctx.close()
    }
    console.log(`Screenshots: ${SHOTS}`)
  }
} finally {
  await browser.close()
  await new Promise((r) => server.httpServer.close(r))
}

/**
 * The save states, for the review set: pressing with Cancel and then ready to
 * Share (the file's writing held 3 s, as a phone's can take), waiting for the
 * photo (a preview decode held back), the photo that could not be loaded (its
 * stored bytes deleted), the smaller-copy question (canvases wider than
 * 2000 px read back blank) and the save that did not finish (the in-flight
 * mark left set).
 */
async function shootSaveStates(vw, vh, scheme) {
  const shoot = async (page, name) => {
    await settle(page, `screenshot ${vw} ${scheme} save ${name}`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, shotName(vw, scheme, 'save', name)) })
  }
  // The file's writing held 3 s (the test seam, README "Test seams").
  const slowEncoder = `
    window.__PM_TEST__ = { finishDelayMs: 3000 }
    navigator.canShare = () => true
    navigator.share = async () => {}
  `
  // Detached canvases wider than 2000 px read back blank: the press's tiles
  // (2880 wide) and its first smaller copy's (2160); the next copy fits.
  const blankWide = `
    const real = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      const d = real.apply(this, a)
      if (!this.canvas.isConnected && this.canvas.width > 2000) d.data.fill(0)
      return d
    }
  `
  const slowDecode = `
    const real = window.createImageBitmap
    window.createImageBitmap = (src, ...rest) =>
      rest.some((o) => o && typeof o === 'object' && 'resizeWidth' in o)
        ? new Promise((r) => setTimeout(r, 4000)).then(() => real(src, ...rest))
        : real(src, ...rest)
  `
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null, init: slowEncoder })
    await page.locator('.app__save').click()
    await page.waitForFunction(() => /%|writing the file/.test(document.querySelector('.app__status-text')?.textContent ?? ''), null, { timeout: 60_000 })
    await shoot(page, 'pressing')
    await page.waitForFunction(() => document.querySelector('.app__save')?.textContent === 'Share', null, { timeout: 120_000 })
    await shoot(page, 'ready')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null, init: blankWide })
    await page.locator('.app__save').click()
    await page.waitForFunction(() => document.querySelector('dialog.savequestion')?.open, null, { timeout: 120_000 })
    await shoot(page, 'smaller-copy')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme, photo: null })
    await page.evaluate(() => localStorage.setItem('printmachine:export-in-flight', JSON.stringify({ height: 3600, format: 'jpeg' })))
    await page.reload()
    await page.waitForFunction(() => document.querySelector('dialog.savequestion')?.open, null, { timeout: 30_000 }).catch(() => undefined)
    await shoot(page, 'did-not-finish')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: vw, height: vh, scheme })
    await page.addInitScript(slowDecode)
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1200)
    await shoot(page, 'loading-photo')
    await page.evaluate(
      () =>
        new Promise((res) => {
          const id = JSON.parse(localStorage.getItem('printmachine:settings:v1')).media.id
          const r = indexedDB.open('printmachine')
          r.onsuccess = () => {
            const t = r.result.transaction('media', 'readwrite')
            t.objectStore('media').delete(id)
            t.oncomplete = res
          }
        }),
    )
    await page.reload()
    await page.waitForSelector('.sheet canvas')
    await page.waitForTimeout(1500)
    await shoot(page, 'missing-photo')
    await ctx.close()
  }
}

/**
 * Where the save's cards are, and whether their actions answer a tap: the
 * floating column lies between the app bar and the dock, and the control
 * `sel` is on screen and is what a tap at its centre lands on.
 */
function probeSaveCard(sel) {
  const box = (s) => document.querySelector(s)?.getBoundingClientRect()
  const bar = box('.app__bar')
  const dock = box('.app__overlay')
  const float = box('.app__float')
  const el = document.querySelector(sel)
  let action = 'missing'
  if (el) {
    const b = el.getBoundingClientRect()
    const x = b.left + b.width / 2
    const y = b.top + b.height / 2
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) action = `off the screen at ${Math.round(x)},${Math.round(y)}`
    else {
      const t = document.elementFromPoint(x, y)
      action = t === el || el.contains(t) ? 'ok' : `covered by ${t ? t.tagName.toLowerCase() + '.' + String(t.className).split(' ').join('.') : 'nothing'}`
    }
  }
  return {
    between: float.top >= bar.bottom - 0.5 && float.bottom <= dock.top + 0.5,
    column: `${Math.round(float.top)}..${Math.round(float.bottom)} (bar ends ${Math.round(bar.bottom)}, dock starts ${Math.round(dock.top)})`,
    action,
    toast: document.querySelector('.app__toast--show')?.textContent ?? null,
    // How long the toast has been up (when the gate started a clock on it).
    toastFor: typeof window.__toastAt === 'number' ? Math.round(performance.now() - window.__toastAt) : null,
    text: document.querySelector('.app__status-text')?.textContent ?? null,
  }
}

/**
 * The save states at 200% text on a small phone, where the cards are taller
 * than the room between the bar and the dock: a 1600×1200 photo on its own
 * sheet zoomed to 300% (the longest reason a real document gives: "photo is
 * 1600×1200 at 300% zoom: upscaled 4.5x", in the toast as the press starts),
 * the file's writing held 3 s as a phone's can take, with the dock closed and
 * with the Frame tool open (where it is right after a photo is chosen).
 * Pressing, with that toast shown: Cancel answers a tap. Ready: Share in the
 * bar answers a tap, and so does the card's ×. The stored photo gone: Choose
 * again answers a tap. In each, the cards stay between the bar and the dock.
 *
 * Pressing is measured with the press held in its first phase ("loading the
 * photo"): the original's decode at Save waits until the measurement is
 * taken. The toast is up for 2.4 s from the tap, and the page must be at rest
 * to be measured; with the press running, the main thread is busy pressing
 * plates, so coming to rest took 1.6 s here and 2.8 to 4.7 s with the CPU
 * throttled 2x to 4x, and the toast was often gone by then. Held, the page is
 * idle, comes to rest in a fraction of that whatever the machine's speed, and
 * the state measured is the tallest stack there is: the press's card with the
 * toast over it.
 */
async function checkSaveStates(vw, vh, tool) {
  const where = `${vw}x${vh} at 200% text, ${tool ? `the ${tool} tool open` : 'the dock closed'}`
  const failedBefore = failures.length
  const slowEncoder = `
    window.__PM_TEST__ = { finishDelayMs: 3000 }
    navigator.canShare = () => true
    navigator.share = async () => { window.__shared = (window.__shared ?? 0) + 1 }
    // A full decode (no resize: the original's, at Save; the preview's copy
    // is a resized one) waits while held, until released.
    const decode = window.createImageBitmap
    let held = null
    window.__holdOriginal = () => { held = [] }
    window.__releaseOriginal = () => { const go = held ?? []; held = null; go.forEach((f) => f()) }
    window.createImageBitmap = (src, ...rest) =>
      held && !rest.some((o) => o && typeof o === 'object' && 'resizeWidth' in o)
        ? new Promise((f) => held.push(f)).then(() => decode(src, ...rest))
        : decode(src, ...rest)
  `
  const { ctx, page, errors } = await newPage({ width: vw, height: vh, photo: [1600, 1200], init: slowEncoder })
  // Zoomed to 300% (what Frame › Place's Zoom stores), read back from
  // storage as a reload does. Set as the reloaded page starts, before the
  // app reads it: the page being left writes its own document on `pagehide`.
  await page.addInitScript(() => {
    const key = 'printmachine:settings:v1'
    const s = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (s?.media && s.media.scale !== 3) {
      s.media.scale = 3
      localStorage.setItem(key, JSON.stringify(s))
    }
  })
  await page.reload()
  await page.waitForSelector('.sheet canvas')
  await page.waitForFunction(() => document.querySelector('.app__save') && !document.querySelector('.app__save[aria-disabled="true"]'), null, { timeout: 30_000 })
  const large = () => page.addStyleTag({ content: 'html { font-size: 200% }' })
  const shoot = async (name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, shotName(vw, 'light', '200pct', tool ?? 'closed', 'save', name)) })
  }
  const state = async (name, sel, extra = () => true) => {
    await settle(page, `${where}, ${name}`)
    const p = await page.evaluate(probeSaveCard, sel)
    check(p.between, `${where}, ${name}: the cards reach past the bar or the dock: ${p.column}`)
    check(p.action === 'ok', `${where}, ${name}: ${sel} does not answer a tap: ${p.action}`)
    check(extra(p), `${where}, ${name}: ${JSON.stringify(p)}`)
    await shoot(name)
    return p
  }
  await large()
  if (tool) await openTool(page, tool)
  else await closeTools(page)
  await settle(page, `${where}, before Save`)
  // More, on a short phone at 200% text: its actions and Cancel on screen as
  // it opens, without scrolling (its facts may scroll inside themselves).
  if (!tool) {
    await page.locator('.app__bar [aria-label="More"]').click()
    await page.waitForSelector('dialog[open] .actsheet__list')
    await settle(page, `${where}, More`)
    const more = await page.evaluate(() => {
      const d = document.querySelector('dialog[open]')
      const inView = (el) => {
        const r = el?.getBoundingClientRect()
        return !!r && r.top >= -0.5 && r.bottom <= innerHeight + 0.5
      }
      const items = [...d.querySelectorAll('.actsheet__list .menu__item')]
      const info = d.querySelector('.actsheet__info')
      const facts = !!info && info.scrollHeight > info.clientHeight + 1
      // A box that scrolls with nothing focusable in it must be a keyboard
      // stop of its own, named (Safari makes none by itself).
      const reach = !facts || (info.tabIndex === 0 && info.getAttribute('role') === 'region' && !!info.getAttribute('aria-label'))
      return { scrolled: d.scrollTop, all: items.length, shown: items.filter(inView).map((i) => i.textContent.trim().slice(0, 24)), facts, reach }
    })
    check(
      more.all >= 2 && more.shown.length === more.all && more.scrolled === 0,
      `${where}, More: its actions on screen as it opens: ${JSON.stringify(more)}`,
    )
    check(more.reach, `${where}, More: its facts scroll but are not a named region the keyboard reaches: ${JSON.stringify(more)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => undefined)
    await settle(page, `${where}, More closed`)
  }
  await page.evaluate(() => {
    window.__holdOriginal()
    // A clock on the toast: from when it shows (no toast is up before Save).
    window.__toastAt = null
    const shown = () => {
      if (window.__toastAt === null && document.querySelector('.app__toast--show')) window.__toastAt = performance.now()
    }
    new MutationObserver(shown).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
  })
  await page.locator('.app__save').click()
  await page.waitForFunction(() => document.querySelector('.app__status-text')?.textContent?.startsWith('Pressing'), null, { timeout: 60_000 })
  // The press's first moments, held there (see above), with the save's toast
  // up: both are required, so it is the tallest stack that is measured.
  const pressing = await state(
    'pressing',
    '.app__status .btn',
    (p) => p.toast?.includes('% zoom: upscaled') === true && p.text?.includes('loading the photo') === true,
  )
  await page.evaluate(() => window.__releaseOriginal())
  await page.waitForFunction(() => document.querySelector('.app__save')?.textContent === 'Share', null, { timeout: 180_000 })
  await state('ready', '.app__save')
  await state('ready', '.app__status .btn')
  const share = await page.locator('.app__save').boundingBox()
  await page.mouse.click(share.x + share.width / 2, share.y + share.height / 2)
  await page.waitForFunction(() => (window.__shared ?? 0) > 0, null, { timeout: 5_000 }).catch(() => undefined)
  check((await page.evaluate(() => window.__shared ?? 0)) === 1, `${where}: a tap on Share did not share`)

  // The stored photo gone: the card says so, with Choose again.
  await page.evaluate(
    () =>
      new Promise((res) => {
        const id = JSON.parse(localStorage.getItem('printmachine:settings:v1')).media.id
        const r = indexedDB.open('printmachine')
        r.onsuccess = () => {
          const t = r.result.transaction('media', 'readwrite')
          t.objectStore('media').delete(id)
          t.oncomplete = res
        }
      }),
  )
  await page.reload()
  await page.waitForSelector('.sheet canvas')
  await large()
  if (tool) await openTool(page, tool)
  await page.waitForFunction(() => document.querySelector('.app__status[data-action="choose"]'), null, { timeout: 30_000 })
  await state('missing-photo', '.app__status .btn')
  check(errors.length === 0, `${where}: page errors: ${errors.join(' | ')}`)
  const failed = failures.length - failedBefore
  console.log(
    failed
      ? `${where}: ${failed} save-state check(s) failed (above)`
      : `${where}: pressing ("${pressing.text}", with the toast, ${pressing.toastFor} ms into its 2400), ready and the missing photo: every action answers, the cards stay between bar and dock`,
  )
  await ctx.close()
}

if (failures.length) {
  console.error(`\n${failures.length} geometry check(s) failed.`)
  process.exit(1)
}
console.log(
  '\nGeometry: the sheet holds still across every tool and tab, no panel overflows, every target owns 44px, ' +
    'nothing is cut off at 200% text, the app bar holds one row at every width, and the Frame tool\'s states and chip rows ' +
    'hold in light and dark, the rows scrolling inside themselves.',
)
