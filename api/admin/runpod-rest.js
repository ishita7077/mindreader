const { runtimeConfig } = require("../lib/config");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let cfg;
  try {
    cfg = runtimeConfig();
  } catch (err) {
    return res.status(500).json({ error: "config_error", detail: err.message });
  }

  if (req.headers["x-admin-token"] !== cfg.blobReadWriteToken) {
    return res.status(403).json({ error: "forbidden" });
  }

  const path = String((req.body && req.body.path) || "");
  if (!path.startsWith(`/v2/${cfg.runpodEndpointId}/`) || path.includes("..")) {
    return res.status(400).json({ error: "bad_path" });
  }

  const method = String((req.body && req.body.method) || "GET").toUpperCase();
  const upstream = await fetch(`https://api.runpod.ai${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.runpodApiKey}`
    },
    body: method === "GET" ? undefined : JSON.stringify(req.body.body || {})
  });
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
  return res.send(text);
};
