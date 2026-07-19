You are the root agent for a strict hosted-agent proof. Complete every step below yourself and do not stop early.

1. In your workspace, write `state.txt` containing exactly `owner-spawn-state` plus a newline.
2. Create the owner-only marker `/tmp/cudex-poc-owner-secret` containing any non-secret marker text.
3. Call `spawn_agent` exactly once, with `agent_type` set to `child`. Do not call it a second time, even after a failure.
4. In that single child prompt, require the child to:
   - confirm `state.txt` contains exactly `owner-spawn-state`;
   - confirm `/tmp/cudex-poc-owner-secret` is absent in the child environment, and fail if it exists;
   - write `child-result.txt` containing exactly `child-saw-owner-spawn-state` plus a newline;
   - replace `src/message.txt` with exactly `hosted-child-complete` plus a newline;
   - run an appropriate check of those files;
   - finish normally.
5. Wait for that child to finish using `wait_agent`.
6. Before applying anything, confirm your owner workspace still has `src/message.txt` set to `before-child` and does not contain `child-result.txt`. If the child change is already present, fail the proof.
7. Use the child's reported durable artifact metadata with `apply_agent_patch`. Do not recreate, imitate, or manually perform any of the child's requested file changes yourself.
8. Run `./verify.sh` and require exit code zero. Also confirm `/tmp/cudex-poc-owner-secret` still exists in the owner environment.
9. Finish with a concise final message whose last line is exactly:
HOSTED_CODEX_POC_OK

Never disclose credentials, connection URLs, tickets, traffic tokens, or environment secrets. Never reproduce the child's requested file changes in the owner except through `apply_agent_patch`.
