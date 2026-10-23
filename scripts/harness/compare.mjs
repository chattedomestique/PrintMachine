/**
 * Compare two harness runs: which renders are byte-identical and which are not.
 *
 *   node scripts/harness/compare.mjs parent.json commit.json
 *
 * Exits 1 when any render present in both differs, so it can gate a claim of
 * "no visible change". A deliberate change shows up as a difference too; the
 * commit message is where it is said to be deliberate.
 */

import { readFileSync } from 'node:fs'

const [aPath, bPath] = process.argv.slice(2)
if (!aPath || !bPath) {
  console.error('usage: node scripts/harness/compare.mjs a.json b.json')
  process.exit(2)
}

const a = JSON.parse(readFileSync(aPath, 'utf8'))
const b = JSON.parse(readFileSync(bPath, 'utf8'))
const ra = a.renders ?? {}
const rb = b.renders ?? {}

const label = (run) => `${run.meta?.commit ?? '?'}${run.meta?.dirty ? '+dirty' : ''}`
console.log(`A ${label(a)} (${aPath})`)
console.log(`B ${label(b)} (${bPath})`)

let differ = 0
for (const key of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
  const x = ra[key]
  const y = rb[key]
  if (!x || !y) {
    console.log(`${key.padEnd(28)} only in ${x ? 'A' : 'B'}`)
    continue
  }
  const same = x.sha256 === y.sha256 && x.w === y.w && x.h === y.h
  if (!same) differ++
  console.log(
    `${key.padEnd(28)} ${same ? 'IDENTICAL' : 'DIFFERS  '} ${x.sha256.slice(0, 12)} ${same ? '' : `-> ${y.sha256.slice(0, 12)}`}`,
  )
}

for (const key of Object.keys(b.timings ?? {})) {
  const x = a.timings?.[key]
  const y = b.timings[key]
  console.log(`time ${key}: A ${x ? `${x.median} ms` : 'n/a'}, B ${y.median} ms`)
}

console.log(differ ? `${differ} render(s) differ` : 'all shared renders identical')
process.exit(differ ? 1 : 0)
