const LABEL_NAMES = {
  jab: "Jab",
  cross: "Cross",
  left_hook: "Left hook",
  right_hook: "Right hook",
  left_uppercut: "Left uppercut",
  right_uppercut: "Right uppercut",
  uncertain: "Uncertain"
};
const KNOWN_PUNCH_LABELS = Object.keys(LABEL_NAMES);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanizeLabel(label) {
  return LABEL_NAMES[label] || String(label || "").replaceAll("_", " ");
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function slugifyFilename(filename) {
  return String(filename || "upload.zip")
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function mergeSummaryCounts(summaries) {
  const merged = {};
  for (const summary of summaries) {
    for (const [label, rawCount] of Object.entries(summary || {})) {
      const count = Number(rawCount || 0);
      merged[label] = (merged[label] || 0) + count;
    }
  }
  return merged;
}

function pickTopPunch(summary) {
  const entries = Object.entries(summary || {})
    .filter(([label]) => label !== "uncertain")
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  return entries[0] ? humanizeLabel(entries[0][0]) : "No sessions yet";
}

function averageConfidence(rows) {
  const totalEvents = rows.reduce((sum, row) => {
    return sum + Number(row.total_events ?? row.totalEvents ?? 0);
  }, 0);
  if (!totalEvents) {
    return 0;
  }
  return rows.reduce((sum, row) => {
    return sum + Number(row.avg_confidence ?? row.avgConfidence ?? 0) * Number(row.total_events ?? row.totalEvents ?? 0);
  }, 0) / totalEvents;
}

function formatConfidence(value) {
  return Number(value || 0).toFixed(3);
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function formatDateLabel(value) {
  if (!value) {
    return "Not recorded";
  }
  if (typeof value === "string" && value.includes("_")) {
    return value.replace("_", " ");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("en-GB");
}

function formatSeconds(value) {
  return Number(value || 0).toFixed(3);
}

function formatArmLabel(arm) {
  return arm === "left" ? "Left arm" : "Right arm";
}

function buildQueryString(values) {
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(values || {})) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = String(rawValue).trim();
    if (!value) {
      continue;
    }
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function csvEscape(value) {
  const normalized = String(value ?? "");
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
}

function toCsv(rows) {
  return rows.map((row) => row.map((value) => csvEscape(value)).join(",")).join("\n");
}

module.exports = {
  averageConfidence,
  buildQueryString,
  csvEscape,
  escapeHtml,
  formatArmLabel,
  formatConfidence,
  formatCount,
  formatDateLabel,
  formatPercent,
  formatSeconds,
  humanizeLabel,
  knownPunchLabels: KNOWN_PUNCH_LABELS,
  mergeSummaryCounts,
  pickTopPunch,
  safeJsonParse,
  slugifyFilename,
  toCsv
};
