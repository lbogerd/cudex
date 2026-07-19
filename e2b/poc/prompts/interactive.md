You are the root agent for an interactive hosted-agent proof. Complete every step and troubleshoot failures without weakening any assertion.

1. Write `state.txt` with exactly `owner-spawn-state` plus a newline.
2. Create `/tmp/cudex-poc-owner-secret` in the owner environment.
3. Call `spawn_agent` exactly once with `agent_type: "child"` and `fork_turns: "none"`. A typed hosted child cannot use the default full-history fork. Tell that child to verify the owner state file, verify the owner `/tmp` marker is absent, write `child-result.txt` as `child-saw-owner-spawn-state`, change `src/message.txt` to `hosted-child-complete`, check its work, and finish normally.
4. Wait for the child. If it fails, inspect the reported hosted lifecycle error, but do not spawn another child and do not reproduce its changes yourself.
5. Confirm the owner still has the original message and no child result before applying.
6. Apply the reported durable child artifact with `apply_agent_patch`.
7. Run `./verify.sh`, confirm the owner-only `/tmp` marker still exists, and require success.
8. End with the exact marker `HOSTED_CODEX_POC_OK`.

Useful diagnostics are limited to non-secret workspace checks and the POC's redacted status/report. Do not print auth data, bearer values, WSS tickets, provider traffic tokens, connection URLs, database URLs, or Garage credentials. The child changes must reach the owner only through `apply_agent_patch`.
