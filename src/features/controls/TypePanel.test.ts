/**
 * Type › Face's Bold switch, as rendered: off and unavailable for Poster,
 * which is one weight, saying so; a switch as before for the other faces.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import TypePanel from './TypePanel.tsx'
import { SettingsContext, type SettingsStore } from '../../state/settingsStore.ts'
import { defaultSettings } from '../../state/defaults.ts'
import type { TextLayer } from '../../engine/types.ts'

function facePanel(fontId: TextLayer['fontId'], bold: boolean): string {
  const s = defaultSettings()
  const layer = { ...s.layers[0], fontId, bold }
  s.layers[0] = layer
  const store: SettingsStore = {
    settings: s,
    dispatch: () => {},
    undo: () => {},
    redo: () => {},
    canUndo: false,
    canRedo: false,
    selectedLayerId: layer.id,
    selectLayer: () => {},
    selectedLayer: layer,
  }
  return renderToStaticMarkup(createElement(SettingsContext.Provider, { value: store }, createElement(TypePanel, { sub: 'face', onSub: () => {} })))
}

const boldSwitch = (html: string) => /<button[^>]*aria-label="Bold"[^>]*>/.exec(html)?.[0] ?? ''
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

describe('the Bold switch', () => {
  it('is unpressed and unavailable on a Poster plate, Bold on or off, and says why', () => {
    for (const bold of [true, false]) {
      const html = facePanel('poster', bold)
      const b = boldSwitch(html)
      expect(b).not.toBe('')
      expect(attr(b, 'aria-pressed')).toBe('false')
      expect(b).toMatch(/\sdisabled=""/)
      const why = attr(b, 'aria-describedby')
      expect(why).toBeTruthy()
      expect(html).toContain(`id="${why}">Poster is one weight</p>`)
    }
  })

  it('is a switch on every other face, pressed as the plate is', () => {
    for (const fontId of ['grotesk', 'serif', 'mono'] as const) {
      for (const bold of [true, false]) {
        const html = facePanel(fontId, bold)
        const b = boldSwitch(html)
        expect(attr(b, 'aria-pressed')).toBe(String(bold))
        expect(b).not.toMatch(/\sdisabled/)
        expect(attr(b, 'aria-describedby')).toBeUndefined()
        expect(html).not.toContain('is one weight')
      }
    }
  })
})
