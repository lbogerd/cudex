export type HostedWorkspaceMode = 'default' | 'git-working-set'

function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function syntheticGitInitializationScript(workspace: string, owner: string): string {
  return `set -eu
workspace=${shell(workspace)}
roots="$workspace/roots"
set -- "$roots/0"/*
test "$#" -eq 1
project="$1"
test -d "$project"
git_dir="$workspace/.cudex-git"
test ! -e "$git_dir"
git init --quiet --separate-git-dir="$git_dir" "$project"
git -C "$project" config user.name "Cudex Synthetic Baseline"
git -C "$project" config user.email "cudex-baseline@invalid"
git -C "$project" add -A -f
GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" \
  git -C "$project" commit --quiet --allow-empty -m "Cudex synthetic baseline"
chown -hR ${owner} "$git_dir" "$project/.git"
test "$(git -C "$project" rev-list --count HEAD)" -eq 1
git -C "$project" status --porcelain=v1 >/dev/null`
}

export function projectedGitExportScript(workspace: string, archive: string, stage: string,
  maxArchiveBytes: number): string {
  return `set -eu
umask 077
workspace=${shell(workspace)}
archive=${shell(archive)}
stage=${shell(stage)}
set -- "$workspace/roots/0"/*
test "$#" -eq 1
project="$1"
test -f "$project/.git"
test "$(git -C "$project" rev-list --count HEAD)" -ge 1
if git -C "$project" ls-files --stage | grep -q '^160000 '; then exit 1; fi
if find "$project" -mindepth 2 -name .git -print -quit | grep -q .; then exit 1; fi
rm -rf -- "$stage"
mkdir -p -- "$stage/roots/0/$(basename -- "$project")"
destination="$stage/roots/0/$(basename -- "$project")"
git -C "$project" ls-files --cached --others --exclude-standard -z -- | while IFS= read -r -d '' item; do
  source="$project/$item"
  if [ -e "$source" ] || [ -L "$source" ]; then
    mkdir -p -- "$destination/$(dirname -- "$item")"
    cp -a -- "$source" "$destination/$item"
  fi
done
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=pax \
  --pax-option=delete=atime,delete=ctime \
  -cf "$archive" -C "$stage" roots
size=$(stat -c %s -- "$archive")
test "$size" -le ${maxArchiveBytes}`
}
