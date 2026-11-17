/**
 * Layout-neutral home frame: occupying `conversation.hero.frame` prevents the
 * default decorative layer, and this frame deliberately draws nothing.
 */
import type { ReactNode } from 'react'
import type { HeroFrameOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Frame owner state and the wrapped Conversation scroll body. */
export type BrandFrameProps = HeroFrameOwnerProps & { readonly children: ReactNode }

/**
 * Pass the Conversation body through untouched.
 * @param props - Home state and wrapped content.
 * @returns the wrapped content without any decoration.
 */
export function BrandFrame({ children }: BrandFrameProps) {
  return <>{children}</>
}
