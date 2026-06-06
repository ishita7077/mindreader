const { runtimeConfig } = require("./config");

function endpointTag(endpointId) {
  const id = String(endpointId || "");
  return {
    endpoint_len: id.length,
    endpoint_suffix: id ? id.slice(-6) : ""
  };
}

function endpoints() {
  const cfg = runtimeConfig();
  const base = `https://api.runpod.ai/v2/${cfg.runpodEndpointId}`;
  return {
    cfg,
    run: `${base}/run`,
    status: (jobId) => `${base}/status/${jobId}`
  };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jobPolicy() {
  return {
    // Long single-text runs can spend most of their time in TRIBE's text→speech
    // path. Keep the endpoint-level timeout from killing valid production runs.
    executionTimeout: positiveInt(process.env.RUNPOD_EXECUTION_TIMEOUT_MS, 7_200_000),
    ttl: positiveInt(process.env.RUNPOD_JOB_TTL_MS, 86_400_000)
  };
}

async function parseResponseBody(res) {
  const text = await res.text();
  if (!text) return { data: {}, bodyPreview: "" };
  try {
    return { data: JSON.parse(text), bodyPreview: text.slice(0, 500) };
  } catch (err) {
    return {
      data: { raw: text.slice(0, 500) },
      bodyPreview: text.slice(0, 500),
      parseError: err instanceof Error ? err.message : String(err)
    };
  }
}

function logRunpodError(event, details) {
  console.error(JSON.stringify({
    event,
    service: "runpod",
    ...details
  }));
}

async function submitJob(input) {
  const ep = endpoints();
  const cfg = ep.cfg;
  const url = ep.run;
  const started = Date.now();
  const policy = jobPolicy();
  console.info(JSON.stringify({
    event: "runpod_submit_started",
    mode: input && input.mode,
    run_type: input && input.run_type,
    policy_execution_timeout_ms: policy.executionTimeout,
    policy_ttl_ms: policy.ttl,
    ...endpointTag(cfg.runpodEndpointId)
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.runpodApiKey}`
    },
    body: JSON.stringify({ input, policy })
  });
  const { data, bodyPreview, parseError } = await parseResponseBody(res);
  if (!res.ok) {
    logRunpodError("runpod_submit_failed", {
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      mode: input && input.mode,
      ...endpointTag(cfg.runpodEndpointId),
      body_preview: bodyPreview,
      parse_error: parseError || null
    });
    throw new Error(`Runpod submit failed: ${res.status} ${JSON.stringify(data)}`);
  }
  if (parseError) {
    logRunpodError("runpod_submit_non_json", {
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      mode: input && input.mode,
      ...endpointTag(cfg.runpodEndpointId),
      body_preview: bodyPreview,
      parse_error: parseError
    });
    throw new Error(`Runpod submit returned non-JSON: ${parseError}`);
  }
  return data;
}

async function getJobStatus(jobId) {
  const ep = endpoints();
  const cfg = ep.cfg;
  const url = ep.status(jobId);
  const started = Date.now();
  const res = await fetch(url, {
    cache: "no-store",
    headers: { authorization: `Bearer ${cfg.runpodApiKey}` }
  });
  const { data, bodyPreview, parseError } = await parseResponseBody(res);
  if (!res.ok) {
    logRunpodError("runpod_status_failed", {
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      job_id: jobId,
      ...endpointTag(cfg.runpodEndpointId),
      body_preview: bodyPreview,
      parse_error: parseError || null
    });
    const err = new Error(`Runpod status failed: ${res.status} ${JSON.stringify(data)}`);
    err.httpStatus = res.status;
    err.data = data;
    err.bodyPreview = bodyPreview;
    throw err;
  }
  if (parseError) {
    logRunpodError("runpod_status_non_json", {
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      job_id: jobId,
      ...endpointTag(cfg.runpodEndpointId),
      body_preview: bodyPreview,
      parse_error: parseError
    });
    throw new Error(`Runpod status returned non-JSON: ${parseError}`);
  }
  return data;
}

module.exports = {
  submitJob,
  getJobStatus,
  endpointTag
};
