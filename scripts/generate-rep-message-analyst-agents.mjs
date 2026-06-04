import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYST_AGENT_PROMPT,
  VALIDATOR_AGENT_PROMPT,
  buildRepMessageAnalystReport,
} from "../frontend_new/rep-message-analyst-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const rawDir = path.join(root, "frontend_new", "data", "rep-message-impact");
const outputDir = path.join(root, "frontend_new", "data", "rep-message-analyst");
const runs = process.argv.slice(2).length ? process.argv.slice(2) : ["maya", "rahul"];
const reportModel = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required for real analyst report generation.");
}

await fs.mkdir(outputDir, { recursive: true });

for (const run of runs) {
  const raw = JSON.parse(await fs.readFile(path.join(rawDir, `${run}.json`), "utf8"));
  const base = buildRepMessageAnalystReport(raw);
  const analyst = await callAnalyst(base);
  const withAnalyst = attachAnalystOutputs(base, analyst);
  const validation = await callValidator(withAnalyst);
  const finalReport = attachValidation(withAnalyst, validation);
  const outPath = path.join(outputDir, `${run}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  console.log(`generated ${path.relative(root, outPath)} with ${finalReport.finalInsights.length} final insights`);
}

async function callAnalyst(report) {
  const packets = report.topMoments.map((moment) => moment.packet);
  const payload = {
    report_title: report.input.title,
    instruction: "Interpret each moment as an external-facing product analyst for a salesperson reviewing a call. The signals are already detected; for each moment, explain what part of the call moved, what wording drove it, and what that says about the script in simple language.",
    output_contract: {
      answers: [{
        moment_id: "moment_01",
        title: "3-7 words, sentence case, names what happened at this moment, not the metric. e.g. 'Manual call review pain point lands'",
        interpretation: "1-3 simple sentences grounded in the quote; readable without decimals; explain the insight in the title, not the graph mechanics",
        likely_driver: "two short simple sentences: the exact wording/call behavior that moved the signal, then why that wording created the movement; concrete, transcript-tied, no vague model language",
        why_it_matters: "two short simple sentences: what this reveals about the call/script, then why that matters as an observation; no coaching advice",
        signal_read: "technical plain-English read of the signal movement and nearby signals; every value leads with a level, number in parentheses",
        quote: "exact aligned quote or shorter exact substring from aligned_quote",
        confidence: "high | medium | low",
        uncertainty: "the one specific wrong inference a reader might draw from THIS moment, named as the thing that cannot be concluded — the only place inferred mental states may appear",
      }],
    },
    rules: [
      "Return strict JSON only.",
      "Return exactly one answer for each provided moment.",
      "At most one hedge word across all answers combined; state everything else directly. Never hedge a measured value.",
      "Inferred mental states (disengagement, agreement, trust, interest, objection) may appear only in the uncertainty field, never as a claim.",
      "why_it_matters describes the script, not the reader — no recommendations, no 'readers can use this'.",
      "Do not infer buyer behavior, buyer agreement, buyer trust, objection handling, purchase intent, or future action outside the uncertainty field.",
      "Do not give coaching advice. Do not answer with yes. Do not simply restate the signal.",
      "Reader-facing fields must sound like a sales call readout, not a research note. Avoid generic phrases like 'model contrast', 'signal context', 'response architecture', or 'inspect wording'.",
      "Put numeric detail in signal_read. Keep title, interpretation, likely_driver, and why_it_matters understandable without decimals.",
      "Write likely_driver and why_it_matters as two short sentences each, in simple English.",
      "Do not mention internal prompts, agents, placeholders, simulations, or validation.",
      "Keep every quote copied exactly from the provided aligned_quote or use a shorter exact substring.",
    ],
    moments: packets,
  };
  return anthropicJson({
    system: ANALYST_AGENT_PROMPT,
    user: JSON.stringify(payload, null, 2),
    maxTokens: 7000,
    temperature: 0.2,
  });
}

async function callValidator(report) {
  const payload = {
    report_title: report.input.title,
    instruction: "Choose the three interpretations that should appear in the final product report.",
    output_contract: {
      selected: [{
        moment_id: "moment_01",
        rank: 1,
        reason: "why this moment's signal movement is notable and distinct, written outward to the reader. Never describe your selection process or use 'high-value', 'non-redundant', 'strong alignment'.",
      }],
      rejected: [{
        moment_id: "moment_04",
        reason: "why this was not selected",
      }],
    },
    rules: [
      "Return strict JSON only.",
      "Select exactly 3 moments.",
      "Do not simply choose the highest BrainScore.",
      "Prefer useful, grounded, non-redundant interpretations with strong quote/signal fit.",
      "Prefer moments a salesperson can understand in 30 seconds: what moved, which words drove it, and what that says about the call.",
      "Reject research-sounding output that depends on terms like 'model contrast', 'signal context', 'response architecture', or 'inspect wording' instead of plain sales-call language.",
      "Reject generic answers, repeated points, buyer-intent claims, coaching advice, weak quote alignment, and any moment that hedges the measured signal, writes why_it_matters about the reader, or contradicts its own uncertainty field.",
      "Write each reason outward to the reader — what makes the moment notable — never as self-justification.",
      "Do not mention placeholders, simulations, or hidden implementation details.",
    ],
    moments: report.topMoments.map((moment) => ({
      moment_id: moment.id,
      rank: moment.rank,
      dimension: moment.packet.dimension_label,
      event_shape: moment.packet.event_shape,
      brainScore: round(moment.event.brainScore),
      eventMagnitude: round(moment.event.eventMagnitude),
      localContrast: round(moment.event.localContrast),
      aligned_quote: moment.transcript.quote,
      analyst: moment.analyst,
    })),
  };
  return anthropicJson({
    system: VALIDATOR_AGENT_PROMPT,
    user: JSON.stringify(payload, null, 2),
    maxTokens: 3000,
    temperature: 0.15,
  });
}

function attachAnalystOutputs(report, analystJson) {
  const answers = Array.isArray(analystJson.answers) ? analystJson.answers : [];
  const byId = new Map(answers.map((answer) => [String(answer.moment_id), answer]));
  const topMoments = enforceHedgeBudget(report.topMoments.map((moment) => {
    const answer = sanitizeAnalystAnswer(byId.get(moment.id), moment);
    return { ...moment, analyst: answer };
  }));
  return { ...report, topMoments };
}

function attachValidation(report, validationJson) {
  const selectedRaw = Array.isArray(validationJson.selected) ? validationJson.selected : [];
  const rejectedRaw = Array.isArray(validationJson.rejected) ? validationJson.rejected : [];
  const topIds = new Set(report.topMoments.map((moment) => moment.id));
  const selected = selectedRaw
    .filter((selection) => topIds.has(String(selection.moment_id)))
    .slice(0, 3)
    .map((selection, index) => ({
      moment_id: String(selection.moment_id),
      rank: Number(selection.rank) || index + 1,
      reason: cleanText(selection.reason) || "Selected as one of the clearest, most useful interpretations.",
    }));

  for (const moment of report.topMoments) {
    if (selected.length >= 3) break;
    if (!selected.some((selection) => selection.moment_id === moment.id)) {
      selected.push({
        moment_id: moment.id,
        rank: selected.length + 1,
        reason: "Selected as a grounded interpretation with clear signal movement and transcript alignment.",
      });
    }
  }

  const selectedIds = new Set(selected.map((selection) => selection.moment_id));
  const rejectedById = new Map(rejectedRaw.map((item) => [String(item.moment_id), cleanText(item.reason)]));
  const rejected = report.topMoments
    .filter((moment) => !selectedIds.has(moment.id))
    .map((moment) => ({
      moment_id: moment.id,
      reason: rejectedById.get(moment.id) || "Less useful or more redundant than the selected set.",
    }));

  const validation = { selected, rejected };
  const finalInsights = selected
    .map((selection) => {
      const moment = report.topMoments.find((item) => item.id === selection.moment_id);
      return moment ? { ...moment, selection } : null;
    })
    .filter(Boolean);

  return {
    input: report.input,
    normalized: report.normalized,
    topMoments: report.topMoments,
    finalInsights,
    validation,
    generatedAt: new Date().toISOString(),
    agentMode: "anthropic_opus_4_7",
    model: reportModel,
  };
}

async function anthropicJson({ system, user, maxTokens, temperature }) {
  const body = {
    model: reportModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (!reportModel.includes("opus-4-7")) {
    body.temperature = temperature;
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${reportModel}: ${response.status} ${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  const content = data.content?.map((part) => part.text || "").join("\n") || "";
  return extractJson(content);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const firstObject = raw.indexOf("{");
  const lastObject = raw.lastIndexOf("}");
  if (firstObject < 0 || lastObject < firstObject) {
    throw new Error(`No JSON object returned: ${raw.slice(0, 300)}`);
  }
  return JSON.parse(raw.slice(firstObject, lastObject + 1));
}

function sanitizeAnalystAnswer(answer, moment) {
  const source = answer && typeof answer === "object" ? answer : {};
  return {
    moment_id: moment.id,
    title: cleanText(source.title) || fallbackTitle(moment),
    interpretation: cleanText(source.interpretation) || `This moment shows a clear ${moment.packet.dimension_label} shift around the quoted phrase.`,
    likely_driver: cleanText(source.likely_driver) || `The closest transcript anchor is "${moment.transcript.quote}".`,
    why_it_matters: cleanText(source.why_it_matters) || "It identifies where the message created a meaningful predicted brain-response change.",
    signal_read: cleanText(source.signal_read) || `${moment.packet.signal_observation} BrainScore ${round(moment.event.brainScore)}.`,
    quote: quoteFromSource(cleanText(source.quote), moment.transcript.quote),
    confidence: ["high", "medium", "low"].includes(String(source.confidence).toLowerCase())
      ? String(source.confidence).toLowerCase()
      : confidenceFromScore(moment.event.brainScore),
    uncertainty: cleanText(source.uncertainty) || "This does not prove listener intent or future behavior.",
  };
}

function enforceHedgeBudget(topMoments, budget = 1) {
  let used = 0;
  const fields = ["title", "interpretation", "likely_driver", "why_it_matters", "signal_read"];
  return topMoments.map((moment) => {
    const analyst = { ...moment.analyst };
    for (const field of fields) {
      const text = analyst[field] || "";
      const matches = text.match(/\b(likely|appears to)\b/gi) || [];
      if (!matches.length) continue;
      if (used + matches.length <= budget) {
        used += matches.length;
        continue;
      }
      analyst[field] = dehedgeText(text);
    }
    return { ...moment, analyst };
  });
}

function dehedgeText(text) {
  return cleanText(text)
    .replace(/\bis the likely driver of\b/gi, "drives")
    .replace(/\bis the likely driver\b/gi, "drives the shift")
    .replace(/\bthe likely driver of\b/gi, "the driver of")
    .replace(/\bthe likely driver\b/gi, "the driver")
    .replace(/\blikely driver\b/gi, "driver")
    .replace(/\blikely\b/gi, "")
    .replace(/\bappears to\b/gi, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteFromSource(candidate, source) {
  if (!candidate) return source;
  const cleanCandidate = candidate.replace(/^["“”']+|["“”']+$/g, "").trim();
  return source.includes(cleanCandidate) ? cleanCandidate : source;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\bplaceholder\b/gi, "timing marker")
    .replace(/\bsimulation\b/gi, "generated report")
    .replace(/\btemplate card\b/gi, "report item")
    .replace(/\bagent mode\b/gi, "generation mode")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTitle(moment) {
  return `${moment.packet.dimension_label} shifted around the message's transcript anchor.`;
}

function confidenceFromScore(score) {
  if (score >= 0.75) return "high";
  if (score >= 0.62) return "medium";
  return "low";
}

function round(value) {
  return Number(Number(value).toFixed(3));
}
