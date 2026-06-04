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

## 2026-06-04 13:20 UTC - Clarification After User Challenge

User challenged the conclusion that the RunPod API key was the issue, noting they did not revoke the onboarding API key.

Clarification:

- The invalid key evidence is specifically for the **GitHub Actions secret** named `RUNPOD_API_KEY`.
- It is separate from the Vercel production `RUNPOD_API_KEY`.
- Vercel production can still have a valid RunPod key and successfully submit jobs while GitHub Actions has an invalid/mis-set key and cannot update the RunPod production template.

Additional evidence:

- `gh secret list` shows repository secret `RUNPOD_API_KEY` exists.
- It was last updated at `2026-05-27T07:45:28Z`.
- The failed `0f5465a` workflow began immediately after that, at `2026-05-27T07:45:57Z`.
- Diagnostic run `26501833412` later showed the GitHub Actions secret was set but length `1`, and RunPod returned `401 invalid api key`.
- Current run `26953422239` failed at the explicit length guard before RunPod GraphQL was called.

Revised confidence statement:

- Proven: Vercel production can submit jobs to RunPod.
- Proven: GitHub Actions currently cannot sync the RunPod production template because its `RUNPOD_API_KEY` secret is not a valid key.
- Proven: both observed text jobs remain `IN_QUEUE` with no worker events.
- Strong but not directly proven without RunPod console/API template access: production is likely pointed at an unavailable/stale worker image or otherwise has no usable workers.
- The GitHub secret issue explains why the automated durable-image fix cannot complete; it may not be the original root cause by itself.

## 2026-06-04 13:30 UTC - New RunPod Worker Log Evidence

User provided a RunPod worker-log screenshot.

Key log lines from screenshot:

```text
2026-06-04T13:16:48.452Z [info] --- Starting Serverless Worker | Version 1.9.0 ---
2026-06-04T13:16:48.452Z [info] Running 7 fitness check(s)...
2026-06-04T13:16:48.452Z [info] GPU binary test passed: 1 GPU(s) healthy (CUDA 13.0)
2026-06-04T13:16:48.452Z [info] CUDA version check passed: 13.0 (minimum: 11.8)
2026-06-04T13:16:48.452Z [info] The current PyTorch install supports CUDA capabilities sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90.
2026-06-04T13:16:48.452Z [info] NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb with CUDA capability sm_120 is not compatible with the current PyTorch installation.
2026-06-04T13:16:48.452Z [error] Fitness check failed: _cuda_init_check | RuntimeError: CUDA initialization failed
2026-06-04T13:16:48.452Z [error] Worker is unhealthy, exiting.
2026-06-04T13:17:06.800Z [error] worker exited with exit code 1
```

Interpretation update:

- RunPod is now starting a worker.
- The worker is dying before it reaches BrainDiff application code.
- The failure is RunPod/PyTorch/CUDA compatibility: the image's PyTorch build does not support the assigned Blackwell `sm_120` GPU.
- This is a stronger direct cause than the earlier queue-only hypothesis.

Worker image/dependency timeline:

- `82dd3b8` (`2026-04-28T22:04:19+07:00`) added the production RunPod Docker install path for `backend/requirements_frozen.txt`.
- `backend/requirements_frozen.txt` pins:
  - `torch==2.6.0`
  - `torchvision==0.21.0`
- That pin is still present at:
  - `0f5465a`
  - `63288e5`
  - `e53b450`
  - `d8d9f33`
- So the incompatible PyTorch stack was not introduced by today's visual-site work; it was latent in the worker image.

Current worker-build timeline:

- `d8d9f33 fix: restore durable RunPod worker image sync` was pushed at `2026-06-04T20:02:30+07:00`.
- GitHub Actions run `26953422239` built the worker image from `d8d9f33`.
- The action pushed:
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-latest`
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-d8d9f33`
  - digest `sha256:1ec89b34c82ff4dad56924165d46be1f9d07b6c729c13a4b7f69c1110f2a0ec6`
- The image push completed at `2026-06-04T13:12:57Z`.
- RunPod worker logs show the Blackwell/PyTorch failure at `2026-06-04T13:16:48Z`.

Forensic conclusion:

- The specific failure shown in the screenshot started immediately after the `d8d9f33` worker image build/push, when RunPod launched a worker on an RTX PRO 6000 Blackwell GPU.
- The deeper code/config problem is older: the worker image pins `torch==2.6.0`, which does not support `sm_120`.
- If production was working before, the likely reason is that the old worker was running on a GPU architecture supported by PyTorch 2.6, or it had not been restarted onto Blackwell yet.
- The GitHub push that most directly preceded the screenshot failure is `d8d9f33`.
- The GitHub push that reintroduced the earlier temporary-image/template-sync risk is `63288e5`.
- The GitHub push where the latent PyTorch 2.6 worker dependency entered the Docker image path is `82dd3b8`.

## 2026-06-04 13:45 UTC - Prior Blackwell/Worker-Boot Fix Check

Question checked: whether this is the same issue previously fixed and whether the same patch should be reapplied.

Prior worker-start fixes found in git history:

- `c30f524` (`2026-05-21T18:39:17+07:00`) - isolated fast boot worker entrypoint.
- `90d2b5f` (`2026-05-21T19:01:22+07:00`) - lazy TRIBE warmup; register worker before model download.
- `a348484` (`2026-05-22T13:37:12+07:00`) - bootstrap RunPod worker before heavy imports.
- `8e83059` (`2026-05-22T15:19:09+07:00`) - RP-NN checkpoint logs.

Current status of those patches:

- They are still present in `runpod_worker/handler.py` and `runpod_worker/worker_impl.py`.
- The current handler still imports only stdlib + RunPod SDK before registering the worker.
- Heavy BrainDiff imports still happen after the worker receives its first job.
- Therefore, this is not a missing-reapply of the old bootstrap patch.

Difference in the new failure:

- The new screenshot failure is inside RunPod's own serverless fitness check before BrainDiff reaches its job handler.
- The log names the incompatible GPU directly: `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb` (`sm_120`).
- The image still pins `torch==2.6.0`, and the log confirms that install supports only up to `sm_90`.

Most likely previous operational resolution:

- The worker was run on GPUs documented for this project as `A40 / RTX A5000`, not Blackwell.
- That is a RunPod endpoint/template GPU-selection fix, not a code diff in this repo.

Conclusion:

- Same family of problem: worker cannot get past GPU/runtime startup.
- Not the same code patch: the old fast-boot/bootstrap patch is already in place.
- Equivalent immediate fix is to move the RunPod endpoint back to a non-Blackwell GPU supported by the current PyTorch image, or rebuild the image with a PyTorch/CUDA stack that supports Blackwell `sm_120`.

## 2026-06-04 14:00 UTC - Full RunPod Log File Review and Image Fix

Input reviewed:

- `/Users/ishita/Downloads/logs-runpod_braindiff_test (1).txt`
- 998 log lines.

Key finding from the full log:

- The same worker image successfully ran at `2026-06-04 16:09` local log time on `NVIDIA RTX A5000`.
- That worker reached:
  - `[RP-10] gpu_detect: cuda=True device=NVIDIA RTX A5000`
  - `[RP-13] tribe_loaded_on_gpu_ok`
  - `[RP-16] job_validated`
  - `[RP-21] predictions_packaged`
- Later workers repeatedly landed on `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb` and failed the RunPod SDK fitness check before any job was handled.
- Repeated failure line:
  - `The current PyTorch install supports CUDA capabilities sm_50 sm_60 sm_70 sm_75 sm_80 sm_86 sm_90.`
  - `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb with CUDA capability sm_120 is not compatible with the current PyTorch installation.`

Operational constraint:

- Local `.env*` files do not contain a valid `RUNPOD_API_KEY` / `RUNPOD_ENDPOINT_ID`.
- GitHub Actions repository secret `RUNPOD_API_KEY` was previously proven invalid for template sync.
- Therefore I cannot directly change the RunPod endpoint GPU selection/template from this machine.

Code/deploy fix applied:

- Edited `runpod_worker/Dockerfile`.
- After the frozen requirements + TRIBE install, force reinstall:
  - `torch==2.7.0+cu128`
  - `torchvision==0.22.0+cu128`
  - `torchaudio==2.7.0+cu128`
  - from `https://download.pytorch.org/whl/cu128`
- Added a build-time assertion that fails the image build unless:
  - `torch.__version__` starts with `2.7.0`
  - `torch.version.cuda == "12.8"`

Reason:

- PyTorch 2.7 CUDA 12.8 wheels are the smallest image-level move from the existing PyTorch 2.6 stack toward Blackwell compatibility.
- If this starts successfully on Blackwell but TRIBE has a runtime incompatibility with torch 2.7, the worker should now reach BrainDiff logs instead of dying inside RunPod's pre-job fitness check.

## 2026-06-04 14:15 UTC - Worker Image Build Log Result

GitHub Actions run:

- `26956301716`
- Commit: `103e512 fix: install Blackwell-ready PyTorch worker wheel`
- Log captured locally at `/tmp/runpod-worker-26956301716.log`

Build result from log:

- Docker `Build and push` step succeeded.
- PyTorch reinstall step ran and passed the explicit build-time assertion:
  - `PyTorch Blackwell-ready wheel: 2.7.0+cu128 CUDA 12.8`
- Image pushed:
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-latest`
  - `ghcr.io/ishita7077/runpod_braindiff_test:runpod-103e512`
  - digest `sha256:b6ae610c1f2da9aa2ec645bcd52b5736935f61efb2a2b0957fa24d49980b3d11`

Dependency warnings from build log:

- `tribev2 0.1.0 requires torch<2.7,>=2.5.1`
- `tribev2 0.1.0 requires torchvision<0.22,>=0.20`
- `whisperx 3.8.6 requires torch~=2.8.0`
- `whisperx 3.8.6 requires torchaudio~=2.8.0`
- `whisperx 3.8.6 requires torchvision~=0.23.0`
- `pyannote-audio 4.0.4 requires torch>=2.8.0`
- `pyannote-audio 4.0.4 requires torchaudio>=2.8.0`

Interpretation:

- The image now exists in GHCR with a PyTorch CUDA 12.8 wheel.
- This has not yet proven runtime success on RunPod.
- The next required evidence is a fresh RunPod worker log after this image is used.
- If the next log still shows `sm_50 ... sm_90`, RunPod is still using the old image.
- If the next log passes fitness but fails later at `[RP-10]` or `[RP-11]`, the problem has moved from RunPod fitness check to BrainDiff/Tribe runtime compatibility.

Deploy blocker from log:

- Workflow failed at `Sync prod RunPod template to latest image`.
- Exact log line:
  - `RUNPOD_API_KEY GitHub secret is missing or clearly invalid.`
- Therefore the image was built and pushed, but the workflow could not confirm/update the RunPod production template.
