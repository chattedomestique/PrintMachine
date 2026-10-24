/**
 * The app's own CSS against the style guide's rules that a file can show.
 * Exits 1 on any violation. Part of `npm run verify`.
 *
 *   node scripts/check-css.mjs
 *
 * The style guide's own lint (its tests/lint.mjs: a CSS tokenizer, undefined
 * tokens, layering, AI tells, unknown classes...) is not vendored: it lints
 * the style guide's source tree, not an app. This is the subset of its rules
 * that holds for the app's CSS (every .css under src/ but src/vendor, and any
 * <style> in index.html), each rule with the reason it exists. It is a
 * subset: the guide's lint also reads, among others, token use, line weights
 * drawn with shadows, and a blur hidden in a filter: url(); the review
 * screenshots and the guide's squint test are where those are seen.
 *
 *  - blur          no `backdrop-filter`, no `blur(`: flat, no glass (rule 2).
 *  - gradient      no gradient that blends (linear, radial, conic, repeating):
 *                  flat fills only (rule 2). A hard-stop gradient (each colour
 *                  starts where the last ends: a meter, a hatch) is allowed,
 *                  as the style guide's lint allows it.
 *  - soft-shadow   no box-shadow with a non-zero blur written as a number: a
 *                  shadow is hard-edged and means "you can press this" (rule
 *                  2). A blur given through var() or calc() is not read.
 *  - drop-shadow   no `drop-shadow()` and no `text-shadow` at all, as in the
 *                  style guide's lint: shadows are hard-edged and only on what
 *                  you can press, and neither is how one is drawn (rule 2).
 *  - colour        no colour literal (hex, rgb(), hsl(), hwb(), lab(), lch(),
 *                  oklab(), oklch(), color(), a named colour): components
 *                  read roles (rules 6, golden 1). The symbols' SVG data URIs
 *                  in index.css are masks (their colour is never shown), so
 *                  url() contents are not read.
 *  - px-font       no font size in px, in `font-size` or `font`: words grow
 *                  with the reader's text size (golden 12).
 *  - outline       no `outline: none` or `0` without a replacement (a border
 *                  or box-shadow) in the same rule: focus stays visible
 *                  (golden 9, WCAG 2.4.7).
 *  - important     no `!important`: the app's CSS is unlayered, so it already
 *                  beats every sg.* layer; `!important` would mean a fight.
 *  - bare-element  no button, input, select or textarea without a class or
 *                  id of its own anywhere in a selector (and no lone `*`):
 *                  unlayered, `.dock input {}` would beat every slider the
 *                  style guide draws in the dock.
 *
 * Its own cases run first: a check that has stopped catching what it names
 * fails before the app's files are read.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const NAMED = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue
  chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
  darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray
  darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
  lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen
  lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
  olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver
  skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen`.split(/\s+/),
)
const BARE = new Set(['button', 'input', 'select', 'textarea'])

/** Comments out (newlines kept, so line numbers hold), strings and url()
 *  contents blanked. */
function clean(css) {
  let out = ''
  for (let i = 0; i < css.length; ) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      const stop = end < 0 ? css.length : end + 2
      out += css.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (css[i] === '"' || css[i] === "'") {
      const q = css[i]
      let j = i + 1
      while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1
      out += q + ' '.repeat(Math.max(0, j - i - 1)) + q
      i = j + 1
    } else if (/^url\(/i.test(css.slice(i, i + 4))) {
      let depth = 0
      let j = i
      for (; j < css.length; j++) {
        if (css[j] === '(') depth++
        else if (css[j] === ')' && --depth === 0) break
      }
      out += 'url(' + css.slice(i + 4, j).replace(/[^\n]/g, ' ') + ')'
      i = j + 1
    } else out += css[i++]
  }
  return out
}

/** Split at top-level separators (outside parentheses). */
function splitTop(text, sep) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
}

/** Rules as { prelude, decls: [{ prop, value, line }], line }, at-rules
 *  descended into, nested rules flattened. */
function parse(css) {
  const rules = []
  const stack = []
  let buf = ''
  let bufLine = 1
  let line = 1
  const flushDecls = (rule) => {
    const text = buf
    buf = ''
    if (!rule) return
    let at = bufLine
    for (const part of splitTop(text, ';')) {
      const lineOf = at + (part.match(/^\s*/)[0].match(/\n/g)?.length ?? 0)
      at += part.match(/\n/g)?.length ?? 0
      const colon = part.indexOf(':')
      if (colon < 0 || !part.trim()) continue
      rule.decls.push({ prop: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim(), line: lineOf })
    }
  }
  for (const ch of css) {
    if (ch === '{') {
      // What came since the last ; { or } is this block's prelude, after any
      // declarations of the enclosing rule.
      const segs = splitTop(buf, ';')
      const prelude = segs.pop()
      const parent = stack[stack.length - 1]
      buf = segs.join(';')
      flushDecls(parent?.rule)
      const p = prelude.trim()
      const preludeLine = line - (prelude.match(/\n/g)?.length ?? 0) + (prelude.match(/^\s*/)[0].match(/\n/g)?.length ?? 0)
      const rule = p.startsWith('@') ? null : { prelude: p, decls: [], line: preludeLine }
      if (rule) rules.push(rule)
      stack.push({ rule })
      buf = ''
      bufLine = line
    } else if (ch === '}') {
      flushDecls(stack.pop()?.rule)
      bufLine = line
    } else {
      if (buf === '') bufLine = line
      buf += ch
    }
    if (ch === '\n') line++
  }
  return rules
}

/** The text inside the parentheses that open at `open` (the index of '('). */
function argsAt(text, open) {
  let depth = 0
  for (let j = open; j < text.length; j++) {
    if (text[j] === '(') depth++
    else if (text[j] === ')' && --depth === 0) return text.slice(open + 1, j)
  }
  return text.slice(open + 1)
}

/** Whether a gradient's stops never blend: every colour starts where the one
 *  before it ends (or at 0), the style guide's gradientIsFlat. */
function gradientIsFlat(args) {
  const stops = splitTop(args, ',')
    .map((p) => p.trim())
    .filter((p) => !/^(to\s|-?\d+(\.\d+)?(deg|turn|rad|grad)\b|circle|ellipse|closest|farthest|at\s|from\s|in\s)/i.test(p))
    .map((p) => {
      const toks = splitTop(p, ' ').filter(Boolean)
      return { colour: toks[0], p1: toks[1], p2: toks[2] ?? toks[1] }
    })
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (a.colour === b.colour) continue
    const atStart = b.p1 === '0' || b.p1 === '0%'
    const meets = b.p1 !== undefined && a.p2 !== undefined && b.p1 === a.p2
    if (!atStart && !meets) return false
  }
  return true
}

/** True when a complex selector's subject or any compound is a bare
 *  button/input/select/textarea, or the whole selector is a lone `*`. */
function bareIn(selector) {
  const s = selector.trim()
  if (/^\*(::?[\w-]+(\([^)]*\))?)*$/.test(s)) return true
  // :not() and :has() only filter what matches, so they are dropped (a
  // button:not(.x) is still every other button); :is() and :where() ARE the
  // match, so what they list is checked as selectors of its own.
  let flat = ''
  for (let i = 0; i < s.length; ) {
    const m = /^:(not|has|is|where)\(/i.exec(s.slice(i))
    if (!m) {
      flat += s[i++]
      continue
    }
    let depth = 0
    let j = i + m[0].length - 1
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++
      else if (s[j] === ')' && --depth === 0) break
    }
    const inner = s.slice(i + m[0].length, j)
    if (/^(is|where)$/i.test(m[1]) && splitTop(inner, ',').some(bareIn)) return true
    i = j + 1
  }
  for (const compound of flat.split(/\s*[>+~]\s*|\s+/)) {
    const c = compound.replace(/\[[^\]]*\]/g, '').replace(/::?[\w-]+(\([^)]*\))?/g, '')
    const type = /^([a-z][\w-]*)/i.exec(c)?.[1]?.toLowerCase()
    if (type && BARE.has(type) && !/[.#]/.test(c)) return true
  }
  return false
}

/** Every violation in one stylesheet's text. */
export function checkCss(css) {
  const out = []
  const add = (line, rule, msg) => out.push({ line, rule, msg })
  for (const rule of parse(clean(css))) {
    for (const sel of splitTop(rule.prelude, ',')) {
      if (sel.trim() && bareIn(sel)) add(rule.line, 'bare-element', `"${sel.trim()}" styles a bare element`)
    }
    const hasReplacement = rule.decls.some((d) => /^(box-shadow|border(-[a-z-]+)?)$/.test(d.prop) && !/^(none|0)$/.test(d.value))
    for (const { prop, value, line } of rule.decls) {
      const v = value.toLowerCase()
      if (/!\s*important/.test(v)) add(line, 'important', `${prop}: ${value}`)
      if (/(^|-)backdrop-filter$/.test(prop)) add(line, 'blur', `${prop} (no glass)`)
      if (/\bblur\(/.test(v)) add(line, 'blur', `${prop}: ${value}`)
      for (const m of v.matchAll(/\b(repeating-)?(linear|radial|conic)-gradient\(/g)) {
        if (!gradientIsFlat(argsAt(v, m.index + m[0].length - 1))) add(line, 'gradient', `${prop}: ${value} (a blend; flat fills only)`)
      }
      if (/\bdrop-shadow\(/.test(v)) add(line, 'drop-shadow', `${prop}: ${value}`)
      if (prop === 'text-shadow' && !/^none$/.test(v.trim())) add(line, 'drop-shadow', `${prop}: ${value}`)
      if (/shadow/.test(prop)) {
        // Per layer: the lengths are offset-x, offset-y, blur, spread, with
        // the colour first or last; the blur is the third length.
        for (const layer of splitTop(v, ',')) {
          const tokens = splitTop(layer.trim(), ' ').filter((t) => t && t !== 'inset')
          const isLength = (t) => /^-?(\d+\.?\d*|\.\d+)([a-z%]+)?$/.test(t) || /^(calc|min|max|clamp)\(/.test(t)
          if (tokens.length && !isLength(tokens[0])) tokens.shift()
          else if (tokens.length && !isLength(tokens[tokens.length - 1])) tokens.pop()
          const blur = tokens[2]
          if (blur && /^(\d+\.?\d*|\.\d+)/.test(blur) && parseFloat(blur) > 0) add(line, 'soft-shadow', `${prop}: ${layer.trim()}`)
        }
      }
      if (/#[0-9a-f]{3,8}\b/.test(v)) add(line, 'colour', `${prop}: ${value}`)
      if (/(^|[^\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/.test(v)) add(line, 'colour', `${prop}: ${value}`)
      for (const word of v.replace(/\b[\w-]+\(/g, ' ').split(/[^a-z-]+/)) {
        if (NAMED.has(word)) add(line, 'colour', `${prop}: ${value} (the named colour "${word}")`)
      }
      if ((prop === 'font-size' || prop === 'font') && /(^|[\s/(,])\d*\.?\d+px\b/.test(v)) add(line, 'px-font', `${prop}: ${value}`)
      if ((prop === 'outline' || prop === 'outline-style') && /^(none|0)$/.test(v.trim()) && !hasReplacement) {
        add(line, 'outline', `${prop}: ${value} with no border or box-shadow in its place`)
      }
    }
  }
  return out
}

/* ── Its own cases: each rule caught where it applies, and passed where not ── */

const CASES = [
  ['.a { backdrop-filter: saturate(2); }', 'blur'],
  ['.a { filter: blur(4px); }', 'blur'],
  ['.a { box-shadow: 0 2px 8px var(--line); }', 'soft-shadow'],
  ['.a { --_shadow: 2px 2px 0.5rem var(--line); }', 'soft-shadow'],
  ['.a { box-shadow: 2px 2px 0 0 var(--line), inset 0 0 0 2px var(--paper); }', null],
  ['.a { box-shadow: 0 0 0 var(--ring-offset) var(--paper); }', null],
  ['.a { background: linear-gradient(var(--ink), var(--paper)); }', 'gradient'],
  ['.a { background-image: radial-gradient(circle at 50% 50%, var(--ink), transparent 70%); }', 'gradient'],
  ['.a { --track: conic-gradient(from 90deg, var(--ink) 25%, var(--paper) 40%); }', 'gradient'],
  ['.a { background: linear-gradient(to right, var(--ink) 50%, var(--paper) 50%); }', null],
  ['.a { background: repeating-linear-gradient(45deg, var(--ink) 0 2px, transparent 2px 6px); }', null],
  ['.a { filter: drop-shadow(0 2px 4px var(--ink)); }', 'drop-shadow'],
  ['.a { filter: drop-shadow(2px 2px 0 var(--ink)); }', 'drop-shadow'],
  ['.a { text-shadow: 0 0 1px var(--ink); }', 'drop-shadow'],
  ['.a { text-shadow: none; }', null],
  ['.a { color: #ff48b0; }', 'colour'],
  ['.a { background: rgb(0 0 0 / 0.5); }', 'colour'],
  ['.a { --x: oklch(0.7 0.1 30); }', 'colour'],
  ['.a { border-color: white; }', 'colour'],
  ['.a { background: color-mix(in oklab, var(--ink) 24%, var(--paper)); }', null],
  ['.a { white-space: nowrap; color: currentColor; background: transparent; }', null],
  ['.ic { --ic: url("data:image/svg+xml,%3Csvg stroke=\'%23000\' fill=\'black\'%3E"); }', null],
  ['.a { font-size: 14px; }', 'px-font'],
  ['.a { font: 500 14px/1.2 var(--font-sans); }', 'px-font'],
  ['.a { font: var(--type-meta); font-size: 1.25rem; }', null],
  ['.a { outline: none; }', 'outline'],
  ['.a:focus-visible { outline: 0; box-shadow: 0 0 0 2px var(--focus); }', null],
  ['.a { color: var(--ink) !important; }', 'important'],
  ['button { padding: 0; }', 'bare-element'],
  ['.dock input[type=range] { margin: 0; }', 'bare-element'],
  [':is(.x, select) { margin: 0; }', 'bare-element'],
  ['* { box-sizing: border-box; }', 'bare-element'],
  ['input.slider__input, .x > .btn, dialog.dialog { margin: 0; }', null],
  ['button:not(.btn) { margin: 0; }', 'bare-element'],
  [':is(.app__overlay, .app__bar) :not(dialog, dialog *) { --lift: 0; }', null],
  ['@media (forced-colors: active) { .a { border-color: ButtonText; } }', null],
  ['@media (hover: hover) { .a:hover { color: red; } }', 'colour'],
  ['/* button { color: red } */ .a { margin: 0; }', null],
]

const caseFailures = []
for (const [css, want] of CASES) {
  const got = checkCss(css).map((v) => v.rule)
  const ok = want ? got.includes(want) : got.length === 0
  if (!ok) caseFailures.push(`${css}\n    want ${want ?? 'nothing'}, got ${got.join(', ') || 'nothing'}`)
}
if (caseFailures.length) {
  console.error(`check-css's own cases failed:\n  ${caseFailures.join('\n  ')}`)
  process.exit(1)
}

/* ── The app's CSS ── */

function cssFiles(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (relative(root, path).startsWith(join('src', 'vendor'))) continue
    if (statSync(path).isDirectory()) files.push(...cssFiles(path))
    else if (name.endsWith('.css')) files.push(path)
  }
  return files
}

const sources = cssFiles(join(root, 'src')).map((path) => ({ path, css: readFileSync(path, 'utf8') }))
const html = readFileSync(join(root, 'index.html'), 'utf8')
for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
  const before = html.slice(0, m.index + m[0].indexOf('>') + 1)
  sources.push({ path: join(root, 'index.html'), css: '\n'.repeat(before.split('\n').length - 1) + m[1] })
}

let count = 0
for (const { path, css } of sources) {
  for (const v of checkCss(css)) {
    console.log(`${relative(root, path)}:${v.line}  ${v.rule}  ${v.msg}`)
    count++
  }
}
if (count) {
  console.error(`\ncheck-css: ${count} violation(s) of the style guide's rules in the app's CSS.`)
  process.exit(1)
}
console.log(`check-css: ${sources.length} stylesheets, ${CASES.length} self-cases; no violations.`)
