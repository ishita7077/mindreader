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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.runpodApiKey}`
    },
    body: JSON.stringify({ input })
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
    throw new Error(`Runpod status failed: ${res.status} ${JSON.stringify(data)}`);
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
