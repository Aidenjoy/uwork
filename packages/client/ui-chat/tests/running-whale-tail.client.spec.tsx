// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningWhaleTail } from '../src/client/chat/RunningWhaleTail.tsx'

afterEach(cleanup)

describe('RunningWhaleTail', () => {
  it('renders a neutral ongoing spinner without inline styles', () => {
    const view = render(<RunningWhaleTail />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.children).toHaveLength(1)
    const svg = icon.querySelector('svg')!
    expect(icon.firstElementChild).toBe(svg)
    expect(svg.getAttribute('data-state')).toBe('ongoing')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.querySelectorAll('circle')).toHaveLength(2)
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('does not reference the retired whale animation asset', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/client/chat/ChatView.module.css'), 'utf8')
    expect(css).not.toContain('running-whale')
  })
})
