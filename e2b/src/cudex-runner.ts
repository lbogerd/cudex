import type { CudexArguments } from './cudex-cli.js'
import type { CudexPaths } from './cudex-config.js'

export async function dispatchCudexCommand(parsed: CudexArguments, _paths: CudexPaths): Promise<number> {
  if (parsed.command === 'status') { console.log(JSON.stringify({ active: false })); return 0 }
  if (parsed.command === 'cleanup') { console.log(JSON.stringify({ cleaned: true, active: false })); return 0 }
  throw new Error(`${parsed.command} is not available until the workspace runner is installed`)
}
