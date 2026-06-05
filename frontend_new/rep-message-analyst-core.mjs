export const DIMENSIONS = [
  "personal_resonance",
  "attention",
  "brain_effort",
  "gut_reaction",
  "memory_encoding",
  "social_thinking",
  "language_depth",
];

export const DIMENSION_LABELS = {
  personal_resonance: "Personal Resonance",
  attention: "Attention",
  brain_effort: "Brain Effort",
  gut_reaction: "Gut Reaction",
  memory_encoding: "Memory Encoding",
  social_thinking: "Social Thinking",
  language_depth: "Language Depth",
};

const DIMENSION_MEANING = {
  personal_resonance: "relevance to the listener's world",
  attention: "noticeability and pull",
  brain_effort: "processing load",
  gut_reaction: "immediate gut-level response",
  memory_encoding: "stickiness and encoding",
  social_thinking: "thinking about people, roles, teams, or stakeholders",
  language_depth: "the depth or distinctiveness of the explanation",
};

const DEFAULT_HRF_LAG_SEC = 5;

export const ANALYST_AGENT_PROMPT = `You are a BrainDiff analyst interpreting one sales-call script through predicted brain-response data.
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
}
`;

export const VALIDATOR_AGENT_PROMPT = `You are the final editor for a BrainDiff rep-message impact report.
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

REASON FIELD (this ships in the report)
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

export function buildRepMessageAnalystReport(raw) {
  const input = normalizeRun(raw);
  const normalized = normalizeCurves(input);
  const candidates = mineEvents(input, normalized)
    .filter((event) => Number.isFinite(event.brainScore))
    .sort((a, b) => b.brainScore - a.brainScore);
  const topMoments = clusterMoments(candidates)
    .slice(0, 10)
    .map((event, index) => {
      const transcript = resolveTranscript(event, input);
      const packet = buildAnalystPacket(input, event, transcript, index + 1, normalized);
      return {
        id: packet.moment_id,
        rank: index + 1,
        event,
        transcript,
        packet,
        analyst: runAnalystAgent(packet),
      };
    });
  const validation = runValidatorAgent(topMoments);
  const finalInsights = validation.selected
    .map((selection) => {
      const moment = topMoments.find((item) => item.id === selection.moment_id);
      return moment ? { ...moment, selection } : null;
    })
    .filter(Boolean);

  return {
    input,
    normalized,
    candidates,
    topMoments,
    finalInsights,
    validation,
    prompts: {
      analyst: ANALYST_AGENT_PROMPT,
      validator: VALIDATOR_AGENT_PROMPT,
    },
    agentMode: "local_simulation_ready_for_llm_swap",
  };
}

export function applyAgentReport(report, agentReport) {
  if (!report || !agentReport || typeof agentReport !== "object") return report;
  const answers = Array.isArray(agentReport.analystCandidates)
    ? agentReport.analystCandidates
    : Array.isArray(agentReport.answers)
      ? agentReport.answers
      : [];
  if (!answers.length || !agentReport.validation || !Array.isArray(agentReport.validation.selected)) {
    return report;
  }
  const analystById = new Map(answers.map((answer) => [String(answer.moment_id || ""), answer]));
  const topMoments = report.topMoments.map((item) => {
    const answer = analystById.get(item.id);
    if (!answer) return item;
    return {
      ...item,
      analyst: {
        ...item.analyst,
        agent_source: "anthropic",
        title: cleanAgentString(answer.title) || item.analyst.title,
        insight_type: cleanAgentString(answer.insight_type) || item.analyst.insight_type || "other",
        interpretation: cleanAgentString(answer.interpretation) || item.analyst.interpretation,
        likely_driver: cleanAgentString(answer.why_it_moved) || cleanAgentString(answer.likely_driver) || item.analyst.likely_driver,
        why_it_matters: cleanAgentString(answer.what_it_means) || cleanAgentString(answer.why_it_matters) || item.analyst.why_it_matters,
        why_it_moved: cleanAgentString(answer.why_it_moved) || cleanAgentString(answer.likely_driver) || item.analyst.why_it_moved || item.analyst.likely_driver,
        what_it_means: cleanAgentString(answer.what_it_means) || cleanAgentString(answer.why_it_matters) || item.analyst.what_it_means || item.analyst.why_it_matters,
        signal_read: cleanAgentString(answer.signal_read) || item.analyst.signal_read,
        quote: cleanAgentString(answer.quote) || item.analyst.quote,
        confidence: cleanAgentString(answer.confidence) || item.analyst.confidence,
        uncertainty: cleanAgentString(answer.uncertainty) || item.analyst.uncertainty,
      },
    };
  });
  const validIds = new Set(topMoments.map((item) => item.id));
  const selected = preferPeakFirstSelection(enforceDistinctInsightTypes(agentReport.validation.selected
    .map((selection, index) => ({
      moment_id: String(selection.moment_id || ""),
      rank: Number(selection.rank) || index + 1,
      reason: cleanAgentString(selection.reason) || "",
    }))
    .filter((selection, index, arr) =>
      validIds.has(selection.moment_id) &&
      arr.findIndex((other) => other.moment_id === selection.moment_id) === index
    )
    .slice(0, 3), answers, topMoments), topMoments);
  if (!selected.length) return report;
  const rejected = Array.isArray(agentReport.validation.rejected)
    ? agentReport.validation.rejected.map((item) => ({
        moment_id: String(item.moment_id || ""),
        reason: cleanAgentString(item.reason) || "",
      })).filter((item) => validIds.has(item.moment_id))
    : report.validation.rejected;
  const validation = { selected, rejected };
  const finalInsights = selected
    .map((selection) => {
      const moment = topMoments.find((item) => item.id === selection.moment_id);
      return moment ? { ...moment, selection } : null;
    })
    .filter(Boolean);
  if (!finalInsights.length) return report;
  return {
    ...report,
    topMoments,
    finalInsights,
    validation,
    prompts: agentReport.prompts || report.prompts,
    agentMode: agentReport.agentMode || "anthropic_server_agent",
    model: agentReport.model || report.model,
    agentGeneratedAt: agentReport.generatedAt || report.agentGeneratedAt,
    agentCache: agentReport.source || report.agentCache,
  };
}

function cleanAgentString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRun(raw) {
  const dimensions = (raw.dimensions || [])
    .map((point) => ({
      t: Number(point.t),
      values: Object.fromEntries(DIMENSIONS.map((dim) => [dim, Number(point.values?.[dim]) || 0])),
    }))
    .filter((point) => Number.isFinite(point.t))
    .sort((a, b) => a.t - b.t);
  return {
    id: String(raw.id || "run"),
    title: String(raw.title || "Rep message"),
    transcriptText: String(raw.transcriptText || ""),
    transcriptWords: normalizeWords(raw.transcriptWords || []),
    transcriptSegments: normalizeSegments(raw.transcriptSegments || []),
    dimensions,
    alignment: {
      alignmentSource: raw.alignment?.alignmentSource || "text_estimate",
      hrfLagSec: Number(raw.alignment?.hrfLagSec ?? DEFAULT_HRF_LAG_SEC),
      generatedAudioDurationSec: Number(raw.alignment?.generatedAudioDurationSec ?? 0),
      analysisDurationSec: Number(raw.alignment?.analysisDurationSec ?? dimensions.at(-1)?.t ?? 0),
      trailingAudioPaddingSec: Number(raw.alignment?.trailingAudioPaddingSec ?? 0),
    },
  };
}

function normalizeCurves(input) {
  const byDimension = {};
  for (const dim of DIMENSIONS) {
    const rawValues = input.dimensions.map((point) => point.values[dim]).filter(Number.isFinite);
    const sorted = [...rawValues].sort((a, b) => a - b);
    const normalized = input.dimensions.map((point) => percentileRank(sorted, point.values[dim]));
    const smoothed = normalized.map((value, index, arr) =>
      mean(arr.slice(Math.max(0, index - 1), Math.min(arr.length, index + 2)))
    );
    byDimension[dim] = input.dimensions.map((point, index) => ({
      t: point.t,
      raw: point.values[dim],
      normalized: normalized[index],
      smoothed: smoothed[index],
    }));
  }
  return { byDimension };
}

function mineEvents(input, normalized) {
  const events = [];
  for (const dim of DIMENSIONS) {
    events.push(...detectSpikes(dim, input, normalized));
    events.push(...detectTroughs(dim, input, normalized));
    events.push(...detectSharpMoves(dim, input, normalized));
    events.push(...detectSustainedExtremes(dim, input, normalized));
    events.push(...detectDominance(dim, input, normalized));
  }
  events.push(...detectCrossovers(input, normalized));
  return dedupeEvents(events);
}

function detectSpikes(dim, input, normalized) {
  const series = normalized.byDimension[dim];
  const out = [];
  for (let i = 1; i < series.length - 1; i += 1) {
    const point = series[i];
    if (point.smoothed < 0.82) continue;
    if (point.smoothed < series[i - 1].smoothed || point.smoothed < series[i + 1].smoothed) continue;
    const contrast = Math.max(0, point.smoothed - localMedian(series, point.t));
    if (contrast < 0.1) continue;
    out.push(scoreEvent(input, normalized, {
      id: `${dim}-spike-${Math.round(point.t)}`,
      signalName: dim,
      eventShape: "spike",
      start: Math.max(0, point.t - 3),
      end: Math.min(input.alignment.analysisDurationSec, point.t + 4),
      peakTime: point.t,
      eventMagnitude: point.smoothed,
      localContrast: contrast,
      contributingDimensions: [dim],
    }));
  }
  return out;
}

function detectTroughs(dim, input, normalized) {
  const series = normalized.byDimension[dim];
  const out = [];
  for (let i = 1; i < series.length - 1; i += 1) {
    const point = series[i];
    if (point.smoothed > 0.18) continue;
    if (point.smoothed > series[i - 1].smoothed || point.smoothed > series[i + 1].smoothed) continue;
    const contrast = Math.max(0, localMedian(series, point.t) - point.smoothed);
    if (contrast < 0.1) continue;
    out.push(scoreEvent(input, normalized, {
      id: `${dim}-trough-${Math.round(point.t)}`,
      signalName: dim,
      eventShape: "trough",
      start: Math.max(0, point.t - 3),
      end: Math.min(input.alignment.analysisDurationSec, point.t + 4),
      peakTime: point.t,
      eventMagnitude: 1 - point.smoothed,
      localContrast: contrast,
      contributingDimensions: [dim],
    }));
  }
  return out;
}

function detectSharpMoves(dim, input, normalized) {
  const series = normalized.byDimension[dim];
  const out = [];
  for (let i = 3; i < series.length; i += 1) {
    const from = series[i - 3];
    const to = series[i];
    const delta = to.smoothed - from.smoothed;
    const magnitude = Math.abs(delta);
    if (magnitude < 0.25) continue;
    const shape = delta > 0 ? "sharp_rise" : "sharp_drop";
    const eventLevel = delta > 0 ? to.smoothed : from.smoothed;
    const contrast = Math.abs(eventLevel - localMedian(series, to.t));
    out.push(scoreEvent(input, normalized, {
      id: `${dim}-${shape}-${Math.round(to.t)}`,
      signalName: dim,
      eventShape: shape,
      start: Math.max(0, from.t),
      end: Math.min(input.alignment.analysisDurationSec, to.t + 2),
      peakTime: delta > 0 ? to.t : from.t,
      eventMagnitude: magnitude,
      localContrast: contrast,
      contributingDimensions: [dim],
    }));
  }
  return out;
}

function detectSustainedExtremes(dim, input, normalized) {
  const series = normalized.byDimension[dim];
  const events = [];
  pushRuns("sustained_high", (point) => point.smoothed >= 0.78);
  pushRuns("sustained_low", (point) => point.smoothed <= 0.22);
  return events;

  function pushRuns(shape, predicate) {
    let run = [];
    for (const point of series) {
      if (predicate(point)) run.push(point);
      else {
        push(run, shape);
        run = [];
      }
    }
    push(run, shape);
  }

  function push(run, shape) {
    if (run.length < 4) return;
    const values = run.map((point) => point.smoothed);
    const representative = shape === "sustained_high"
      ? run[values.indexOf(Math.max(...values))]
      : run[values.indexOf(Math.min(...values))];
    const magnitude = shape === "sustained_high" ? representative.smoothed : 1 - representative.smoothed;
    const contrast = Math.abs(representative.smoothed - localMedian(series, representative.t));
    events.push(scoreEvent(input, normalized, {
      id: `${dim}-${shape}-${Math.round(run[0].t)}`,
      signalName: dim,
      eventShape: shape,
      start: run[0].t,
      end: Math.min(input.alignment.analysisDurationSec, run.at(-1).t + 1),
      peakTime: representative.t,
      eventMagnitude: magnitude,
      localContrast: contrast,
      contributingDimensions: [dim],
    }));
  }
}

function detectDominance(dim, input, normalized) {
  const series = normalized.byDimension[dim];
  const out = [];
  for (let i = 0; i < series.length; i += 1) {
    const point = series[i];
    const others = DIMENSIONS
      .filter((other) => other !== dim)
      .map((other) => normalized.byDimension[other][i].smoothed)
      .sort((a, b) => b - a);
    const separation = point.smoothed - others[0];
    if (point.smoothed < 0.65 || separation < 0.2) continue;
    out.push(scoreEvent(input, normalized, {
      id: `${dim}-dominant-${Math.round(point.t)}`,
      signalName: dim,
      eventShape: "dominant_signal",
      start: Math.max(0, point.t - 3),
      end: Math.min(input.alignment.analysisDurationSec, point.t + 4),
      peakTime: point.t,
      eventMagnitude: separation,
      localContrast: separation,
      contributingDimensions: [dim],
    }));
  }
  return out;
}

function detectCrossovers(input, normalized) {
  const out = [];
  for (let a = 0; a < DIMENSIONS.length; a += 1) {
    for (let b = a + 1; b < DIMENSIONS.length; b += 1) {
      const dimA = DIMENSIONS[a];
      const dimB = DIMENSIONS[b];
      const seriesA = normalized.byDimension[dimA];
      const seriesB = normalized.byDimension[dimB];
      for (let i = 1; i < seriesA.length; i += 1) {
        const prev = seriesA[i - 1].smoothed - seriesB[i - 1].smoothed;
        const now = seriesA[i].smoothed - seriesB[i].smoothed;
        if (prev === 0 || now === 0 || Math.sign(prev) === Math.sign(now)) continue;
        const separation = Math.abs(now);
        if (separation < 0.14) continue;
        const winner = now > 0 ? dimA : dimB;
        out.push(scoreEvent(input, normalized, {
          id: `${winner}-crossover-${dimA}-${dimB}-${Math.round(seriesA[i].t)}`,
          signalName: winner,
          eventShape: "crossover",
          start: Math.max(0, seriesA[i - 1].t),
          end: Math.min(input.alignment.analysisDurationSec, seriesA[i].t + 3),
          peakTime: seriesA[i].t,
          eventMagnitude: separation,
          localContrast: Math.abs(now - prev),
          contributingDimensions: [dimA, dimB],
          crossoverPair: [dimA, dimB],
        }));
      }
    }
  }
  return out;
}

function scoreEvent(input, normalized, event) {
  const brainScore = 0.8 * clamp(event.eventMagnitude, 0, 1) + 0.2 * clamp(event.localContrast, 0, 1);
  return {
    ...event,
    start: clamp(event.start, 0, input.alignment.analysisDurationSec),
    end: clamp(event.end, 0, input.alignment.analysisDurationSec),
    peakTime: clamp(event.peakTime, 0, input.alignment.analysisDurationSec),
    brainScore,
  };
}

function clusterMoments(events) {
  const kept = [];
  for (const event of events) {
    const duplicate = kept.some((item) =>
      item.signalName === event.signalName &&
      Math.abs(item.peakTime - event.peakTime) <= 5
    );
    if (!duplicate) kept.push(event);
  }
  return kept;
}

function buildAnalystPacket(input, event, transcript, rank, normalized) {
  const surrounding = signalSnapshot(normalized, event.peakTime);
  return {
    moment_id: `moment_${String(rank).padStart(2, "0")}`,
    dimension: event.signalName,
    dimension_label: DIMENSION_LABELS[event.signalName],
    dimension_plain_english: DIMENSION_MEANING[event.signalName],
    event_shape: event.eventShape,
    brainScore: event.brainScore,
    eventMagnitude: event.eventMagnitude,
    localContrast: event.localContrast,
    response_window: [event.start, event.end],
    spoken_window_after_lag_correction: [transcript.stimulusStart, transcript.stimulusEnd],
    aligned_quote: transcript.quote,
    nearby_transcript: transcript.contextText,
    signal_observation: signalObservation(event),
    other_signal_context: surrounding,
  };
}

function runAnalystAgent(packet) {
  const label = packet.dimension_label;
  const quote = packet.aligned_quote;
  const movement = movementPhrase(packet.event_shape);
  const title = analystTitle(packet);
  return {
    moment_id: packet.moment_id,
    title,
    insight_type: insightTypeFor(packet),
    interpretation: `${title} The ${label} signal ${movement} around this phrase, which suggests this part of the message is doing more than simply continuing the script.`,
    likely_driver: driverSentence(packet, quote),
    why_it_matters: whyItMatters(packet),
    why_it_moved: driverSentence(packet, quote),
    what_it_means: whyItMatters(packet),
    signal_read: `${label} ${movement} after the lag-corrected phrase.`,
    quote,
    confidence: packet.brainScore >= 0.75 ? "high" : packet.brainScore >= 0.62 ? "medium" : "low",
    uncertainty: uncertaintyFor(packet),
  };
}

function insightTypeFor(packet) {
  const shape = String(packet.event_shape || "");
  if (shape.includes("trough") || shape.includes("low") || shape.includes("drop")) return "procedural_trough";
  if (packet.dimension === "gut_reaction") return "emotional_trigger";
  if (packet.dimension === "memory_encoding") return "memory_hook";
  if (packet.dimension === "social_thinking") return "social_context";
  if (packet.dimension === "language_depth") return "explanation_depth";
  if (packet.dimension === "attention") return "specificity";
  if (packet.dimension === "personal_resonance") return "pain_point";
  return "other";
}

function runValidatorAgent(topMoments) {
  const sorted = [...topMoments].sort((a, b) => b.event.brainScore - a.event.brainScore);
  const selected = [];
  const rejected = new Map();
  const usable = sorted.filter((item) => isUsableAgentAnswer(item));

  choose((item) => !sharesQuote(item, selected, topMoments) && !sharesInsightType(item, selected, topMoments));
  choose((item) => !sharesQuote(item, selected, topMoments) && !sharesDimension(item, selected, topMoments));
  choose((item) => !sharesQuote(item, selected, topMoments));
  choose(() => true);

  for (const item of sorted) {
    if (selected.some((selection) => selection.moment_id === item.id)) continue;
    rejected.set(item.id, {
      moment_id: item.id,
      reason: isUsableAgentAnswer(item)
        ? "Less useful than the selected set or redundant with another stronger moment."
        : "Weak transcript alignment for a final report item.",
    });
  }
  return { selected: preferPeakFirstSelection(selected, topMoments), rejected: [...rejected.values()] };

  function choose(predicate) {
    for (const item of usable) {
      if (selected.length >= 3) return;
      if (selected.some((selection) => selection.moment_id === item.id)) continue;
      if (!predicate(item)) continue;
      selected.push({
        moment_id: item.id,
        rank: selected.length + 1,
        reason: `Strong ${DIMENSION_LABELS[item.event.signalName]} movement with a clear transcript anchor and useful interpretation.`,
      });
    }
  }
}

function enforceDistinctInsightTypes(selected, answers, topMoments) {
  if (selected.length < 3 || !answers.length) return selected;
  const answerById = new Map(answers.map((answer) => [String(answer.moment_id || ""), answer]));
  const availableTypes = new Set(answers.map((answer) => normalizeInsightType(answer.insight_type)));
  if (availableTypes.size < 3) return selected;
  const output = [...selected];
  for (let guard = 0; guard < output.length; guard += 1) {
    const counts = countTypes(output, answerById);
    const duplicateIndex = output.findIndex((item, index) =>
      index > 0 && counts.get(normalizeInsightType(answerById.get(item.moment_id)?.insight_type)) > 1
    );
    if (duplicateIndex < 0) break;
    const usedTypes = new Set(output.map((item) => normalizeInsightType(answerById.get(item.moment_id)?.insight_type)));
    const replacement = answers.find((answer) => {
      const id = String(answer.moment_id || "");
      return id &&
        !output.some((item) => item.moment_id === id) &&
        !usedTypes.has(normalizeInsightType(answer.insight_type)) &&
        topMoments.some((moment) => moment.id === id);
    });
    if (!replacement) break;
    output[duplicateIndex] = {
      moment_id: String(replacement.moment_id),
      rank: output[duplicateIndex].rank,
      reason: `This adds a different read on the call: ${cleanAgentString(replacement.title || replacement.interpretation)}`,
    };
  }
  return output.map((item, index) => ({ ...item, rank: index + 1 }));
}

function countTypes(selected, answerById) {
  const counts = new Map();
  for (const item of selected) {
    const type = normalizeInsightType(answerById.get(item.moment_id)?.insight_type);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
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
    "other",
  ]);
  const text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return allowed.has(text) ? text : "other";
}

function preferPeakFirstSelection(selected, topMoments) {
  if (selected.length < 2) return selected.map((item, index) => ({ ...item, rank: index + 1 }));
  const byId = new Map(topMoments.map((item) => [item.id, item]));
  if (isPeakOrHighMoment(byId.get(selected[0].moment_id))) {
    return selected.map((item, index) => ({ ...item, rank: index + 1 }));
  }
  const peakIndex = selected.findIndex((item) => isPeakOrHighMoment(byId.get(item.moment_id)));
  if (peakIndex <= 0) {
    const selectedIds = new Set(selected.map((item) => item.moment_id));
    const externalPeak = topMoments.find((item) => !selectedIds.has(item.id) && isPeakOrHighMoment(item));
    if (!externalPeak) return selected.map((item, index) => ({ ...item, rank: index + 1 }));
    return [{
      moment_id: externalPeak.id,
      rank: 1,
      reason: `This gives the report its clearest high moment: ${externalPeak.analyst.title}`,
    }, ...selected.slice(1)].map((item, index) => ({ ...item, rank: index + 1 }));
  }
  const output = [...selected];
  const [peak] = output.splice(peakIndex, 1);
  return [peak, ...output].map((item, index) => ({ ...item, rank: index + 1 }));
}

function isPeakOrHighMoment(item) {
  if (!item) return false;
  const shape = String(item.event?.eventShape || item.packet?.event_shape || "").toLowerCase();
  return shape.includes("spike") ||
    shape.includes("rise") ||
    shape.includes("high") ||
    shape.includes("dominant") ||
    Number(item.event?.brainScore || item.packet?.brainScore) >= 0.72 && !shape.includes("low") && !shape.includes("trough") && !shape.includes("drop");
}

function isUsableAgentAnswer(item) {
  const wordCount = item.analyst.quote.split(/\s+/).filter(Boolean).length;
  return item.transcript.alignmentConfidence !== "low" && wordCount >= 3;
}

function sharesQuote(item, selected, topMoments) {
  return selected.some((selection) => {
    const picked = topMoments.find((candidate) => candidate.id === selection.moment_id);
    return picked && sameQuote(picked.analyst.quote, item.analyst.quote);
  });
}

function sharesDimension(item, selected, topMoments) {
  return selected.some((selection) => {
    const picked = topMoments.find((candidate) => candidate.id === selection.moment_id);
    return picked && picked.event.signalName === item.event.signalName;
  });
}

function sharesInsightType(item, selected, topMoments) {
  return selected.some((selection) => {
    const picked = topMoments.find((candidate) => candidate.id === selection.moment_id);
    return picked && picked.analyst.insight_type === item.analyst.insight_type;
  });
}

function resolveTranscript(event, input) {
  const lag = input.alignment.hrfLagSec;
  const stimulusStart = Math.max(0, event.start - lag);
  const stimulusEnd = Math.max(0, event.end - lag);
  const stimulusPeak = Math.max(0, event.peakTime - lag);
  const words = input.transcriptWords;
  if (words.length) {
    const peakWord = nearestWord(words, stimulusPeak);
    const localWords = words.filter((word) =>
      word.segmentId === peakWord?.segmentId &&
      word.end >= Math.max(0, stimulusPeak - 5) &&
      word.start <= stimulusPeak + 5
    );
    const quoteWords = trimWordWindow(localWords.length ? localWords : [peakWord].filter(Boolean), words, stimulusPeak);
    const contextWords = words.filter((word) =>
      word.end >= Math.max(0, stimulusStart - 8) &&
      word.start <= Math.min(input.alignment.generatedAudioDurationSec, stimulusEnd + 8)
    );
    return {
      stimulusStart,
      stimulusEnd,
      stimulusPeak,
      quote: wordsToText(quoteWords),
      quoteStart: quoteWords[0]?.start ?? stimulusStart,
      quoteEnd: quoteWords.at(-1)?.end ?? stimulusEnd,
      contextText: wordsToText(contextWords),
      alignmentConfidence: "word_exact",
    };
  }
  const segment = input.transcriptSegments.find((seg) => seg.start <= stimulusPeak && seg.end >= stimulusPeak);
  return {
    stimulusStart,
    stimulusEnd,
    stimulusPeak,
    quote: segment?.text || "",
    quoteStart: segment?.start ?? stimulusStart,
    quoteEnd: segment?.end ?? stimulusEnd,
    contextText: segment?.text || "",
    alignmentConfidence: segment ? "segment_level" : "low",
  };
}

function signalObservation(event) {
  const label = DIMENSION_LABELS[event.signalName];
  if (event.eventShape === "sharp_rise") return `${label} rose sharply.`;
  if (event.eventShape === "sharp_drop") return `${label} fell sharply.`;
  if (event.eventShape === "trough") return `${label} reached an unusually low point.`;
  if (event.eventShape === "sustained_high") return `${label} stayed elevated.`;
  if (event.eventShape === "sustained_low") return `${label} stayed low.`;
  if (event.eventShape === "crossover") return `${label} crossed past another signal.`;
  if (event.eventShape === "dominant_signal") return `${label} separated from the other signals.`;
  return `${label} spiked.`;
}

function movementPhrase(shape) {
  if (shape === "sharp_rise") return "rose sharply";
  if (shape === "sharp_drop") return "fell sharply";
  if (shape === "trough") return "reached a low point";
  if (shape === "sustained_high") return "stayed high";
  if (shape === "sustained_low") return "stayed low";
  if (shape === "crossover") return "crossed past another signal";
  if (shape === "dominant_signal") return "stood apart from the other signals";
  return "spiked";
}

function analystTitle(packet) {
  const dim = packet.dimension;
  const low = packet.event_shape === "trough" || packet.event_shape === "sustained_low" || packet.event_shape === "sharp_drop";
  if (dim === "attention") return low ? "Focus dipped here." : "This is where attention concentrated.";
  if (dim === "memory_encoding") return low ? "The memory signal dipped here." : "This is the part most likely to stick.";
  if (dim === "gut_reaction") return low ? "The immediate reaction cooled here." : "This is where the message produced a gut-level shift.";
  if (dim === "brain_effort") return low ? "The message became easier to process here." : "The message became heavier to process.";
  if (dim === "personal_resonance") return low ? "Personal relevance dipped here." : "This moment felt more personally situated.";
  if (dim === "social_thinking") return low ? "People and intent mattered less here." : "The message pulled other people into the listener's frame.";
  if (dim === "language_depth") return low ? "The meaning got lighter here." : "The explanation stood out here.";
  return "A clear brain-signal shift appeared here.";
}

function driverSentence(packet, quote) {
  const cleanQuote = quote || "the selected phrase";
  return `The likely driver is the idea carried by "${cleanQuote}", because that phrase is the closest lag-corrected transcript anchor to the signal movement.`;
}

function whyItMatters(packet) {
  return `This is useful because it tells the report reader where the message changed the predicted ${packet.dimension_plain_english}, not just where the transcript sounded important.`;
}

function uncertaintyFor(packet) {
  if (packet.event_shape === "sharp_drop" || packet.event_shape === "trough") {
    return "A downward movement is not automatically negative; it only marks a meaningful change in this signal.";
  }
  return "This does not prove listener agreement, intent, or future behavior; it explains where the signal lines up with the message.";
}

function signalSnapshot(normalized, time) {
  return Object.fromEntries(DIMENSIONS.map((dim) => {
    const point = nearestPoint(normalized.byDimension[dim], time);
    return [dim, Number(point?.smoothed?.toFixed(3) || 0)];
  }));
}

function trimWordWindow(selected, words, peakTime) {
  if (!selected.length) return [];
  const peak = nearestWord(selected, peakTime) || selected[0];
  const peakIndex = words.indexOf(peak);
  let start = Math.max(0, peakIndex - 7);
  let end = Math.min(words.length - 1, peakIndex + 9);
  const segmentId = peak.segmentId;
  while (start < end && words[start].segmentId !== segmentId) start += 1;
  while (end > start && words[end].segmentId !== segmentId) end -= 1;
  while (
    end < words.length - 1 &&
    words[end + 1].segmentId === segmentId &&
    (!/[.!?]$/.test(words[end].word) || isWeakEndingWord(words[end].word)) &&
    end - start < 30
  ) {
    end += 1;
  }
  return words.slice(start, end + 1);
}

function normalizeWords(words) {
  return words.map((word, index) => ({
    word: String(word.word || ""),
    start: Number(word.start),
    end: Number(word.end),
    segmentId: String(word.segmentId ?? ""),
    index,
  })).filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end));
}

function normalizeSegments(segments) {
  return segments.map((segment) => ({
    id: String(segment.id),
    start: Number(segment.start),
    end: Number(segment.end),
    text: String(segment.text || ""),
  })).filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.signalName}-${event.eventShape}-${Math.round(event.peakTime)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localMedian(series, time) {
  return median(series.filter((point) => Math.abs(point.t - time) <= 6).map((point) => point.smoothed));
}

function nearestPoint(points, time) {
  return points.reduce((best, point) => Math.abs(point.t - time) < Math.abs(best.t - time) ? point : best, points[0]);
}

function nearestWord(words, time) {
  if (!words.length) return null;
  return words.reduce((best, word) => Math.abs(midpoint(word.start, word.end) - time) < Math.abs(midpoint(best.start, best.end) - time) ? word : best, words[0]);
}

function wordsToText(words) {
  return words.map((word) => word.word).join(" ").replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
}

function isWeakEndingWord(word) {
  return /^(and|or|but|because|so|then|that|this|the|a|an|to|of|in|on|with|for|from)$/i.test(
    String(word || "").replace(/[^\w'-]+$/g, "")
  );
}

function percentileRank(sorted, value) {
  if (!sorted.length) return 0.5;
  let below = 0;
  let equal = 0;
  for (const item of sorted) {
    if (item < value) below += 1;
    else if (item === value) equal += 1;
  }
  return clamp((below + equal * 0.5) / sorted.length, 0, 1);
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function midpoint(start, end) {
  return start + (end - start) / 2;
}

function sameQuote(a, b) {
  return String(a || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ===
    String(b || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
