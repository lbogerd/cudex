import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTrustedRoles, generateCodexConfiguration, generateRuntimeSecrets, pocRunPaths,
  prepareRunFiles, validatePocProvenance } from '../src/poc-config.js'
import { validateGeneratedCodexConfiguration } from '../src/poc-config.js'
import type { PocEnvironment } from '../src/poc-env.js'

test('POC runtime files contain distinct generated secrets with mode 0600', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'cudex-poc-config-'))
  const e2bRoot = join(repositoryRoot, 'e2b')
  await import('node:fs/promises').then(fs => fs.mkdir(join(e2bRoot, 'poc'), { recursive: true }))
  await writeFile(join(e2bRoot, 'poc', 'garage.toml.template'), 'replication_factor = 1\n')
  const paths = pocRunPaths(repositoryRoot, '20260719120000-123456abcdef')
  const env: PocEnvironment = {
    e2bApiKey: 'key', e2bApiUrl: 'https://e2b.invalid', e2bDomain: 'cube.app', e2bValidateApiKey: true,
    templateMetadata: 'metadata.json', accessToken: 'auth', controlPort: 18443,
    postgresPort: 15432, garagePort: 13900, keepOnFailure: false, verifyTemplate: false,
  }
  const secrets = generateRuntimeSecrets()
  await prepareRunFiles(paths, env, secrets)
  for (const path of [paths.runtimeEnv, paths.composeEnv, paths.garageConfig]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  const values = Object.values(secrets)
  assert.equal(new Set(values).size, values.length)
  const runtime = await readFile(paths.runtimeEnv, 'utf8')
  assert.ok(runtime.includes(secrets.serviceBearer))
  assert.ok(!runtime.includes(env.accessToken!))
})

test('strict config validation redacts the hosted bearer from subprocess errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cudex-poc-validator-'))
  const binary = join(root, 'codex')
  await writeFile(binary, '#!/bin/sh\necho "failure $CODEX_HOSTED_AGENT_TOKEN" >&2\nexit 1\n')
  await chmod(binary, 0o755)
  const paths = pocRunPaths(root, '20260719120000-fedcba654321')
  paths.codexHome = join(root, 'codex-home')
  await mkdir(paths.codexHome)
  await assert.rejects(validateGeneratedCodexConfiguration({ buildId: 'build', revision: 'a'.repeat(40),
    codexSha256: 'b'.repeat(64), codeModeHostSha256: 'c'.repeat(64), templateId: 'template',
    cpuMillicores: 2000, memoryMb: 2000,
    binaryPath: binary, codeModeHostPath: binary, metadataPath: 'metadata' },
  paths, '/tmp/ca.pem', 'never-print-this-bearer'), error => {
    assert.ok(!String(error).includes('never-print-this-bearer'))
    assert.ok(String(error).includes('[REDACTED]'))
    return true
  })
})

async function fakeProvenanceRoot(): Promise<{ repositoryRoot: string; metadataPath: string;
  binaryPath: string; codeModeHostPath: string }> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'cudex-poc-provenance-'))
  const buildId = 'test-build'
  const artifactDirectory = join(repositoryRoot, 'e2b', '.artifacts', 'codex', buildId)
  const templateDirectory = join(repositoryRoot, 'e2b', '.artifacts', 'templates')
  await Promise.all([mkdir(artifactDirectory, { recursive: true }), mkdir(templateDirectory, { recursive: true })])
  const binary = Buffer.alloc(64)
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0); binary.writeUInt16LE(0x3e, 18)
  const binaryPath = join(artifactDirectory, 'codex')
  await writeFile(binaryPath, binary); await chmod(binaryPath, 0o755)
  const codeModeHostPath = join(artifactDirectory, 'codex-code-mode-host')
  await writeFile(codeModeHostPath, binary); await chmod(codeModeHostPath, 0o755)
  const metadataPath = join(templateDirectory, `${buildId}.json`)
  await writeFile(metadataPath, JSON.stringify({ buildId, revision: 'a'.repeat(40),
    codexSha256: createHash('sha256').update(binary).digest('hex'),
    codeModeHostSha256: createHash('sha256').update(binary).digest('hex'), templateId: 'tpl-test',
    cpuMillicores: 2000, memoryMb: 2000 }))
  return { repositoryRoot, metadataPath, binaryPath, codeModeHostPath }
}

test('provenance requires an independently checksummed code-mode host binary', async () => {
  const fixture = await fakeProvenanceRoot()
  const host = Buffer.alloc(64)
  host.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0); host.writeUInt16LE(0x3e, 18); host[32] = 1
  await writeFile(fixture.codeModeHostPath, host); await chmod(fixture.codeModeHostPath, 0o755)
  const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8')) as Record<string, unknown>
  metadata.codeModeHostSha256 = createHash('sha256').update(host).digest('hex')
  await writeFile(fixture.metadataPath, JSON.stringify(metadata))
  const provenance = await validatePocProvenance(fixture.repositoryRoot, fixture.metadataPath)
  assert.notEqual(provenance.codexSha256, provenance.codeModeHostSha256)

  await writeFile(fixture.codeModeHostPath, Buffer.from(host).fill(2, 32))
  await assert.rejects(validatePocProvenance(fixture.repositoryRoot, fixture.metadataPath), /checksum/)
})

test('provenance rejects missing, unbounded, non-executable, symlinked, and wrong-architecture code-mode hosts', async () => {
  for (const failure of ['missing', 'empty', 'oversized', 'non-executable', 'symlink', 'wrong-architecture'] as const) {
    const fixture = await fakeProvenanceRoot()
    if (failure === 'missing') await unlink(fixture.codeModeHostPath)
    if (failure === 'empty') await writeFile(fixture.codeModeHostPath, Buffer.alloc(0))
    if (failure === 'oversized') {
      const file = await open(fixture.codeModeHostPath, 'r+')
      try { await file.truncate(512 * 1024 * 1024 + 1) } finally { await file.close() }
    }
    if (failure === 'non-executable') await chmod(fixture.codeModeHostPath, 0o644)
    if (failure === 'symlink') {
      await unlink(fixture.codeModeHostPath)
      await symlink(fixture.binaryPath, fixture.codeModeHostPath)
    }
    if (failure === 'wrong-architecture') {
      const binary = await readFile(fixture.codeModeHostPath); binary.writeUInt16LE(0xb7, 18)
      await writeFile(fixture.codeModeHostPath, binary); await chmod(fixture.codeModeHostPath, 0o755)
      const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8')) as Record<string, unknown>
      metadata.codeModeHostSha256 = createHash('sha256').update(binary).digest('hex')
      await writeFile(fixture.metadataPath, JSON.stringify(metadata))
    }
    await assert.rejects(validatePocProvenance(fixture.repositoryRoot, fixture.metadataPath),
      /unavailable|bounded executable|x86_64 Linux/)
  }
})

test('provenance rejects missing or malformed code-mode host metadata', async () => {
  for (const value of [undefined, 'A'.repeat(64), '0'.repeat(63)]) {
    const fixture = await fakeProvenanceRoot()
    const metadata = JSON.parse(await readFile(fixture.metadataPath, 'utf8')) as Record<string, unknown>
    if (value === undefined) delete metadata.codeModeHostSha256
    else metadata.codeModeHostSha256 = value
    await writeFile(fixture.metadataPath, JSON.stringify(metadata))
    await assert.rejects(validatePocProvenance(fixture.repositoryRoot, fixture.metadataPath), /code-mode host checksum/)
  }
})

test('provenance and generated configuration contain exact hosted roles and explicit tool namespaces', async () => {
  const { repositoryRoot, metadataPath } = await fakeProvenanceRoot()
  const provenance = await validatePocProvenance(repositoryRoot, metadataPath)
  const runRoot = join(repositoryRoot, 'run')
  await mkdir(runRoot)
  const paths = pocRunPaths(repositoryRoot, '20260719120000-abcdef123456')
  paths.runDirectory = runRoot; paths.codexHome = join(runRoot, 'codex-home')
  const env: PocEnvironment = { e2bApiKey: 'key', e2bApiUrl: 'https://e2b.invalid', e2bDomain: 'cube.app', e2bValidateApiKey: true,
    templateMetadata: metadataPath, accessToken: 'auth', codexModel: 'gpt-test', controlPort: 18443,
    postgresPort: 15432, garagePort: 13900, keepOnFailure: false, verifyTemplate: false }
  const source = { sourceSnapshotId: `source_${'a'.repeat(32)}`, checksum: `sha256:${'b'.repeat(64)}`,
    expiresAt: '2026-07-19T12:00:00.000Z', manifestChecksum: `sha256:${'c'.repeat(64)}`, sizeBytes: 10 }
  const generated = await generateCodexConfiguration(paths, env, source, provenance)
  const config = await readFile(generated.configPath, 'utf8')
  for (const expected of ['hosted_agents = true', '[features.multi_agent_v2]', 'enabled = true',
    'default_agent_type = "root"', 'sandbox_template = "poc-root-v1"', 'sandbox_template = "poc-child-v1"',
    source.sourceSnapshotId, source.checksum, 'model = "gpt-test"']) assert.ok(config.includes(expected))
  assert.ok(config.includes('tool_namespace = "collaboration"'))
  const roles = JSON.parse(await readFile(generated.trustedRolesPath, 'utf8')) as {
    root: { toolPolicy: { allowedTools: Array<{ namespace: unknown }> } }
  }
  assert.deepEqual(roles, createTrustedRoles(provenance.templateId))
  assert.deepEqual(roles.root.toolPolicy.allowedTools.map(tool => tool.namespace),
    [null, null, null, null, 'collaboration', 'collaboration', null])
})
