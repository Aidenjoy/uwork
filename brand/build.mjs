/**
 * Brand-aware build entry: apply the active profile, then run the standard repository
 * build with the brand title injected. Usage: node brand/build.mjs [build.ts args...]
 * The official profile is deliberately unset so DSH_CLIENT_TITLE survives resolution.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { brand, REPO_ROOT } from './resolve.mjs'

const applied = spawnSync(process.execPath, [join(import.meta.dirname, 'apply.mjs')], { stdio: 'inherit' })
if (applied.status !== 0) process.exit(applied.status ?? 1)

const env = { ...process.env, DSH_CLIENT_TITLE: brand.productName, npm_config_verify_deps_before_run: 'false' }
delete env.DSH_BUILD_CLIENT_PROFILE
const built = spawnSync('pnpm', ['exec', 'tsx', 'scripts/build.ts', ...process.argv.slice(2)], {
  stdio: 'inherit', cwd: REPO_ROOT, env, shell: true,
})
process.exit(built.status ?? 1)