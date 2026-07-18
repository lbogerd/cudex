import process from 'node:process'
import { Sandbox } from 'e2b'

const templateId = process.argv[2]
if (!templateId) throw new Error('usage: node scripts/live-lifecycle-canary.mjs <template-id>')
if (!process.env.E2B_API_KEY || !process.env.E2B_API_URL) throw new Error('E2B_API_KEY and E2B_API_URL are required')
const connection = { apiKey: process.env.E2B_API_KEY, apiUrl: process.env.E2B_API_URL, domain: process.env.E2B_DOMAIN ?? 'cube.app',
  validateApiKey: process.env.E2B_VALIDATE_API_KEY !== 'false', requestTimeoutMs: 120_000 }
const options = { ...connection, timeoutMs: 120_000, secure: true, lifecycle: { onTimeout: 'pause', autoResume: false } }
const sandboxes = []
let snapshotId
const run = async (sandbox, command) => {
  const result = await sandbox.commands.run(command, { user: 'root' })
  if (result.exitCode !== 0) throw new Error(`command failed: ${result.stderr}`)
  return result.stdout.trim()
}
try {
  const owner = await Sandbox.create(templateId, { ...options, metadata: { canary: 'lifecycle-owner' } }); sandboxes.push(owner.sandboxId)
  await run(owner, "mkdir -p /workspace/project; printf spawn-state >/workspace/project/state; printf owner-secret >/tmp/gateway-secret; setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! >/tmp/owner-pid")
  const ownerPid = await run(owner, 'cat /tmp/owner-pid')
  await run(owner, 'tar -cf /tmp/checkpoint-workspace.tar -C /workspace project')
  const checkpointArchive = await owner.files.read('/tmp/checkpoint-workspace.tar', { format: 'bytes' })
  const snapshot = await owner.createSnapshot()
  snapshotId = snapshot.snapshotId
  const reconnected = await Sandbox.connect(owner.sandboxId, options)
  const afterCheckpoint = await run(reconnected, 'printf second-command')
  await Sandbox.kill(owner.sandboxId, connection); sandboxes.splice(sandboxes.indexOf(owner.sandboxId), 1)

  const restored = await Sandbox.create(snapshot.snapshotId, { ...options, metadata: { canary: 'lifecycle-restored' } }); sandboxes.push(restored.sandboxId)
  const providerSnapshotHadWorkspace = await restored.commands.run('test -e /workspace/project/state', { user: 'root' }).then(result => result.exitCode === 0).catch(() => false)
  await restored.files.write('/tmp/checkpoint-workspace.tar', Uint8Array.from(checkpointArchive).buffer)
  await run(restored, 'mkdir -p /workspace; tar -xf /tmp/checkpoint-workspace.tar -C /workspace')
  await run(restored, `rm -f /tmp/gateway-secret; kill ${ownerPid} 2>/dev/null || true`)
  const restoreState = await run(restored, 'cat /workspace/project/state')
  const oldIdentityGone = await run(restored, `test ! -e /tmp/gateway-secret && ! kill -0 ${ownerPid} 2>/dev/null && printf isolated`)

  const archiveResult = await restored.commands.run('tar -cf /tmp/workspace.tar -C /workspace project', { user: 'root' })
  if (archiveResult.exitCode !== 0) throw new Error(archiveResult.stderr)
  const archive = await restored.files.read('/tmp/workspace.tar', { format: 'bytes' })
  const child = await Sandbox.create(templateId, { ...options, metadata: { canary: 'lifecycle-child' } }); sandboxes.push(child.sandboxId)
  await child.files.write('/tmp/workspace.tar', Uint8Array.from(archive).buffer)
  await run(child, 'mkdir -p /workspace; tar -xf /tmp/workspace.tar -C /workspace; test ! -e /tmp/gateway-secret; cat /workspace/project/state')
  await run(child, 'printf child >/workspace/project/state')
  const divergence = { owner: await run(restored, 'cat /workspace/project/state'), child: await run(child, 'cat /workspace/project/state') }
  if (afterCheckpoint !== 'second-command' || restoreState !== 'spawn-state' || oldIdentityGone !== 'isolated' || divergence.owner === divergence.child) throw new Error('lifecycle assertion failed')
  console.log(JSON.stringify({ snapshotId: snapshot.snapshotId, providerSnapshotHadWorkspace, recovery: 'provider snapshot plus service workspace archive', afterCheckpoint, restoreState, oldIdentityGone, divergence, verified: true }, null, 2))
} finally {
  await Promise.all(sandboxes.map(id => Sandbox.kill(id, connection).catch(() => false)))
  if (snapshotId) await Sandbox.deleteSnapshot(snapshotId, connection).catch(() => false)
}
