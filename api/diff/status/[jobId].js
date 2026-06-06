const { methodNotAllowed, badRequest, serverError, noStore } = require("../../lib/http");
const { getJobStatus } = require("../../lib/runpod");
const { redis } = require("../../lib/security");
const { maybeDeleteBlobsForJob, getJobMetadata } = require("../../lib/jobs");
const { handleRepMessageAnalystReport } = require("../../../server/rep-message-report-agent");

function filenameFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
  } catch (_) {
    return "";
  }
}

// Codex's `media_name_a/b` job-meta merge — preserved verbatim so the result
// page always sees the upload filename even if the worker's own meta omits it.
function resultWithJobMetadata(result, jobMeta) {
  if (!result || typeof result !== "object" || !jobMeta) return result;
  const merged = { ...result };
  const meta = { ...(result.meta || {}) };
  const modality = jobMeta.modality || (jobMeta.type === "media" ? "media" : "");
  const runType = jobMeta.runType || meta.run_type || result.run_type || "";
  if (modality && !meta.modality) meta.modality = modality;
  if (runType && !meta.run_type) meta.run_type = runType;
  if (runType === "single") {
    if (!meta.media_name) meta.media_name = jobMeta.mediaName || filenameFromUrl(jobMeta.blobUrl);
    if (!meta.display_name) meta.display_name = jobMeta.displayName || meta.media_name || "";
    if (meta.media_duration_s == null && jobMeta.mediaDuration != null) {
      meta.media_duration_s = jobMeta.mediaDuration;
    }
  }
  if (!meta.media_name_a) meta.media_name_a = jobMeta.mediaNameA || filenameFromUrl(jobMeta.blobUrlA);
  if (!meta.media_name_b) meta.media_name_b = jobMeta.mediaNameB || filenameFromUrl(jobMeta.blobUrlB);
  merged.meta = meta;
  return merged;
}

// Real progress events: the RunPod worker pushes JSON-encoded `(ts, status,
// message)` objects to `events:{jobId}` via Upstash Redis. We read the full
// list on each poll and surface it to the frontend, which is responsible for
// dedupe (it already keys log lines by ts+message). No synthesised events.
async function readProgressEvents(jobId) {
  try {
    const store = redis();
    const raw = await store.lrange(`events:${jobId}`, 0, -1);
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = [];
    for (const item of raw) {
      // Upstash REST may return parsed objects (when value-as-JSON is detected)
      // or raw strings. Handle both shapes without throwing on malformed entries.
      if (item && typeof item === "object") {
        out.push(item);
        continue;
      }
      if (typeof item === "string") {
        try {
          out.push(JSON.parse(item));
        } catch (_) {
          // Drop unparseable entries silently — better than blowing up the poll.
        }
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function explainFailure(code, message, rawStatus) {
  const normalizedCode = String(code || "RUNPOD_JOB_FAILED");
  const raw = String(rawStatus || "");
  const msg = String(message || "");
  const text = `${normalizedCode} ${raw} ${msg}`.toLowerCase();
  let reason = "RunPod reported that the job failed, but did not return a specific MindReader error.";
  let action = "Open the RunPod job logs for the exact stack trace. If the worker returns that error, MindReader will show it here.";
  if (text.includes("timeout") || text.includes("timed_out")) {
    reason = "The job took too long and was stopped.";
    action = "Try shorter files/text, then check whether the RunPod worker has enough GPU time for media jobs.";
  } else if (text.includes("media_duration_mismatch") || (text.includes("durations differ") && text.includes("within 5s"))) {
    reason = "The worker rejected a media length mismatch from an older run path.";
    action = "Retry from the current launch page. MindReader now compares full media by default, with optional trimming if you choose it.";
  } else if ((text.includes("cuda") && text.includes("memory")) || text.includes("out of memory") || text.includes("oom")) {
    reason = "The worker ran out of GPU memory.";
    action = "Use shorter media or a worker with more available GPU memory, then retry.";
  } else if (text.includes("hf_auth") || text.includes("hugging face") || text.includes("401") || text.includes("403")) {
    reason = "The worker could not access a required model.";
    action = "Check the Hugging Face token on the RunPod worker and confirm it has access to the gated model.";
  } else if (text.includes("ffmpeg")) {
    reason = "The worker could not read or convert the uploaded media.";
    action = "Verify ffmpeg exists in the worker image and retry with a standard mp3/wav/mp4 file.";
  } else if (text.includes("whisperx") || text.includes("transcrib")) {
    reason = "Audio transcription/alignment failed.";
    action = "Try clearer or shorter audio, and check WhisperX device/compute settings on the worker.";
  } else if (text.includes("blob") || text.includes("media_url") || text.includes("download") || text.includes("fetch")) {
    reason = "The worker could not download one of the uploaded files.";
    action = "Check the Vercel Blob token, file URL expiry, and whether both uploads are reachable from RunPod.";
  } else if (text.includes("duration") || text.includes("input_rejected")) {
    reason = "The two inputs were rejected before analysis.";
    action = "Check the exact worker error. The app no longer blocks long or uneven inputs before analysis.";
  } else if (text.includes("atlas")) {
    reason = "The worker is missing required brain atlas files.";
    action = "Verify the atlas files exist in the worker image under the configured atlas directory.";
  }
  return {
    code: normalizedCode,
    reason,
    action,
    raw_status: raw,
    raw_message: msg
  };
}

function mapRunpodStatus(data, jobId, jobMeta, events) {
  const raw = String(data.status || "").toUpperCase();

  if (raw === "COMPLETED") {
    const output = data.output || {};
    if (output && (output.error_type || output.error_traceback || output.error_message)) {
      const message = output.error_message || output.error || "RunPod worker returned an error payload.";
      const code = output.error_code || output.code || output.error_type || "RUNPOD_WORKER_ERROR";
      return {
        status: "error",
        events,
        error: {
          code,
          message,
          plain: explainFailure(code, message, raw),
          runpod_status: raw,
          worker_error: {
            type: output.error_type || null,
            stage: output.stage || null,
            traceback: output.error_traceback || null
          }
        }
      };
    }
    // Worker can return a clean spend-cap error inside the output payload —
    // surface as a structured error instead of "done" so the frontend can
    // render the daily-limit banner.
    if (output && output.error === "spend_cap_reached") {
      const cap = output.spend_cap || {};
      return {
        status: "error",
        events,
        error: {
          code: "SPEND_CAP_REACHED",
          message: `MindReader has reached its daily processing budget ($${(cap.cap_usd || 0).toFixed(2)} for ${cap.day || "today"}). Please try again tomorrow.`,
          plain: {
            code: "SPEND_CAP_REACHED",
            reason: "MindReader has reached its daily processing budget.",
            action: "Please try again tomorrow when the budget resets at midnight UTC.",
            spent_usd: cap.spent_usd,
            cap_usd: cap.cap_usd,
            day: cap.day
          }
        }
      };
    }
    return {
      status: "done",
      job_id: jobId,
      events,
      result: resultWithJobMetadata(output || data, jobMeta)
    };
  }

  if (raw === "FAILED" || raw === "CANCELLED" || raw === "TIMED_OUT") {
    const message =
      data.error ||
      (data.output && (data.output.error_message || data.output.error)) ||
      `Runpod status: ${raw}`;
    const code =
      (data.output && (data.output.error_code || data.output.code)) ||
      (raw === "TIMED_OUT" ? "DIFF_TIMEOUT" : "RUNPOD_JOB_FAILED");
    return {
      status: "error",
      events,
      error: {
        code,
        message,
        plain: explainFailure(code, message, raw),
        runpod_status: raw
      }
    };
  }

  // While the worker is in flight, derive the canonical status from the most
  // recent event the worker actually emitted. If the queue hasn't picked up
  // the job yet (no events at all), report "queued"; if RunPod says
  // IN_PROGRESS but we have no events, the worker is booting — report
  // "worker_booting" rather than pretending Step 1 is running.
  const last = events.length ? events[events.length - 1] : null;
  let status = last && typeof last.status === "string" ? last.status : null;
  if (!status) {
    status = raw === "IN_PROGRESS" ? "worker_booting" : "queued";
  }
  return {
    status,
    events,
    runpod_status: raw,
    diagnostics: {
      event_count: events.length,
      has_job_metadata: !!jobMeta,
      runpod_output_present: !!data.output,
      runpod_delay_time: data.delayTime || data.delay_time || null,
      runpod_execution_time: data.executionTime || data.execution_time || null
    }
  };
}

// Persisted-result lookup — the worker writes the final response to
// `result:{jobId}` in Redis (TTL 30 days) so links keep working long after
// RunPod's serverless cache purges (~30-60 min after job completion).
// This avoids the "Job status check failed HTTP 500" links go through after
// ~40 minutes.
async function readPersistedResult(jobId) {
  try {
    const store = redis();
    const raw = await store.get(`result:${jobId}`);
    if (!raw) return null;
    // Upstash @upstash/redis returns parsed JSON automatically when the
    // value is JSON-shaped. Handle both shapes defensively.
    if (typeof raw === "object") return raw;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); }
      catch (_) { return null; }
    }
    return null;
  } catch (_) {
    // Redis hiccup — fall through to the RunPod query.
    return null;
  }
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method === "POST" && (req.query.report_agent === "1" || req.query.jobId === "report-agent")) {
    return handleRepMessageAnalystReport(req, res);
  }
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const jobId = req.query.jobId;
  if (!jobId || typeof jobId !== "string") {
    return badRequest(res, "Missing jobId");
  }
  try {
    const fastMeta = await getJobMetadata(jobId).catch(() => null);
    if (fastMeta && fastMeta.fastResult) {
      return res.status(200).json({
        status: "done",
        job_id: jobId,
        events: [
          { status: "queued", message: "Queued", ts: fastMeta.createdAt },
          { status: "done", message: "Done", ts: new Date().toISOString() }
        ],
        result: resultWithJobMetadata(fastMeta.fastResult, fastMeta)
      });
    }
    // FIRST: check our persisted store. If the worker stored the result
    // there (30-day TTL), return it — RunPod's cache is irrelevant.
    const persisted = await readPersistedResult(jobId);
    if (persisted) {
      // Re-derive events from Redis (the worker also persisted those during
      // execution); ok if empty for old jobs that were stored before the
      // event-persistence migration.
      const events = await readProgressEvents(jobId);
      return res.status(200).json({
        status: "done",
        job_id: jobId,
        events,
        result: resultWithJobMetadata(persisted, fastMeta),
        diagnostics: {
          source: "redis_persisted_result",
          event_count: events.length,
          has_job_metadata: !!fastMeta
        }
      });
    }
    const [jobMeta, events] = await Promise.all([
      getJobMetadata(jobId).catch(() => null),
      readProgressEvents(jobId)
    ]);
    let data;
    try {
      data = await getJobStatus(jobId);
    } catch (err) {
      if (err && err.httpStatus === 404) {
        return res.status(404).json({
          status: "error",
          job_id: jobId,
          events,
          error: {
            code: "NOT_FOUND",
            message: "RunPod no longer has this job and MindReader has no persisted result for it.",
            plain: {
              reason: "This run is no longer available.",
              action: "Start a new run. If this just finished, the worker did not persist the final result for this job."
            },
            runpod_status: "NOT_FOUND"
          },
          diagnostics: {
            source: "runpod_404_no_persisted_result",
            event_count: events.length,
            has_job_metadata: !!jobMeta
          }
        });
      }
      throw err;
    }
    const mapped = mapRunpodStatus(data, jobId, jobMeta, events);
    if (mapped.status === "done") {
      // Best-effort cleanup — never block the result on Blob/Redis hiccups.
      // Note: we no longer delete events:{jobId} here because they're
      // useful for the persisted-result render path above.
      await Promise.all([
        maybeDeleteBlobsForJob(jobId).catch(() => {}),
      ]);
    }
    return res.status(200).json(mapped);
  } catch (err) {
    console.error(JSON.stringify({
      event: "diff_status_failed",
      code: "DIFF_STATUS_FAILED",
      job_id: jobId,
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      message: err instanceof Error ? err.message : String(err)
    }));
    return serverError(res, err, "DIFF_STATUS_FAILED");
  }
};
