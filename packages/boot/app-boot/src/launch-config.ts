/**
 * Local backend routing overrides, read from `yun.config.json` before the profile composes.
 *
 * The boot layer refuses `DSH_*` names in any `.env` (`packages/boot/app-boot`, `BOOTSTRAP_PREFIXES`),
 * so a repository `.env` cannot retarget the account or inference origins. This module supplies the
 * same effect from an ordinary JSON document that never travels with a clone — the repository file is
 * gitignored, and `$DSH_HOME/yun.config.json` is the user's own.
 *
 * Every entry point calls it before its launch-environment snapshot: `apps/cli` for `dsh <profile>`
 * and `apps/desktop-host` for the packaged desktop app.
 *
 * A broken or absent file is never fatal: startup proceeds with the bundled defaults.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** File name searched in each candidate directory. */
export const LAUNCH_CONFIG_FILE = 'yun.config.json'

/** Harness home override, spelled as `@deepseek-ai/dsh-home-paths` spells it. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Absolute path of an explicit configuration file, overriding every search location. */
const CONFIG_ENV = 'YUN_CONFIG'

/** Preset name selected for this launch, overriding the document's `active` field. */
const PROFILE_ENV = 'YUN_PROFILE'

/** Ancestor directories visited when looking for the file beside a working directory. */
const MAX_WALK_UP = 6

/** What a successful application recorded, for the startup diagnostic line. */
export interface LaunchConfigApplication {
  readonly path: string
  readonly profile: string
  readonly names: readonly string[]
}

/** Inputs resolved from the runtime, kept explicit so the search order is testable. */
export interface LaunchConfigOptions {
  /** Environment mutated in place; the host passes `process.env`. */
  readonly environment?: NodeJS.ProcessEnv
  /** Invoking directory; the desktop host runs from the desktop profile directory. */
  readonly cwd?: string
  /** Directory of the running entry, so a repository checkout is found regardless of `cwd`. */
  readonly moduleDirectory?: string
  /** Harness home holding the user-level file. */
  readonly dshHome?: string
  /** Diagnostic sink; startup never fails because of it. */
  readonly warn?: (line: string) => void
}

/**
 * Find the nearest file at or above one directory.
 * @param start - directory to begin at.
 * @returns the absolute file path, or undefined when no ancestor holds one.
 */
function nearestConfig(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    const candidate = join(current, LAUNCH_CONFIG_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Resolve the default Harness home without loading the shared path package's filesystem probes. */
function defaultDshHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment[DSH_HOME_ENV]
  return configured !== undefined && configured.trim().length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * Choose the configuration file: explicit override, then the working directory, then the checkout
 * beside this entry, then the Harness home.
 * @param options - resolved search inputs.
 * @param warn - diagnostic sink for an explicit path that does not exist.
 * @returns the absolute file path, or undefined when no candidate exists.
 */
function resolveConfigPath(
  options: Required<Pick<LaunchConfigOptions, 'cwd' | 'moduleDirectory'>> & {
    environment: NodeJS.ProcessEnv
    dshHome: string
  },
  warn: (line: string) => void,
): string | undefined {
  const explicit = options.environment[CONFIG_ENV]
  if (explicit !== undefined && explicit.trim().length > 0) {
    const path = isAbsolute(explicit) ? explicit : resolve(options.cwd, explicit)
    if (existsSync(path)) return path
    warn(`launch config: ${CONFIG_ENV} points at a missing file: ${path}`)
    return undefined
  }
  const nearby = nearestConfig(options.cwd) ?? nearestConfig(options.moduleDirectory)
  if (nearby !== undefined) return nearby
  const home = join(options.dshHome, LAUNCH_CONFIG_FILE)
  return existsSync(home) ? home : undefined
}

/**
 * Validate one preset into string-valued entries.
 * @param profile - candidate preset object.
 * @param name - preset name, for the diagnostic.
 * @param warn - diagnostic sink for a rejected entry.
 * @returns every accepted name and value, in document order.
 */
function readProfile(
  profile: Record<string, unknown>, name: string, warn: (line: string) => void,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === 'object' && value !== null) {
      warn(`launch config: ${name}.${key} must be a string, number, or boolean; ignored`)
      continue
    }
    values[key] = String(value)
  }
  return values
}

/**
 * Apply the selected preset to the environment.
 *
 * A value in the file replaces an inherited one, so editing the document is always the single source
 * of truth for backend routing during local debugging.
 * @param options - search inputs and the environment to mutate in place.
 * @returns what was applied, or undefined when no usable file or preset was found.
 */
export function applyLaunchConfig(options: LaunchConfigOptions = {}): LaunchConfigApplication | undefined {
  const environment = options.environment ?? process.env
  const warn = options.warn ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  try {
    const path = resolveConfigPath({
      environment,
      cwd: options.cwd ?? process.cwd(),
      moduleDirectory: options.moduleDirectory ?? import.meta.dirname,
      dshHome: options.dshHome ?? defaultDshHome(environment),
    }, warn)
    if (path === undefined) return undefined
    const document: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      warn(`launch config: ${path} must hold an object; ignored`)
      return undefined
    }
    const { profiles, active } = document as { profiles?: unknown; active?: unknown }
    if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) {
      warn(`launch config: ${path} needs a "profiles" object; ignored`)
      return undefined
    }
    const selected = environment[PROFILE_ENV]?.trim() || active
    if (typeof selected !== 'string' || selected.length === 0) {
      warn(`launch config: ${path} needs an "active" preset name; ignored`)
      return undefined
    }
    const profile = (profiles as Record<string, unknown>)[selected]
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      const available = Object.keys(profiles).join(', ')
      warn(`launch config: ${path} has no preset "${selected}" (available: ${available}); ignored`)
      return undefined
    }
    const values = readProfile(profile as Record<string, unknown>, selected, warn)
    for (const [name, value] of Object.entries(values)) environment[name] = value
    return { path, profile: selected, names: Object.keys(values) }
  } catch (error) {
    warn(`launch config: ignored after ${String(error)}`)
    return undefined
  }
}
