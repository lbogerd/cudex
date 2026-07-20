import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeCudexPhaseReport } from '../src/run-report.js'

const base = { version: 1 as const, runId: '20260720120000-abcdef123456', phase: 'session' as const,
  status: 'succeeded' as const, startedAt: '2026-07-20T12:00:00Z', finishedAt: '2026-07-20T12:01:00Z' }

test('phase reports are separate owner-only bounded records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-report-')); const path = join(directory, 'session-report.json')
  await writeCudexPhaseReport(path, { ...base, details: { tuiExitCode: 0, projectedFiles: 12, interrupted: false } })
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(parsed.phase, 'session'); assert.equal(parsed.details.tuiExitCode, 0)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('phase reports reject secret-shaped keys and connection material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cudex-report-reject-'))
  await assert.rejects(writeCudexPhaseReport(join(directory, 'one'), { ...base, details: { apiKey: 'nope' } }), /unsafe/)
  await assert.rejects(writeCudexPhaseReport(join(directory, 'two'),
    { ...base, details: { detail: 'https://user:password@example.invalid/' } }), /unsafe/)
  await assert.rejects(writeCudexPhaseReport(join(directory, 'three'),
    { ...base, details: { detail: 'sk-test-secret' } }), /unsafe/)
})
