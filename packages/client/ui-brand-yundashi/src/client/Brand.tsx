/** 云大师 Agent brand components occupying the sidebar and blank-home identity slots. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import markUrl from './assets/mark.png'
import markDarkUrl from './assets/mark-dark.png'
import mark512Url from './assets/mark-512.png'
import wordmarkUrl from './assets/wordmark.png'

/** Product identity rendered as plain text so the Chinese font follows the host theme. */
export const BRAND_NAME = '云大师 Agent'

/** Product slogan used by the welcome surface. */
export const BRAND_TAGLINE = '1 个人 + 云大师 = 一支企业'

/**
 * Render the 云大师 mark at the size requested by the sidebar.
 * @param props - Host-supplied square edge.
 * @returns the cyan mark image.
 */
export function BrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', width: size, height: size, objectFit: 'contain' }}
    />
  )
}

/** Render the product name beside the sidebar mark. */
export function BrandName() {
  return (
    <span
      data-brand-name=""
      style={{ color: '#2D97D3', fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}
    >
      {BRAND_NAME}
    </span>
  )
}

/**
 * Render the 云大师 mark on the blank home.
 * @param props - Host-supplied square edge and preserving class.
 * @returns the cyan mark image.
 */
export function HeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return (
    <img
      src={mark512Url}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', width: size, height: size, objectFit: 'contain' }}
    />
  )
}

/** Horizontal artwork for surfaces that need the full lock-up rather than the text name. */
export function BrandWordmark() {
  return (
    <img
      src={wordmarkUrl}
      alt={BRAND_NAME}
      style={{ display: 'block', width: '100%', height: 'auto', objectFit: 'contain' }}
    />
  )
}

/** Anti-white artwork for dark surfaces. */
export function BrandMarkDark({ size }: { readonly size: number }) {
  return (
    <img
      src={markDarkUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', width: size, height: size, objectFit: 'contain' }}
    />
  )
}
