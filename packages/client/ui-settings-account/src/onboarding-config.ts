/** Public desktop onboarding options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** First-run introduction switch projected from Host deployment config into the page. */
export interface OnboardingConfig {
  /** Register the multi-step first-run introduction after sign-in. */
  desktopOnboarding: boolean
}
/** Defaults preserve upstream behaviour; brand builds may disable the flow. */
export const OnboardingFields = { desktopOnboarding: z.boolean().default(true) }
/** Validate the public onboarding switch. */
export const OnboardingConfig: z<Partial<OnboardingConfig>, OnboardingConfig> = z.object(OnboardingFields)
/** Bootstrap key carrying only the public onboarding option and no credentials. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_ACCOUNT_ONBOARDING__'
