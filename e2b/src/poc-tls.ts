import { execa } from 'execa'
import { X509Certificate } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
const exec = execa
const systemCaPath = '/etc/ssl/certs/ca-certificates.crt'

export interface PocTlsMaterial {
  caCertificatePath: string
  caKeyPath: string
  serverCertificatePath: string
  serverKeyPath: string
  combinedCaBundlePath: string
}

async function openssl(args: string[]): Promise<void> {
  try { await exec('openssl', args, { timeout: 30_000, maxBuffer: 1024 * 1024 }) }
  catch { throw new Error('failed to generate ephemeral POC TLS material') }
}

export async function validateProviderCaCertificate(repositoryRoot: string, configuredPath: string): Promise<string> {
  const path = isAbsolute(configuredPath) ? configuredPath : resolve(repositoryRoot, configuredPath)
  let metadata
  try { metadata = await lstat(path) } catch { throw new Error('POC provider CA certificate is unavailable') }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 1024 * 1024) {
    throw new Error('POC provider CA certificate must be a bounded regular file')
  }
  try { await exec('openssl', ['crl2pkcs7', '-nocrl', '-certfile', path, '-outform', 'DER', '-out', '/dev/null'],
    { timeout: 30_000, maxBuffer: 1024 * 1024 }) }
  catch { throw new Error('POC provider CA certificate is invalid') }
  return path
}

export async function generatePocTls(directory: string, providerCaCertificate?: string): Promise<PocTlsMaterial> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const material: PocTlsMaterial = {
    caCertificatePath: join(directory, 'ca.crt'), caKeyPath: join(directory, 'ca.key'),
    serverCertificatePath: join(directory, 'server.crt'), serverKeyPath: join(directory, 'server.key'),
    combinedCaBundlePath: join(directory, 'combined-ca.pem'),
  }
  const requestPath = join(directory, 'server.csr')
  const extensionsPath = join(directory, 'server.ext')
  await writeFile(extensionsPath, [
    'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '',
  ].join('\n'), { mode: 0o600 })
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-subj', '/CN=cudex-poc-local-ca', '-keyout', material.caKeyPath, '-out', material.caCertificatePath,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  await openssl(['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=localhost',
    '-keyout', material.serverKeyPath, '-out', requestPath])
  await openssl(['x509', '-req', '-sha256', '-days', '2', '-in', requestPath,
    '-CA', material.caCertificatePath, '-CAkey', material.caKeyPath, '-CAcreateserial',
    '-extfile', extensionsPath, '-out', material.serverCertificatePath])
  await Promise.all([chmod(material.caKeyPath, 0o600), chmod(material.serverKeyPath, 0o600)])
  const [systemRoots, localRoot, providerRoot, server] = await Promise.all([
    readFile(systemCaPath), readFile(material.caCertificatePath),
    providerCaCertificate ? readFile(providerCaCertificate) : Promise.resolve(Buffer.alloc(0)),
    readFile(material.serverCertificatePath, 'utf8'),
  ])
  await writeFile(material.combinedCaBundlePath,
    Buffer.concat([systemRoots, Buffer.from('\n'), providerRoot, Buffer.from('\n'), localRoot]), { mode: 0o600 })
  const certificate = new X509Certificate(server)
  if (!certificate.subjectAltName?.includes('DNS:localhost') || !certificate.subjectAltName.includes('IP Address:127.0.0.1')) {
    throw new Error('generated POC certificate is missing required localhost SANs')
  }
  await openssl(['verify', '-CAfile', material.combinedCaBundlePath, material.serverCertificatePath])
  return material
}
