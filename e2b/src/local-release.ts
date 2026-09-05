import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateCachedRelease, type CudexReleaseManifest } from './cudex-release.js'
import { validatePocProvenance } from './poc-config.js'

export async function packageLocalRelease(repositoryRoot: string, templatePath: string,
  cudexRevision: string, expected: { buildId: string; revision: string;
    codexSha256: string; codeModeHostSha256: string }): Promise<string> {
  if (!/^[0-9a-f]{40}$/u.test(cudexRevision)) throw new Error('invalid runner revision')
  const provenance = await validatePocProvenance(repositoryRoot, templatePath)
  if (provenance.buildId !== expected.buildId || provenance.revision !== expected.revision
    || provenance.codexSha256 !== expected.codexSha256
    || provenance.codeModeHostSha256 !== expected.codeModeHostSha256) {
    throw new Error('template provenance does not match the selected build')
  }
  const releases = join(repositoryRoot, 'e2b', '.artifacts', 'releases')
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const releaseId = `local-${cudexRevision}-${createHash('sha256').update(provenance.buildId).digest('hex').slice(0, 24)}`
  const destination = join(releases, releaseId)
  if (await lstat(destination).catch(() => undefined)) {
    const existing = await validateCachedRelease(destination)
    if (existing.cudexRevision !== cudexRevision || existing.codexRevision !== provenance.revision
      || existing.template.templateId !== provenance.templateId
      || existing.binaries.codex.sha256 !== provenance.codexSha256
      || existing.binaries['codex-code-mode-host'].sha256 !== provenance.codeModeHostSha256) {
      throw new Error('existing local release does not match selected build/template')
    }
    return join(destination, 'release.json')
  }
  const temporary = await mkdtemp(join(releases, '.package-'))
  try {
    for (const [source, name] of [[provenance.binaryPath, 'codex'],
      [provenance.codeModeHostPath, 'codex-code-mode-host'], [templatePath, 'template.json']] as const) {
      await copyFile(source, join(temporary, name))
      await chmod(join(temporary, name), name === 'template.json' ? 0o600 : 0o755)
    }
    const describe = async (name: string) => {
      const bytes = await readFile(join(temporary, name))
      return { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const manifest: CudexReleaseManifest = {
      version: 1, releaseId, cudexRevision, codexRevision: provenance.revision,
      platform: 'linux-x86_64', minimumNodeVersion: '22.0.0',
      binaries: { codex: await describe('codex'), 'codex-code-mode-host': await describe('codex-code-mode-host') },
      template: { ...await describe('template.json'), templateId: provenance.templateId },
      cpuMillicores: provenance.cpuMillicores, memoryMb: provenance.memoryMb, createdAt: new Date().toISOString(),
    }
    await writeFile(join(temporary, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await validateCachedRelease(temporary)
    await rename(temporary, destination)
    return join(destination, 'release.json')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
