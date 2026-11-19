#!/usr/bin/env node
/**
 * Inject the repository-root `yun.config.json` preset into a child process environment.
 *
 * The boot layer refuses `DSH_*` names in any `.env` file (`packages/boot/app-boot`,
 * `BOOTSTRAP_PREFIXES`), so a plain `.env` cannot retarget the account or inference origins.
 * This wrapper reads an ordinary JSON file instead and hands the values to the child as if the
 * launching shell had exported them.
 *
 * Usage:
 *   node scripts/yun-env.mjs --list
 *   node scripts/yun-env.mjs --print
 *   node scripts/yun-env.mjs --profile local -- pnpm dev:desktop
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE_NAME = 'yun.config.json'
const PROFILE_ENV = 'YUN_PROFILE'
const CONFIG_ENV = 'YUN_CONFIG'

/** Environment names the desktop runtime actually reads for backend routing. */
const KNOWN_NAMES = new Set([
  'DSH_ACCOUNT_ORIGIN',
  'DSH_INFERENCE_ORIGIN',
  'DSH_ACCOUNT_INSECURE',
  'DEEPSEEK_BASE_URL',
])

/** Pick the configuration file: explicit flag, `$YUN_CONFIG`, then the repository root. */
function resolveConfigPath(explicit) {
  const candidate = explicit ?? process.env[CONFIG_ENV] ?? resolve(ROOT, FILE_NAME)
  const path = resolve(candidate)
  if (!existsSync(path)) {
    throw new Error(`找不到配置文件：${path}\n先复制模板：cp yun.config.example.json yun.config.json`)
  }
  return path
}

/** Read and validate one configuration document. */
function loadDocument(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${path}\n${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`配置文件顶层必须是对象：${path}`)
  }
  const { profiles } = parsed
  if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) {
    throw new Error(`配置文件缺少 "profiles" 对象：${path}`)
  }
  return parsed
}

/** Resolve one preset into a plain string-valued environment map. */
function resolveProfile(document, name) {
  const profile = document.profiles[name]
  if (profile === undefined) {
    const available = Object.keys(document.profiles).join(', ') || '(空)'
    throw new Error(`配置文件中没有预设 "${name}"，可用：${available}`)
  }
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new Error(`预设 "${name}" 必须是对象`)
  }
  const env = {}
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === 'object' && value !== null) {
      throw new Error(`预设 "${name}" 的 ${key} 必须是字符串、数字或布尔值`)
    }
    env[key] = String(value)
    if (!KNOWN_NAMES.has(key)) {
      process.stderr.write(`yun-env: 提示：${name}.${key} 不是桌面端已知的后端路由变量\n`)
    }
  }
  return env
}

/** Compose the child environment: the file wins over the ambient shell for clarity. */
function childEnvironment(env) {
  return { ...process.env, ...env }
}

function printUsage() {
  process.stderr.write([
    '用法：',
    '  node scripts/yun-env.mjs --list                  列出所有预设',
    '  node scripts/yun-env.mjs --print                 打印当前预设（Windows set / POSIX export）',
    '  node scripts/yun-env.mjs --profile <名字> --print',
    '  node scripts/yun-env.mjs -- <命令...>            带着预设运行命令（含空格时整体加引号）',
    '  例：node scripts/yun-env.mjs -- "pnpm dev:desktop"',
    '',
    `配置文件：根目录 ${FILE_NAME}（可用 ${CONFIG_ENV} 指定其他路径）`,
    `选择预设：文件里的 active 字段（可用 ${PROFILE_ENV} 环境变量临时覆盖）`,
    '',
  ].join('\n'))
}

function main(argv) {
  let explicitPath
  let profileName = process.env[PROFILE_ENV]
  let mode = 'run'
  const command = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') { command.push(...argv.slice(index + 1)); break }
    if (argument === '--help' || argument === '-h') return printUsage()
    if (argument === '--list') { mode = 'list'; continue }
    if (argument === '--print') { mode = 'print'; continue }
    if (argument === '--config') { explicitPath = argv[++index]; continue }
    if (argument === '--profile') { profileName = argv[++index]; continue }
    command.push(argument)
  }
  const path = resolveConfigPath(explicitPath)
  const document = loadDocument(path)

  if (mode === 'list') {
    const active = profileName ?? document.active
    for (const name of Object.keys(document.profiles)) {
      process.stdout.write(`${name === active ? '*' : ' '} ${name}\n`)
    }
    return
  }

  const chosen = profileName ?? document.active
  if (typeof chosen !== 'string' || chosen.length === 0) {
    throw new Error(`配置文件缺少 "active" 字段：${path}`)
  }
  const env = resolveProfile(document, chosen)

  if (mode === 'print') {
    const lines = Object.entries(env).map(([key, value]) => process.platform === 'win32'
      ? `set ${key}=${value}`
      : `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    process.stdout.write(`${lines.length === 0 ? `# 预设 ${chosen} 不注入任何变量` : lines.join('\n')}\n`)
    return
  }

  if (command.length === 0) {
    printUsage()
    process.exitCode = 2
    return
  }
  // The tail is a shell command line, so quote arguments that contain spaces at the call site.
  const line = command.join(' ')
  const result = spawnSync(line, {
    stdio: 'inherit',
    env: childEnvironment(env),
    shell: true,
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
}

try {
  main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`yun-env: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
