import { access, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Prune orphaned compiler output without removing live files: installer tests
// build this package again while the test runner is consuming dist/.
const output = new URL('../dist/', import.meta.url)
let entries = []
try { entries = await readdir(output, { recursive: true }) }
catch (error) { if (error.code !== 'ENOENT') throw error }
for (const entry of entries) {
  if (!/\.js(?:\.map)?$/.test(entry)) continue
  const source = new URL(`../${entry.replace(/\.js(?:\.map)?$/, '.ts')}`, import.meta.url)
  try { await access(source) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    await rm(new URL(entry, output), { force: true })
  }
}
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
  '-p', fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
