const { methodNotAllowed, badRequest, serverError, readIp, jsonOrEmpty, noStore } = require("../lib/http");
const { verifyTurnstile, applyRateLimit } = require("../lib/security");
const { submitJob } = require("../lib/runpod");
const { saveJobMetadata } = require("../lib/jobs");
const { runtimeConfig } = require("../lib/config");
const { buildFastResult } = require("../lib/fast-result");

function sameDisplayName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function defaultDisplayName(modality, side, runType = "diff") {
  if (runType === "single") {
    if (modality === "video") return "Video";
    if (modality === "audio") return "Audio";
    return "Text";
  }
  const suffix = side === "a" ? "A" : "B";
  if (modality === "video") return `Video ${suffix}`;
  if (modality === "audio") return `Audio ${suffix}`;
  return `Text ${suffix}`;
}

function labelFromMediaName(name) {
  const clean = String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 60);
}

function addSideSuffix(label, side) {
  const suffix = side === "a" ? "A" : "B";
  return `${String(label || "").replace(/\s+[AB]$/i, "").slice(0, 58)} ${suffix}`.trim();
}

function finalizeDisplayNames(input) {
  if (!input) return input;
  if (input.runType === "single") {
    input.displayNameA = (
      input.displayNameA ||
      labelFromMediaName(input.mediaNameA) ||
      defaultDisplayName(input.modality, "a", "single")
    ).slice(0, 60);
    input.displayNameB = "";
    return input;
  }
  input.displayNameA = (
    input.displayNameA ||
    labelFromMediaName(input.mediaNameA) ||
    defaultDisplayName(input.modality, "a")
  ).slice(0, 60);
  input.displayNameB = (
    input.displayNameB ||
    labelFromMediaName(input.mediaNameB) ||
    defaultDisplayName(input.modality, "b")
  ).slice(0, 60);
  if (sameDisplayName(input.displayNameA, input.displayNameB)) {
    input.displayNameA = addSideSuffix(input.displayNameA, "a").slice(0, 60);
    input.displayNameB = addSideSuffix(input.displayNameB, "b").slice(0, 60);
  }
  return input;
}

function optionalNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeInput(body) {
  const payload = jsonOrEmpty(body);
  const modality = String(payload.modality || "text").toLowerCase();
  const explicitRunType = String(payload.run_type || payload.runType || "").toLowerCase();
  const hasSingleFields =
    typeof payload.text === "string" ||
    typeof payload.media_url === "string" ||
    typeof payload.display_name === "string" ||
    typeof payload.media_name === "string";
  const runType = explicitRunType === "single" || (explicitRunType !== "diff" && hasSingleFields)
    ? "single"
    : "diff";
  // Display names: short, human-readable labels for each input. Auto-suggested
  // on the launch page (extracted from text or filename) and editable by the
  // user. Capped at 60 chars defensively. Stored in job metadata and forwarded
  // to the worker so the entire UI uses the same labels everywhere.
  const cap = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");
  const singleText = typeof payload.text === "string" ? payload.text : payload.text_a;
  const singleMediaUrl = typeof payload.media_url === "string" ? payload.media_url : payload.media_url_a;
  const singleMediaName = typeof payload.media_name === "string" ? payload.media_name : payload.media_name_a;
  const singleMediaDuration = payload.media_duration_s ?? payload.media_duration_a_s;
  return finalizeDisplayNames({
    runType,
    modality,
    textA: typeof (runType === "single" ? singleText : payload.text_a) === "string"
      ? String(runType === "single" ? singleText : payload.text_a).trim()
      : "",
    textB: typeof payload.text_b === "string" ? payload.text_b.trim() : "",
    mediaUrlA: typeof (runType === "single" ? singleMediaUrl : payload.media_url_a) === "string"
      ? String(runType === "single" ? singleMediaUrl : payload.media_url_a).trim()
      : "",
    mediaUrlB: typeof payload.media_url_b === "string" ? payload.media_url_b.trim() : "",
    mediaNameA: typeof (runType === "single" ? singleMediaName : payload.media_name_a) === "string"
      ? String(runType === "single" ? singleMediaName : payload.media_name_a).trim()
      : "",
    mediaNameB: typeof payload.media_name_b === "string" ? payload.media_name_b.trim() : "",
    mediaDurationA: runType === "single" ? optionalNumber(singleMediaDuration) : optionalNumber(payload.media_duration_a_s),
    mediaDurationB: Number.isFinite(Number(payload.media_duration_b_s)) ? Number(payload.media_duration_b_s) : null,
    displayNameA: runType === "single" ? cap(payload.display_name || payload.display_name_a, 60) : cap(payload.display_name_a, 60),
    displayNameB: runType === "single" ? "" : cap(payload.display_name_b, 60),
    trimToShorter: payload.trim_to_shorter === true,
    turnstileToken: payload.turnstileToken || payload.turnstile_token || ""
  });
}

function validateStartInput(input) {
  if (!["text", "audio", "video"].includes(input.modality)) {
    return { ok: false, message: "modality must be one of: text, audio, video" };
  }
  if (input.runType === "single") {
    if (input.modality === "text" && !input.textA) {
      return { ok: false, message: "Text is required for single-content jobs" };
    }
    if (input.modality !== "text" && !input.mediaUrlA) {
      return { ok: false, message: "media_url is required for audio/video single-content jobs" };
    }
    return { ok: true };
  }
  if (input.modality === "text" && (!input.textA || !input.textB)) {
    return { ok: false, message: "Both text_a and text_b are required for text jobs" };
  }
  if ((input.modality === "audio" || input.modality === "video") && (!input.mediaUrlA || !input.mediaUrlB)) {
    return { ok: false, message: "media_url_a and media_url_b are required for audio/video jobs" };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    const ip = readIp(req);
    const input = normalizeInput(req.body);
    const cfg = runtimeConfig();
    const started = Date.now();
    console.info(JSON.stringify({
      event: "diff_start_received",
      run_type: input.runType,
      modality: input.modality,
      ip_suffix: ip ? String(ip).slice(-6) : "",
      text_a_len: input.textA.length,
      text_b_len: input.textB.length,
      has_media_a: !!input.mediaUrlA,
      has_media_b: !!input.mediaUrlB,
      trim_to_shorter: input.trimToShorter
    }));
    if (cfg.turnstileEnabled && !String(input.turnstileToken || "").trim()) {
      return badRequest(res, "Missing bot protection token", "TURNSTILE_MISSING");
    }
    const validation = validateStartInput(input);
    if (!validation.ok) {
      return badRequest(res, validation.message);
    }

    const rateType = input.modality === "text" ? "text" : "media";
    const [captcha, limit] = await Promise.all([
      verifyTurnstile({ token: input.turnstileToken, ip }),
      applyRateLimit({ ip, type: rateType })
    ]);
    if (!captcha.ok) {
      return res.status(403).json({
        code: captcha.code,
        message: "Bot verification failed"
      });
    }
    if (!limit.ok) {
      return res.status(429).json({
        code: limit.code,
        message: "Rate limit exceeded",
        limit: limit.limit
      });
    }

    if (process.env.BRAIN_DIFF_FAST_RESULT === "1" && input.modality === "text") {
      const jobId = `fast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      await saveJobMetadata(jobId, {
        createdAt: new Date().toISOString(),
        ip,
        type: rateType,
        modality: input.modality,
        runType: input.runType,
        displayNameA: input.displayNameA || null,
        displayNameB: input.displayNameB || null,
        displayName: input.runType === "single" ? input.displayNameA || null : null,
        fastResult: buildFastResult(input, jobId)
      });
      return res.status(200).json({
        job_id: jobId,
        request_id: jobId,
        status: "queued"
      });
    }

    const runpodInput = input.runType === "single"
      ? {
          run_type: "single",
          mode: input.modality,
          text: input.modality === "text" ? input.textA || undefined : undefined,
          media_url: input.modality !== "text" ? input.mediaUrlA || undefined : undefined,
          media_name: input.modality !== "text" ? input.mediaNameA || undefined : undefined,
          display_name: input.displayNameA || undefined,
          blob_token: input.modality === "audio" || input.modality === "video" ? cfg.blobReadWriteToken : undefined
        }
      : {
          run_type: "diff",
          mode: input.modality,
          text_a: input.textA || undefined,
          text_b: input.textB || undefined,
          media_url_a: input.mediaUrlA || undefined,
          media_url_b: input.mediaUrlB || undefined,
          display_name_a: input.displayNameA || undefined,
          display_name_b: input.displayNameB || undefined,
          trim_to_shorter: input.trimToShorter || undefined,
          blob_token: input.modality === "audio" || input.modality === "video" ? cfg.blobReadWriteToken : undefined
        };
    const submitted = await submitJob(runpodInput);
    const jobId = submitted.id || submitted.jobId;
    if (!jobId) {
      throw new Error("Runpod response missing job id");
    }
    console.info(JSON.stringify({
      event: "diff_start_runpod_submitted",
      job_id: jobId,
      run_type: input.runType,
      modality: input.modality,
      elapsed_ms: Date.now() - started
    }));

    await saveJobMetadata(jobId, {
      createdAt: new Date().toISOString(),
      ip,
      type: rateType,
      runType: input.runType,
      modality: input.modality,
      mediaName: input.runType === "single" ? input.mediaNameA || null : null,
      mediaNameA: input.mediaNameA || null,
      mediaNameB: input.mediaNameB || null,
      displayName: input.runType === "single" ? input.displayNameA || null : null,
      displayNameA: input.displayNameA || null,
      displayNameB: input.displayNameB || null,
      mediaDuration: input.runType === "single" ? input.mediaDurationA : null,
      mediaDurationA: input.mediaDurationA,
      mediaDurationB: input.mediaDurationB,
      trimToShorter: input.trimToShorter,
      blobUrl: input.runType === "single" ? input.mediaUrlA || null : null,
      blobUrlA: input.mediaUrlA || null,
      blobUrlB: input.mediaUrlB || null,
      blobDeleted: false
    });

    return res.status(200).json({
      job_id: jobId,
      request_id: jobId,
      status: "queued"
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: "diff_start_failed",
      code: "DIFF_START_FAILED",
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      message: err instanceof Error ? err.message : String(err)
    }));
    return serverError(res, err, "DIFF_START_FAILED");
  }
};
