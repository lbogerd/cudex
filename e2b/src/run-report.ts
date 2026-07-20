import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type CudexResultStatus = 'succeeded' | 'failed' | 'conflict' | 'manual-recovery' | 'interrupted'

export interface CudexPhaseReport {
  version: 1
  runId: string
  phase: 'session' | 'apply' | 'cleanup'
  status: CudexResultStatus
  startedAt: string
  finishedAt: string
  details: Record<string, string | number | boolean | null>
}

function validateReport(report: CudexPhaseReport): void {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(report.runId) || report.version !== 1
    || !['session', 'apply', 'cleanup'].includes(report.phase)
    || !['succeeded', 'failed', 'conflict', 'manual-recovery', 'interrupted'].includes(report.status)
    || !Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.finishedAt))) {
    throw new Error('invalid Cudex phase report')
  }
  for (const [key, value] of Object.entries(report.details)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key)
      || /(?:token|secret|password|credential|apiKey|url|auth)/iu.test(key)
      || (typeof value === 'string' && (Buffer.byteLength(value) > 2048
        || /(?:[?&]ticket=|:\/\/[^/\s]*@|\bsk-[A-Za-z0-9_-]+)/u.test(value)))) {
      throw new Error('Cudex phase report contains unsafe details')
    }
  }
}

export async function writeCudexPhaseReport(path: string, report: CudexPhaseReport): Promise<void> {
  validateReport(report)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
