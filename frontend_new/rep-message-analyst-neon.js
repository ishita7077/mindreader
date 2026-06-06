import { mountCortex } from "./assets/cortex-viewer-neon.js?v=28";
import {
  DIMENSION_LABELS,
  applyAgentReport,
  buildRepMessageAnalystReport,
} from "./rep-message-analyst-core.mjs";

const COLORS = {
  personal_resonance: "#7af4de",
  attention: "#5aa2ff",
  brain_effort: "#a994ff",
  gut_reaction: "#ff6f8e",
  memory_encoding: "#ffd94a",
  social_thinking: "#ff914d",
  language_depth: "#84d6ff",
};

const DIMENSION_QUESTIONS = {
  personal_resonance: "Did this feel relevant?",
  attention: "Did this pull focus?",
  brain_effort: "Did this make them think?",
  gut_reaction: "Did this hit instinctively?",
  memory_encoding: "Will this stick?",
  social_thinking: "Did this make people matter?",
  language_depth: "Was the meaning clear?",
};

const DIMENSION_TAGLINES = {
  personal_resonance: "Felt relevant",
  attention: "Grabbed attention",
  brain_effort: "Made them think",
  gut_reaction: "Triggered instinct",
  memory_encoding: "Will stick",
  social_thinking: "Read intent",
  language_depth: "Meaning was clear",
};

const DIMENSION_ORDER = Object.keys(DIMENSION_LABELS).sort((a, b) => DIMENSION_LABELS[a].localeCompare(DIMENSION_LABELS[b]));

const PLAYBACK_SECONDS_PER_SECOND = 2.15;
const LONG_TRANSCRIPT_WORD_LIMIT = 58;

const params = new URLSearchParams(location.search);
const jobId = params.get("jobId") || params.get("job_id") || params.get("job");
const resultSide = String(params.get("side") || "a").toLowerCase() === "b" ? "b" : "a";
let runId = params.get("run") || "maya";
let isJobReport = Boolean(jobId);
let report = null;
let cortex = null;
let activeInsightId = null;
let scrubTime = 0;
let activeDimension = "attention";
let activeChartDimensions = new Set(["attention"]);
let momentChartDimensions = new Map();
let scrubPlaying = false;
let scrubRaf = null;
let playbackStartedAt = 0;
let playbackStartedFrom = 0;
let lastHeroTranscriptKey = "";
let lastScrubBarsKey = "";
let pendingAgentHydration = null;

const app = document.querySelector("#app");
boot();

async function boot() {
  try {
    report = await loadReport();
    activeInsightId = report.finalInsights[0]?.id || null;
    scrubTime = activeInsight()?.event.peakTime || 0;
    activeDimension = activeInsight()?.event.signalName || "attention";
    render();
    await mountBrain();
    await hydrateReportAfterFirstPaint();
  } catch (error) {
    app.innerHTML = `<section class="error"><p class="eyebrow">Report failed</p><h1>${esc(error.message)}</h1></section>`;
  }
}

async function hydrateReportAfterFirstPaint() {
  if (!pendingAgentHydration) return;
  try {
    const hydrated = await pendingAgentHydration;
    pendingAgentHydration = null;
    if (!hydrated || !report || hydrated.input?.id !== report.input?.id) return;
    const previousInsightId = activeInsightId;
    const previousDimension = activeDimension;
    report = hydrated;
    activeInsightId = report.finalInsights.some((item) => item.id === previousInsightId)
      ? previousInsightId
      : report.finalInsights[0]?.id || null;
    activeDimension = DIMENSION_LABELS[previousDimension]
      ? previousDimension
      : activeInsight()?.event.signalName || "attention";
    lastHeroTranscriptKey = "";
    lastScrubBarsKey = "";
    render();
    await mountBrain();
  } catch (error) {
    console.warn("BrainDiff report hydration failed after first paint", error);
  }
}

async function loadReport() {
  if (jobId) {
    return loadJobReport(jobId, resultSide);
  }

  const id = runId;
  const generated = await fetch(`/data/rep-message-analyst/${encodeURIComponent(id)}.json`, { cache: "no-store" });
  if (generated.ok) return generated.json();

  const raw = await fetch(`/data/rep-message-impact/${encodeURIComponent(id)}.json`, { cache: "no-store" }).then((res) => {
    if (!res.ok) throw new Error(`Could not load run '${id}'.`);
    return res.json();
  });
  return buildRepMessageAnalystReport(raw);
}

async function loadJobReport(id, side) {
  const response = await fetch(`/api/diff/status/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load job '${id}' (HTTP ${response.status}).`);
  const job = await response.json();
  if (job.status === "error") {
    throw new Error(job.error?.message || "This run failed before returning a result.");
  }
  if (job.status !== "done") {
    throw new Error("This run is not finished yet. Open the run page and wait for completion.");
  }
  const workerResult = job.result || {};
  const baseReport = buildRepMessageAnalystReport(adaptWorkerJobToSingleRun(job, side));
  const embeddedAgentReport = workerResult.single_report || workerResult.meta?.single_report || null;
  if (embeddedAgentReport) return applyAgentReport(baseReport, embeddedAgentReport);
  pendingAgentHydration = hydrateAgentReport(baseReport, id, side);
  return baseReport;
}

async function hydrateAgentReport(baseReport, id, side) {
  const payload = {
    jobId: id,
    side,
    input: {
      id: baseReport.input.id,
      title: baseReport.input.title,
      durationSec: baseReport.input.alignment.generatedAudioDurationSec || baseReport.input.alignment.analysisDurationSec || 0,
    },
    topMoments: baseReport.topMoments.slice(0, 7).map((item) => ({
      id: item.id,
      rank: item.rank,
      event: item.event,
      packet: item.packet,
      transcript: {
        quote: item.transcript?.quote || "",
        contextText: item.transcript?.contextText || "",
        stimulusStart: item.transcript?.stimulusStart,
        stimulusEnd: item.transcript?.stimulusEnd,
        stimulusPeak: item.transcript?.stimulusPeak,
      },
      localAnalyst: item.analyst,
    })),
  };
  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 55_000);
    const response = await fetch("/api/diff/status/report-agent?report_agent=1", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.warn("BrainDiff agent report unavailable", response.status, await response.text().catch(() => ""));
      return { ...baseReport, agentError: `agent_http_${response.status}` };
    }
    const data = await response.json();
    return applyAgentReport(baseReport, data.report || data);
  } catch (error) {
    console.warn("BrainDiff agent report failed", error);
    return { ...baseReport, agentError: error?.message || String(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function adaptWorkerJobToSingleRun(job, side) {
  const result = job.result || {};
  const meta = result.meta || {};
  const runType = String(meta.run_type || result.run_type || "").toLowerCase();
  if (runType === "single" || hasSingleDimensionSeries(result.dimensions || [])) {
    const transcript =
      meta.transcript ||
      meta.text ||
      result.transcript ||
      "";
    if (!String(transcript).trim()) {
      throw new Error("This completed job does not include transcript data.");
    }
    const displayName =
      meta.display_name ||
      meta.media_name ||
      meta.media_filename ||
      meta.modality ||
      "Completed BrainDiff run";
    const seriesLength = singleWorkerSeriesLength(result.dimensions || []);
    const duration = Math.max(
      Number(meta.text_timesteps || meta.media_duration_s || 0),
      seriesLength - 1,
      1
    );
    const dimensions = adaptSingleDimensionSeries(result.dimensions || [], duration);
    if (!dimensions.length) {
      throw new Error("This completed job does not include the seven brain-signal timelines needed for the neon report.");
    }
    const transcriptSegments = adaptTranscriptSegments(meta.transcript_segments, transcript, duration);
    const transcriptWords = buildWordTimings(transcriptSegments, transcript, duration);
    return {
      id: String(job.job_id || jobId || "job"),
      title: String(displayName || "Completed BrainDiff run"),
      transcriptText: transcript,
      transcriptWords,
      transcriptSegments,
      dimensions,
      alignment: {
        alignmentSource: meta.pipeline || meta.modality || "worker_result",
        hrfLagSec: 5,
        generatedAudioDurationSec: duration,
        analysisDurationSec: duration,
        trailingAudioPaddingSec: 0,
      },
    };
  }
  const prefix = side === "b" ? "b" : "a";
  const transcript =
    meta[`transcript_${prefix}`] ||
    meta[`text_${prefix}`] ||
    result[`transcript_${prefix}`] ||
    "";
  if (!transcript.trim()) {
    throw new Error(`This completed job does not include transcript ${prefix.toUpperCase()} data.`);
  }

  const displayName =
    meta[`display_name_${prefix}`] ||
    meta[`media_name_${prefix}`] ||
    `${meta.modality || "Input"} ${prefix.toUpperCase()}`;
  const seriesLength = workerSeriesLength(result.dimensions || [], prefix);
  const duration = Math.max(
    Number(meta[`${prefix === "a" ? "text_a" : "text_b"}_timesteps`] || 0),
    seriesLength - 1,
    1
  );
  const dimensions = adaptDimensionSeries(result.dimensions || [], prefix, duration);
  if (!dimensions.length) {
    throw new Error("This completed job does not include the seven brain-signal timelines needed for the neon report.");
  }

  const transcriptSegments = adaptTranscriptSegments(meta[`transcript_segments_${prefix}`], transcript, duration);
  const transcriptWords = buildWordTimings(transcriptSegments, transcript, duration);

  return {
    id: String(job.job_id || jobId || "job"),
    title: String(displayName || "Completed BrainDiff run"),
    transcriptText: transcript,
    transcriptWords,
    transcriptSegments,
    dimensions,
    alignment: {
      alignmentSource: meta.pipeline || meta.modality || "worker_result",
      hrfLagSec: 5,
      generatedAudioDurationSec: duration,
      analysisDurationSec: duration,
      trailingAudioPaddingSec: 0,
    },
  };
}

function hasSingleDimensionSeries(workerDimensions) {
  return Array.isArray(workerDimensions) && workerDimensions.some((item) => Array.isArray(item?.timeseries));
}

function singleWorkerSeriesLength(workerDimensions) {
  return Math.max(0, ...workerDimensions.map((item) => Array.isArray(item?.timeseries) ? item.timeseries.length : 0));
}

function workerSeriesLength(workerDimensions, side) {
  const seriesKey = side === "b" ? "timeseries_b" : "timeseries_a";
  return Math.max(0, ...workerDimensions.map((item) => Array.isArray(item?.[seriesKey]) ? item[seriesKey].length : 0));
}

function adaptSingleDimensionSeries(workerDimensions, duration) {
  const byDim = new Map();
  let maxLen = 0;
  for (const item of workerDimensions) {
    const key = normalizeWorkerDimensionKey(item?.key || item?.dimension);
    if (!DIMENSION_LABELS[key]) continue;
    const values = Array.isArray(item?.timeseries) ? item.timeseries.map(Number).filter(Number.isFinite) : [];
    if (!values.length) continue;
    byDim.set(key, values);
    maxLen = Math.max(maxLen, values.length);
  }
  if (!maxLen) return [];
  return Array.from({ length: maxLen }, (_, index) => {
    const t = maxLen === 1 ? 0 : (index / (maxLen - 1)) * duration;
    const values = Object.fromEntries(Object.keys(DIMENSION_LABELS).map((dim) => {
      const arr = byDim.get(dim) || [];
      return [dim, Number.isFinite(arr[index]) ? arr[index] : Number.isFinite(arr.at(-1)) ? arr.at(-1) : 0];
    }));
    return { t, values };
  });
}

function adaptDimensionSeries(workerDimensions, side, duration) {
  const seriesKey = side === "b" ? "timeseries_b" : "timeseries_a";
  const byDim = new Map();
  let maxLen = 0;
  for (const item of workerDimensions) {
    const key = normalizeWorkerDimensionKey(item?.key);
    if (!DIMENSION_LABELS[key]) continue;
    const values = Array.isArray(item?.[seriesKey]) ? item[seriesKey].map(Number).filter(Number.isFinite) : [];
    if (!values.length) continue;
    byDim.set(key, values);
    maxLen = Math.max(maxLen, values.length);
  }
  if (!maxLen) return [];
  return Array.from({ length: maxLen }, (_, index) => {
    const t = maxLen === 1 ? 0 : (index / (maxLen - 1)) * duration;
    const values = Object.fromEntries(Object.keys(DIMENSION_LABELS).map((dim) => {
      const arr = byDim.get(dim) || [];
      return [dim, Number.isFinite(arr[index]) ? arr[index] : Number.isFinite(arr.at(-1)) ? arr.at(-1) : 0];
    }));
    return { t, values };
  });
}

function normalizeWorkerDimensionKey(key) {
  const value = String(key || "").trim();
  if (value === "attention_salience") return "attention";
  if (value === "cognitive_control") return "brain_effort";
  if (value === "visceral_response") return "gut_reaction";
  return value;
}

function adaptTranscriptSegments(rawSegments, transcript, duration) {
  if (Array.isArray(rawSegments) && rawSegments.length) {
    const normalized = rawSegments
      .map((segment, index) => ({
        id: String(segment.id ?? index),
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text || segment.transcript || ""),
      }))
      .filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
    if (normalized.length) return normalized;
  }

  const sentences = splitSentences(transcript);
  const totalChars = Math.max(1, sentences.reduce((sum, sentence) => sum + sentence.length, 0));
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const span = Math.max(0.8, (sentence.length / totalChars) * duration);
    const start = cursor;
    const end = index === sentences.length - 1 ? duration : Math.min(duration, start + span);
    cursor = end;
    return { id: String(index), start, end, text: sentence };
  });
}

function buildWordTimings(segments, transcript, duration) {
  const sourceSegments = segments.length ? segments : [{ id: "0", start: 0, end: duration, text: transcript }];
  const words = [];
  for (const segment of sourceSegments) {
    const tokens = String(segment.text || "").match(/\S+/g) || [];
    const span = Math.max(0.1, Number(segment.end) - Number(segment.start));
    tokens.forEach((word, index) => {
      const start = Number(segment.start) + (index / Math.max(1, tokens.length)) * span;
      const end = Number(segment.start) + ((index + 1) / Math.max(1, tokens.length)) * span;
      words.push({
        word,
        start,
        end,
        segmentId: String(segment.id),
        index: words.length,
      });
    });
  }
  return words;
}

function splitSentences(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const matches = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function trimTerminalPunctuation(text) {
  return String(text || "").trim().replace(/[.!?]+$/, "");
}

function trimToSentences(text, maxSentences = 2) {
  const sentences = splitSentences(text);
  return sentences.slice(0, maxSentences).join(" ").trim();
}

async function mountBrain() {
  const canvas = document.querySelector("#reportBrain");
  if (!canvas) return;
  if (cortex) cortex.dispose();
  const active = activeInsight();
  try {
    cortex = await mountCortex({
      canvas,
      roiHighlight: activeDimension || active?.event.signalName || "attention",
      cameraDistance: 6.35,
    });
    updateBrainScrubber();
  } catch (error) {
    cortex = null;
    const wrap = document.querySelector(".brain-canvas-wrap");
    if (wrap) {
      wrap.innerHTML = `<div class="brain-fallback"><b>Brain activity surface</b><span>Signal evidence remains available below.</span></div>`;
    }
  }
}

function render() {
  const selected = report.finalInsights;
  const active = activeInsight() || selected[0];
  document.title = `BrainDiff - ${report.input.title} analyst report`;
  app.innerHTML = `
    <div class="page">
      <header class="topbar">
        <a class="brand" href="/"><span class="brand-mark"></span>BrainDiff</a>
        <div class="top-readout">
          <span class="live-dot"></span>
          <span>Live readout</span>
          <span class="readout-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span>${formatTime(report.input.alignment.generatedAudioDurationSec || report.input.alignment.analysisDurationSec)}</span>
          <span>Single call</span>
        </div>
        ${isJobReport ? `<div class="job-chip">Job · ${esc(short(report.input.id))}</div>` : `
          <nav class="run-switch" aria-label="Run switcher">
            ${switchButton("maya", "Maya")}
            ${switchButton("rahul", "Rahul")}
          </nav>
        `}
      </header>

      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow"><span class="eyebrow-dot"></span> BrainDiff · Neural response engine</p>
          <h1>What the <span>brain</span> heard.</h1>
          <h2 class="hero-subtitle">${esc(active?.analyst.title || "Whole-call response trace")}</h2>
          <p class="hero-metric"><span data-scrub-dimension>${esc(DIMENSION_LABELS[activeDimension])}</span> · score <b data-scrub-score>${active?.event.brainScore.toFixed(2) || "--"}</b> · <span data-scrub-shape>${esc(active?.event.eventShape.replaceAll("_", " ") || "signal")}</span></p>
          ${renderDimensionControls()}
          ${renderHeroScrubber(active)}
          ${renderHeroTranscript()}
          <div class="hero-cards">
            ${selected.slice(1, 3).map((item, index) => renderHeroNudge(item, index)).join("")}
            <button class="hero-card appendix-jump" type="button" data-scroll-target=".appendix">
              <span>Appendix</span>
              <b>Open the full signal view.</b>
              <small>Timeline and pairing maps for a deeper read.</small>
            </button>
          </div>
        </div>
        <aside class="brain-panel">
          <div class="neural-field" aria-hidden="true">
            <span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span><span class="spark s4"></span>
            <span class="spark s5"></span><span class="spark s6"></span><span class="spark s7"></span><span class="spark s8"></span>
            <span class="thread t1"></span><span class="thread t2"></span><span class="thread t3"></span><span class="thread t4"></span>
            <span class="branch b1"></span><span class="branch b2"></span><span class="branch b3"></span><span class="branch b4"></span><span class="branch b5"></span><span class="branch b6"></span>
          </div>
          <div class="brain-canvas-wrap">
            <div class="mesh-badge">Real fsaverage5 · 20,484 vertices</div>
            <canvas id="reportBrain" aria-label="Interactive BrainDiff cortical surface"></canvas>
            <div class="brain-front-field" aria-hidden="true">
              <span class="front-filament f1"></span><span class="front-filament f2"></span><span class="front-filament f3"></span>
              <span class="front-filament f4"></span><span class="front-filament f5"></span>
              <span class="contact-node c1"></span><span class="contact-node c2"></span><span class="contact-node c3"></span><span class="contact-node c4"></span>
              <span class="contact-node c5"></span><span class="contact-node c6"></span>
            </div>
          </div>
          <div class="brain-orb-readout"><span data-orb-dimension>${esc(shortLabel(activeDimension))}</span><i></i><b data-orb-value>${Math.round((nearest(report.normalized.byDimension[activeDimension], scrubTime)?.smoothed ?? 0) * 100)}%</b></div>
        </aside>
      </section>

      <section>
        <div class="section-head report-head">
          <div><p class="eyebrow">Report</p><h2>Final Report</h2></div>
        </div>
        ${renderCallSpine(selected)}
      </section>

      <section class="appendix" aria-label="Appendix">
        <div class="section-head compact">
          <div><p class="eyebrow">Appendix</p><h2>Signal Timeline</h2></div>
          <p>Pick a signal to see its timeline.</p>
        </div>
        ${renderAppendixActivity()}
        <div class="section-head compact">
          <div><p class="eyebrow">Signal Pairing</p><h2>Which reactions moved together?</h2></div>
          <p>This shows which brain signals rose together during the call.</p>
        </div>
        ${renderNetworkGraph()}
      </section>
    </div>
  `;
  bindInteractions();
}

function renderHeroSignalCard(active) {
  if (!active) return "";
  return `
    <div class="hero-signal-card">
      <div>
        <strong>${esc(active.analyst.title)}</strong>
        <span>${esc(DIMENSION_LABELS[active.event.signalName])} · score ${active.event.brainScore.toFixed(2)} · ${active.event.eventShape.replaceAll("_", " ")}</span>
      </div>
      <p>${esc(active.analyst.quote || active.analyst.signal_read || "")}</p>
    </div>
  `;
}

function renderHeroNudge(item, index) {
  const question = heroNudgeTitle(item, index);
  return `
    <button class="hero-card" type="button" data-insight-id="${escAttr(item.id)}">
      <span>Insight ${index + 2}</span>
      <b>${esc(question)}</b>
    </button>
  `;
}

function renderInsight(item, index) {
  const evidence = transcriptEvidenceForInsight(item);
  const phrase = phraseForInsight(item, index);
  return `
    <article class="insight ${item.id === activeInsightId ? "is-active" : ""}" data-insight-id="${escAttr(item.id)}">
      <div>
        <div class="rank">Selected ${String(index + 1).padStart(2, "0")} · ${esc(DIMENSION_LABELS[item.event.signalName])}</div>
        ${renderSignalPhrase(item.event.signalName, true, phrase)}
        <h3>${esc(item.analyst.title)}</h3>
        <p class="interpretation">${esc(plainInsightLead(item))}</p>
        <div class="transcript-evidence">
          <blockquote>${esc(evidence.shortText || item.analyst.quote)}</blockquote>
          ${evidence.hasMore ? `<details><summary>Show full transcript context</summary><p>${esc(evidence.fullText)}</p></details>` : ""}
        </div>
        <div class="note-grid">
          <div class="note"><b>Why it moved</b><span>${esc(simpleDriver(item, evidence.fullText))}</span></div>
          <div class="note"><b>What it means</b><span>${esc(simpleWhy(item))}</span></div>
        </div>
      </div>
      <div class="trace-card">
        ${renderMomentChartShell(item)}
        <p class="chart-caption">${esc(momentChartCaption(item))}</p>
      </div>
    </article>
  `;
}

function renderCallSpine(items) {
  return `
    <div class="call-spine" aria-label="Final report signals">
      <div class="spine-line" aria-hidden="true"></div>
      ${items.map((item, index) => renderSpineMoment(item, index)).join("")}
    </div>
  `;
}

function renderSpineMoment(item, index) {
  const evidence = transcriptEvidenceForInsight(item);
  const dims = momentDimensions(item);
  const isTrough = item.event.eventShape.includes("trough") || item.analyst.title.toLowerCase().includes("trough");
  const side = index % 2 === 1 ? "right" : "left";
  const signalColor = isTrough ? "#6f82ff" : COLORS[item.event.signalName];
  const phrase = phraseForInsight(item, index);
  return `
    <article class="spine-moment spine-${side} ${isTrough ? "is-trough" : "is-peak"}" data-insight-id="${escAttr(item.id)}" style="--signal:${signalColor}; --index:${index + 1}">
      <div class="spine-node" aria-hidden="true">
        <i></i>
        <span>${formatTime(item.event.peakTime)}</span>
      </div>
      <div class="spine-copy">
        <div class="spine-ghost">${String(index + 1).padStart(2, "0")}</div>
        <p class="spine-kicker"><i></i> Signal ${String(index + 1).padStart(2, "0")} · ${esc(DIMENSION_LABELS[item.event.signalName])} <span>${isTrough ? "Trough" : "Peak"} · ${formatTime(item.event.peakTime)}</span></p>
        <h3>${esc(item.analyst.title)}</h3>
        <p class="spine-lead">${esc(plainInsightLead(item))}</p>
        <blockquote class="spine-quote">${highlightTranscriptPhrase(evidence.shortText || item.analyst.quote, item.analyst.quote)}</blockquote>
        ${evidence.hasMore ? `<details class="spine-details"><summary>Show full transcript context</summary><p>${esc(evidence.fullText)}</p></details>` : ""}
        <div class="spine-reads">
          <div><b>Why it moved</b><span>${esc(simpleDriver(item, evidence.fullText))}</span></div>
          <div><b>What it means</b><span>${esc(simpleWhy(item))}</span></div>
        </div>
      </div>
      <div class="spine-visual">
        <div class="spine-signal-row" aria-label="Toggle moment signal dimensions">
          ${dims.map((dim) => `
            <button class="moment-dim-toggle ${momentActiveDimensions(item).has(dim) ? "is-active" : ""}" type="button" data-moment-id="${escAttr(item.id)}" data-dimension="${escAttr(dim)}" style="--signal:${COLORS[dim]}">
              <span></span><b>${esc(DIMENSION_LABELS[dim])}</b>
            </button>
          `).join("")}
        </div>
        <div class="spine-chart-stage" data-moment-chart-stage="${escAttr(item.id)}" data-spine-stage="true" data-moment-index="${index}">
          ${renderSpineCurve(item, index)}
        </div>
        <p class="chart-caption spine-caption">${esc(momentChartCaption(item))}</p>
      </div>
    </article>
  `;
}

function renderSpineCurve(item, index) {
  const width = 620;
  const height = 250;
  const pad = { left: 30, right: 26, top: 26, bottom: 42 };
  const dims = [...momentActiveDimensions(item)];
  const start = Math.max(0, item.event.start - 10);
  const end = Math.min(report.input.alignment.analysisDurationSec, item.event.end + 10);
  const graphW = width - pad.left - pad.right;
  const graphH = height - pad.top - pad.bottom;
  const x = (time) => pad.left + ((time - start) / Math.max(1, end - start)) * graphW;
  const y = (value) => pad.top + (1 - value) * graphH;
  const primary = item.event.signalName;
  const primaryColor = item.event.eventShape.includes("trough") ? "#6f82ff" : COLORS[primary];
  const primaryPoints = (report.normalized.byDimension[primary] || []).filter((point) => point.t >= start && point.t <= end);
  const primaryPath = primaryPoints.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${x(point.t).toFixed(2)} ${y(point.smoothed).toFixed(2)}`).join(" ");
  const areaPath = primaryPoints.length ? `${primaryPath} L ${x(end).toFixed(2)} ${height - pad.bottom} L ${x(start).toFixed(2)} ${height - pad.bottom} Z` : "";
  const quoteX = x(item.transcript.quoteStart + report.input.alignment.hrfLagSec);
  const quoteW = Math.max(4, x(item.transcript.quoteEnd + report.input.alignment.hrfLagSec) - quoteX);
  const isTrough = item.event.eventShape.includes("trough") || item.analyst.title.toLowerCase().includes("trough");
  const paths = dims.map((dim) => {
    const points = (report.normalized.byDimension[dim] || []).filter((point) => point.t >= start && point.t <= end);
    const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${x(point.t).toFixed(2)} ${y(point.smoothed).toFixed(2)}`).join(" ");
    return `<path class="spine-curve-line ${dim === primary ? "is-primary" : ""}" d="${path}" fill="none" stroke="${dim === primary ? primaryColor : COLORS[dim]}" stroke-width="${dim === primary ? 3.2 : 2}" opacity="${dim === primary ? 1 : 0.58}" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  const peak = nearest(report.normalized.byDimension[primary], item.event.peakTime);
  const peakY = y(peak?.smoothed ?? 0.5);
  const peakX = x(item.event.peakTime);
  return `
    <svg class="spine-curve ${isTrough ? "is-trough" : "is-peak"}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escAttr(DIMENSION_LABELS[primary])} response curve">
      <defs>
        <linearGradient id="spineArea${index}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${primaryColor}" stop-opacity="${isTrough ? "0.20" : "0.34"}" />
          <stop offset="100%" stop-color="${primaryColor}" stop-opacity="0" />
        </linearGradient>
      </defs>
      <text x="${pad.left}" y="14" class="axis-label">Y: response strength</text>
      <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" class="axis-label">X: call time</text>
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" class="axis-line" />
      <line x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${height - pad.bottom}" class="axis-line" />
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + graphH / 2}" y2="${pad.top + graphH / 2}" class="chart-mid" />
      <rect x="${quoteX.toFixed(2)}" y="${pad.top}" width="${quoteW.toFixed(2)}" height="${graphH}" rx="4" class="spine-quote-window" />
      ${areaPath ? `<path d="${areaPath}" fill="url(#spineArea${index})" class="spine-area" />` : ""}
      ${paths}
      <line x1="${peakX.toFixed(2)}" x2="${peakX.toFixed(2)}" y1="${pad.top}" y2="${height - pad.bottom}" class="spine-peak-line" />
      <circle cx="${peakX.toFixed(2)}" cy="${peakY.toFixed(2)}" r="5.5" fill="${primaryColor}" class="spine-peak-dot" />
      <text x="${peakX.toFixed(2)}" y="${Math.max(28, peakY - 12).toFixed(2)}" text-anchor="middle" class="spine-peak-label">${isTrough ? "trough" : "peak"} ${formatTime(item.event.peakTime)}</text>
      <text x="${pad.left}" y="${height - 18}" class="trace-time">${formatTime(start)}</text>
      <text x="${width - pad.right}" y="${height - 18}" text-anchor="end" class="trace-time">${formatTime(end)}</text>
    </svg>
  `;
}

function renderActivityBands() {
  return DIMENSION_ORDER.map((dim) => {
    const points = report.normalized.byDimension[dim] || [];
    const stops = points
      .filter((_, index) => index % 2 === 0)
      .map((point, index, arr) => {
        const pct = arr.length <= 1 ? 0 : (index / (arr.length - 1)) * 100;
        return `${hexToRgba(COLORS[dim], 0.12 + (point.smoothed * 0.78))} ${pct.toFixed(2)}%`;
      })
      .join(", ");
    const selectedTicks = report.finalInsights
      .filter((item) => item.event.signalName === dim)
      .map((item) => {
        const pct = (item.event.peakTime / Math.max(1, report.input.alignment.analysisDurationSec)) * 100;
        return `<span class="band-tick" style="left:${pct.toFixed(2)}%"></span>`;
      })
      .join("");
    return `
      <div class="activity-row">
        <div class="activity-label">${esc(DIMENSION_LABELS[dim])}</div>
        <div class="activity-band" style="background: linear-gradient(90deg, ${stops || "#211f4b"});">
          ${selectedTicks}
        </div>
      </div>
    `;
  }).join("");
}

function renderDimensionControls() {
  return `
    <div class="dimension-picker" aria-label="Choose brain dimension">
      ${DIMENSION_ORDER.map((dim) => `
        <button class="dimension-pill ${dim === activeDimension ? "is-active" : ""}" type="button" data-dimension="${escAttr(dim)}" style="--signal:${COLORS[dim]}">
          <span>${esc(DIMENSION_LABELS[dim])}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderHeroScrubber(active) {
  if (!active) return "";
  const dim = activeDimension || active.event.signalName;
  const duration = Math.floor(report.input.alignment.analysisDurationSec || 0);
  const point = nearest(report.normalized.byDimension[dim], scrubTime);
  const pct = duration ? (scrubTime / duration) * 100 : 0;
  return `
    <div class="brain-scrubber" style="--scrub-pct:${pct.toFixed(2)}%; --signal:${COLORS[dim]}">
      <div class="scrub-top">
        <span class="scrub-dimension-line"><span data-scrub-dimension>${esc(DIMENSION_LABELS[dim])}</span><i>·</i><em data-scrub-question>${esc(DIMENSION_QUESTIONS[dim] || "")}</em></span>
      </div>
      <div class="scrub-control-row">
        <button id="scrubPlay" class="play-scrub" type="button" aria-label="Play full brain activity scrubber">${scrubPlaying ? "Pause" : "Play"}</button>
        <div class="scrub-rail">
          <div class="scrub-bars" data-scrub-bars>
            ${renderScrubBars(dim, scrubTime)}
          </div>
          <span class="scrub-marker" aria-hidden="true"></span>
          <input id="brainScrubber" type="range" min="0" max="${duration}" step="0.1" value="${scrubTime.toFixed(1)}" aria-label="Scrub brain activity over time" />
        </div>
      </div>
      <div class="scrub-bottom">
        <span>activity <b data-scrub-value>${Math.round((point?.smoothed ?? 0) * 100)}%</b></span>
        <span>selected moment <b data-scrub-peak>${formatTime(active.event.peakTime)}</b></span>
      </div>
    </div>
  `;
}

function renderHeroTranscript() {
  const window = stableTranscriptAtSignalTime(scrubTime);
  return `
    <div class="hero-transcript">
      <b><span data-hero-transcript-range>${formatTime(window.start)}-${formatTime(window.end)}</span> transcript</b>
      <p data-hero-transcript>${esc(window.text || activeInsight()?.analyst.quote || "")}</p>
    </div>
  `;
}

function renderScrubBars(dim, time) {
  const points = report.normalized.byDimension[dim] || [];
  if (!points.length) return "";
  const count = 58;
  const duration = Math.max(1, report.input.alignment.analysisDurationSec || points.at(-1)?.t || 1);
  return Array.from({ length: count }, (_, index) => {
    const t = (index / Math.max(1, count - 1)) * duration;
    const value = nearest(points, t)?.smoothed ?? 0;
    return `<button class="scrub-bar ${t <= time ? "is-past" : ""}" type="button" data-scrub-bar-time="${t.toFixed(2)}" style="--bar:${Math.max(0.08, value).toFixed(3)}" aria-label="Jump to ${formatTime(t)}"></button>`;
  }).join("");
}

function plainInsightLead(item) {
  if (item.analyst.agent_source === "anthropic" && item.analyst.interpretation) {
    return trimToSentences(item.analyst.interpretation, 2);
  }
  const title = item.analyst.title.toLowerCase();
  const dim = DIMENSION_LABELS[item.event.signalName];
  const low = isLowEvent(item);
  if (title.includes("manual call review")) {
    return "The strongest moment is the line that names the buyer's manual work clearly.";
  }
  if (title.includes("working-session") || title.includes("trough")) {
    return "The call loses pull when it moves from the buyer's pain into the next-step ask.";
  }
  if (title.includes("motive") || item.event.signalName === "gut_reaction") {
    return "The instinctive reaction rises when the script connects a likely motive to a concrete pain.";
  }
  if (item.event.signalName === "attention") {
    return low ? "This is where attention becomes quieter." : "This is where the listener is most likely to lock onto the message.";
  }
  if (item.event.signalName === "personal_resonance") {
    return low ? "This is where personal relevance becomes quieter." : "This is where the wording connects most clearly to the listener's situation.";
  }
  if (item.event.signalName === "brain_effort") {
    return low ? "This is where the wording asks for less mental work." : "This is where the wording asks the listener to do the most mental work.";
  }
  if (item.event.signalName === "memory_encoding") {
    return low ? "This is where the memory signal becomes quieter." : "This is where the wording is most likely to stay available later.";
  }
  if (item.event.signalName === "social_thinking") {
    return low ? "This is where people and intent become less central." : "This is where the wording makes people, roles, or trust more central.";
  }
  if (item.event.signalName === "language_depth") {
    return low ? "This is where the explanation becomes lighter." : "This is where the wording asks the listener to process the meaning more deeply.";
  }
  return `${dim} changes most clearly at this point in the call.`;
}

function simpleDriver(item, sentenceText) {
  if (item.analyst.agent_source === "anthropic" && (item.analyst.why_it_moved || item.analyst.likely_driver)) {
    return item.analyst.why_it_moved || item.analyst.likely_driver;
  }
  const title = item.analyst.title.toLowerCase();
  const quote = sentenceText || item.analyst.quote;
  const low = isLowEvent(item);
  if (title.includes("manual call review")) {
    return "The line names the exact burden: managers having to listen to every call. That is more concrete than saying teams need better coaching or faster ramp.";
  }
  if (title.includes("working-session") || title.includes("trough")) {
    return "The wording shifts into logistics: meeting length, setup, and process. It stops carrying the same problem-and-payoff language that made the earlier section stronger.";
  }
  if (title.includes("motive") || item.event.signalName === "gut_reaction") {
    return "The line puts motive and friction in the same breath. It turns the point from explanation into something more immediate.";
  }
  const cleanQuote = trimTerminalPunctuation(truncateWords(quote, 28));
  if (item.event.signalName === "attention") {
    return low
      ? `The line carries less pull than the surrounding call: "${cleanQuote}." The attention signal gets quieter here instead of building.`
      : `The line gives the listener a concrete reason to keep tracking the message: "${cleanQuote}." It is the part of the call where focus rises most clearly.`;
  }
  if (item.event.signalName === "personal_resonance") {
    return low
      ? `The line feels less tied to the listener's own situation: "${cleanQuote}." The personal-relevance signal drops against the surrounding call.`
      : `The line makes the message feel tied to the listener's own situation: "${cleanQuote}." It is less abstract than the surrounding setup.`;
  }
  if (item.event.signalName === "brain_effort") {
    return low
      ? `The line asks for less mental work: "${cleanQuote}." It reads as lighter processing than the surrounding script.`
      : `The line asks the listener to process more detail: "${cleanQuote}." The wording carries more mental work than the surrounding script.`;
  }
  if (item.event.signalName === "memory_encoding") {
    return low
      ? `The line is less sticky than nearby wording: "${cleanQuote}." The memory signal becomes quieter here.`
      : `The line gives the listener a phrase that can be held onto later: "${cleanQuote}." It is the clearest memory cue near this signal movement.`;
  }
  if (item.event.signalName === "social_thinking") {
    return low
      ? `The line carries less people-and-intent framing: "${cleanQuote}." The social-thinking signal dips instead of rising.`
      : `The line brings people, roles, or trust into the frame: "${cleanQuote}." That is what pulls the social-thinking signal upward here.`;
  }
  if (item.event.signalName === "language_depth") {
    return low
      ? `The line carries lighter meaning than nearby wording: "${cleanQuote}." The language-depth signal dips in this window.`
      : `The line carries the densest meaning in this window: "${cleanQuote}." It asks the listener to parse the message more deeply.`;
  }
  return `The signal attaches to this nearby line: "${cleanQuote}." It is the clearest wording around this response shift.`;
}

function simpleWhy(item) {
  if (item.analyst.agent_source === "anthropic" && (item.analyst.what_it_means || item.analyst.why_it_matters)) {
    return item.analyst.what_it_means || item.analyst.why_it_matters;
  }
  const title = item.analyst.title.toLowerCase();
  const low = isLowEvent(item);
  if (title.includes("manual call review")) {
    return "This is where the problem becomes specific, not generic. The call is strongest when the pain is easy to picture.";
  }
  if (title.includes("working-session") || title.includes("trough")) {
    return "This is where the call loses some pull as it moves into the ask. The useful read is the contrast between the strong pain language and the weaker next-step language.";
  }
  if (title.includes("motive") || item.event.signalName === "gut_reaction") {
    return low
      ? "This is where the immediate reaction cools. The useful read is the contrast between this quieter stretch and the parts that feel more urgent."
      : "This is the line that made the message feel more immediate. The reaction is tied to the claim itself, not just the overall topic.";
  }
  if (item.event.signalName === "attention") {
    return low
      ? "This is a quieter attention moment. It marks wording that carries less pull than the stronger parts around it."
      : "This is the part of the call that earns focus. It shows where the message stops being background and becomes something to track.";
  }
  if (item.event.signalName === "personal_resonance") {
    return low
      ? "This is where personal relevance drops. The call is less tied to the listener's world in this window."
      : "This is where the script feels closest to the listener's world. The useful read is relevance, not persuasion or agreement.";
  }
  if (item.event.signalName === "brain_effort") {
    return low
      ? "This is where the script becomes easier to process. The low signal does not mean bad; it means this part asks for less mental work."
      : "This is where the script becomes heavier to process. That can mean useful depth, or it can mean friction, so the wording deserves a closer look.";
  }
  if (item.event.signalName === "memory_encoding") {
    return low
      ? "This is where the memory signal gets quieter. The wording is less likely to be the part that stays available later."
      : "This is the part most likely to remain available after the call. It marks the phrase the listener's brain treated as most memorable.";
  }
  if (item.event.signalName === "social_thinking") {
    return low
      ? "This is where the call becomes less about people and intent. The signal is about social meaning, not whether the listener trusted the rep."
      : "This is where the call becomes more about people and intent. The signal is about social meaning, not whether the listener trusted the rep.";
  }
  if (item.event.signalName === "language_depth") {
    return low
      ? "This is where the explanation becomes lighter to parse. It is a quieter language-depth moment, not a quality score."
      : "This is where the explanation carries the most meaning. The signal shows deeper parsing, not automatically better wording.";
  }
  return "This marks the sentence that moved the brain response most clearly in this window. It gives the report a concrete line to inspect.";
}

function momentChartCaption(item) {
  const dim = DIMENSION_LABELS[item.event.signalName];
  if (item.analyst.title.toLowerCase().includes("working-session") || item.analyst.title.toLowerCase().includes("trough")) {
    return `${dim} sinks into a long, broad trough as the ask turns procedural.`;
  }
  if (isLowEvent(item)) {
    return `${dim} dips through the highlighted line.`;
  }
  if (item.event.signalName === "gut_reaction") {
    return `${dim} rises fastest as the wording turns from explanation into instinct.`;
  }
  return `${dim} climbs as the highlighted sentence lands.`;
}

function isLowEvent(item) {
  return ["trough", "sustained_low", "sharp_drop"].includes(item?.event?.eventShape);
}

function renderStackedTraces(item) {
  const dims = traceDimensions(item);
  return `
    <div class="stacked-traces" aria-label="Stacked signal traces">
      ${dims.map((dim) => renderTraceStrip(item, dim)).join("")}
    </div>
  `;
}

function renderMomentChartShell(item) {
  const dims = momentDimensions(item);
  return `
    <div class="moment-chart" data-moment-chart="${escAttr(item.id)}">
      <div class="moment-chart-toolbar" aria-label="Toggle moment signal dimensions">
        ${dims.map((dim) => `
          <button class="moment-dim-toggle ${momentActiveDimensions(item).has(dim) ? "is-active" : ""}" type="button" data-moment-id="${escAttr(item.id)}" data-dimension="${escAttr(dim)}" style="--signal:${COLORS[dim]}">
            <span></span><b>${esc(DIMENSION_LABELS[dim])}</b>
          </button>
        `).join("")}
      </div>
      <div class="moment-chart-stage" data-moment-chart-stage="${escAttr(item.id)}">
        ${renderMomentOverlayChart(item)}
      </div>
    </div>
  `;
}

function renderMomentOverlayChart(item) {
  const width = 760;
  const height = 270;
  const pad = { left: 58, right: 28, top: 34, bottom: 34 };
  const dims = [...momentActiveDimensions(item)];
  const start = Math.max(0, item.event.start - 10);
  const end = Math.min(report.input.alignment.analysisDurationSec, item.event.end + 10);
  const graphW = width - pad.left - pad.right;
  const graphH = height - pad.top - pad.bottom;
  const x = (time) => pad.left + ((time - start) / Math.max(1, end - start)) * graphW;
  const y = (value) => pad.top + (1 - value) * graphH;
  const quoteX = x(item.transcript.quoteStart + report.input.alignment.hrfLagSec);
  const quoteW = Math.max(4, x(item.transcript.quoteEnd + report.input.alignment.hrfLagSec) - quoteX);
  const eventX = x(item.event.start);
  const eventW = Math.max(4, x(item.event.end) - eventX);
  const paths = dims.map((dim) => {
    const points = (report.normalized.byDimension[dim] || []).filter((point) => point.t >= start && point.t <= end);
    const path = points.map((point, index) => `${index ? "L" : "M"} ${x(point.t).toFixed(2)} ${y(point.smoothed).toFixed(2)}`).join(" ");
    const peak = nearest(report.normalized.byDimension[dim], item.event.peakTime);
    return `
      <path d="${path}" fill="none" stroke="${COLORS[dim]}" stroke-width="${dim === item.event.signalName ? 3 : 2.2}" opacity="${dim === item.event.signalName ? 1 : 0.78}" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${x(item.event.peakTime).toFixed(2)}" cy="${y(peak?.smoothed ?? 0.5).toFixed(2)}" r="${dim === item.event.signalName ? 4.8 : 3.8}" fill="${COLORS[dim]}" class="moment-peak-dot" />
    `;
  }).join("");
  return `
    <svg class="moment-overlay-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Moment signal overlay chart">
      <rect x="0" y="0" width="${width}" height="${height}" rx="8" class="chart-bg" />
      <rect x="${quoteX.toFixed(2)}" y="${pad.top}" width="${quoteW.toFixed(2)}" height="${graphH}" rx="6" class="quote-window" />
      <rect x="${eventX.toFixed(2)}" y="${pad.top}" width="${eventW.toFixed(2)}" height="${graphH}" rx="6" class="event-window" />
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + graphH / 2}" y2="${pad.top + graphH / 2}" class="chart-mid" />
      <line x1="${x(item.event.peakTime).toFixed(2)}" x2="${x(item.event.peakTime).toFixed(2)}" y1="${pad.top}" y2="${height - pad.bottom}" class="chart-event" />
      ${paths}
      <text x="${pad.left}" y="${height - 10}" class="trace-time">${formatTime(start)}</text>
      <text x="${x(item.event.peakTime).toFixed(2)}" y="22" text-anchor="middle" class="trace-label">peak ${formatTime(item.event.peakTime)}</text>
      <text x="${width - pad.right}" y="${height - 10}" text-anchor="end" class="trace-time">${formatTime(end)}</text>
    </svg>
  `;
}

function renderTraceStrip(item, dim) {
  const width = 760;
  const height = 118;
  const pad = { left: 118, right: 24, top: 18, bottom: 26 };
  const graphW = width - pad.left - pad.right;
  const graphH = height - pad.top - pad.bottom;
  const start = Math.max(0, item.event.start - 8);
  const end = Math.min(report.input.alignment.analysisDurationSec, item.event.end + 8);
  const x = (time) => pad.left + ((time - start) / Math.max(1, end - start)) * graphW;
  const y = (value) => pad.top + (1 - value) * graphH;
  const points = (report.normalized.byDimension[dim] || []).filter((point) => point.t >= start && point.t <= end);
  const path = points.map((point, index) => `${index ? "L" : "M"} ${x(point.t).toFixed(2)} ${y(point.smoothed).toFixed(2)}`).join(" ");
  const responseX = x(item.event.start);
  const responseW = Math.max(4, x(item.event.end) - responseX);
  const quoteX = x(item.transcript.quoteStart + report.input.alignment.hrfLagSec);
  const quoteW = Math.max(4, x(item.transcript.quoteEnd + report.input.alignment.hrfLagSec) - quoteX);
  const peak = nearest(report.normalized.byDimension[dim], item.event.peakTime);
  return `
    <svg class="signal-trace trace-strip" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escAttr(DIMENSION_LABELS[dim])} trace">
      <rect x="${pad.left}" y="${pad.top}" width="${graphW}" height="${graphH}" rx="8" class="trace-field" />
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0.5)}" y2="${y(0.5)}" class="trace-midline" />
      <rect x="${quoteX.toFixed(2)}" y="${pad.top}" width="${quoteW.toFixed(2)}" height="${graphH}" rx="5" class="quote-window" />
      <rect x="${responseX.toFixed(2)}" y="${pad.top}" width="${responseW.toFixed(2)}" height="${graphH}" rx="5" class="event-window" />
      <path d="${path}" fill="none" stroke="${COLORS[dim]}" stroke-width="${dim === item.event.signalName ? 3 : 2}" opacity="${dim === item.event.signalName ? 1 : 0.68}" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="${x(item.event.peakTime).toFixed(2)}" x2="${x(item.event.peakTime).toFixed(2)}" y1="${pad.top}" y2="${height - pad.bottom}" class="peak-line" />
      <circle cx="${x(item.event.peakTime).toFixed(2)}" cy="${y(peak?.smoothed ?? 0.5).toFixed(2)}" r="${dim === item.event.signalName ? 5 : 4}" class="peak-dot" />
      <text x="16" y="${pad.top + 18}" class="trace-dim">${esc(DIMENSION_LABELS[dim])}</text>
      <text x="16" y="${pad.top + 36}" class="trace-value">${Math.round((peak?.smoothed ?? 0) * 100)}%</text>
      <text x="${pad.left}" y="${height - 11}" class="trace-time">${formatTime(start)}</text>
      <text x="${width - pad.right}" y="${height - 11}" text-anchor="end" class="trace-time">${formatTime(end)}</text>
      <text x="${x(item.event.peakTime).toFixed(2)}" y="15" text-anchor="middle" class="trace-label">${formatTime(item.event.peakTime)}</text>
    </svg>
  `;
}

function traceDimensions(item) {
  const snapshot = DIMENSION_ORDER
    .map((dim) => ({
      dim,
      value: nearest(report.normalized.byDimension[dim], item.event.peakTime)?.smoothed ?? 0,
    }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.dim);
  return [...new Set([item.event.signalName, ...item.event.contributingDimensions, ...snapshot])].slice(0, 3);
}

function momentDimensions(item) {
  return traceDimensions(item);
}

function momentActiveDimensions(item) {
  if (!momentChartDimensions.has(item.id)) {
    momentChartDimensions.set(item.id, new Set(momentDimensions(item)));
  }
  const allowed = new Set(momentDimensions(item));
  const selected = new Set([...momentChartDimensions.get(item.id)].filter((dim) => allowed.has(dim)));
  if (!selected.size) selected.add(momentDimensions(item)[0]);
  momentChartDimensions.set(item.id, selected);
  return selected;
}

function renderAppendixActivity() {
  return `
    <div class="lab-chart">
      <div class="chart-toolbar">
        <div class="dimension-toggles" aria-label="Toggle signal dimensions">
          ${DIMENSION_ORDER.map((dim) => `
            <button class="chart-dim-toggle ${activeChartDimensions.has(dim) ? "is-active" : ""}" type="button" data-dimension="${escAttr(dim)}" style="--signal:${COLORS[dim]}">
              <span></span><b>${esc(DIMENSION_LABELS[dim])}</b>
            </button>
          `).join("")}
        </div>
      </div>
        <div class="chart-stage" data-chart-stage>
        ${renderFullCallChart("overlay")}
        <div class="chart-hover-line" data-chart-hover-line hidden></div>
        <div class="chart-hover-readout" data-chart-hover-readout hidden></div>
      </div>
    </div>
  `;
}

function renderFullCallChart(mode) {
  const width = 1100;
  const dims = DIMENSION_ORDER.filter((dim) => activeChartDimensions.has(dim));
  const height = mode === "lanes" ? Math.max(260, dims.length * 76 + 72) : 380;
  const pad = { left: mode === "lanes" ? 160 : 54, right: 28, top: mode === "lanes" ? 28 : 58, bottom: 34 };
  const duration = Math.max(1, report.input.alignment.analysisDurationSec || 1);
  const graphW = width - pad.left - pad.right;
  const graphH = height - pad.top - pad.bottom;
  const x = (time) => pad.left + (time / duration) * graphW;
  const laneH = graphH / dims.length;
  const y = (value, index) => {
    if (mode === "lanes") return pad.top + index * laneH + (1 - value) * (laneH - 12) + 6;
    return pad.top + (1 - value) * graphH;
  };
  const paths = dims.map((dim, index) => {
    const points = report.normalized.byDimension[dim] || [];
    const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${x(point.t).toFixed(2)} ${y(point.smoothed, index).toFixed(2)}`).join(" ");
    return `<path d="${path}" fill="none" stroke="${COLORS[dim]}" stroke-width="${mode === "lanes" ? 2.4 : 2.2}" opacity="${mode === "lanes" ? 0.98 : 0.78}" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  const labels = mode === "lanes" ? dims.map((dim, index) => `
    <text x="18" y="${(pad.top + index * laneH + laneH / 2 + 4).toFixed(2)}" class="chart-label">${esc(DIMENSION_LABELS[dim])}</text>
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${(pad.top + index * laneH + laneH - 2).toFixed(2)}" y2="${(pad.top + index * laneH + laneH - 2).toFixed(2)}" class="chart-lane" />
  `).join("") : "";
  const eventTicks = report.finalInsights.map((item, index) => {
    const eventX = x(item.event.peakTime);
    const labelY = pad.top + 14 + index * 24;
    return `
      <line x1="${eventX.toFixed(2)}" x2="${eventX.toFixed(2)}" y1="${pad.top}" y2="${height - pad.bottom}" class="chart-event" />
      <rect x="${(eventX - 13).toFixed(2)}" y="${labelY}" width="26" height="18" rx="9" fill="${COLORS[item.event.signalName]}" class="chart-event-pill" />
      <text x="${eventX.toFixed(2)}" y="${labelY + 12}" text-anchor="middle" class="chart-event-label">${String(index + 1).padStart(2, "0")}</text>
      <title>Signal ${String(index + 1).padStart(2, "0")} · ${esc(DIMENSION_LABELS[item.event.signalName])} · ${formatTime(item.event.peakTime)}</title>
    `;
  }).join("");
  const legend = mode === "overlay" ? dims.map((dim, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    return `<g transform="translate(${pad.left + col * 190}, ${24 + row * 18})"><circle r="5" fill="${COLORS[dim]}" /><text x="12" y="4" class="chart-legend">${esc(DIMENSION_LABELS[dim])}</text></g>`;
  }).join("") : "";
  return `
    <svg class="full-call-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Full call brain-signal chart">
      <rect x="0" y="0" width="${width}" height="${height}" rx="8" class="chart-bg" />
      ${labels}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + graphH / 2}" y2="${pad.top + graphH / 2}" class="chart-mid" />
      <text x="${pad.left}" y="${pad.top - 14}" class="axis-label">Y: response strength (low to high)</text>
      <text x="${width - pad.right}" y="${height - 10}" text-anchor="end" class="axis-label">X: call time</text>
      ${eventTicks}
      ${paths}
      <text x="${pad.left}" y="${height - 10}" class="trace-time">00:00</text>
      <text x="${width - pad.right - 96}" y="${height - 10}" text-anchor="end" class="trace-time">${formatTime(duration)}</text>
      ${legend}
    </svg>
  `;
}

function renderSignalPhrase(dim, active = false, label = DIMENSION_TAGLINES[dim]) {
  return `
    <span class="signal-phrase ${active ? "is-active" : ""}" data-signal-phrase-dim="${escAttr(dim)}" style="--signal:${COLORS[dim]}">
      <i></i>${esc(label)}
    </span>
  `;
}

function heroNudgeTitle(item, index) {
  const title = item.analyst.title.toLowerCase();
  if (title.includes("working-session") || title.includes("trough")) return "Where did the ask lose energy?";
  if (title.includes("motive") || item.event.signalName === "gut_reaction") return "What created the gut reaction?";
  if (item.event.signalName === "memory_encoding") return "What might stick later?";
  if (item.event.signalName === "language_depth") return "Where did meaning deepen?";
  if (item.event.signalName === "social_thinking") return "Where did people matter?";
  if (item.event.signalName === "personal_resonance") return "What felt most relevant?";
  if (item.event.signalName === "brain_effort") return "What made them think?";
  if (item.event.signalName === "attention") return index ? "Where did focus shift?" : "What grabbed attention?";
  return "Which line moved the signal?";
}

function phraseForInsight(item, index) {
  const alternates = {
    personal_resonance: ["Felt relevant", "Felt personal", "Connected to them"],
    attention: ["Grabbed attention", "Pulled focus", "Focus shifted"],
    brain_effort: ["Made them think", "Asked for processing", "Raised effort"],
    gut_reaction: ["Triggered instinct", "Created a gut hit", "Felt immediate"],
    memory_encoding: ["Will stick", "Memory cue", "Easy to remember"],
    social_thinking: ["Read intent", "People mattered", "Trust entered"],
    language_depth: ["Meaning was clear", "Meaning deepened", "Needed parsing"],
  };
  const dim = item.event.signalName;
  const previousSame = report.finalInsights.slice(0, index).filter((candidate) => candidate.event.signalName === dim).length;
  return alternates[dim]?.[previousSame % alternates[dim].length] || DIMENSION_TAGLINES[dim];
}

function renderNetworkGraph() {
  const dims = DIMENSION_ORDER;
  const width = 900;
  const height = 520;
  const center = { x: width / 2, y: height / 2 };
  const radius = 182;
  const positions = Object.fromEntries(dims.map((dim, index) => {
    const angle = (-Math.PI / 2) + (index / dims.length) * Math.PI * 2;
    return [dim, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    }];
  }));
  const links = [];
  for (let i = 0; i < dims.length; i += 1) {
    for (let j = i + 1; j < dims.length; j += 1) {
      const a = dims[i];
      const b = dims[j];
      const r = pearson(
        (report.normalized.byDimension[a] || []).map((point) => point.smoothed),
        (report.normalized.byDimension[b] || []).map((point) => point.smoothed)
      );
      links.push({ a, b, r });
    }
  }
  const summary = networkSummary(links);
  const visible = summary.items;
  return `
    <div class="network-card research-network" data-network-card>
      <svg class="network-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Network coordination graph">
        <rect x="0" y="0" width="${width}" height="${height}" rx="8" class="network-bg" />
        <circle cx="${center.x}" cy="${center.y}" r="${radius}" class="network-ring" />
        ${visible.map((link, index) => {
          const a = positions[link.a];
          const b = positions[link.b];
          const path = chordPath(a, b, center, link.type === "anti" ? 0.18 : 0.42);
          const strokeW = link.type === "anti" ? 1.8 : Math.max(2.4, 5.0 - index * 0.8);
          return `
            <path class="network-edge ${index === 0 ? "is-active" : ""} ${link.type === "anti" ? "is-anti" : "is-coupling"}" data-network-index="${index}" data-a="${escAttr(link.a)}" data-b="${escAttr(link.b)}" d="${path}" stroke="#6edcff" stroke-width="${strokeW.toFixed(2)}" fill="none" stroke-linecap="round" />
          `;
        }).join("")}
        ${dims.map((dim) => {
          const pos = positions[dim];
          const avg = mean((report.normalized.byDimension[dim] || []).map((point) => point.smoothed));
          const r = 28 + avg * 12;
          return `
            <g class="network-node" data-dim="${escAttr(dim)}">
              <circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="${(r + 8).toFixed(2)}" fill="${COLORS[dim]}" opacity="0.10" />
              <circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="${r.toFixed(2)}" fill="rgba(8,17,34,0.92)" stroke="${COLORS[dim]}" stroke-width="2.4" />
              <text x="${pos.x.toFixed(2)}" y="${(pos.y + 5).toFixed(2)}" text-anchor="middle" class="network-node-label">${shortLabel(dim)}</text>
              <text x="${pos.x.toFixed(2)}" y="${(pos.y + r + 24).toFixed(2)}" text-anchor="middle" class="network-node-caption">${esc(DIMENSION_LABELS[dim])}</text>
            </g>
          `;
        }).join("")}
      </svg>
      <div class="network-list">
        ${visible.map((link, index) => {
          const moment = coordinationMoment(link);
          const transcript = sentenceAtSignalTime(moment.time, 5);
          const isAnti = link.type === "anti";
          const label = isAnti ? "Anti-coupling" : "Strongest coupling";
          const motion = isAnti ? "Moved opposite" : "Moved together";
          const read = networkMomentInsight(link, transcript.text);
          return `
          <button class="network-item ${index === 0 ? "is-active" : ""} ${link.type === "anti" ? "is-anti" : ""}" type="button" data-network-index="${index}" data-a="${escAttr(link.a)}" data-b="${escAttr(link.b)}">
            <span class="network-type">${label}<small>${motion}</small></span>
            <b>${esc(DIMENSION_LABELS[link.a])} + ${esc(DIMENSION_LABELS[link.b])}</b>
            <p>${esc(read)}</p>
            <div class="network-transcript">
              <strong>Transcript</strong>
              <small>${esc(transcript.text || "No aligned transcript words in this window.")}</small>
            </div>
          </button>
        `;}).join("")}
        ${summary.hasAnti ? "" : `
          <div class="network-item is-anti is-empty">
            <span class="network-type">Anti-coupling<small>Not detected</small></span>
            <b>No strong opposite pair in this call</b>
            <p>The signals did not show a clear pattern where one reaction rose while another fell. The useful read here is the strongest pair above.</p>
          </div>
        `}
      </div>
    </div>
  `;
}

function chordPath(a, b, center, pull) {
  const cx = center.x + ((a.x + b.x) / 2 - center.x) * pull;
  const cy = center.y + ((a.y + b.y) / 2 - center.y) * pull;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function pointBetween(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function networkSummary(links) {
  const positive = links.filter((link) => link.r >= 0).sort((a, b) => b.r - a.r).slice(0, 1)
    .map((link) => ({ ...link, type: "coupling" }));
  const negative = links.filter((link) => link.r < 0).sort((a, b) => a.r - b.r)[0];
  const anti = negative ? { ...negative, type: "anti" } : null;
  return { items: [...positive, anti].filter(Boolean), hasAnti: Boolean(anti) };
}

function networkFallbackExplanation(link) {
  if (link.type === "anti" && link.r >= 0) {
    return `${DIMENSION_LABELS[link.a]} and ${DIMENSION_LABELS[link.b]} stayed mostly separate. The call did not strongly tie these two listener reactions together.`;
  }
  if (link.type === "anti") {
    return `${DIMENSION_LABELS[link.a]} and ${DIMENSION_LABELS[link.b]} pulled apart. When one reaction rose, the other tended to stay quiet.`;
  }
  return `${DIMENSION_LABELS[link.a]} and ${DIMENSION_LABELS[link.b]} rose together. When one became active, the other tended to come with it.`;
}

function networkMomentInsight(link, sentenceText) {
  const a = DIMENSION_LABELS[link.a];
  const b = DIMENSION_LABELS[link.b];
  if (link.type === "anti") {
    if ((link.a === "gut_reaction" && link.b === "language_depth") || (link.a === "language_depth" && link.b === "gut_reaction")) {
      return "The gut reaction did not come from dense language here. The instinctive hit is probably carried by the claim itself, not by complex wording.";
    }
    return `${a} and ${b} moved apart here. The call created one kind of response without turning it into the other.`;
  }
  if ((link.a === "language_depth" && link.b === "memory_encoding") || (link.a === "memory_encoding" && link.b === "language_depth")) {
    return "The fuller explanation also became easier to retain. In simple terms: the part with more meaning was also the part most likely to stick.";
  }
  if ((link.a === "attention" && link.b === "gut_reaction") || (link.a === "gut_reaction" && link.b === "attention")) {
    return "The line that pulled focus also produced a fast gut response. It did not just get noticed; it felt immediate.";
  }
  if (link.a === "personal_resonance" && link.b === "social_thinking") {
    return "The line felt relevant while also making the listener think about people, roles, and trust. In simple terms: it connected the problem to their world.";
  }
  return `${a} and ${b} rose together. This part of the call pulled both reactions at once, so the two signals should be read as one moment.`;
}

function bindInteractions() {
  document.querySelectorAll(".switch-pill").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.run;
      if (!next || next === runId) return;
      location.href = `/rep-message-analyst-neon.html?run=${encodeURIComponent(next)}`;
    });
  });
  document.querySelectorAll(".insight").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target.closest("button, input, .moment-chart")) return;
      activeInsightId = el.dataset.insightId;
      const active = activeInsight();
      scrubTime = active?.event.peakTime || scrubTime;
      activeDimension = active?.event.signalName || activeDimension;
      document.querySelectorAll(".insight").forEach((node) => node.classList.toggle("is-active", node === el));
      updateHeroActiveCopy(active);
      const scrubber = document.querySelector("#brainScrubber");
      if (scrubber && active) scrubber.value = scrubTime.toFixed(1);
      updateDimensionPills();
      updateBrainScrubber();
    });
  });
  document.querySelectorAll(".spine-moment").forEach((el) => {
    el.addEventListener("click", (event) => {
      if (event.target.closest("button, input, details, .spine-chart-stage")) return;
      activeInsightId = el.dataset.insightId;
      const active = activeInsight();
      scrubTime = active?.event.peakTime || scrubTime;
      activeDimension = active?.event.signalName || activeDimension;
      document.querySelectorAll(".spine-moment").forEach((node) => node.classList.toggle("is-active", node === el));
      updateHeroActiveCopy(active);
      updateDimensionPills();
      updateBrainScrubber();
    });
  });
  document.querySelectorAll(".hero-card[data-insight-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeInsightId = button.dataset.insightId;
      const active = activeInsight();
      scrubTime = active?.event.peakTime || scrubTime;
      activeDimension = active?.event.signalName || activeDimension;
      updateHeroActiveCopy(active);
      updateDimensionPills();
      updateBrainScrubber();
      document.querySelector(`.spine-moment[data-insight-id="${CSS.escape(activeInsightId)}"], .insight[data-insight-id="${CSS.escape(activeInsightId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  document.querySelectorAll("[data-scroll-target]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector(button.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelectorAll(".dimension-pill").forEach((button) => {
    button.addEventListener("click", () => {
      activeDimension = button.dataset.dimension || activeDimension;
      updateDimensionPills();
      updateBrainScrubber();
    });
  });
  document.querySelector("#brainScrubber")?.addEventListener("input", (event) => {
    scrubTime = Number(event.currentTarget.value) || 0;
    stopScrubberPlayback();
    updateBrainScrubber();
  });
  document.querySelector(".scrub-rail")?.addEventListener("click", (event) => {
    const bar = event.target.closest("[data-scrub-bar-time]");
    if (!bar) return;
    scrubTime = Number(bar.dataset.scrubBarTime) || scrubTime;
    stopScrubberPlayback();
    const scrubber = document.querySelector("#brainScrubber");
    if (scrubber) scrubber.value = scrubTime.toFixed(1);
    updateBrainScrubber();
  });
  document.querySelector("#scrubPlay")?.addEventListener("click", toggleScrubberPlayback);
  document.querySelectorAll(".moment-dim-toggle").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.momentId;
      const dim = button.dataset.dimension;
      const item = report.finalInsights.find((candidate) => candidate.id === id);
      if (!id || !dim || !item) return;
      const selected = momentActiveDimensions(item);
      if (selected.has(dim) && selected.size > 1) selected.delete(dim);
      else selected.add(dim);
      momentChartDimensions.set(id, selected);
      document.querySelectorAll(`.moment-dim-toggle[data-moment-id="${CSS.escape(id)}"]`).forEach((node) => {
        node.classList.toggle("is-active", selected.has(node.dataset.dimension));
      });
      const stage = document.querySelector(`[data-moment-chart-stage="${CSS.escape(id)}"]`);
      if (stage) {
        stage.innerHTML = stage.dataset.spineStage === "true"
          ? renderSpineCurve(item, Number(stage.dataset.momentIndex || 0))
          : renderMomentOverlayChart(item);
      }
    });
  });
  document.querySelectorAll(".chart-dim-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const dim = button.dataset.dimension;
      if (!dim) return;
      if (activeChartDimensions.has(dim) && activeChartDimensions.size > 1) activeChartDimensions.delete(dim);
      else activeChartDimensions.add(dim);
      button.classList.toggle("is-active", activeChartDimensions.has(dim));
      const stage = document.querySelector("[data-chart-stage]");
      if (stage) {
        stage.innerHTML = `${renderFullCallChart("overlay")}<div class="chart-hover-line" data-chart-hover-line hidden></div><div class="chart-hover-readout" data-chart-hover-readout hidden></div>`;
      }
      bindChartHover();
    });
  });
  document.querySelectorAll(".network-item").forEach((button) => {
    button.addEventListener("click", () => activateNetworkEdge(button.dataset.networkIndex));
    button.addEventListener("mouseenter", () => activateNetworkEdge(button.dataset.networkIndex));
  });
  document.querySelectorAll(".network-edge").forEach((node) => {
    node.addEventListener("mouseenter", () => activateNetworkEdge(node.dataset.networkIndex));
    node.addEventListener("click", () => activateNetworkEdge(node.dataset.networkIndex));
  });
  activateNetworkEdge("0");
  bindSpineReveal();
  bindChartHover();
}

function updateHeroActiveCopy(active) {
  const heroSubtitle = document.querySelector(".hero-subtitle");
  if (heroSubtitle) heroSubtitle.textContent = active?.analyst.title || "Whole-call response trace";
  const activeTitle = document.querySelector(".active-read strong");
  const activeMeta = document.querySelector(".active-read span");
  if (activeTitle) activeTitle.textContent = active?.analyst.title || "Brain activity";
  if (activeMeta) activeMeta.textContent = active ? `${DIMENSION_LABELS[active.event.signalName]} · score ${active.event.brainScore.toFixed(2)} · ${active.event.eventShape.replaceAll("_", " ")}` : "";
  const card = document.querySelector(".hero-signal-card");
  if (!card || !active) return;
  card.querySelector("strong").textContent = active.analyst.title;
  card.querySelector("span").textContent = `${DIMENSION_LABELS[active.event.signalName]} · score ${active.event.brainScore.toFixed(2)} · ${active.event.eventShape.replaceAll("_", " ")}`;
  card.querySelector("p").textContent = active.analyst.quote || active.analyst.signal_read || "";
}

function toggleScrubberPlayback() {
  const duration = Math.floor(report.input.alignment.analysisDurationSec || 0);
  const button = document.querySelector("#scrubPlay");
  if (scrubPlaying) {
    stopScrubberPlayback();
    return;
  }
  scrubPlaying = true;
  if (button) button.textContent = "Pause";
  if (scrubTime >= duration) scrubTime = 0;
  playbackStartedAt = performance.now();
  playbackStartedFrom = scrubTime;
  const tick = (now) => {
    if (!scrubPlaying) return;
    const elapsed = (now - playbackStartedAt) / 1000;
    scrubTime = Math.min(duration, playbackStartedFrom + elapsed * PLAYBACK_SECONDS_PER_SECOND);
    updateBrainScrubber();
    if (scrubTime >= duration) {
      stopScrubberPlayback();
      return;
    }
    scrubRaf = requestAnimationFrame(tick);
  };
  scrubRaf = requestAnimationFrame(tick);
}

function stopScrubberPlayback() {
  if (scrubRaf) cancelAnimationFrame(scrubRaf);
  scrubRaf = null;
  scrubPlaying = false;
  const button = document.querySelector("#scrubPlay");
  if (button) button.textContent = "Play";
  if (report) updateBrainScrubber();
}

function updateBrainScrubber() {
  const active = activeInsight();
  if (!active) return;
  const dim = activeDimension || active.event.signalName;
  const point = nearest(report.normalized.byDimension[dim], scrubTime);
  const value = point?.smoothed ?? 0;
  if (cortex) {
    cortex.setRoi(dim);
    cortex.setRoiIntensity(value);
  }
  const timeEl = document.querySelector("[data-scrub-time]");
  const valueEl = document.querySelector("[data-scrub-value]");
  const dimEls = document.querySelectorAll("[data-scrub-dimension]");
  const questionEl = document.querySelector("[data-scrub-question]");
  const taglineEl = document.querySelector("[data-scrub-tagline]");
  const scoreEl = document.querySelector("[data-scrub-score]");
  const shapeEl = document.querySelector("[data-scrub-shape]");
  const peakEl = document.querySelector("[data-scrub-peak]");
  const orbDim = document.querySelector("[data-orb-dimension]");
  const orbValue = document.querySelector("[data-orb-value]");
  const duration = Math.max(1, report.input.alignment.analysisDurationSec || 1);
  const scrubber = document.querySelector("#brainScrubber");
  if (scrubber) scrubber.value = scrubTime.toFixed(1);
  document.querySelector(".brain-scrubber")?.style.setProperty("--scrub-pct", `${((scrubTime / duration) * 100).toFixed(2)}%`);
  document.querySelector(".brain-scrubber")?.style.setProperty("--signal", COLORS[dim]);
  const bars = document.querySelector("[data-scrub-bars]");
  const nextBarsKey = `${dim}|${Math.floor(scrubTime)}`;
  if (bars && nextBarsKey !== lastScrubBarsKey) {
    lastScrubBarsKey = nextBarsKey;
    bars.innerHTML = renderScrubBars(dim, scrubTime);
  }
  const transcript = scrubPlaying
    ? { start: scrubTime, end: scrubTime, text: "Pause to see the transcript at this moment." }
    : stableTranscriptAtSignalTime(scrubTime);
  const transcriptRange = document.querySelector("[data-hero-transcript-range]");
  const transcriptText = document.querySelector("[data-hero-transcript]");
  const transcriptWrap = document.querySelector(".hero-transcript");
  if (timeEl) timeEl.textContent = formatTime(scrubTime);
  if (valueEl) valueEl.textContent = `${Math.round(value * 100)}%`;
  dimEls.forEach((dimEl) => { dimEl.textContent = DIMENSION_LABELS[dim]; });
  if (questionEl) questionEl.textContent = DIMENSION_QUESTIONS[dim] || "";
  if (taglineEl) taglineEl.textContent = DIMENSION_TAGLINES[dim] || "";
  if (scoreEl) scoreEl.textContent = value.toFixed(2);
  if (shapeEl) shapeEl.textContent = active.event.eventShape.replaceAll("_", " ");
  if (peakEl) peakEl.textContent = formatTime(active.event.peakTime);
  if (orbDim) orbDim.textContent = shortLabel(dim);
  if (orbValue) orbValue.textContent = `${Math.round(value * 100)}%`;
  const nextTranscriptRange = `${formatTime(transcript.start)}-${formatTime(transcript.end)}`;
  const nextTranscriptText = transcript.text || active.analyst.quote || "";
  const nextTranscriptKey = `${nextTranscriptRange}|${nextTranscriptText}`;
  if (nextTranscriptKey !== lastHeroTranscriptKey) {
    lastHeroTranscriptKey = nextTranscriptKey;
    if (transcriptWrap) {
      transcriptWrap.classList.add("is-updating");
      window.setTimeout(() => transcriptWrap.classList.remove("is-updating"), 260);
    }
    if (transcriptRange) transcriptRange.textContent = nextTranscriptRange;
    if (transcriptText) transcriptText.textContent = nextTranscriptText;
  }
  const button = document.querySelector("#scrubPlay");
  if (button) button.textContent = scrubPlaying ? "Pause" : "Play";
}

function updateDimensionPills() {
  document.querySelectorAll(".dimension-pill").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.dimension === activeDimension);
  });
  document.querySelectorAll("[data-signal-phrase-dim]").forEach((phrase) => {
    phrase.classList.toggle("is-active", phrase.dataset.signalPhraseDim === activeDimension);
  });
}

function activateNetworkEdge(index) {
  if (index == null) return;
  const activeEdge = document.querySelector(`.network-edge[data-network-index="${CSS.escape(String(index))}"]`);
  if (!activeEdge) return;
  const a = activeEdge?.dataset.a;
  const b = activeEdge?.dataset.b;
  document.querySelectorAll(".network-edge").forEach((edge) => edge.classList.toggle("is-active", edge.dataset.networkIndex === String(index)));
  document.querySelectorAll(".network-item").forEach((item) => item.classList.toggle("is-active", item.dataset.networkIndex === String(index)));
  document.querySelectorAll(".network-node").forEach((node) => node.classList.toggle("is-active", node.dataset.dim === a || node.dataset.dim === b));
}

function activeInsight() {
  return report?.finalInsights.find((item) => item.id === activeInsightId);
}

function switchButton(id, label) {
  return `<button class="switch-pill ${id === runId ? "is-active" : ""}" type="button" data-run="${id}">${label}</button>`;
}

function short(value) {
  return String(value || "").slice(0, 8);
}

function nearest(points = [], time) {
  if (!points.length) return null;
  return points.reduce((best, point) => Math.abs(point.t - time) < Math.abs(best.t - time) ? point : best, points[0]);
}

function transcriptWindow(item, radiusSec) {
  const center = item.transcript.stimulusPeak ?? Math.max(0, item.event.peakTime - report.input.alignment.hrfLagSec);
  const start = Math.max(0, center - radiusSec);
  const end = Math.min(report.input.alignment.generatedAudioDurationSec || report.input.alignment.analysisDurationSec, center + radiusSec);
  const words = (report.input.transcriptWords || []).filter((word) => word.end >= start && word.start <= end);
  return {
    start,
    end,
    text: words.map((word) => word.word).join(" ").replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim(),
  };
}

function transcriptWindowAtSignalTime(signalTime, radiusSec) {
  const hrfLag = report.input.alignment.hrfLagSec || 0;
  const center = Math.max(0, signalTime - hrfLag);
  const start = Math.max(0, center - radiusSec);
  const end = Math.min(report.input.alignment.generatedAudioDurationSec || report.input.alignment.analysisDurationSec, center + radiusSec);
  const words = (report.input.transcriptWords || []).filter((word) => word.end >= start && word.start <= end);
  return {
    start,
    end,
    text: words.map((word) => word.word).join(" ").replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim(),
  };
}

function captionAtSignalTime(signalTime) {
  const sentence = sentenceAtSignalTime(signalTime, 4);
  if (!sentence.text) return transcriptWindowAtSignalTime(signalTime, 4);
  return {
    ...sentence,
    text: truncateWords(sentence.text, 34),
  };
}

function stableTranscriptAtSignalTime(signalTime) {
  return sentenceWindowAtSignalTime(signalTime, 2);
}

function sentenceWindowAtSignalTime(signalTime, sentenceTarget = 2) {
  const hrfLag = report.input.alignment.hrfLagSec || 0;
  const center = Math.max(0, signalTime - hrfLag);
  const duration = report.input.alignment.generatedAudioDurationSec || report.input.alignment.analysisDurationSec;
  const words = report.input.transcriptWords || [];
  if (!words.length) return transcriptWindowAtSignalTime(signalTime, 9);

  let targetIndex = 0;
  let bestDistance = Infinity;
  words.forEach((word, index) => {
    const wordCenter = ((word.start || 0) + (word.end || 0)) / 2;
    const distance = Math.abs(wordCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      targetIndex = index;
    }
  });

  let startIndex = targetIndex;
  while (startIndex > 0 && !endsSentence(words[startIndex - 1].word)) startIndex -= 1;

  let endIndex = targetIndex;
  let sentenceCount = 0;
  while (endIndex < words.length - 1 && sentenceCount < sentenceTarget) {
    if (endsSentence(words[endIndex].word)) sentenceCount += 1;
    if (sentenceCount >= sentenceTarget) break;
    endIndex += 1;
  }
  while (endIndex < words.length - 1 && !endsSentence(words[endIndex].word)) endIndex += 1;
  ({ startIndex, endIndex } = expandWeakSentenceRange(words, startIndex, endIndex));

  const selectedWords = words.slice(startIndex, endIndex + 1);
  const text = cleanTranscriptText(selectedWords.map((word) => word.word).join(" "));
  return {
    start: selectedWords[0]?.start ?? Math.max(0, center - 8),
    end: selectedWords.at(-1)?.end ?? Math.min(duration, center + 8),
    text: truncateWords(text, 58),
  };
}

function transcriptEvidenceForInsight(item) {
  const hrfLag = report.input.alignment.hrfLagSec || 0;
  const center = item.transcript.stimulusPeak ?? Math.max(0, item.event.peakTime - hrfLag);
  const startTime = Math.max(0, center - 5);
  const words = report.input.transcriptWords || [];
  if (!words.length) {
    const fallback = transcriptWindow(item, 7);
    return { ...fallback, shortText: fallback.text, fullText: fallback.text, hasMore: false };
  }

  let startIndex = words.findIndex((word) => (word.end ?? word.start ?? 0) >= startTime);
  if (startIndex < 0) startIndex = 0;

  let targetIndex = startIndex;
  let bestDistance = Infinity;
  words.forEach((word, index) => {
    const wordCenter = ((word.start || 0) + (word.end || 0)) / 2;
    const distance = Math.abs(wordCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      targetIndex = index;
    }
  });

  let endIndex = targetIndex;
  while (endIndex < words.length - 1 && !endsSentence(words[endIndex].word)) endIndex += 1;

  let sentenceCount = words.slice(startIndex, endIndex + 1).filter((word) => endsSentence(word.word)).length;
  while (sentenceCount < 2 && endIndex < words.length - 1 && endIndex - startIndex < 56) {
    endIndex += 1;
    if (endsSentence(words[endIndex].word)) sentenceCount += 1;
  }

  const selectedWords = words.slice(startIndex, endIndex + 1);
  const fullText = cleanTranscriptText(selectedWords.map((word) => word.word).join(" "));
  const tooLong = selectedWords.length > LONG_TRANSCRIPT_WORD_LIMIT || sentenceCount > 3;
  return {
    start: selectedWords[0]?.start ?? startTime,
    end: selectedWords.at(-1)?.end ?? center,
    fullText,
    shortText: tooLong ? `${truncateWords(fullText, 42)}...` : fullText,
    hasMore: tooLong,
  };
}

function truncateWords(text, limit) {
  const words = cleanTranscriptText(text).split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(" ");
  const cut = words.slice(0, limit);
  while (cut.length > 4 && isWeakEndingWord(cut.at(-1))) cut.pop();
  return cut.join(" ");
}

function transcriptSentenceForInsight(item) {
  return sentenceAtSignalTime(item.event.peakTime, 5);
}

function sentenceAtSignalTime(signalTime, radiusSec) {
  const hrfLag = report.input.alignment.hrfLagSec || 0;
  const center = Math.max(0, signalTime - hrfLag);
  const duration = report.input.alignment.generatedAudioDurationSec || report.input.alignment.analysisDurationSec;
  const words = report.input.transcriptWords || [];
  if (!words.length) return { start: Math.max(0, center - radiusSec), end: Math.min(duration, center + radiusSec), text: "" };
  let targetIndex = 0;
  let bestDistance = Infinity;
  words.forEach((word, index) => {
    const wordCenter = ((word.start || 0) + (word.end || 0)) / 2;
    const distance = Math.abs(wordCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      targetIndex = index;
    }
  });
  let startIndex = targetIndex;
  while (startIndex > 0 && !endsSentence(words[startIndex - 1].word)) startIndex -= 1;
  let endIndex = targetIndex;
  while (endIndex < words.length - 1 && !endsSentence(words[endIndex].word)) endIndex += 1;
  ({ startIndex, endIndex } = expandWeakSentenceRange(words, startIndex, endIndex));
  const sentenceWords = words.slice(startIndex, endIndex + 1);
  const fallback = transcriptWindowAtSignalTime(signalTime, radiusSec);
  const text = cleanTranscriptText(sentenceWords.map((word) => word.word).join(" "));
  return {
    start: sentenceWords[0]?.start ?? fallback.start,
    end: sentenceWords.at(-1)?.end ?? fallback.end,
    text: text || fallback.text,
  };
}

function cleanTranscriptText(text) {
  return String(text || "")
    .replace(/\b([ap])\.\s*m\./gi, "$1.m.")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function expandWeakSentenceRange(words, startIndex, endIndex) {
  let start = startIndex;
  let end = endIndex;
  let guard = 0;
  while (sentenceLooksBroken(words.slice(start, end + 1)) && guard < 3 && (start > 0 || end < words.length - 1)) {
    guard += 1;
    if (start > 0) {
      start -= 1;
      while (start > 0 && !endsSentence(words[start - 1].word)) start -= 1;
    } else if (end < words.length - 1) {
      end += 1;
      while (end < words.length - 1 && !endsSentence(words[end].word)) end += 1;
    }
  }
  return { startIndex: start, endIndex: end };
}

function sentenceLooksBroken(sentenceWords) {
  const text = cleanTranscriptText(sentenceWords.map((word) => word.word).join(" "));
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return true;
  if (text.length < 24) return true;
  return isWeakEndingWord(tokens.at(-1));
}

function isWeakEndingWord(word) {
  return /^(and|or|but|because|so|then|that|this|the|a|an|to|of|in|on|with|for|from)$/i.test(
    String(word || "").replace(/[^\w'-]+$/g, "")
  );
}

function highlightTranscriptPhrase(text, phrase) {
  const cleanText = cleanTranscriptText(text);
  const cleanPhrase = cleanTranscriptText(phrase);
  if (!cleanText || !cleanPhrase) return esc(cleanText);
  const index = cleanText.toLowerCase().indexOf(cleanPhrase.toLowerCase());
  if (index < 0) return esc(cleanText);
  return `${esc(cleanText.slice(0, index))}<strong>${esc(cleanText.slice(index, index + cleanPhrase.length))}</strong>${esc(cleanText.slice(index + cleanPhrase.length))}`;
}

function bindSpineReveal() {
  const moments = document.querySelectorAll(".spine-moment");
  if (!moments.length) return;
  if (!("IntersectionObserver" in window)) {
    moments.forEach((moment) => moment.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.22 });
  moments.forEach((moment) => observer.observe(moment));
}

function bindChartHover() {
  const stage = document.querySelector("[data-chart-stage]");
  const svg = stage?.querySelector(".full-call-chart");
  const readout = document.querySelector("[data-chart-hover-readout]");
  const hoverLine = document.querySelector("[data-chart-hover-line]");
  if (!stage || !svg || !readout) return;
  const duration = Math.max(1, report.input.alignment.analysisDurationSec || 1);
  const pad = { left: 54, right: 28, top: 58, bottom: 34 };
  const width = 1100;
  const height = 380;
  const graphW = width - pad.left - pad.right;
  const graphH = height - pad.top - pad.bottom;
  const selectedDims = () => DIMENSION_ORDER.filter((dim) => activeChartDimensions.has(dim));

  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const svgY = ((event.clientY - rect.top) / rect.height) * height;
    const clampedX = Math.max(pad.left, Math.min(width - pad.right, svgX));
    const time = ((clampedX - pad.left) / graphW) * duration;
    const dims = selectedDims();
    const values = dims.map((dim) => ({
      dim,
      point: nearest(report.normalized.byDimension[dim], time),
    })).filter((item) => item.point);
    const nearestValue = values.reduce((best, item) => {
      const y = pad.top + (1 - item.point.smoothed) * graphH;
      const distance = Math.abs(y - svgY);
      return !best || distance < best.distance ? { ...item, y, distance } : best;
    }, null);
    if (!nearestValue) return;
    readout.hidden = false;
    if (hoverLine) {
      hoverLine.hidden = false;
      hoverLine.style.left = `${Math.min(rect.width - 1, Math.max(0, event.clientX - rect.left))}px`;
    }
    readout.style.left = `${Math.min(rect.width - 230, Math.max(8, event.clientX - rect.left + 12))}px`;
    readout.style.top = `${Math.min(rect.height - 74, Math.max(8, event.clientY - rect.top + 12))}px`;
    readout.innerHTML = `<b>${esc(DIMENSION_LABELS[nearestValue.dim])}</b><span>${formatTime(time)} · ${Math.round(nearestValue.point.smoothed * 100)}% response strength</span>`;
  };
  svg.onmouseleave = () => {
    readout.hidden = true;
    if (hoverLine) hoverLine.hidden = true;
  };
}

function endsSentence(word) {
  return /[.!?]$/.test(String(word || "").trim());
}

function coordinationMoment(link) {
  const a = report.normalized.byDimension[link.a] || [];
  const b = report.normalized.byDimension[link.b] || [];
  const n = Math.min(a.length, b.length);
  let best = { time: a[0]?.t || 0, score: -Infinity };
  for (let i = 0; i < n; i += 1) {
    const av = a[i].smoothed ?? 0;
    const bv = b[i].smoothed ?? 0;
    const score = link.type === "anti" ? Math.abs(av - bv) : (av + bv) / 2;
    if (score > best.score) best = { time: a[i].t, score };
  }
  return {
    time: best.time,
    label: link.type === "anti" ? "Largest separation between the two signals" : "Strongest shared high point between the two signals",
  };
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const aa = a.slice(0, n);
  const bb = b.slice(0, n);
  const ma = mean(aa);
  const mb = mean(bb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = aa[i] - ma;
    const y = bb[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function mean(values = []) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function shortLabel(dim) {
  return {
    personal_resonance: "Personal",
    attention: "Attention",
    brain_effort: "Effort",
    gut_reaction: "Gut",
    memory_encoding: "Memory",
    social_thinking: "Social",
    language_depth: "Language",
  }[dim] || dim;
}

function hexToRgba(hex, alpha) {
  const clean = String(hex).replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escAttr(value) {
  return esc(value).replaceAll("`", "&#96;");
}
