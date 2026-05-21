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

  const { query, variables } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "missing_query" });
  }

  const url = `https://api.runpod.io/graphql?api_key=${encodeURIComponent(cfg.runpodApiKey)}`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.runpodApiKey}`
    },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
  return res.send(text);
};
