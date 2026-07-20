import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, rmdir, stat, symlink,
  writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { projectGitWorkspace } from './git-workspace.js'
import type { LocalPatchContentObject, ResolvedRootPatch } from './local-patch-source.js'
import { planPatchApplication, type PatchContentMaterial } from './patch-apply.js'
import { canonicalJson, diffWorkspaceManifests, type WorkspaceEntry,
  type WorkspaceManifest } from './workspace-manifest.js'

const exec = promisify(execFile)

export type LocalPatchApplyResult =
  | { type: 'applied'; changedFiles: number }
  | { type: 'no-change' }
  | { type: 'conflict'; paths: string[]; total: number; truncated: boolean }
  | { type: 'failed'; reason: string }
  | { type: 'manual-recovery'; reason: string; journalPath: string }

export interface LocalPatchApplyInput {
  runId: string
  selectedDirectory: string
  immutableBaseManifest: WorkspaceManifest
  patch: ResolvedRootPatch
  fault?: (action: string, path: string) => void | Promise<void>
}

type JournalAction =
  | { kind: 'backup'; path: string }
  | { kind: 'rmdir'; path: string; mode: number }
  | { kind: 'mkdir'; path: string }
  | { kind: 'install'; path: string }
  | { kind: 'chmod'; path: string; mode: number }

interface JournalRecord {
  version: 1
  runId: string
  checkout: string
  state: 'staged' | 'applying' | 'rolling-back' | 'manual-recovery'
  actions: JournalAction[]
}

function sameEntry(left: WorkspaceEntry | null, right: WorkspaceEntry | null): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function depth(path: string): number { return path.split('/').length }

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function atomicJournal(path: string, value: JournalRecord): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

function localPath(checkout: string, path: string): string {
  const absolute = resolve(checkout, ...path.split('/'))
  const child = relative(checkout, absolute)
  if (!child || child === '..' || child.startsWith(`..${sep}`)) throw new Error('patch path escaped the checkout')
  return absolute
}

async function entryAt(checkout: string, path: string): Promise<WorkspaceEntry | null> {
  const absolute = localPath(checkout, path)
  const metadata = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!metadata) return null
  const mode = metadata.mode & 0o7777
  if (metadata.isDirectory()) return { path, type: 'directory', mode }
  if (metadata.isSymbolicLink()) return { path, type: 'symlink', mode, linkTarget: await readlink(absolute) }
  if (metadata.isFile()) {
    const bytes = await readFile(absolute)
    return { path, type: 'file', mode, digest: digest(bytes), sizeBytes: bytes.byteLength }
  }
  throw new Error('patch path is an unsupported special file')
}

async function safeAncestors(checkout: string, path: string): Promise<void> {
  const segments = path.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join('/')
    const metadata = await lstat(localPath(checkout, ancestor)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) {
      throw new Error('patch path has an unsafe local ancestor')
    }
  }
}

function contentMetadata(patch: ResolvedRootPatch): PatchContentMaterial[] {
  return patch.contentObjects.map(object => ({ objectId: object.objectId,
    checksum: object.checksum, sizeBytes: object.sizeBytes }))
}

function targetMetadata(manifest: WorkspaceManifest,
  references: Array<{ path: string; objectId: string }>): PatchContentMaterial[] {
  const entries = new Map(manifest.entries.filter((entry): entry is Extract<WorkspaceEntry, { type: 'file' }> =>
    entry.type === 'file').map(entry => [entry.path, entry]))
  const result = new Map<string, PatchContentMaterial>()
  for (const reference of references) {
    const entry = entries.get(reference.path)
    if (!entry) throw new Error('local projection content is inconsistent')
    const prior = result.get(reference.objectId)
    if (prior && (prior.checksum !== entry.digest || prior.sizeBytes !== entry.sizeBytes)) {
      throw new Error('local projection object identity is inconsistent')
    }
    result.set(reference.objectId, { objectId: reference.objectId,
      checksum: entry.digest, sizeBytes: entry.sizeBytes })
  }
  return [...result.values()]
}

async function ignoredAddition(checkout: string, path: string): Promise<boolean> {
  try {
    await exec('git', ['-C', checkout, 'ls-files', '--error-unmatch', '--', path], { maxBuffer: 1024 * 1024 })
    return false
  } catch { /* An untracked proposed addition is checked against ignore policy below. */ }
  try {
    await exec('git', ['-C', checkout, 'check-ignore', '--no-index', '-q', '--', path], { maxBuffer: 1024 * 1024 })
    return true
  } catch { return false }
}

async function stageEntry(stageRoot: string, relativePath: string, entry: WorkspaceEntry,
  contentById: Map<string, LocalPatchContentObject>, contentId: string | null): Promise<void> {
  const destination = localPath(stageRoot, relativePath)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (entry.type === 'directory') {
    await mkdir(destination, { mode: entry.mode }); await chmod(destination, entry.mode)
  } else if (entry.type === 'symlink') {
    await symlink(entry.linkTarget, destination)
  } else {
    const content = contentId ? contentById.get(contentId) : undefined
    if (!content || content.checksum !== entry.digest || content.sizeBytes !== entry.sizeBytes
      || digest(content.bytes) !== entry.digest || content.bytes.byteLength !== entry.sizeBytes) {
      throw new Error('proposed patch content is unavailable')
    }
    await writeFile(destination, content.bytes, { flag: 'wx', mode: entry.mode }); await chmod(destination, entry.mode)
  }
  const staged = await entryAt(stageRoot, relativePath)
  if (!sameEntry(staged, { ...entry, path: relativePath } as WorkspaceEntry)) {
    throw new Error('staged patch entry failed verification')
  }
}

async function rollback(checkout: string, journalRoot: string, record: JournalRecord,
  original: Map<string, WorkspaceEntry>, proposed: Map<string, WorkspaceEntry>): Promise<boolean> {
  record.state = 'rolling-back'
  await atomicJournal(join(journalRoot, 'journal.json'), record).catch(() => undefined)
  try {
    const lastAction = new Map<string, JournalAction>()
    for (const action of record.actions) lastAction.set(action.path, action)
    for (const [path, action] of lastAction) {
      const expected = ['install', 'mkdir', 'chmod'].includes(action.kind)
        ? proposed.get(path) ?? null : null
      if (!sameEntry(await entryAt(checkout, path), expected)) return false
    }
    const discard = join(journalRoot, 'rollback-discard')
    await mkdir(discard, { recursive: true, mode: 0o700 })
    for (const action of [...record.actions].reverse()) {
      const target = localPath(checkout, action.path)
      if (action.kind === 'install') {
        const destination = localPath(discard, action.path)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await rename(target, destination)
      } else if (action.kind === 'mkdir') {
        await rmdir(target)
      } else if (action.kind === 'chmod') {
        await chmod(target, action.mode)
      } else if (action.kind === 'rmdir') {
        await mkdir(target, { mode: action.mode }); await chmod(target, action.mode)
      } else {
        const backup = localPath(join(journalRoot, 'backup'), action.path)
        await mkdir(dirname(target), { recursive: true })
        await rename(backup, target)
      }
    }
    for (const path of lastAction.keys()) {
      if (!sameEntry(await entryAt(checkout, path), original.get(path) ?? null)) return false
    }
    return true
  } catch { return false }
}

/** Applies one exact root result without touching Git metadata or unrelated paths. */
export async function applyLocalRootPatch(input: LocalPatchApplyInput): Promise<LocalPatchApplyResult> {
  if (!/^\d{14}-[0-9a-f]{12}$/u.test(input.runId)) {
    return { type: 'failed', reason: 'local patch run identity is invalid' }
  }
  const checkout = resolve(input.selectedDirectory)
  const target = await projectGitWorkspace(checkout)
  const artifact = input.patch.serialized.artifact
  if (canonicalJson(artifact.baseManifest.entries)
    !== canonicalJson(input.immutableBaseManifest.entries)) {
    return { type: 'failed', reason: 'hosted patch base does not match the uploaded local base' }
  }
  const plan = planPatchApplication({ artifact: input.patch.serialized,
    targetManifest: target.captured.manifest, resultSnapshotId: `cudex-local-${input.runId}`,
    targetContentObjects: targetMetadata(target.captured.manifest, target.captured.contentObjects),
    artifactContentObjects: contentMetadata(input.patch) })
  if (plan.type === 'conflict') return { type: 'conflict', paths: plan.paths,
    total: plan.total, truncated: plan.truncated }
  if (plan.type === 'rejected') return { type: 'failed', reason: plan.reason }
  const changes = diffWorkspaceManifests(artifact.baseManifest, artifact.currentManifest)
  if (changes.length === 0) return { type: 'no-change' }

  const prefix = `roots/0/${basename(checkout)}`
  const changed = changes.map(change => {
    if (!change.path.startsWith(`${prefix}/`)) throw new Error('hosted patch changed workspace scaffolding')
    const path = change.path.slice(prefix.length + 1)
    if (!path || path.split('/').includes('.git')) throw new Error('hosted patch targeted Git metadata')
    return { path, base: change.base, proposed: change.current,
      contentId: input.patch.serialized.artifact.changes.find(item => item.path === change.path)?.contentObjectId ?? null }
  })
  for (const change of changed) {
    await safeAncestors(checkout, change.path)
    if (change.base === null && change.proposed !== null && await ignoredAddition(checkout, change.path)) {
      return { type: 'failed', reason: 'hosted patch contains an ignored local addition' }
    }
  }

  const targetByPath = new Map(target.captured.manifest.entries
    .filter(entry => entry.path.startsWith(`${prefix}/`))
    .map(entry => [entry.path.slice(prefix.length + 1), { ...entry,
      path: entry.path.slice(prefix.length + 1) } as WorkspaceEntry]))
  const proposedByPath = new Map(artifact.currentManifest.entries
    .filter(entry => entry.path.startsWith(`${prefix}/`))
    .map(entry => [entry.path.slice(prefix.length + 1), { ...entry,
      path: entry.path.slice(prefix.length + 1) } as WorkspaceEntry]))
  const mutations = changed.filter(change => !sameEntry(targetByPath.get(change.path) ?? null, change.proposed))
  if (mutations.length === 0) return { type: 'no-change' }

  // TODO(internal-release, PILOT-012): The pilot uses an owner-only same-filesystem rollback journal
  // because portable multi-path filesystem transactions do not exist. Evaluate atomic worktree swaps
  // and formal crash recovery guarantees before an internal release.
  const journalRoot = join(dirname(checkout), `.${basename(checkout)}.cudex-journal-${input.runId}`)
  if (await lstat(journalRoot).catch(() => undefined)) {
    return { type: 'manual-recovery', reason: 'an apply recovery journal already exists', journalPath: journalRoot }
  }
  await mkdir(journalRoot, { mode: 0o700 })
  const [checkoutDevice, journalDevice] = await Promise.all([stat(checkout), stat(journalRoot)])
  if (checkoutDevice.dev !== journalDevice.dev) {
    await rm(journalRoot, { recursive: true, force: true })
    return { type: 'failed', reason: 'apply journal is not on the checkout filesystem' }
  }
  const stageRoot = join(journalRoot, 'stage'); const backupRoot = join(journalRoot, 'backup')
  await Promise.all([mkdir(stageRoot, { mode: 0o700 }), mkdir(backupRoot, { mode: 0o700 })])
  const record: JournalRecord = { version: 1, runId: input.runId, checkout, state: 'staged', actions: [] }
  try {
    const contents = new Map(input.patch.contentObjects.map(object => [object.objectId, object]))
    for (const change of mutations) if (change.proposed) {
      await stageEntry(stageRoot, change.path, { ...change.proposed, path: change.path } as WorkspaceEntry,
        contents, change.contentId)
    }
    await atomicJournal(join(journalRoot, 'journal.json'), record)
    const revalidated = await projectGitWorkspace(checkout)
    if (canonicalJson(revalidated.captured.manifest.entries)
      !== canonicalJson(target.captured.manifest.entries)) throw new Error('local workspace changed while staging the patch')
    record.state = 'applying'; await atomicJournal(join(journalRoot, 'journal.json'), record)

    const remove = mutations.filter(change => {
      const current = targetByPath.get(change.path)
      return current && (change.proposed === null || current.type !== change.proposed.type
        || current.type !== 'directory')
    }).sort((left, right) => depth(right.path) - depth(left.path) || right.path.localeCompare(left.path))
    for (const change of remove) {
      const current = targetByPath.get(change.path)!
      if (!sameEntry(await entryAt(checkout, change.path), { ...current, path: change.path } as WorkspaceEntry)) {
        throw new Error('local path changed immediately before patch application')
      }
      if (current.type === 'directory') {
        await rmdir(localPath(checkout, change.path))
        record.actions.push({ kind: 'rmdir', path: change.path, mode: current.mode })
      } else {
        const backup = localPath(backupRoot, change.path); await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
        await rename(localPath(checkout, change.path), backup)
        record.actions.push({ kind: 'backup', path: change.path })
      }
      await input.fault?.('remove', change.path); await atomicJournal(join(journalRoot, 'journal.json'), record)
    }

    const construct = mutations.filter(change => change.proposed !== null)
      .sort((left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path))
    for (const change of construct) {
      const proposed = change.proposed!
      const current = targetByPath.get(change.path)
      if (proposed.type === 'directory' && current?.type === 'directory') {
        if (current.mode === proposed.mode) continue
        if (!sameEntry(await entryAt(checkout, change.path), { ...current, path: change.path } as WorkspaceEntry)) {
          throw new Error('local directory changed immediately before mode application')
        }
        await chmod(localPath(checkout, change.path), proposed.mode)
        record.actions.push({ kind: 'chmod', path: change.path, mode: current.mode })
      } else if (proposed.type === 'directory') {
        if (await entryAt(checkout, change.path) !== null) throw new Error('local path appeared during patch application')
        await mkdir(localPath(checkout, change.path), { mode: proposed.mode }); await chmod(localPath(checkout, change.path), proposed.mode)
        record.actions.push({ kind: 'mkdir', path: change.path })
      } else {
        if (await entryAt(checkout, change.path) !== null) throw new Error('local path appeared during patch application')
        await mkdir(dirname(localPath(checkout, change.path)), { recursive: true })
        await rename(localPath(stageRoot, change.path), localPath(checkout, change.path))
        record.actions.push({ kind: 'install', path: change.path })
      }
      await input.fault?.('construct', change.path); await atomicJournal(join(journalRoot, 'journal.json'), record)
    }
    const applied = await projectGitWorkspace(checkout)
    if (canonicalJson(applied.captured.manifest.entries) !== canonicalJson(plan.manifest.entries)) {
      throw new Error('applied checkout does not match the planned result')
    }
    await rm(journalRoot, { recursive: true, force: true })
    return { type: 'applied', changedFiles: changes.length }
  } catch (error) {
    const restored = await rollback(checkout, journalRoot, record, targetByPath, proposedByPath)
    if (restored) {
      await rm(journalRoot, { recursive: true, force: true })
      return { type: 'failed', reason: error instanceof Error ? error.message : 'local patch application failed' }
    }
    record.state = 'manual-recovery'; await atomicJournal(join(journalRoot, 'journal.json'), record).catch(() => undefined)
    return { type: 'manual-recovery', reason: 'local rollback could not be proven complete', journalPath: journalRoot }
  }
}
