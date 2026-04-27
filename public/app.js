const LABEL_NAMES = {
  jab: "Jab",
  cross: "Cross",
  left_hook: "Left hook",
  right_hook: "Right hook",
  left_uppercut: "Left uppercut",
  right_uppercut: "Right uppercut",
  uncertain: "Uncertain"
};

const LABEL_COLOURS = {
  jab: "#c85a34",
  cross: "#137b7b",
  left_hook: "#ba8d38",
  right_hook: "#8f4bb8",
  left_uppercut: "#397557",
  right_uppercut: "#0f4d63",
  uncertain: "#7d6f66"
};

const ARM_STROKES = {
  left: "#137b7b",
  right: "#922d11"
};

function toggleUploadMode(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  for (const pane of form.querySelectorAll("[data-mode-pane]")) {
    pane.hidden = pane.getAttribute("data-mode-pane") !== mode;
  }
}

function buildSessionDateOverride(dateValue, timeValue) {
  if (!dateValue && !timeValue) {
    return "";
  }
  if (!dateValue) {
    throw new Error("Choose a date when setting an override time.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("Session date is invalid.");
  }
  if (!timeValue) {
    return `${dateValue}_00-00-00`;
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(timeValue)) {
    throw new Error("Session time is invalid.");
  }
  const fullTime = timeValue.length === 5 ? `${timeValue}:00` : timeValue;
  return `${dateValue}_${fullTime.replace(/:/g, "-")}`;
}

function resolveApiSessionsUrl() {
  const current = new URL(window.location.href);
  const pathname = current.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/sessions/new")) {
    return `${current.origin}${pathname.slice(0, -"/sessions/new".length)}/api/sessions`;
  }
  return `${current.origin}/api/sessions`;
}

function resolveRedirectTarget(target) {
  try {
    return new URL(String(target || ""), window.location.href).toString();
  } catch (_error) {
    return null;
  }
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function buildUploadPayload(form) {
  const mode = form.querySelector('input[name="mode"]:checked')?.value || "single";
  const sessionDateValue = String(form.elements.sessionDate?.value || "").trim();
  const sessionTimeValue = String(form.elements.sessionTime?.value || "").trim();
  const sessionDateOverride = buildSessionDateOverride(sessionDateValue, sessionTimeValue);

  const payload = {
    title: form.elements.title.value.trim(),
    notes: form.elements.notes.value.trim(),
    mode,
    sessionDateOverride,
    uploads: []
  };

  if (mode === "single") {
    const singleFile = form.elements.singleFile.files[0];
    if (!singleFile) {
      throw new Error("Choose a ZIP file for the selected arm.");
    }
    payload.uploads.push({
      arm: form.elements.singleArm.value,
      name: singleFile.name,
      data: await fileToBase64(singleFile)
    });
    return payload;
  }

  const leftFile = form.elements.leftFile.files[0];
  const rightFile = form.elements.rightFile.files[0];
  if (!leftFile || !rightFile) {
    throw new Error("Dual-arm mode needs both a left and right ZIP file.");
  }
  payload.uploads.push({
    arm: "left",
    name: leftFile.name,
    data: await fileToBase64(leftFile)
  });
  payload.uploads.push({
    arm: "right",
    name: rightFile.name,
    data: await fileToBase64(rightFile)
  });
  return payload;
}

function setupUploadForm() {
  const form = document.querySelector("[data-upload-form]");
  if (!form) {
    return;
  }
  const apiSessionsUrl = resolveApiSessionsUrl();
  const status = form.querySelector("[data-upload-status]");

  toggleUploadMode(form);
  for (const modeInput of form.querySelectorAll('input[name="mode"]')) {
    modeInput.addEventListener("change", () => toggleUploadMode(form));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Reading files and sending them for analysis...";
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    try {
      const payload = await buildUploadPayload(form);
      const response = await fetch(apiSessionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const bodyText = await response.text();
      let result = {};
      if (bodyText) {
        try {
          result = JSON.parse(bodyText);
        } catch (_error) {
          throw new Error("Server returned an unexpected response while saving the session.");
        }
      }
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "The session could not be saved.");
      }
      const redirectTarget = resolveRedirectTarget(result.redirectTo);
      if (!redirectTarget) {
        throw new Error("Session saved but redirect target was invalid.");
      }
      window.location.assign(redirectTarget);
    } catch (error) {
      const rawMessage = String(error?.message || "Unexpected error.");
      status.textContent = rawMessage === "The string did not match the expected pattern."
        ? "Browser rejected the request format. Refresh the page and try again."
        : rawMessage;
    } finally {
      button.disabled = false;
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatLabel(label) {
  return LABEL_NAMES[label] || String(label || "").replaceAll("_", " ");
}

function formatArm(arm) {
  return arm === "left" ? "Left arm" : "Right arm";
}

function formatSeconds(value) {
  return Number(value || 0).toFixed(3);
}

function readExplorerPayload(root) {
  const script = root.querySelector("[data-session-explorer-data]");
  if (!script) {
    return null;
  }
  try {
    const payload = JSON.parse(script.textContent);
    if (!payload || !Array.isArray(payload.events)) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function getExplorerEvents(payload, state) {
  return payload.events.filter((event) => {
    if (state.label !== "all" && event.label !== state.label) {
      return false;
    }
    if (state.arm !== "all" && event.arm !== state.arm) {
      return false;
    }
    return true;
  });
}

function sortExplorerEvents(events, sortMode) {
  const sorted = [...events];
  switch (sortMode) {
    case "time_desc":
      return sorted.sort((left, right) => Number(right.time_sec) - Number(left.time_sec));
    case "label_asc":
      return sorted.sort((left, right) => formatLabel(left.label).localeCompare(formatLabel(right.label)) || Number(left.time_sec) - Number(right.time_sec));
    case "time_asc":
    default:
      return sorted.sort((left, right) => Number(left.time_sec) - Number(right.time_sec));
  }
}

function renderExplorerMetrics(root, events) {
  const container = root.querySelector("[data-explorer-metrics]");
  if (!container) {
    return;
  }

  const eventCount = events.length;
  const minTime = eventCount ? Math.min(...events.map((event) => Number(event.time_sec || 0))) : 0;
  const maxTime = eventCount ? Math.max(...events.map((event) => Number(event.time_sec || 0))) : 0;
  const distinctLabels = new Set(events.map((event) => event.label)).size;

  const cards = [
    {
      label: "Visible events",
      value: `${eventCount}`,
      note: eventCount ? "Matching current filters" : "Nothing matches yet"
    },
    {
      label: "Punch labels",
      value: `${distinctLabels}`,
      note: eventCount ? "Types in the current view" : "No labels visible"
    },
    {
      label: "Visible span",
      value: eventCount ? `${formatSeconds(maxTime - minTime)}s` : "0.000s",
      note: eventCount ? `${formatSeconds(minTime)}s to ${formatSeconds(maxTime)}s` : "No time range yet"
    }
  ];

  container.innerHTML = cards
    .map((card) => `
      <article class="mini-stat-card">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <small>${escapeHtml(card.note)}</small>
      </article>
    `)
    .join("");
}

function buildTimelineSvg(events, labels) {
  const width = 1080;
  const leftPad = 120;
  const rightPad = 32;
  const topPad = 28;
  const laneGap = 54;
  const bottomPad = 44;
  const laneLabels = labels.filter((label) => events.some((event) => event.label === label));
  const unknownLabels = [...new Set(events.map((event) => event.label))].filter((label) => !laneLabels.includes(label));
  const lanes = [...laneLabels, ...unknownLabels];
  const height = topPad + bottomPad + Math.max(1, lanes.length) * laneGap;
  const minTime = Math.min(...events.map((event) => Number(event.time_sec || 0)));
  const maxTime = Math.max(...events.map((event) => Number(event.time_sec || 0)));
  const timeSpan = Math.max(0.001, maxTime - minTime);
  const plotWidth = width - leftPad - rightPad;

  const xFor = (time) => leftPad + ((Number(time || 0) - minTime) / timeSpan) * plotWidth;
  const yFor = (label) => topPad + lanes.indexOf(label) * laneGap + laneGap / 2;

  const laneLines = lanes
    .map((label) => `
      <g>
        <text x="0" y="${yFor(label) + 4}" fill="#5d696b" font-size="13">${escapeHtml(formatLabel(label))}</text>
        <line x1="${leftPad}" y1="${yFor(label)}" x2="${width - rightPad}" y2="${yFor(label)}" stroke="rgba(18,32,39,0.12)" stroke-width="1" />
      </g>
    `)
    .join("");

  const ticks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const time = minTime + timeSpan * ratio;
    const x = leftPad + plotWidth * ratio;
    return `
      <g>
        <line x1="${x}" y1="${height - bottomPad + 4}" x2="${x}" y2="${height - bottomPad + 12}" stroke="rgba(18,32,39,0.28)" stroke-width="1" />
        <text x="${x}" y="${height - 10}" text-anchor="middle" fill="#5d696b" font-size="12">${formatSeconds(time)}s</text>
      </g>
    `;
  }).join("");

  const eventDots = events
    .map((event) => {
      const fill = LABEL_COLOURS[event.label] || "#ba8d38";
      const stroke = ARM_STROKES[event.arm] || "#122027";
      const radius = 7;
      const x = xFor(event.time_sec);
      const y = yFor(event.label);
      return `
        <g>
          <circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2">
            <title>${escapeHtml(`${formatLabel(event.label)} · ${formatArm(event.arm)} · ${formatSeconds(event.time_sec)}s`)}</title>
          </circle>
        </g>
      `;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Session event timeline">
      ${laneLines}
      <line x1="${leftPad}" y1="${height - bottomPad}" x2="${width - rightPad}" y2="${height - bottomPad}" stroke="rgba(18,32,39,0.22)" stroke-width="1.2" />
      ${ticks}
      ${eventDots}
    </svg>
  `;
}

function renderExplorerTimeline(root, payload, events) {
  const container = root.querySelector("[data-event-timeline]");
  if (!container) {
    return;
  }
  if (!events.length) {
    container.innerHTML = `<div class="timeline-empty">No events match the current filters.</div>`;
    return;
  }
  const timeOrderedEvents = [...events].sort((left, right) => Number(left.time_sec) - Number(right.time_sec));
  container.innerHTML = buildTimelineSvg(timeOrderedEvents, payload.labels || []);
}

function renderExplorerTable(root, events) {
  const meta = root.querySelector("[data-explorer-meta]");
  const container = root.querySelector("[data-event-table]");
  if (!container || !meta) {
    return;
  }
  if (!events.length) {
    meta.textContent = "No matching events for the current filters.";
    container.innerHTML = `<div class="empty-state">No events match the current filters.</div>`;
    return;
  }

  meta.textContent = `${events.length} events visible.`;

  const rows = events
    .map((event, index) => `
      <tr>
        <td>${String(index + 1).padStart(2, "0")}</td>
        <td>${escapeHtml(formatArm(event.arm))}</td>
        <td>${formatSeconds(event.time_sec)}s</td>
        <td>${escapeHtml(formatLabel(event.label))}</td>
        <td>${escapeHtml(event.sourceName || event.originalFilename || "Upload")}</td>
      </tr>
    `)
    .join("");

  container.innerHTML = `
    <table class="session-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Arm</th>
          <th>Time</th>
          <th>Label</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderExplorer(root, payload, state) {
  const filteredEvents = getExplorerEvents(payload, state);
  const tableEvents = sortExplorerEvents(filteredEvents, state.sortMode);
  renderExplorerMetrics(root, filteredEvents);
  renderExplorerTimeline(root, payload, filteredEvents);
  renderExplorerTable(root, tableEvents);
}

function setActiveLabelChip(root, label) {
  for (const chip of root.querySelectorAll("[data-label-filter]")) {
    chip.classList.toggle("filter-chip--active", chip.getAttribute("data-label-filter") === label);
  }
}

function setupSessionExplorer() {
  for (const root of document.querySelectorAll("[data-session-explorer]")) {
    const payload = readExplorerPayload(root);
    if (!payload) {
      continue;
    }

    const state = {
      label: "all",
      arm: "all",
      sortMode: "time_asc"
    };

    const armSelect = root.querySelector("[data-arm-filter]");
    const sortSelect = root.querySelector("[data-sort-filter]");

    root.querySelector("[data-session-labels]")?.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-label-filter]");
      if (!chip) {
        return;
      }
      state.label = chip.getAttribute("data-label-filter") || "all";
      setActiveLabelChip(root, state.label);
      renderExplorer(root, payload, state);
    });

    armSelect?.addEventListener("change", (event) => {
      state.arm = event.target.value || "all";
      renderExplorer(root, payload, state);
    });

    sortSelect?.addEventListener("change", (event) => {
      state.sortMode = event.target.value || "time_asc";
      renderExplorer(root, payload, state);
    });

    setActiveLabelChip(root, state.label);
    renderExplorer(root, payload, state);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupUploadForm();
  setupSessionExplorer();
});
