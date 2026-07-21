import { copyFile, lstat, mkdir, readFile, realpath, rm, chmod } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadCommandOsEnv } from './config/command-env.js'

export interface ValidatedAuthJson {
  sourcePath: string
}

function below(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

export async function validateAuthJsonFile(repositoryRoot: string, configuredPath: string): Promise<ValidatedAuthJson> {
  const root = await realpath(resolve(repositoryRoot))
  const sourcePath = resolve(root, configuredPath)
  if (!below(sourcePath, root)) throw new Error('Codex auth JSON must be inside the repository')
  const segments = relative(root, sourcePath).split(sep).filter(Boolean)
  let cursor = root
  for (const segment of segments) {
    cursor = resolve(cursor, segment)
    let metadata
    try { metadata = await lstat(cursor) } catch { throw new Error('Codex auth JSON file is unavailable') }
    if (metadata.isSymbolicLink()) throw new Error('Codex auth JSON path must not contain symbolic links')
  }
  const metadata = await lstat(sourcePath)
  if (!metadata.isFile()) throw new Error('Codex auth JSON source must be a regular file')
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(sourcePath, 'utf8')) }
  catch { throw new Error('Codex auth JSON source is invalid') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed as Record<string, unknown>).length === 0) {
    throw new Error('Codex auth JSON source must contain a non-empty JSON object')
  }
  return { sourcePath }
}

export async function copyAuthJsonToRuntime(validated: ValidatedAuthJson, codexHome: string): Promise<string> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  const destination = resolve(codexHome, 'auth.json')
  await copyFile(validated.sourcePath, destination)
  await chmod(destination, 0o600)
  return destination
}

export async function removeRuntimeAuth(codexHome: string): Promise<void> {
  await rm(resolve(codexHome, 'auth.json'), { force: true })
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets.filter(secret => secret.length > 0).sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join('[REDACTED]')
  }
  return result
}

export function createCodexProcessEnvironment(input: {
  codexHome: string
  caBundlePath: string
  hostedBearer: string
  accessToken?: string
}): NodeJS.ProcessEnv {
  return {
    PATH: loadCommandOsEnv().path, CODEX_HOME: input.codexHome,
    // Shared Codex HTTP/websocket clients read CODEX_CA_CERTIFICATE. The hosted-agent
    // service uses reqwest's Linux native-root loader, which reads SSL_CERT_FILE.
    // Using the same combined bundle keeps every POC Codex transport on one trust policy.
    CODEX_CA_CERTIFICATE: input.caBundlePath, SSL_CERT_FILE: input.caBundlePath,
    CODEX_HOSTED_AGENT_TOKEN: input.hostedBearer,
    ...(input.accessToken ? { CODEX_ACCESS_TOKEN: input.accessToken } : {}),
  }
}
