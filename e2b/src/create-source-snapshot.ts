import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { archiveWorkspace } from './ingress.js'
import { uploadSourceSnapshot } from './source-snapshot-client.js'

const names = new Set(['service-url', 'bearer-env', 'ca-bundle', 'root', 'cwd', 'ttl-seconds'])

function argumentsMap(argv: string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--json') { result.set('json', 'true'); continue }
    if (!argument.startsWith('--') || !names.has(argument.slice(2)) || !argv[index + 1]) throw new Error('invalid source snapshot CLI arguments')
    const name = argument.slice(2)
    if (result.has(name)) throw new Error('duplicate source snapshot CLI argument')
    result.set(name, argv[++index]!)
  }
  for (const name of names) if (!result.has(name)) throw new Error(`--${name} is required`)
  if (result.get('json') !== 'true') throw new Error('--json is required')
  return result
}

async function main(): Promise<void> {
  const args = argumentsMap(process.argv.slice(2))
  const root = resolve(args.get('root')!)
  const cwd = resolve(args.get('cwd')!)
  const ttl = Number(args.get('ttl-seconds'))
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 14_400) throw new Error('invalid source snapshot TTL')
  const bearer = process.env[args.get('bearer-env')!]
  if (!bearer) throw new Error('source snapshot bearer environment variable is unavailable')
  const archived = await archiveWorkspace(pathToFileURL(cwd).href, [pathToFileURL(root).href], [root], {
    maxBytes: 512 * 1024 * 1024, maxRoots: 1, maxExpandedBytes: 1024 * 1024 * 1024,
    maxEntries: 100_000, maxFileBytes: 256 * 1024 * 1024, maxPathDepth: 64, maxExtractionRatio: 4,
  })
  const result = await uploadSourceSnapshot({ serviceUrl: new URL(args.get('service-url')!), bearerToken: bearer,
    caBundlePath: resolve(args.get('ca-bundle')!), archive: archived.bytes, cwdUri: archived.cwd,
    workspaceRootUris: archived.roots, expiresAt: new Date(Date.now() + ttl * 1000) })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'source snapshot creation failed'); process.exitCode = 2 })
