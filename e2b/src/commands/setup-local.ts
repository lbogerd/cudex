import { execa } from 'execa'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { createPilotConfig } from '../cudex-config.js'
import { loadCudexEnv } from '../config/cudex-env.js'
import { packageLocalRelease } from '../local-release.js'
import { detectDocker } from '../poc-infrastructure.js'

const e2bRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const repositoryRoot = resolve(e2bRoot, '..')
const git = async (...args: string[]) => (await execa('git', args, { cwd: repositoryRoot })).stdout.trim()

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--build-id'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(args[1]!))) {
    throw new Error('usage: setup-local.sh [--build-id <id>]')
  }
  if (await git('status', '--porcelain')) throw new Error('commit or stash source changes before local setup')
  const revision = await git('rev-parse', 'HEAD')
  const dotenv = join(e2bRoot, 'poc', '.env')
  const metadata = await lstat(dotenv).catch(() => undefined)
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)) {
    throw new Error('poc/.env must be a private regular file (chmod 600)')
  }
  const local = metadata ? parseEnv(await readFile(dotenv, 'utf8')) : {}
  const connection = {
    CUDEX_API_URL: process.env.CUDEX_API_URL ?? local.E2B_API_URL ?? 'http://127.0.0.1:3000',
    CUDEX_API_KEY: process.env.CUDEX_API_KEY ?? local.E2B_API_KEY,
    CUDEX_DOMAIN: process.env.CUDEX_DOMAIN ?? local.E2B_DOMAIN ?? 'cube.app',
    CUDEX_VALIDATE_API_KEY: process.env.CUDEX_VALIDATE_API_KEY ?? local.E2B_VALIDATE_API_KEY ?? 'true',
    CUDEX_PROVIDER_CA_CERTIFICATE: (process.env.CUDEX_PROVIDER_CA_CERTIFICATE ?? local.POC_PROVIDER_CA_CERTIFICATE) || undefined,
  }
  const checked = loadCudexEnv(connection)
  if (!checked.CUDEX_API_KEY) throw new Error('set CUDEX_API_KEY or E2B_API_KEY in private poc/.env')
  createPilotConfig({ releaseId: 'preflight', releaseDirectory: e2bRoot,
    apiUrl: checked.CUDEX_API_URL!, domain: checked.CUDEX_DOMAIN,
    validateApiKey: checked.CUDEX_VALIDATE_API_KEY })
  if (checked.CUDEX_PROVIDER_CA_CERTIFICATE) {
    const ca = await lstat(checked.CUDEX_PROVIDER_CA_CERTIFICATE).catch(() => undefined)
    if (!ca?.isFile() || ca.isSymbolicLink()) throw new Error('provider CA certificate is missing or unsafe')
  }
  await detectDocker()
  const artifactRoot = join(e2bRoot, '.artifacts', 'codex')
  const candidates = args[1] ? [args[1]] : await readdir(artifactRoot).catch(() => [])
  const builds: { buildId: string; builtAt: string; revision: string;
    codexSha256: string; codeModeHostSha256: string }[] = []
  for (const buildId of candidates) {
    try {
      const build = JSON.parse(await readFile(join(artifactRoot, buildId, 'build.json'), 'utf8'))
      if (build.dirty !== false || build.buildId !== buildId || !/^[0-9a-f]{40}$/u.test(build.revision)
        || build.target !== 'x86_64-unknown-linux-musl' || build.profile !== 'release') continue
      if (await git('diff', build.revision, 'HEAD', '--', 'codex')) continue
      builds.push({ buildId, builtAt: String(build.builtAt), revision: build.revision,
        codexSha256: build.binaries.codex.sha256, codeModeHostSha256: build.binaries['codex-code-mode-host'].sha256 })
    } catch { /* Ignore incomplete or obsolete build directories. */ }
  }
  builds.sort((a, b) => b.builtAt.localeCompare(a.builtAt))
  const selected = builds[0]
  if (!selected) throw new Error('no matching clean release build; run e2b/scripts/build-codex-artifact.sh first')
  console.log(`Using Codex build ${selected.buildId}`)
  const templatePath = join(e2bRoot, '.artifacts', 'templates', `${selected.buildId}.json`)
  if (!await lstat(templatePath).catch(() => undefined)) {
    const api = new URL(checked.CUDEX_API_URL!)
    if (!['127.0.0.1', '[::1]'].includes(api.hostname)) {
      throw new Error('automatic publication requires a local API; publish the template on the configured backend first')
    }
    console.log('Publishing the development template (CubeSandbox must be running).')
    const env = { CODEX_BUILD_ID: selected.buildId, CODEX_ARTIFACT_DIR: join(artifactRoot, selected.buildId) }
    await execa('bash', ['scripts/build-template-image.sh'], { cwd: e2bRoot, env, stdio: 'inherit' })
    await execa('bash', ['scripts/publish-template.sh'], { cwd: e2bRoot, env, stdio: 'inherit' })
  }
  const release = await packageLocalRelease(repositoryRoot, templatePath, revision, selected)
  await execa('bash', ['scripts/install-cudex.sh', '--release', release], { cwd: e2bRoot, stdio: 'inherit' })
  const launcher = join(process.env.XDG_BIN_HOME ?? join(process.env.HOME!, '.local', 'bin'), 'cudex')
  await execa(launcher, ['setup', '--release', release], { env: connection, stdio: 'inherit' })
  console.log(`Installed ${launcher}. If authentication is missing, run: cudex login`)
  await execa(launcher, ['doctor', '--verify-template'], { stdio: 'inherit' })
  console.log('Local setup verified. Run: cudex -C /absolute/path/to/project')
  if (!(process.env.PATH ?? '').split(':').includes(dirname(launcher))) {
    console.log(`Add ${dirname(launcher)} to your shell PATH, then open a new terminal.`)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'local setup failed')
  process.exitCode = 1
})
