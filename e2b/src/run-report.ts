import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

export const CudexResultStatusSchema = z.enum(['succeeded', 'failed', 'conflict', 'manual-recovery', 'interrupted'])
export type CudexResultStatus = z.infer<typeof CudexResultStatusSchema>
const timestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)))
const detailsSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
  .superRefine((details, context) => {
    for (const [key, value] of Object.entries(details)) if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key)
      || /(?:token|secret|password|credential|apiKey|url|auth)/iu.test(key)
      || (typeof value === 'string' && (Buffer.byteLength(value) > 2048
        || /(?:[?&]ticket=|:\/\/[^/\s]*@|\bsk-[A-Za-z0-9_-]+)/u.test(value)))) {
      context.addIssue({ code: 'custom', message: 'unsafe report details', path: [key] })
    }
  })
export const CudexPhaseReportSchema = z.strictObject({ version: z.literal(1),
  runId: z.string().regex(/^\d{14}-[0-9a-f]{12}$/u), phase: z.enum(['session', 'apply', 'cleanup']),
  status: CudexResultStatusSchema, startedAt: timestampSchema, finishedAt: timestampSchema, details: detailsSchema })
export type CudexPhaseReport = z.infer<typeof CudexPhaseReportSchema>

export async function writeCudexPhaseReport(path: string, report: CudexPhaseReport): Promise<void> {
  const result = CudexPhaseReportSchema.safeParse(report)
  if (!result.success) throw new Error(result.error.issues.some(issue => issue.path[0] === 'details')
    ? 'Cudex phase report contains unsafe details' : 'invalid Cudex phase report')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
