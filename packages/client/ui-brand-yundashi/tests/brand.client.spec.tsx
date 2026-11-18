// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import {
  BRAND_NAME as BRAND_NAME_FROM_COMPONENTS,
  BRAND_TAGLINE as BRAND_TAGLINE_FROM_COMPONENTS,
  BrandMark, BrandMarkDark, BrandName, BrandWordmark, HeroMark,
} from '../src/client/Brand.tsx'
import { BrandFrame } from '../src/client/BrandFrame.tsx'
import {
  BRAND_COLOR, BRAND_NAME, BRAND_TAGLINE, markDarkUrl, markUrl, wordmarkUrl,
} from '../src/client/brand.generated.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => { cleanup() })

/** The computed value React writes for the generated accent colour. */
const BRAND_COLOR_RGB = `rgb(${[1, 3, 5].map(at => parseInt(BRAND_COLOR.slice(at, at + 2), 16)).join(', ')})`

/** Every hole this package occupies, with the kind its declaration uses. */
const HOLES = [
  ['sidebar.brand.mark', 'single'],
  ['sidebar.brand.name', 'single'],
  ['conversation.hero.frame', 'hoc'],
  ['conversation.hero.brand.mark', 'single'],
] as const

/**
 * Declare the brand holes so the plugin's lazy `inject` callbacks resolve.
 * @param declare - whether to declare the holes before the plugin mounts.
 * @returns the context, the slot registry and the hole helpers.
 */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(([name, kind]) => [name, { kind, scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('yundashi browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('occupies all four brand holes, naming the home frame layer', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
      expect(subject.slots.entries('conversation.hero.frame')[0]?.options.id).toBe('yundashi-brand-frame')
    } finally {
      await fiber.dispose()
    }
  })

  it('fills holes declared after apply through the lazy inject callbacks', async () => {
    const subject = await bench(false)
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
      subject.declareHoles()
      await Promise.resolve()
      for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
    for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('removes every occupant when the declarations go away and restores them on re-declare', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      subject.disposeHoles?.()
      for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
      subject.declareHoles()
      await Promise.resolve()
      for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })
})

describe('yundashi brand components', () => {
  it('renders the sidebar mark at each requested edge without an accessible name', () => {
    const mark = render(<BrandMark size={24} />)
    const image = mark.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(markUrl)
    expect(image?.getAttribute('width')).toBe('24')
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
    mark.rerender(<BrandMark size={34} />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('34')
  })

  it('renders the product name as themed text carrying the brand colour', () => {
    const name = render(<BrandName />)
    const text = name.container.querySelector('[data-brand-name]')
    expect(text?.textContent).toBe(BRAND_NAME)
    expect(text?.getAttribute('style')).toContain(`color: ${BRAND_COLOR_RGB}`)
  })

  it('renders the blank-home mark and forwards the host geometry class', () => {
    const hero = render(<HeroMark size={34} className="hero-fish" />)
    const image = hero.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(markUrl)
    expect(image?.getAttribute('class')).toBe('hero-fish')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
    hero.rerender(<HeroMark size={34} />)
    expect(hero.container.querySelector('img')?.getAttribute('class')).toBeNull()
  })

  it('renders the wordmark lock-up with the product name as its alt text', () => {
    const wordmark = render(<BrandWordmark />)
    const image = wordmark.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(wordmarkUrl)
    expect(image?.getAttribute('alt')).toBe(BRAND_NAME)
  })

  it('renders the anti-white mark from the dark artwork', () => {
    const dark = render(<BrandMarkDark size={20} />)
    const image = dark.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(markDarkUrl)
    expect(image?.getAttribute('width')).toBe('20')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
  })

  it('re-exports the generated name and tagline beside the components', () => {
    expect(BRAND_NAME).toBe('云大师 Agent')
    expect(BRAND_TAGLINE).toBe('1 个人 + 云大师 = 一支企业')
    expect(BRAND_COLOR).toBe('#2D97D3')
    expect(BRAND_NAME_FROM_COMPONENTS).toBe(BRAND_NAME)
    expect(BRAND_TAGLINE_FROM_COMPONENTS).toBe(BRAND_TAGLINE)
  })

  it('passes the home frame body through without adding a layer', () => {
    const frame = render(<BrandFrame hero>{<p>conversation body</p>}</BrandFrame>)
    expect(frame.container.innerHTML).toBe('<p>conversation body</p>')
    expect(screen.getByText('conversation body')).toBeTruthy()
  })
})
