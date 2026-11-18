/**
 * Root-level brand profile resolver: the single source of truth for product identity.
 * Selection order: DSH_BRAND_PROFILE env > brand/local.json > default "yundashi".
 * Build scripts and the desktop packaging config import this module; switching the
 * active profile never requires editing package or app sources.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding profiles, assets and the apply/build entries. */
export const BRAND_ROOT = dirname(fileURLToPath(import.meta.url))
/** Repository root (the uwork checkout). */
export const REPO_ROOT = dirname(BRAND_ROOT)

const REQUIRED_STRING_FIELDS = [
  'key', 'productName', 'shortName', 'tagline', 'brandColor', 'backgroundColor', 'themeColor', 'artifactPrefix',
]

function activeKey() {
  const fromEnv = process.env.DSH_BRAND_PROFILE
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const local = join(BRAND_ROOT, 'local.json')
  if (existsSync(local)) {
    const parsed = JSON.parse(readFileSync(local, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.profile === 'string' && parsed.profile !== '') {
      return parsed.profile
    }
  }
  return 'yundashi'
}

function loadProfile(key) {
  const file = join(BRAND_ROOT, 'profiles', `${key}.json`)
  if (!existsSync(file)) throw new Error(`brand: unknown profile "${key}" (expected ${file})`)
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof profile !== 'object' || profile === null) throw new Error(`brand: profile "${key}" must be a JSON object`)
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof profile[field] !== 'string' || profile[field] === '') {
      throw new Error(`brand: profile "${key}" is missing non-empty string field "${field}"`)
    }
  }
  if (profile.key !== key) throw new Error(`brand: profile "${key}" declares mismatched key "${profile.key}"`)
  // The prefix lands in artifact filenames, COS keys and a discovery regex; keep it inert.
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(profile.artifactPrefix)) {
    throw new Error(`brand: profile "${key}" artifactPrefix must be lowercase kebab-case`)
  }
  return Object.freeze(profile)
}

/** The active, validated and frozen brand profile. */
export const brand = loadProfile(activeKey())
/** Installer/artifact filename prefix shared by the whole release chain. */
export const artifactPrefix = brand.artifactPrefix