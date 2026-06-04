# RunPod Diagnostic Audit - 2026-06-04

Scope: diagnosis only. No code changes should be made during this phase.

## 2026-06-04 12:38 UTC - Start

- User reported production runs were working before the last two or three GitHub pushes and are now not running.
- Current branch: `main`
- Remote: `https://github.com/ishita7077/runpod_braindiff_test.git`
- Recent commits observed:
  - `5ad6573 Add neon rep message analyst report`
  - `7646f3d fix: show expired run state clearly`
  - `e53b450 fix: remove input size caps`
  - `6aefbca fix: start deep scope immediately`
  - `4a3b4f1 fix: prioritize result moments`

Initial live run under observation:

- Job ID: `f4df4423-1a6c-4f8e-994b-d4c59c20cb6d-u1`
- Production endpoint: `https://braindiffv2.vercel.app/api/diff/status/f4df4423-1a6c-4f8e-994b-d4c59c20cb6d-u1`
- Observed status before this audit: `queued`, `runpod_status: IN_QUEUE`, no worker output.

Next steps:

- Inspect recent commit diffs around RunPod, job queueing, status polling, and frontend submit/run behavior.
- Verify production env/config and current API imports.
- Trigger controlled production text runs and compare their status behavior.

## 2026-06-04 12:40 UTC - Commit Diff Triage

Recent commit findings:

- `5ad6573 Add neon rep message analyst report`
  - Adds rep-message analyst page/data/assets only.
  - No direct RunPod, `/api/diff/start`, or worker changes found.
- `7646f3d fix: show expired run state clearly`
  - Changes `/api/diff/status/[jobId].js` to handle RunPod 404 as an explicit expired/not-found run.
  - Adds `httpStatus` metadata to RunPod status errors.
  - This affects how status failures are displayed, not how jobs are submitted.
- `e53b450 fix: remove input size caps`
  - Removes frontend/backend/worker caps for text and media duration/size.
  - Changes worker behavior for long/uneven media.
  - Could affect media jobs, but a tiny text run should not depend on this path.
- `6aefbca fix: start deep scope immediately`
  - Frontend run page display/progress changes only.

Current uncommitted/deployed code path findings:

- API helper imports were moved from `api/lib/*` to `server/api-lib/*`.
- `/api/diff/start` imports `submitJob` from `server/api-lib/runpod.js`.
- `/api/diff/status/[jobId].js` imports `getJobStatus` from `server/api-lib/runpod.js`.
- No direct evidence yet that these import moves prevent submission/status calls.

## 2026-06-04 12:41 UTC - Controlled Text Run

Submitted a minimal production text run to avoid media/upload variables.

- Endpoint: `POST https://braindiffv2.vercel.app/api/diff/start`
- Response: HTTP 200
- Job ID: `97fd6f56-4b1a-4a85-8629-7b9810c38891-u2`
- Initial interpretation: Vercel start API can still submit to RunPod and receive a job id.

## 2026-06-04 12:42 UTC - Status Comparison

Polled both the user run and the controlled text run.

- `f4df4423-1a6c-4f8e-994b-d4c59c20cb6d-u1`
  - API status: `queued`
  - RunPod status: `IN_QUEUE`
  - Events: `[]`
  - Job metadata present: `true`
- `97fd6f56-4b1a-4a85-8629-7b9810c38891-u2`
  - API status: `queued`
  - RunPod status: `IN_QUEUE`
  - Events: `[]`
  - Job metadata present: `true`

Interpretation:

- Two separate text jobs are accepted by RunPod but are not being picked up by a worker.
- Because the controlled run is text-only and tiny, this is unlikely to be caused by media upload/download hardening or removed media caps.

## 2026-06-04 12:43 UTC - Vercel Deployment and Logs

Production deployment inspected:

- Deployment ID: `dpl_DNU8SGHLDZxNumpoqT7zMVjCuFc8`
- Status: Ready
- Created: 2026-06-04 19:08 +07
- API functions present:
  - `api/blob/upload`
  - `api/brain-mesh`
  - `api/config/public`
  - `api/diff/start`
  - `api/diff/status/[jobId]`
  - `api/telemetry/dashboard`

Vercel start logs:

- `f4df4423-1a6c-4f8e-994b-d4c59c20cb6d-u1`
  - `diff_start_received`
  - `diff_start_runpod_submitted`
  - Modality: `text`
  - Submit elapsed: `423 ms`
- `97fd6f56-4b1a-4a85-8629-7b9810c38891-u2`
  - `diff_start_received`
  - `diff_start_runpod_submitted`
  - Modality: `text`
  - Submit elapsed: `422 ms`

Interpretation:

- Vercel is not failing to submit.
- RunPod is accepting jobs.
- The failure is after submission: jobs remain in RunPod queue and no worker progress events appear.

## 2026-06-04 12:48 UTC - Worker Image / GitHub Actions Investigation

GitHub Actions workflow found:

- `.github/workflows/runpod-worker-docker.yml`
- It auto-runs on pushes to `main` when these paths change:
  - `runpod_worker/**`
  - `backend/**`
  - `atlases/**`
  - `.github/workflows/runpod-worker-docker.yml`

Relevant workflow history:

- `0f5465a ci: auto-sync prod RunPod template + remove ttl.sh dependency`
  - Removed `ttl.sh` image usage.
  - Added comments saying `ttl.sh/braindiff-<sha>:24h` self-deletes after 24h and previously caused production jobs to hang.
  - Added prod RunPod template sync logic.
- `63288e5 fix: restore RunPod production endpoint wiring`
  - Removed the prod template sync logic.
  - Reintroduced `ttl.sh/braindiff-${GITHUB_SHA::12}:24h`.
- `e53b450 fix: remove input size caps`
  - Changed `runpod_worker/worker_impl.py`, so the workflow ran again.

GitHub Actions evidence:

- Run `26558054826` for commit `e53b450` succeeded.
- It pushed:
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-latest`
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-e53b450`
  - `ttl.sh/braindiff-e53b4507bfcf:24h`
- Run `26504291852` for commit `63288e5` succeeded.
- It pushed:
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-latest`
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-63288e5`
  - `ttl.sh/braindiff-63288e54afc0:24h`

Registry checks:

- `https://ttl.sh/v2/braindiff-e53b4507bfcf/manifests/24h`
  - HTTP `404`
  - `MANIFEST_UNKNOWN`
- `https://ttl.sh/v2/braindiff-63288e54afc0/manifests/24h`
  - HTTP `404`
  - `MANIFEST_UNKNOWN`

Interpretation:

- The temporary worker images pushed by the recent successful worker builds are now expired/unpullable.
- This matches the exact failure mode described in the repo's own old workflow comments: production can accept jobs but workers cannot start, so jobs hang in queue/loading.
- This is now the strongest root-cause candidate.

## 2026-06-04 12:53 UTC - Final Poll Before Recommendation

Polled both live jobs again.

- `f4df4423-1a6c-4f8e-994b-d4c59c20cb6d-u1`
  - API status: `queued`
  - RunPod status: `IN_QUEUE`
  - Events: `[]`
- `97fd6f56-4b1a-4a85-8629-7b9810c38891-u2`
  - API status: `queued`
  - RunPod status: `IN_QUEUE`
  - Events: `[]`

Reason for not adding more jobs:

- Additional jobs would likely queue behind the same worker-start failure.
- The existing two text jobs are enough to prove this is not a single bad input and not a media-specific issue.

Current confidence:

- High confidence that Vercel submission is working.
- High confidence that RunPod is accepting jobs but no worker is processing them.
- High confidence that the worker image/template path is the likely break, especially because recent workflow history explicitly documents the `ttl.sh` 24-hour expiry failure mode and the current workflow reintroduced it.

Recommended next action for approval:

- Inspect/update the RunPod production endpoint template so it points to a permanent, pullable worker image, not an expired `ttl.sh/*:24h` image.
- Prefer restoring the prod template sync logic from `0f5465a` or manually pointing RunPod prod to a permanent RunPod registry/GHCR image that RunPod can pull.
- After the template is fixed, trigger one tiny text run and poll until it reaches worker progress (`worker_received` / `worker_started`) and then completion.

## 2026-06-04 13:02 UTC - Fix Started

User approved proceeding with the earlier `0f5465a`-style fix or the right equivalent fix.

Prior failure inspection:

- GitHub Actions run `26498055806` for `0f5465a` built and pushed the durable GHCR image.
- It failed in the "Sync prod RunPod template to latest image" step.
- Error observed:
  - Python JSON decode failed while reading RunPod GraphQL response.
- Follow-up diagnostic run `26501833412` showed the underlying reason:
  - `RUNPOD_API_KEY` GitHub secret was set but length was `1`.
  - RunPod REST returned HTTP `401` with `invalid api key`.

Patch applied locally:

- Edited `.github/workflows/runpod-worker-docker.yml`.
- Removed `ttl.sh/braindiff-${GITHUB_SHA::12}:24h` push.
- Restored production template sync after worker image build.
- Made the sync step fail loudly if:
  - `RUNPOD_API_KEY` is missing or clearly invalid.
  - RunPod GraphQL returns an error/non-JSON response.
  - the test template does not move to the current commit image.
  - the image is still a `ttl.sh` temporary image.
  - the prod template does not confirm the expected image after save.

Validation:

- YAML parse: passed.
- `git diff --check`: passed for the workflow and audit files.

Important caveat:

- If the GitHub Actions `RUNPOD_API_KEY` secret is still invalid, the next workflow run should fail clearly instead of pretending production was fixed.
- In that case the required operational fix is to replace the GitHub Actions secret with a valid RunPod API key, then rerun the workflow.

## 2026-06-04 13:03 UTC - Fix Pushed

Commit pushed:

- `d8d9f33 fix: restore durable RunPod worker image sync`

Files in commit:

- `.github/workflows/runpod-worker-docker.yml`
- `RUNPOD_DIAG_AUDIT_2026-06-04.md`

GitHub Actions run triggered:

- Run ID: `26953422239`
- URL: `https://github.com/ishita7077/runpod_braindiff_test/actions/runs/26953422239`
- Initial state: `in_progress`
- Current observed step at 13:04 UTC: `Build and push`
- Prod template sync step has not started yet.

## 2026-06-04 13:13 UTC - Workflow Result

GitHub Actions run `26953422239` completed with failure.

Step results:

- `Build and push`: success
- `Sync prod RunPod template to latest image`: failure

Image build evidence:

- The workflow produced permanent GHCR tags for commit `d8d9f33`:
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-latest`
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-d8d9f33`
- The workflow no longer pushed a `ttl.sh/*:24h` image.

Failure log:

```text
RUNPOD_API_KEY GitHub secret is missing or clearly invalid.
Set a valid RunPod API key in GitHub Actions secrets, then rerun this workflow.
Process completed with exit code 1.
```

Interpretation:

- The code/workflow fix did what it should: it prevented a false-green deploy.
- The blocker is now the GitHub Actions `RUNPOD_API_KEY` secret.
- Until that secret is replaced with a valid RunPod API key, the workflow cannot update the production RunPod template.
- Until the production template is updated, production runs are expected to remain stuck at `IN_QUEUE`.

Required operational fix:

- In GitHub repo secrets, replace `RUNPOD_API_KEY` with a valid RunPod API key that can read/write templates.
- Rerun GitHub Actions run `26953422239`, or manually run the `Runpod worker Docker image` workflow from `main`.
- After the sync step succeeds, submit a tiny text run and confirm worker progress events appear.
