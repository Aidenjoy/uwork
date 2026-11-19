/** Where the Desktop client renders the Platform usage and top-up pages; shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Platform page host shared by Host and Client. */
export interface PlatformPagesConfig {
  /** Render usage and top-up in the app's own native view. When false, the entries open the system
   * browser instead — the right choice for a console that authenticates with its own browser
   * session and does not read the embedded page bridge. */
  embeddedPlatformPages: boolean
}
/** Validate the Platform page host choice. */
export const PlatformPagesFields = { embeddedPlatformPages: z.boolean().default(true) }
/** Validate the Platform page host choice. */
export const PlatformPagesConfig: z<Partial<PlatformPagesConfig>, PlatformPagesConfig> = z.object(PlatformPagesFields)
/** Bootstrap key carrying no account credentials. */
export const PLATFORM_PAGES_GLOBAL = '__DSH_ACCOUNT_PLATFORM_PAGES__'
