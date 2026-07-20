#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPilotConfig, loadCudexConfig, loadCudexCredentials, resolveCudexPaths,
  saveCudexSetup, validateCudexCredentials, type CudexPaths } from './cudex-config.js'
import { installSharedRelease, validateCachedRelease } from './cudex-release.js'

const exec = promisify(execFile)
const e2bRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type CudexArguments =
  | { command: 'session'; directory: string; prompt?: string; model?: string }
  | { command: 'setup'; release: string }
  | { command: 'doctor'; verifyTemplate: boolean }
  | { command: 'files'; directory: string }
  | { command: 'status' | 'cleanup' | 'login' | 'version' | 'help' }

function argument(args: readonly string[], index: number, label: string): string {
  const value = args[index]
  if (!value || value.startsWith('-')) throw new Error(`${label} requires a value`)
  return value
}

export function parseCudexArguments(args: readonly string[], cwd = process.cwd()): CudexArguments {
  if (args.length === 0) return { command: 'session', directory: resolve(cwd) }
  if (args[0] === '--help' || args[0] === '-h') return { command: 'help' }
  const named = new Set(['setup', 'doctor', 'files', 'status', 'cleanup', 'login', 'version'])
  if (named.has(args[0]!)) {
    const command = args[0]!
    if (command === 'setup') {
      if (args.length !== 3 || args[1] !== '--release') throw new Error('usage: cudex setup --release <shared-release.json>')
      return { command: 'setup', release: resolve(cwd, argument(args, 2, '--release')) }
    }
    if (command === 'doctor') {
      if (args.length > 2 || (args.length === 2 && args[1] !== '--verify-template')) {
        throw new Error('usage: cudex doctor [--verify-template]')
      }
      return { command: 'doctor', verifyTemplate: args[1] === '--verify-template' }
    }
    if (command === 'files') {
      let directory = cwd
      if (args.length === 3 && args[1] === '-C') directory = argument(args, 2, '-C')
      else if (args.length !== 1) throw new Error('usage: cudex files [-C <directory>]')
      return { command: 'files', directory: resolve(cwd, directory) }
    }
    if (args.length !== 1) throw new Error(`cudex ${command} does not accept arguments`)
    return { command: command as 'status' | 'cleanup' | 'login' | 'version' }
  }

  let directory = cwd; let model: string | undefined; let prompt: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value === '-C') { directory = argument(args, ++index, '-C'); continue }
    if (value === '--model') { model = argument(args, ++index, '--model'); continue }
    // TODO(internal-release, PILOT-009): The pilot accepts only prompt, -C, and --model because this
    // covers coworker use without ambiguous forwarding. Replace it with versioned safe flag compatibility.
    if (value.startsWith('-')) throw new Error(`unsupported Cudex option: ${value}`)
    if (prompt !== undefined) throw new Error('cudex accepts one prompt argument')
    prompt = value
  }
  return { command: 'session', directory: resolve(cwd, directory), ...(prompt ? { prompt } : {}), ...(model ? { model } : {}) }
}

export const usage = `cudex [PROMPT]
cudex -C <directory> [PROMPT]
cudex --model <model> [-C <directory>] [PROMPT]
cudex setup --release <shared-release.json>
cudex doctor [--verify-template]
cudex files [-C <directory>]
cudex status | cleanup | login | version`

async function promptLine(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${label} is required in the environment for non-interactive setup`)
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try { return (await terminal.question(`${label}: `)).trim() } finally { terminal.close() }
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${label} is required in the environment for non-interactive setup`)
  process.stderr.write(`${label}: `)
  const disabled = spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] }).status === 0
  const terminal = createInterface({ input: process.stdin, terminal: false })
  try { return (await terminal.question('')).trim() }
  finally {
    terminal.close()
    if (disabled) spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
    process.stderr.write('\n')
  }
}

async function currentCudexRevision(): Promise<string> {
  const buildFile = join(e2bRoot, 'cudex-build.json')
  try {
    const parsed = JSON.parse(await readFile(buildFile, 'utf8')) as Record<string, unknown>
    if (typeof parsed.revision === 'string' && /^[0-9a-f]{40}$/u.test(parsed.revision)) return parsed.revision
  } catch {}
  try { return (await exec('git', ['rev-parse', 'HEAD'], { cwd: resolve(e2bRoot, '..') })).stdout.trim() }
  catch { throw new Error('installed Cudex revision provenance is unavailable') }
}

async function setup(release: string, paths: CudexPaths): Promise<void> {
  const installed = await installSharedRelease(release, paths)
  const revision = await currentCudexRevision()
  if (revision !== installed.manifest.cudexRevision) throw new Error('installed Cudex revision does not match the selected release')
  const apiUrl = process.env.CUDEX_API_URL?.trim() || await promptLine('CubeSandbox API URL')
  const apiKey = process.env.CUDEX_API_KEY || await promptSecret('CubeSandbox API key')
  const domain = process.env.CUDEX_DOMAIN?.trim() || 'cube.app'
  const providerCaCertificate = process.env.CUDEX_PROVIDER_CA_CERTIFICATE?.trim()
  if (providerCaCertificate) {
    const metadata = await lstat(providerCaCertificate).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('provider CA certificate is missing or unsafe')
  }
  const config = createPilotConfig({ releaseId: installed.manifest.releaseId, releaseDirectory: installed.directory,
    apiUrl, domain, ...(providerCaCertificate ? { providerCaCertificate } : {}) })
  await saveCudexSetup(paths, config, validateCudexCredentials({ version: 1, e2bApiKey: apiKey }))
  console.log(JSON.stringify({ configured: true, releaseId: installed.manifest.releaseId,
    templateId: installed.manifest.template.templateId, authentication: await discoverCodexAuth(paths) ? 'existing' : 'login-required' }))
}

export async function discoverCodexAuth(paths: CudexPaths): Promise<string | undefined> {
  const candidates = [process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'auth.json') : undefined,
    join(paths.home, '.codex', 'auth.json'), join(paths.isolatedCodexHome, 'auth.json')].filter(Boolean) as string[]
  for (const candidate of candidates) {
    const metadata = await lstat(candidate).catch(() => undefined)
    if (metadata?.isFile() && !metadata.isSymbolicLink() && metadata.size > 1 && metadata.size <= 1024 * 1024) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate
      } catch {}
    }
  }
  return undefined
}

export async function copyDiscoveredCodexAuth(paths: CudexPaths, runtimeCodexHome: string): Promise<string> {
  // TODO(internal-release, PILOT-016): The pilot copies existing file-backed Codex auth into an isolated
  // per-run home to avoid another login. Replace this after credential storage and threat-model review.
  const source = await discoverCodexAuth(paths)
  if (!source) throw new Error('Codex authentication is unavailable; run cudex login')
  const bytes = await readFile(source)
  await mkdir(runtimeCodexHome, { recursive: true, mode: 0o700 }); await chmod(runtimeCodexHome, 0o700)
  const destination = join(runtimeCodexHome, 'auth.json')
  await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' }); await chmod(destination, 0o600)
  return destination
}

async function doctor(paths: CudexPaths, verifyTemplate: boolean): Promise<void> {
  const [config, credentials] = await Promise.all([loadCudexConfig(paths), loadCudexCredentials(paths)])
  const release = await validateCachedRelease(config.releaseDirectory)
  if (release.releaseId !== config.releaseId) throw new Error('configured release identity is inconsistent')
  const revision = await currentCudexRevision()
  if (revision !== release.cudexRevision) throw new Error('installed Cudex revision does not match configured release')
  const docker = await import('./poc-infrastructure.js').then(module => module.detectDocker())
  const git = (await exec('git', ['--version'])).stdout.trim()
  const auth = await discoverCodexAuth(paths)
  if (!auth) throw new Error('Codex authentication is unavailable; run cudex login')
  if (verifyTemplate) {
    const verifier = join(e2bRoot, 'scripts', 'verify-template.mjs')
    await exec(process.execPath, [verifier, join(config.releaseDirectory, 'template.json')], {
      timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, E2B_API_KEY: credentials.e2bApiKey, E2B_API_URL: config.apiUrl,
        E2B_DOMAIN: config.domain, E2B_VALIDATE_API_KEY: String(config.validateApiKey),
        ...(config.providerCaCertificate ? { NODE_EXTRA_CA_CERTS: config.providerCaCertificate } : {}) },
    })
  }
  console.log(JSON.stringify({ ready: true, releaseId: release.releaseId, codexRevision: release.codexRevision,
    templateId: release.template.templateId, docker: [docker.executable, ...docker.prefix].join(' '), git,
    authentication: 'existing', templateVerified: verifyTemplate }))
}

async function login(paths: CudexPaths): Promise<void> {
  const config = await loadCudexConfig(paths); const release = await validateCachedRelease(config.releaseDirectory)
  await mkdir(paths.isolatedCodexHome, { recursive: true, mode: 0o700 }); await chmod(paths.isolatedCodexHome, 0o700)
  await writeFile(join(paths.isolatedCodexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 })
  const child = spawn(join(config.releaseDirectory, 'codex'), ['login', '--device-auth'], { stdio: 'inherit',
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', CODEX_HOME: paths.isolatedCodexHome } })
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  if (code !== 0 || !await discoverCodexAuth(paths)) throw new Error('Codex device login did not complete')
  console.log(JSON.stringify({ loggedIn: true, releaseId: release.releaseId }))
}

export async function runCli(args = process.argv.slice(2), paths = resolveCudexPaths()): Promise<number> {
  const parsed = parseCudexArguments(args)
  if (parsed.command === 'help') { console.log(usage); return 0 }
  if (parsed.command === 'setup') { await setup(parsed.release, paths); return 0 }
  if (parsed.command === 'doctor') { await doctor(paths, parsed.verifyTemplate); return 0 }
  if (parsed.command === 'login') { await login(paths); return 0 }
  if (parsed.command === 'version') {
    const config = await loadCudexConfig(paths); const release = await validateCachedRelease(config.releaseDirectory)
    console.log(`cudex ${release.releaseId} (cudex ${release.cudexRevision}, codex ${release.codexRevision})`); return 0
  }
  const runner = await import('./cudex-runner.js')
  return runner.dispatchCudexCommand(parsed, paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Cudex failed')
    process.exitCode = 2
  })
}
