# Real Pi tool-output visibility captures

Result: full requested 100×38 before/after matrix completed; compact output retained. See [comparison.md](comparison.md) for observations and limits. Optional 40×38 local read/bash/consecutive checks also completed. Each phase has 48 paired text/ANSI pane frames.

Host: `/Users/blaz/.bun/bin/pi`, version `1.2.0`. Detached tmux, real interactive fullscreen TUI; foreground preserved. No installed copies or implementation files edited by the operator.

BEFORE used a pre-edit snapshot matching Git revision `9e10b62b2ac1cd966c4f966f4dbcfafc6a20cbc7` byte-for-byte. The temporary `baseline-source/` snapshot was removed after captures; original source hashes remain in `before/source.sha256`. AFTER loaded repository `src/index.ts`. Each viewport's `manifest.json` records launch arguments and source hashes. Final AFTER captures were rerun from implementation commit `cc32b569ea4f7e44ed2803270f6758646b305427`, replacing the earlier AFTER matrix. Older AFTER observations are superseded. Both final AFTER manifests match all source files at `cc32b56` byte-for-byte. Final implementation `d1c45a3` adds exception-renderer recovery and binary-control sanitization fixes after these captures. The normal success/error matrix is unaffected; exception paths were verified by regression tests and native ANSI comparisons rather than these TUI captures. Captured `src/tool-output-visibility.ts` SHA-256 is `702c1e94c45a93253e0e93d1c6af530f1475e93a66a6a8c44cc53e7ef06bcd81`.

Reproduce from repository root, with tmux, Python 3, installed repository dependencies and Pi 1.2.0 available:

```sh
mkdir -p evidence/tool-output-visibility/baseline-source
git archive 9e10b62b2ac1cd966c4f966f4dbcfafc6a20cbc7 src | tar -x -C evidence/tool-output-visibility/baseline-source --strip-components=1
python3 evidence/tool-output-visibility/capture.py before 100
python3 evidence/tool-output-visibility/capture.py after 100
# Optional narrow checks:
python3 evidence/tool-output-visibility/capture.py before 40 local-read,local-bash,consecutive
python3 evidence/tool-output-visibility/capture.py after 40 local-read,local-bash,consecutive
# Remove temporary baseline source after use:
rm -r evidence/tool-output-visibility/baseline-source
```

Every launch unsets `PI_PACKAGE_DIR` and `FO_CODING_AGENT_DIR`, uses `--no-extensions` plus the explicit phase index and evidence fixture, and disables MCP, skills, context files, prompt templates, startup networking and session persistence. Exact commands are in manifests. No model network requests or authentication commands. A fixture provider supplies deterministic calls; actual registered tools execute through the Pi agent loop. There are no renderer overrides in the fixture. A four-second `tool_call` hook delays read I/O; bash running states use actual `sleep 6` and partial output.

Matrix: local/remote read/bash success in running collapsed/expanded and completed collapsed/expanded/recollapsed states; local/remote missing-file and exit-7 errors in completed collapsed/expanded/recollapsed states; consecutive read/read/ls/grep/find. Stable consecutive inputs use `ls src` and `find index.ts in src` (the first trial listed the changing evidence directory; final captures replace that trial).

Remote operations are read-only on existing registry session `personal-servers/yocto-builder`: `/etc/os-release`, a nonexistent path, printf/sleep, intentional nonzero exit. No registry dump, credentials, SSH target address or socket metadata captured. A credential-pattern scan of text/ANSI evidence found no matches; this is not a proof of absence.

Known harness limits: text/ANSI rather than images, full-pane viewport clipping, host timing variation. Ctrl+O also changes startup resource details and emits notifications. The baseline resource path differs from the source path; compare tool regions, not absolute rows. Initial fixture setup attempted duplicate read registration and was rejected; corrected before successful matrix runs. No remaining tooling blocker.
