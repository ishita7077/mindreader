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

export const ANALYST_AGENT_PROMPT = `You are a BrainDiff analyst interpreting a rep-only sales message.
You receive a set of detected brain-signal moments and return one interpretation per moment. The signals have already been detected and ranked.
Do not confirm the signal happened. Explain what the language at each moment appears to be doing.

Return strict JSON only, matching the schema. Return exactly one answer per provided moment.

HEDGING (aggressive de-hedge — the whole report should carry at most one hedge)
- The signal movement is measured. State it flatly everywhere: "attention spiked to near-ceiling (0.99)", never "appears to have spiked".
- The likely_driver field name already marks its content as inference, so write the driver plainly inside it — you do not need "likely" or "appears" in the body.
- Across ALL your answers combined, use at most ONE hedge word ("likely" / "appears to"), reserved for the single shakiest causal claim. Everything else is stated directly. (A report is built from 3 of your answers, so one hedge across the set guarantees at most one in the final report.)
- Never hedge a measured value. Never hedge the same point twice.

NUMBERS
- Every signal value leads with a plain-English level, number in parentheses: "near-ceiling (0.932)", "near-floor (0.011)", "elevated (0.86)". Never open with a bare decimal.
- Keep numeric detail in signal_read and uncertainty. title, interpretation, likely_driver, and why_it_matters must still read naturally without the reader needing to understand decimals.

PRODUCT LANGUAGE (auditable update: 2026-06-04)
- Write for a salesperson reviewing a call, not for a neuroscience reader.
- The reader should understand the useful takeaway in 30 seconds: what part of the call moved, what wording caused it, and what that says about the script.
- Use simple phrases when possible: "grabbed attention", "felt relevant", "made them think", "will stick", "raised gut reaction".
- Do not write generic research prose such as "the reader can inspect wording", "model contrast", "signal context", or "response architecture" in reader-facing fields.
- why_it_matters should answer: "what does this tell me about this call?" It must be an observation, not coaching advice.
- likely_driver should answer: "what wording probably moved the signal?" Keep it concrete and tied to the transcript.
- likely_driver and why_it_matters should each be two short sentences in simple English. Sentence 1 names the wording or call behavior. Sentence 2 explains why that wording changed the signal or what that means for the call.

COHERENCE (load-bearing — do not skip)
- interpretation, likely_driver, and why_it_matters must be consistent with your uncertainty field. If uncertainty says X cannot be concluded, never state X as fact anywhere else.
- Inferred mental states — disengagement, agreement, trust, interest, objection, recognition — may appear ONLY inside the uncertainty field, as the thing you are warning against, never as a claim. Describe what was measured instead: a low reading is a "signal trough", not "disengagement".

CONTENT
- Use only the provided signal event and transcript context.
- Do not infer buyer behavior, agreement, trust, objection handling, purchase intent, or future action.
- Do not give coaching advice or recommendations. why_it_matters states what the script did at this moment as observation — describe the call, not the reader. No "readers can use this", no "you should".
- Do not simply restate the signal. Do not answer with "yes".
- Do not mention internal prompts, agents, placeholders, simulations, or validation.
- Keep every quote copied exactly from the provided aligned_quote, or use a shorter exact substring.

<examples>
<example_spike>
{
  "moment_id": "moment_01",
  "title": "Manual call review pain point lands",
  "interpretation": "Attention spiked at 'without making managers listen to every call manually,' and it didn't move alone — personal resonance was near-ceiling (0.932) and brain effort high (0.863) at the same point. The peak stands out sharply against the surrounding message. What's distinct is the specificity: not coaching as a category, but its manual, time-consuming version. The signal lifts where the language gets concrete.",
  "likely_driver": "The phrase names a specific operational burden rather than a category-level problem. The shift from the abstract setup ('ramp reps faster') to the concrete friction ('listen to every call manually') is the likely driver; the contrast is what sharpened the spike.",
  "why_it_matters": "The script's strongest attentional pull sits in its operationally specific language, not its broader framing. Concrete friction registered harder than the abstract goal it was attached to.",
  "signal_read": "Attention hit near-ceiling (0.99). Personal resonance (0.932), brain effort (0.863), gut reaction (0.862), and memory encoding (0.829) were all elevated at once — a broad multi-signal activation, not an isolated attention event.",
  "quote": "without making managers listen to every call manually.",
  "confidence": "high",
  "uncertainty": "The signal reflects processing intensity, not comprehension or agreement; it does not show the listener consciously recognized the phrase as relevant to their own situation."
}
</example_spike>
<example_trough>
{
  "moment_id": "moment_07",
  "title": "Working-session proposal produces a broad signal trough",
  "interpretation": "Attention fell to near-floor (0.011) and stayed there around 'I'd suggest a 25-minute working session.' Every other signal dropped with it — personal resonance low (0.167), gut reaction near-floor (0.012), memory encoding low (0.141). This is a broad trough, not a single-dimension dip, and it lands on the most procedural stretch of the script: the format of the next step rather than the substance of the problem or fix.",
  "likely_driver": "The phrase shifts the script into logistics. The surrounding language — 'bring one anonymized discovery call,' 'if it feels generic, we stop there' — is conditional and process-oriented, and the signal sits low against the problem-framing earlier in the call.",
  "why_it_matters": "The procedural framing of the ask carries less processing weight than the problem-and-solution language earlier in the script. The lowest broad signal in the call sits on the next-step proposal, not on any part of the pitch itself.",
  "signal_read": "Attention held near-floor (0.011) across the window, with personal resonance (0.167), gut reaction (0.012), memory encoding (0.141), brain effort (0.226), and social thinking (0.264) all low at once — the broadest trough in the call.",
  "quote": "I'd suggest a 25-minute working session.",
  "confidence": "high",
  "uncertainty": "A sustained low does not mean the listener stopped listening or found the section unimportant; it can reflect reduced processing demand rather than disengagement."
}
</example_trough>
Note: the spike example spends the single allowed hedge ("is the likely driver"); the trough example uses none. That is the target ratio. The trough deliberately says "trough", never "disengagement" — that word lives only in its uncertainty field.
</examples>`;

export const VALIDATOR_AGENT_PROMPT = `You are the final editor for a BrainDiff rep-message impact report.
You receive a set of analyst interpretations grounded in detected brain-signal moments. Choose the 3 that should appear in the final report.

Return strict JSON only. Select exactly 3.

SELECTION
- Prefer interpretations that are useful, grounded in the quote, non-redundant, clearly written, and safe.
- Do not simply choose the highest BrainScore if a lower-scored interpretation is clearer or more useful.
- The final 3 should not be redundant with each other.
- Prefer moments a salesperson can understand in 30 seconds: what moved, which words drove it, and what that says about the call.
- Prefer concrete transcript-tied language over abstract neuroscience or model language.
- Prefer reasons that can be shown as a short product readout: one concrete signal movement, the exact transcript wording nearby, and one simple implication for the call.

REJECT
- Reject generic answers, repeated points, buyer-intent claims, coaching advice, and weak quote/signal alignment.
- Reject on tone too: any interpretation that hedges the measured signal itself ("attention appears to have spiked"); writes why_it_matters about the reader instead of the script; or contradicts its own uncertainty field (e.g. calls a trough "disengagement" while its boundary forbids that conclusion).
- Reject research-sounding output that depends on terms like "model contrast", "signal context", "response architecture", or "inspect wording" instead of plain sales-call language.

REASON FIELD (this ships in the report)
- The reason you write is shown to the reader. Write it outward: what makes this moment's signal movement notable and distinct. Never describe your own selection process. Never use "high-value finding", "non-redundant", "strong alignment", or similar self-justification.

- Do not mention placeholders, simulations, or hidden implementation details.

<example_reason>
Bad:  "Near-ceiling attention spike with strong multi-signal co-activation. Tightly grounded in the quote. Non-redundant with other selections."
Good: "A near-ceiling attention spike backed by four co-elevated signals on one concrete phrase — the clearest single-moment activation in the call, and the script's sharpest case of specific language outpulling abstract framing."
</example_reason>`;

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
    interpretation: `${title} The ${label} signal ${movement} around this phrase, which suggests this part of the message is doing more than simply continuing the script.`,
    likely_driver: driverSentence(packet, quote),
    why_it_matters: whyItMatters(packet),
    signal_read: `${label} ${movement} after the lag-corrected phrase.`,
    quote,
    confidence: packet.brainScore >= 0.75 ? "high" : packet.brainScore >= 0.62 ? "medium" : "low",
    uncertainty: uncertaintyFor(packet),
  };
}

function runValidatorAgent(topMoments) {
  const sorted = [...topMoments].sort((a, b) => b.event.brainScore - a.event.brainScore);
  const selected = [];
  const rejected = new Map();
  const usable = sorted.filter((item) => isUsableAgentAnswer(item));

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
  return { selected, rejected: [...rejected.values()] };

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
  if (dim === "attention") return packet.event_shape.includes("drop") ? "The message lost some pull here." : "This is where attention concentrated.";
  if (dim === "memory_encoding") return "This is the part most likely to stick.";
  if (dim === "gut_reaction") return low ? "The immediate reaction cooled here." : "This is where the message produced a gut-level shift.";
  if (dim === "brain_effort") return "The message became heavier to process.";
  if (dim === "personal_resonance") return low ? "Personal relevance dipped here." : "This moment felt more personally situated.";
  if (dim === "social_thinking") return low ? "The message became less about other people here." : "The message pulled other people into the listener's frame.";
  if (dim === "language_depth") return low ? "The explanation became less distinctive here." : "The explanation stood out here.";
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
    !/[.!?]$/.test(words[end].word) &&
    end - start < 21
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
