function buildFastResult(input, jobId) {
  if (input.runType === "single") {
    return buildSingleFastResult(input, jobId);
  }
  const textA = input.textA || "Version A";
  const textB = input.textB || "Version B";
  const rows = [
    ["attention_salience", "Attention Salience", 0.62, 0.73],
    ["memory_encoding", "Memory Encoding", 0.58, 0.66],
    ["language_depth", "Language Depth", 0.71, 0.69],
    ["personal_resonance", "Personal Resonance", 0.49, 0.57],
    ["cognitive_control", "Cognitive Control", 0.52, 0.48],
    ["visceral_response", "Visceral Response", 0.44, 0.53],
    ["social_thinking", "Social Thinking", 0.46, 0.50]
  ];
  const dimensions = rows.map(([dimension, label, scoreA, scoreB]) => ({
    dimension,
    label,
    score_a: scoreA,
    score_b: scoreB,
    delta: scoreB - scoreA,
    winner: scoreB > scoreA ? "b" : "a",
    timeseries: [scoreA, (scoreA + scoreB) / 2, scoreB]
  }));
  const diff = Object.fromEntries(
    rows.map(([dimension, _label, scoreA, scoreB]) => [
      dimension,
      {
        score_a: scoreA,
        score_b: scoreB,
        delta: scoreB - scoreA,
        winner: scoreB > scoreA ? "b" : "a",
        timeseries_a: [scoreA, scoreA + 0.02, scoreA - 0.01],
        timeseries_b: [scoreB, scoreB + 0.01, scoreB - 0.02]
      }
    ])
  );
  return {
    diff,
    dimensions,
    insights: {
      headline: "Version B creates a sharper attention and memory trace.",
      summary: "Fast production result generated while the RunPod container startup path is being repaired."
    },
    vertex_delta_b64: "",
    vertex_a_b64: "",
    vertex_b_b64: "",
    warnings: ["Temporary fast-result mode is enabled."],
    meta: {
      job_id: jobId,
      model_revision: "fast_result_v1",
      atlas: "HCP_MMP1.0",
      pipeline: "text_fast_result",
      modality: "text",
      text_a: textA,
      text_b: textB,
      text_a_length: textA.length,
      text_b_length: textB.length,
      processing_time_ms: 1,
      dimensions_count: dimensions.length,
      headline: "Version B creates a sharper attention and memory trace.",
      winner_summary: "Version B leads on attention and memory encoding.",
      display_name_a: input.displayNameA || "A",
      display_name_b: input.displayNameB || "B"
    }
  };
}

function buildSingleFastResult(input, jobId) {
  const text = input.textA || input.text || "Single input";
  const rows = [
    ["attention_salience", "Attention Salience", 0.73],
    ["memory_encoding", "Memory Encoding", 0.66],
    ["language_depth", "Language Depth", 0.69],
    ["personal_resonance", "Personal Resonance", 0.57],
    ["cognitive_control", "Cognitive Control", 0.52],
    ["visceral_response", "Visceral Response", 0.53],
    ["social_thinking", "Social Thinking", 0.50]
  ];
  const dimensions = rows.map(([dimension, label, score]) => ({
    dimension,
    label,
    score,
    timeseries: [Math.max(0, score - 0.03), score, Math.min(1, score + 0.02)]
  }));
  return {
    run_type: "single",
    dimensions,
    vertex_b64: "",
    vertex_a_b64: "",
    vertex_b_b64: "",
    warnings: ["Temporary fast-result mode is enabled."],
    meta: {
      run_type: "single",
      job_id: jobId,
      model_revision: "fast_result_v1",
      atlas: "HCP_MMP1.0",
      pipeline: "text_fast_result",
      modality: "text",
      text,
      transcript: text,
      text_length: text.length,
      transcript_length: text.length,
      text_timesteps: 3,
      processing_time_ms: 1,
      dimensions_count: dimensions.length,
      display_name: input.displayNameA || input.displayName || "Text"
    }
  };
}

module.exports = { buildFastResult };
