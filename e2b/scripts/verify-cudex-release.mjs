import process from 'node:process'
import path from 'node:path'
import { validateCachedRelease } from '../dist/src/cudex-release.js'

const [manifestPath, expectedCudexRevision] = process.argv.slice(2)
if (!manifestPath || !expectedCudexRevision || !/^[0-9a-f]{40}$/u.test(expectedCudexRevision)) {
  throw new Error('usage: verify-cudex-release.mjs <release.json> <cudex-revision>')
}
const manifest = await validateCachedRelease(path.dirname(path.resolve(manifestPath)))
if (manifest.cudexRevision !== expectedCudexRevision) {
  throw new Error('release Cudex revision does not match the installer revision')
}
console.log(JSON.stringify({ releaseId: manifest.releaseId, codexRevision: manifest.codexRevision,
  templateId: manifest.template.templateId, verified: true }))
