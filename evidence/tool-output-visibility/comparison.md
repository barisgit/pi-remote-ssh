# Observed before/after result

DONE: full requested 100×38 AFTER matrix rerun using real interactive Pi 1.2.0 in detached tmux, loaded source `cc32b56`. These files replace earlier AFTER captures and supersede the earlier observation report. No regression found in the final exercised normal/error matrix. This is inspection evidence, not full extension acceptance or exceptional-renderer recovery verification.

## Checks

- Across all 35 paired 100-column frames, extracted tool-region text matches BEFORE after ignoring host notifications/warnings and normalizing elapsed times; trailing pane padding is excluded. No remaining observed tool-layout delta in this matrix.
- Local and live remote read: running `● Read`, successful compact `○ Read … [ctrl+o expand]`, expanded payload, recollapsed payload hidden. Expanded local payload removes the fixture's hidden DCP tag and retains the reminder text. Corresponding payload ANSI styling matched in inspected lines.
- Local and live remote bash: genuine running command/elapsed state; completed output, Ctrl+O expansion and recollapse. Local 40-line result collapses to the final five lines with the earlier-lines hint; expanded output shows the viewport's longer tail. Remote result remains readable. Exit-7 errors show output and exit code.
- Local/remote missing-file read errors remain visible in collapsed, expanded and recollapsed states. Final AFTER recollapse preserves error text and the same blank-line spacing as BEFORE. The earlier reported missing blank line is no longer present.
- Consecutive read/read/ls/grep/find: all five compact summaries visible, with one empty line between rows. Stable `ls src` and `find index.ts in src` reruns replaced the original evidence-directory listing. At 100 columns, extracted tool text from the first compact header through completion is byte-identical BEFORE/AFTER in collapsed, expanded and recollapsed frames (excluding only host `Tool output:` notifications and trailing empty rows). Expanded full-pane capture clips the first two reads above the viewport; visible ls/grep/find content is identical. Standalone expanded read is separately captured.
- Optional 40×38 local read/bash/consecutive: no observed compact/expand/recollapse regression. All five consecutive compact headers fit; paths wrap or truncate normally. Already completed before the final prioritization request; no further narrow runs needed.

## Evidence

`before/100x38/` and `after/100x38/` each contain 35 `.txt` frames plus paired `.ansi` files and a launch/source-hash manifest. `before/40x38/` and `after/40x38/` each contain 13 paired frames. Example names:

- `local-read-running-collapsed.txt`, `local-read-running-expanded.txt`
- `remote-read-collapsed.txt`, `remote-read-expanded.txt`, `remote-read-recollapsed.txt`
- `local-read-error-recollapsed.txt`, `remote-read-error-recollapsed.txt`
- `local-bash-running-collapsed.txt`, `local-bash-expanded.txt`
- `remote-bash-error-collapsed.txt`
- `consecutive-collapsed.txt`, `consecutive-expanded.txt`, `consecutive-recollapsed.txt`

Successful final commands (repository root):

```sh
python3 evidence/tool-output-visibility/capture.py after 100
python3 evidence/tool-output-visibility/capture.py after 40 local-read,local-bash,consecutive
```

Earlier successful baseline commands: `python3 evidence/tool-output-visibility/capture.py before 100` and `python3 evidence/tool-output-visibility/capture.py before 100 consecutive`; the stable consecutive baseline rerun is retained.

All nine 100-column scenarios completed in both phases; the final AFTER rerun completed all nine again with no stderr. Optional final narrow rerun completed three scenarios. Stable consecutive inputs remain in all final captures. No implementation/installed-copy edits, commits or pushes by the operator. Temporary baseline source removed; README documents git-archive recreation.

## Interpretation and limits

- Read delay is BEFORE file I/O but AFTER native host execution-start: Pi 1.2.0's agent loop emits `tool_execution_start` before `beforeToolCall`; interactive mode calls `markExecutionStarted()` there. Observed `● Read` agrees. This checks host-started/pre-I/O presentation, not read streaming/slow filesystem transfer. Bash captures exercise actual running execution.
- Startup extension paths differ (`baseline-source` versus `src`), startup warning timing can differ, spinner frames differ, and SSH elapsed times vary. These are not output-layout regressions.
- Full panes are 38 rows. Long expanded results scroll above the viewport; these are rendered viewport captures, not complete tool-output transcripts or image screenshots.
- No aborted calls, image payloads, deliberately throwing/recovering renderers, generic renderer-failure fallback, or fully unregistered tools exercised. No claim about those paths follows from this normal/error matrix. Unit tests/typecheck were not independently rerun by the operator.
- Both final AFTER manifests match every source file at `cc32b569ea4f7e44ed2803270f6758646b305427` byte-for-byte. Captured visibility-file SHA-256: `702c1e94c45a93253e0e93d1c6af530f1475e93a66a6a8c44cc53e7ef06bcd81`. Final implementation is `d1c45a3`; only `src/tool-output-visibility.ts` differs from captured source hashes. Later fixes filter exception-fallback Text out of renderer lastComponent during recovery and strip binary controls from exception-fallback text, matching native Pi. These exception-only changes do not affect the normal success/error matrix. They were verified by regression tests and native ANSI comparisons, not this TUI matrix. Final owner checks: `bun test` (99 passed, 0 failed, 393 assertions), `bun run typecheck` and `git diff --check` passed. No lint script exists in the repository.

Blocker / next: None for assigned runtime captures. Evidence is ready for the owner's integration/evidence commit/push; those actions were not requested of the operator.
