import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generatePocTls, validateProviderCaCertificate } from '../src/poc-tls.js'

test('POC TLS contains localhost SANs and a restrictive combined trust bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-poc-tls-'))
  const tls = await generatePocTls(directory)
  const certificate = new X509Certificate(await readFile(tls.serverCertificatePath, 'utf8'))
  assert.match(certificate.subjectAltName ?? '', /DNS:localhost/)
  assert.match(certificate.subjectAltName ?? '', /IP Address:127\.0\.0\.1/)
  assert.equal((await stat(tls.caKeyPath)).mode & 0o777, 0o600)
  assert.equal((await stat(tls.serverKeyPath)).mode & 0o777, 0o600)
  const bundle = await readFile(tls.combinedCaBundlePath, 'utf8')
  assert.ok(bundle.split('BEGIN CERTIFICATE').length > 2)
  assert.ok(bundle.includes(await readFile(tls.caCertificatePath, 'utf8')))
})

test('POC TLS validates and includes an explicit provider CA', async () => {
  const providerDirectory = await mkdtemp(join(tmpdir(), 'cudex-poc-provider-ca-'))
  const provider = await generatePocTls(providerDirectory)
  const providerCa = await validateProviderCaCertificate('/', provider.caCertificatePath)
  const directory = await mkdtemp(join(tmpdir(), 'cudex-poc-tls-provider-'))
  const tls = await generatePocTls(directory, providerCa)
  const bundle = await readFile(tls.combinedCaBundlePath, 'utf8')
  assert.ok(bundle.includes(await readFile(provider.caCertificatePath, 'utf8')))
})
