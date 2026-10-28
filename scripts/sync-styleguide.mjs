#!/usr/bin/env node
// Copy the parts of the style guide Print Machine uses from a styleguide
// checkout into this repo, and record which commit they came from.
//
//   npm run sync:styleguide              (expects ../styleguide)
//   node scripts/sync-styleguide.mjs <path to a styleguide checkout>
//
// The same script as Border Studio's (the app this one follows), with this
// app's own lists. Only the elements listed below are copied, not the whole
// bundle: the style guide ships each element as its own file for exactly this
// (its dist/elements/manifest.json: "Link core.min.css first, then the
// elements you use, then core.min.js and the scripts they list").
//
// Never edit the copies by hand: change the style guide, rebuild it there,
// run this again, then run the geometry gate (scripts/verify-geometry.mjs).
// src/styles/editor.css reads a few of button.css's private properties
// (--_selw, --_select, --_rest-bg, ...), so a new style guide can move the
// dock without a single line here changing.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

const src = resolve(process.argv[2] ?? '../styleguide')
const dist = join(src, 'dist')
if (!existsSync(join(dist, 'core.min.css'))) {
  console.error(`No style guide build at ${dist}`)
  process.exit(1)
}

// Every element a Print Machine screen is built from (15): `chip` for the
// frame's ratio chips (ui/ChipRow.tsx). Border Studio also copies `field` and
// `divider`, which none of its markup uses: dead CSS is not shipped.
const ELEMENTS = ['button', 'card', 'appbar', 'toolbar', 'tabs', 'segmented', 'slider', 'switch',
                  'swatch', 'select', 'input', 'dialog', 'menu', 'spinner', 'chip']
// The style guide's scripts that only measure layout. The ones that own state
// (40-tabs, 31-slider, 60-dialog, 63-menu, 42-chip) are left out on purpose:
// React owns that state, and two owners of aria-selected fight. 42-chip also
// reveals a focused chip in a scrolling row through 40-tabs' SG.revealInline,
// so it cannot load without the tabs script; ui/ChipRow.tsx does that reveal
// itself, as ui.tsx's Tabs keeps its chosen tab in view.
// 70-scrubber is here only because 71-toolbar calls SG.afterParse, which the
// scrubber script defines; dist/elements/manifest.json lists only 71-toolbar
// for the toolbar (an upstream gap: without it every page load throws
// "SG.afterParse is not a function"). It is inert without .scrubber elements.
const SCRIPTS = ['44-segmented', '70-scrubber', '71-toolbar']

const css = resolve('src/vendor/styleguide')
const js = resolve('public/sg')
rmSync(css, { recursive: true, force: true })
rmSync(js, { recursive: true, force: true })
mkdirSync(join(css, 'elements'), { recursive: true })
mkdirSync(join(js, 'js'), { recursive: true })

cpSync(join(dist, 'core.min.css'), join(css, 'core.min.css'))
cpSync(join(dist, 'icons.css'), join(css, 'icons.css'))
cpSync(join(dist, 'fonts'), join(css, 'fonts'), { recursive: true })
for (const e of ELEMENTS) cpSync(join(dist, 'elements', `${e}.min.css`), join(css, 'elements', `${e}.min.css`))
cpSync(join(dist, 'core.min.js'), join(js, 'core.min.js'))
for (const s of SCRIPTS) cpSync(join(dist, 'js', `${s}.min.js`), join(js, 'js', `${s}.min.js`))
cpSync(join(src, 'src', 'icons', 'LICENSE-lucide.txt'), join(css, 'LICENSE-lucide.txt'))

const git = (cmd) => execSync(`git ${cmd}`, { cwd: src, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
let commit = 'unknown'
let branch = 'unknown'
try {
  commit = git('rev-parse --short HEAD')
  branch = git('rev-parse --abbrev-ref HEAD')
  // A detached checkout (a CI clone, a pinned worktree): name the remote
  // branch the commit is on, so VERSION.md still says where it came from.
  if (branch === 'HEAD') {
    branch = git("name-rev --name-only --refs='refs/remotes/*' HEAD")
      .replace(/^remotes\/[^/]+\//, '')
      .replace(/[~^].*$/, '')
  }
} catch {
  /* not a git checkout */
}
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version
writeFileSync(
  join(css, 'VERSION.md'),
  `# Vendored style guide

From chattedomestique/styleguide, branch \`${branch}\`, commit \`${commit}\` (v${version}).
Copied by \`scripts/sync-styleguide.mjs\`. Do not edit these files by hand.

Elements: ${ELEMENTS.join(', ')}.
Scripts (in public/sg/js): core, ${SCRIPTS.join(', ')}.

Archivo is SIL OFL 1.1 (fonts/OFL-Archivo.txt). Icons are Lucide, ISC (LICENSE-lucide.txt).
`,
)
console.log(`Vendored style guide ${branch}@${commit} (v${version}): ${ELEMENTS.length} elements, ${SCRIPTS.length + 1} scripts`)
