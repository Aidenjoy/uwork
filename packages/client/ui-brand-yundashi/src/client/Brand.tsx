/** Brand components occupying the sidebar and blank-home identity slots; identity values are injected by brand/apply.mjs. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BRAND_COLOR, BRAND_NAME, BRAND_TAGLINE, mark512Url, markDarkUrl, markUrl, wordmarkUrl } from './brand.generated.ts'

export { BRAND_NAME, BRAND_TAGLINE }

/**
 * Render the active brand mark at the size requested by the sidebar.
 * @param props - Host-supplied square edge.
 * @returns the brand mark image.
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
      style={{ color: BRAND_COLOR, fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}
    >
      {BRAND_NAME}
    </span>
  )
}

/**
 * Render the active brand mark on the blank home.
 * @param props - Host-supplied square edge and preserving class.
 * @returns the brand mark image.
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
