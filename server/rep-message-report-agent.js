const crypto = require("crypto");
const { badRequest, methodNotAllowed, noStore } = require("../api/lib/http");
const { redis } = require("../api/lib/security");

const REPORT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MODEL = process.env.BRAIN_DIFF_REPORT_MODEL || "claude-sonnet-4-6";
const PROMPT_VERSION = "rep-message-analyst.v3.insight-type-peak-first";

const ANALYST_AGENT_PROMPT = `You are a BrainDiff analyst interpreting one sales-call script through predicted brain-response data.
You receive candidate moments that have already been detected from the seven BrainDiff signals. Your job is not to praise the signal and not to coach the rep. Your job is to translate the data into plain sales language.

Return strict JSON only, matching the schema. Return exactly one answer per provided moment.

AUDIENCE
- Write for a salesperson or sales leader reviewing a call in 30 seconds.
- They do not care about research prose. They care: what wording moved, what brain signal moved, and what that says about the call.
- Keep the useful product language from the demo: "grabbed attention", "felt relevant", "made them think", "will stick", "raised gut reaction".

WHAT TO WRITE
- title: a short sales-call insight, not a metric label. Bad: "Attention increased here." Good: "Manual review pain point lands."
- interpretation: 2-3 short sentences. Explain the signal movement and the transcript moment together. Do not repeat the title.
- insight_type: one label from this set: pain_point, ask_or_next_step, credibility, permissioning, specificity, emotional_trigger, procedural_trough, memory_hook, social_context, explanation_depth, other.
- why_it_moved: 2 short sentences. Sentence 1 names the exact wording or call behavior. Sentence 2 explains why that wording would move this signal.
- what_it_means: 2 short sentences. Explain what this reveals about this call. No advice, no coaching, no "you should".
- signal_read: one measured readout with the primary signal and any important co-moving signals. Numeric detail is allowed here only.
- quote: copy an exact substring from aligned_quote or nearby_transcript.
- uncertainty: one boundary sentence. Say what the signal does NOT prove.

PRIORITY
- Prefer the sales meaning over the largest number. A smaller but clearer transcript-tied moment can be more useful than a larger generic spike.
- Troughs can be important when they show a procedural ask, vague wording, or a change in processing demand.
- Strong co-movement matters: if attention, gut reaction, memory, or personal resonance move together, explain the combined story in simple language.

STRICT SAFETY
- Do not infer buyer behavior, agreement, trust, objection handling, purchase intent, recognition, or future action.
- Do not say the listener "liked", "believed", "understood", "agreed", or "disengaged".
- Do not give recommendations.
- Do not write "model contrast", "signal context", "response architecture", "inspect wording", or similar internal/research language.
- Do not mention prompts, agents, validation, simulations, or implementation details.

JSON SCHEMA
{
  "answers": [
    {
      "moment_id": "moment_01",
      "title": "Short sales-call insight",
      "insight_type": "specificity",
      "interpretation": "2-3 short sentences.",
      "why_it_moved": "2 short sentences.",
      "what_it_means": "2 short sentences.",
      "signal_read": "Measured signal readout.",
      "quote": "Exact transcript substring.",
      "confidence": "high | medium | low",
      "uncertainty": "One boundary sentence."
    }
  ]
}

EXAMPLES
Spike example:
{
  "moment_id": "moment_01",
  "title": "Manual call review pain point lands",
  "insight_type": "pain_point",
  "interpretation": "Attention spiked at 'without making managers listen to every call manually,' and it did not move alone. Personal resonance and brain effort were also high at the same point. The useful read is the specificity: not coaching as a category, but the manual work nobody wants.",
  "why_it_moved": "The phrase names a specific operating burden instead of a broad goal. The shift from 'ramp reps faster' to 'listen to every call manually' is what sharpened the signal.",
  "what_it_means": "The strongest pull sits in operationally specific language. Concrete friction carried more response than the abstract goal around it.",
  "signal_read": "Attention hit near-ceiling, with personal resonance, brain effort, gut reaction, and memory also elevated.",
  "quote": "without making managers listen to every call manually.",
  "confidence": "high",
  "uncertainty": "The signal reflects processing intensity; it does not prove agreement, interest, or conscious recognition."
}

Trough example:
{
  "moment_id": "moment_07",
  "title": "Working-session ask drops into logistics",
  "insight_type": "procedural_trough",
  "interpretation": "Attention fell around 'I'd suggest a 25-minute working session.' The other signals dropped with it, so this is a broad trough rather than one weak metric. The call moved from problem language into process language.",
  "why_it_moved": "The phrase shifts the script into logistics. The surrounding setup is conditional and procedural, so the response sits lower than the earlier problem framing.",
  "what_it_means": "The next-step ask carried less processing weight than the problem-and-solution language before it. The lowest broad read sits on the meeting setup, not the pitch.",
  "signal_read": "Attention held near-floor, with personal resonance, gut reaction, memory, brain effort, and social thinking also low.",
  "quote": "I'd suggest a 25-minute working session.",
  "confidence": "high",
  "uncertainty": "A low signal does not mean the listener stopped listening or found the section unimportant; it can reflect lower processing demand."
}`;

const VALIDATOR_AGENT_PROMPT = `You are the final editor for a BrainDiff rep-message impact report.
You receive a set of analyst interpretations grounded in detected brain-signal moments. Choose the 3 that should appear in the final report.

Return strict JSON only. Select exactly 3.

YOUR JOB
Choose the 3 moments that make the best product report for a salesperson.
The final report should feel like: "Here are the three places where the call's wording changed the predicted brain response, and here is what that reveals about the call."

SELECTION RUBRIC, IN ORDER
1. Sales usefulness: the moment tells a salesperson something concrete about the call.
2. Transcript grounding: the insight points to actual words, not just a high score.
3. Distinctness: the three selected moments should teach three different things.
4. Signal quality: the brain movement is clear enough to defend.
5. Readability: the title and explanation are simple, sharp, and non-researchy.

IMPORTANT
- Do not simply choose the highest BrainScore.
- A lower-scored moment can beat a higher-scored one if it has clearer sales meaning.
- A trough can be selected if it reveals that a next-step ask, procedural wording, or vague language carried less response than the surrounding call.
- If multiple candidates sit on the same sentence, choose the one with the clearest combined story and reject the rest as redundant.
- Force the selected 3 to cover different insight_type values unless the data truly has only one story. If you repeat an insight_type, say why in the reason.
- Strongly prefer rank 1 to be a peak/high moment: sharp_rise, spike, sustained_high, or dominant_signal. Only put a trough/low first if the whole call is mostly flat/low or the trough is clearly the most truthful story.

REJECT
- Reject generic metric-only answers.
- Reject repeated points, even if the scores are strong.
- Reject buyer-intent claims, coaching advice, and weak quote/signal alignment.
- Reject anything that depends on research/internal language instead of plain sales-call language.

REASON FIELD
- The reason you write is shown to the reader. Write it outward: what makes this moment notable in the call.
- Never describe your own selection process.
- Never use "high-value finding", "non-redundant", "strong alignment", "selected because", or similar self-justification.
- No bare numbers unless they are essential. Prefer plain-English signal levels.

- Do not mention placeholders, simulations, or hidden implementation details.

JSON SCHEMA
{
  "selected": [
    {"moment_id": "moment_01", "rank": 1, "reason": "Why this moment belongs in the final report."}
  ],
  "rejected": [
    {"moment_id": "moment_04", "reason": "Why this moment was not selected."}
  ]
}

EXAMPLE REASON
Bad: "Near-ceiling attention spike with strong multi-signal co-activation. Tightly grounded in the quote. Non-redundant with other selections."
Good: "A near-ceiling attention spike backed by several co-moving signals on one concrete phrase - the clearest place where specific operational friction outpulls abstract framing."`;

async function handleRepMessageAnalystReport(req, res) {
  noStore(res);
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return badRequest(res, "Invalid JSON body");
    }
  }

  const jobId = String(body && body.jobId || "").trim();
  const candidates = sanitizeCandidates(body && body.topMoments);
  if (!jobId) return badRequest(res, "Missing jobId");
  if (candidates.length < 3) return badRequest(res, "At least 3 candidate moments are required");

  const model = DEFAULT_MODEL;
  const reportHash = stableHash({ jobId, promptVersion: PROMPT_VERSION, candidates });
  const cacheKey = `single-report:${jobId}:${reportHash}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      return res.status(200).json({ report: { ...cached, source: "redis_cache" } });
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "single_report_cache_read_failed",
      job_id: jobId,
      error: error instanceof Error ? error.message : String(error)
    }));
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) {
    console.error(JSON.stringify({ event: "single_report_missing_anthropic_key", job_id: jobId }));
    return res.status(503).json({ error: "ANTHROPIC_API_KEY is not configured for report generation." });
  }

  try {
    const analystPrompt = renderAnalystPrompt(candidates, body.input || {});
    const analystRaw = await callAnthropic({ apiKey, model, prompt: analystPrompt, maxTokens: 2600, temperature: 0.35 });
    const analystJson = extractJsonObject(analystRaw);
    const analystCandidates = normalizeAnalystAnswers(analystJson.answers, candidates);
    if (analystCandidates.length !== candidates.length) {
      throw new Error(`Analyst returned ${analystCandidates.length} answers for ${candidates.length} candidates`);
    }

    const validatorPrompt = renderValidatorPrompt(candidates, analystCandidates);
    const validatorRaw = await callAnthropic({ apiKey, model, prompt: validatorPrompt, maxTokens: 1200, temperature: 0.2 });
    const validatorJson = extractJsonObject(validatorRaw);
    const validation = normalizeValidation(validatorJson, candidates, analystCandidates);
    if (validation.selected.length !== 3) {
      throw new Error(`Validator selected ${validation.selected.length} moments, expected 3`);
    }

    const report = {
      schema_version: "rep_message_analyst.v1",
      agentMode: "anthropic_server_analyst_validator",
      model,
      promptVersion: PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      reportHash,
      prompts: {
        analyst: ANALYST_AGENT_PROMPT,
        validator: VALIDATOR_AGENT_PROMPT
      },
      analystCandidates,
      validation
    };
    try {
      await writeCache(cacheKey, report);
    } catch (cacheError) {
      console.error(JSON.stringify({
        event: "single_report_cache_write_failed",
        job_id: jobId,
        error: cacheError instanceof Error ? cacheError.message : String(cacheError)
      }));
    }
    return res.status(200).json({ report });
  } catch (error) {
    console.error(JSON.stringify({
      event: "single_report_generation_failed",
      job_id: jobId,
      model,
      error: error instanceof Error ? error.message : String(error)
    }));
    return res.status(502).json({
      error: "Single-run report agent failed. The page can still use the local fallback.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function renderAnalystPrompt(candidates, input) {
  return `${ANALYST_AGENT_PROMPT}

RUN CONTEXT
${JSON.stringify({
    title: trim(input.title, 120),
    durationSec: Number(input.durationSec || 0)
  }, null, 2)}

CANDIDATE MOMENTS
${JSON.stringify(candidates, null, 2)}

Return JSON only.`;
}

function renderValidatorPrompt(candidates, analystCandidates) {
  return `${VALIDATOR_AGENT_PROMPT}

DETECTED MOMENTS
${JSON.stringify(candidates.map((candidate) => ({
    moment_id: candidate.moment_id,
    rank: candidate.rank,
    dimension: candidate.dimension_label,
    event_shape: candidate.event_shape,
    brainScore: candidate.brainScore,
    aligned_quote: candidate.aligned_quote,
    nearby_transcript: candidate.nearby_transcript
  })), null, 2)}

ANALYST INTERPRETATIONS
${JSON.stringify(analystCandidates, null, 2)}

Return JSON only.`;
}

async function callAnthropic({ apiKey, model, prompt, maxTokens, temperature }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`Anthropic HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const output = Array.isArray(data && data.content)
    ? data.content.map((part) => part && part.type === "text" ? part.text : "").join("")
    : "";
  if (!output.trim()) throw new Error("Anthropic returned no text");
  return output;
}

function sanitizeCandidates(topMoments) {
  if (!Array.isArray(topMoments)) return [];
  return topMoments.slice(0, 10).map((item, index) => {
    const packet = item && item.packet || {};
    const event = item && item.event || {};
    const transcript = item && item.transcript || {};
    const localAnalyst = item && item.localAnalyst || {};
    return {
      moment_id: trim(packet.moment_id || item.id || `moment_${String(index + 1).padStart(2, "0")}`, 40),
      rank: Number(item.rank || index + 1),
      dimension: trim(packet.dimension || event.signalName, 80),
      dimension_label: trim(packet.dimension_label || "", 80),
      dimension_plain_english: trim(packet.dimension_plain_english || "", 140),
      event_shape: trim(packet.event_shape || event.eventShape, 60),
      brainScore: finiteNumber(packet.brainScore ?? event.brainScore),
      eventMagnitude: finiteNumber(packet.eventMagnitude ?? event.eventMagnitude),
      localContrast: finiteNumber(packet.localContrast ?? event.localContrast),
      response_window: normalizeNumberArray(packet.response_window, 2),
      spoken_window_after_lag_correction: normalizeNumberArray(packet.spoken_window_after_lag_correction, 2),
      aligned_quote: trim(packet.aligned_quote || transcript.quote || localAnalyst.quote, 320),
      nearby_transcript: trim(packet.nearby_transcript || transcript.contextText, 900),
      signal_observation: trim(packet.signal_observation, 220),
      other_signal_context: Array.isArray(packet.other_signal_context)
        ? packet.other_signal_context.slice(0, 5).map((ctx) => ({
            dimension: trim(ctx.dimension, 80),
            dimension_label: trim(ctx.dimension_label, 80),
            value: finiteNumber(ctx.value)
          }))
        : []
    };
  }).filter((item) => item.moment_id && item.dimension && item.aligned_quote);
}

function normalizeAnalystAnswers(answers, candidates) {
  const validIds = new Set(candidates.map((item) => item.moment_id));
  if (!Array.isArray(answers)) return [];
  const seen = new Set();
  return answers.map((answer) => {
    const whyItMoved = trim(answer && (answer.why_it_moved || answer.likely_driver), 450);
    const whatItMeans = trim(answer && (answer.what_it_means || answer.why_it_matters), 450);
    return {
      moment_id: trim(answer && answer.moment_id, 40),
      title: trim(answer && answer.title, 120),
      insight_type: normalizeInsightType(answer && answer.insight_type),
      interpretation: trim(answer && answer.interpretation, 700),
      why_it_moved: whyItMoved,
      what_it_means: whatItMeans,
      likely_driver: whyItMoved,
      why_it_matters: whatItMeans,
      signal_read: trim(answer && answer.signal_read, 350),
      quote: trim(answer && answer.quote, 320),
      confidence: normalizeConfidence(answer && answer.confidence),
      uncertainty: trim(answer && answer.uncertainty, 260)
    };
  }).filter((answer) => {
    if (!validIds.has(answer.moment_id) || seen.has(answer.moment_id)) return false;
    seen.add(answer.moment_id);
    return answer.title && answer.interpretation && answer.why_it_moved && answer.what_it_means;
  });
}

function normalizeValidation(value, candidates, analystCandidates = []) {
  const validIds = new Set(candidates.map((item) => item.moment_id));
  const seen = new Set();
  const byId = new Map(candidates.map((candidate) => [candidate.moment_id, candidate]));
  const answersById = new Map(analystCandidates.map((answer) => [answer.moment_id, answer]));
  const selected = preferPeakFirst(enforceDistinctInsightTypes((Array.isArray(value && value.selected) ? value.selected : [])
    .map((item, index) => ({
      moment_id: trim(item && item.moment_id, 40),
      rank: Number(item && item.rank) || index + 1,
      reason: trim(item && item.reason, 360)
    }))
    .filter((item) => {
      if (!validIds.has(item.moment_id) || seen.has(item.moment_id)) return false;
      seen.add(item.moment_id);
      return item.reason;
    })
    .slice(0, 3)
    , analystCandidates, answersById), byId, analystCandidates).map((item, index) => ({ ...item, rank: index + 1 }));
  const rejected = (Array.isArray(value && value.rejected) ? value.rejected : [])
    .map((item) => ({
      moment_id: trim(item && item.moment_id, 40),
      reason: trim(item && item.reason, 260)
    }))
    .filter((item) => validIds.has(item.moment_id) && item.reason);
  return { selected, rejected };
}

function enforceDistinctInsightTypes(selected, analystCandidates, answersById) {
  if (selected.length < 3 || !analystCandidates.length) return selected;
  const availableTypes = new Set(analystCandidates.map((answer) => insightTypeOf(answer)));
  if (availableTypes.size < 3) return selected;

  const output = [...selected];
  for (let guard = 0; guard < output.length; guard += 1) {
    const counts = countSelectedTypes(output, answersById);
    const duplicateIndex = output.findIndex((item, index) => {
      if (index === 0) return false;
      return counts.get(insightTypeOf(answersById.get(item.moment_id))) > 1;
    });
    if (duplicateIndex < 0) break;
    const usedTypes = new Set(output.map((item) => insightTypeOf(answersById.get(item.moment_id))));
    const replacement = analystCandidates.find((answer) =>
      !output.some((item) => item.moment_id === answer.moment_id) &&
      !usedTypes.has(insightTypeOf(answer))
    );
    if (!replacement) break;
    output[duplicateIndex] = {
      moment_id: replacement.moment_id,
      rank: output[duplicateIndex].rank,
      reason: `This adds a different read on the call: ${trim(replacement.title || replacement.interpretation, 220)}`
    };
  }
  return output;
}

function countSelectedTypes(selected, answersById) {
  const counts = new Map();
  for (const item of selected) {
    const type = insightTypeOf(answersById.get(item.moment_id));
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

function insightTypeOf(answer) {
  return normalizeInsightType(answer && answer.insight_type);
}

function preferPeakFirst(selected, byId, analystCandidates = []) {
  if (selected.length < 2) return selected;
  if (isPeakCandidate(byId.get(selected[0].moment_id))) return selected;
  const peakIndex = selected.findIndex((item) => isPeakCandidate(byId.get(item.moment_id)));
  if (peakIndex <= 0) {
    const selectedIds = new Set(selected.map((item) => item.moment_id));
    const externalPeak = analystCandidates.find((answer) =>
      !selectedIds.has(answer.moment_id) &&
      isPeakCandidate(byId.get(answer.moment_id))
    );
    if (!externalPeak) return selected;
    return [{
      moment_id: externalPeak.moment_id,
      rank: 1,
      reason: `This gives the report its clearest high moment: ${trim(externalPeak.title || externalPeak.interpretation, 220)}`
    }, ...selected.slice(1)];
  }
  const copy = [...selected];
  const [peak] = copy.splice(peakIndex, 1);
  return [peak, ...copy];
}

function isPeakCandidate(candidate) {
  if (!candidate) return false;
  const shape = String(candidate.event_shape || "").toLowerCase();
  return shape.includes("spike") ||
    shape.includes("rise") ||
    shape.includes("high") ||
    shape.includes("dominant") ||
    Number(candidate.brainScore) >= 0.72 && !shape.includes("low") && !shape.includes("trough") && !shape.includes("drop");
}

function normalizeInsightType(value) {
  const allowed = new Set([
    "pain_point",
    "ask_or_next_step",
    "credibility",
    "permissioning",
    "specificity",
    "emotional_trigger",
    "procedural_trough",
    "memory_hook",
    "social_context",
    "explanation_depth",
    "other"
  ]);
  const text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return allowed.has(text) ? text : "other";
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf("{");
    if (start < 0) throw new Error("No JSON object found in model output");
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
      }
    }
    throw new Error("Could not parse JSON object from model output");
  }
}

async function readCache(key) {
  const store = redis();
  const value = await store.get(key);
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (_) { return null; }
  }
  return null;
}

async function writeCache(key, value) {
  const store = redis();
  await store.set(key, value);
  await store.expire(key, REPORT_CACHE_TTL_SECONDS);
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function trim(value, max = 500) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function normalizeNumberArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit).map(finiteNumber) : [];
}

function normalizeConfidence(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("high")) return "high";
  if (text.includes("low")) return "low";
  return "medium";
}

module.exports = {
  handleRepMessageAnalystReport,
  ANALYST_AGENT_PROMPT,
  VALIDATOR_AGENT_PROMPT
};
