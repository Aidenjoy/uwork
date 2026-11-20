/** Public contact options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; empty hides the Feedback menu entry, or override with a support form URL. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^(?:$|https:\/\/[^/?#\s]+(?:[/?#][^\s]*)?)$/).default(''),
  contactSource: z.string().default(''),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'
