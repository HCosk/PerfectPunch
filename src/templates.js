// Server-side HTML page templates
const config = require("./config");
const {
  buildQueryString,
  escapeHtml,
  formatArmLabel,
  formatCount,
  formatDateLabel,
  formatPercent,
  formatSeconds,
  humanizeLabel,
  knownPunchLabels
} = require("./utils");

function renderLayout({ title, user, activePath = "", pageName = "app", content }) {
  // Wrap content in shared HTML shell
  return `<!DOCTYPE html>
<html lang="en-GB">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${config.withBasePath("/assets/styles.css")}" />
  </head>
  <body data-page="${escapeHtml(pageName)}" data-base-path="${escapeHtml(config.basePath)}">
    <div class="shell">
      ${user ? renderTopbar(user, activePath) : ""}
      <main class="page-shell ${user ? "" : "page-shell--public"}">
        ${content}
      </main>
    </div>
    <script src="${config.withBasePath("/assets/app.js")}" defer></script>
  </body>
</html>`;
}

function renderTopbar(user, activePath) {
  // Render the signed-in navigation bar
  const links = [
    { path: "/dashboard", label: "Dashboard" },
    { path: "/sessions/new", label: "Record session" },
    { path: "/history", label: "History" },
    { path: "/compare", label: "Compare" }
  ];
  return `
    <header class="topbar">
      <a class="brand" href="${config.withBasePath("/dashboard")}">
        <span class="brand-mark">PP</span>
        <span>
          <strong>PerfectPunch</strong>
          <small>Coaching desk</small>
        </span>
      </a>
      <nav class="nav-links">
        ${links
          .map((link) => {
            const isActive = activePath === link.path ? "nav-link--active" : "";
            return `<a class="nav-link ${isActive}" href="${config.withBasePath(link.path)}">${link.label}</a>`;
          })
          .join("")}
      </nav>
      <div class="user-chip">
        <div>
          <strong>${escapeHtml(user.username)}</strong>
          <small>Athlete · Jab arm ${escapeHtml(user.jab_arm)}</small>
        </div>
        <form method="post" action="${config.withBasePath("/logout")}">
          <button type="submit" class="ghost-button">Log out</button>
        </form>
      </div>
    </header>
  `;
}

function renderAuthPage({ mode, error = "", values = {} }) {
  // Login or signup form page
  const isLogin = mode === "login";
  const title = isLogin ? "Welcome back" : "Create your account";
  const submitLabel = isLogin ? "Sign in" : "Create account";
  const altHref = isLogin ? config.withBasePath("/signup") : config.withBasePath("/login");
  const altLabel = isLogin ? "Need an account?" : "Already registered?";
  const altCta = isLogin ? "Create one" : "Sign in";
  const action = isLogin ? config.withBasePath("/login") : config.withBasePath("/signup");

  return renderLayout({
    title: isLogin ? "PerfectPunch Login" : "PerfectPunch Sign Up",
    pageName: isLogin ? "login" : "signup",
    content: `
      <section class="auth-grid">
        <article class="hero-panel">
          <p class="eyebrow">Boxing intelligence</p>
          <h1>${title}</h1>
          <p>
            Track left and right arm uploads, store every recorded session, and come back to clean,
            coach-friendly history whenever you need it.
          </p>
        </article>
        <article class="card auth-card">
          <div class="card-head">
            <h2>${isLogin ? "Sign in to your desk" : "Build your desk"}</h2>
            <p>${isLogin ? "Pick up where your last session left off." : "Create a regular athlete account."}</p>
          </div>
          ${error ? `<p class="feedback feedback--error">${escapeHtml(error)}</p>` : ""}
          <form method="post" action="${action}" class="form-stack">
            ${
              isLogin
                ? `
                  <label>
                    <span>Username or email</span>
                    <input name="login" type="text" required value="${escapeHtml(values.login || "")}" />
                  </label>
                `
                : `
                  <label>
                    <span>Username</span>
                    <input name="username" type="text" required value="${escapeHtml(values.username || "")}" />
                  </label>
                  <label>
                    <span>Email</span>
                    <input name="email" type="email" required value="${escapeHtml(values.email || "")}" />
                  </label>
                `
            }
            <label>
              <span>Password</span>
              <input name="password" type="password" required />
            </label>
            ${
              isLogin
                ? ""
                : `
                  <label>
                    <span>Confirm password</span>
                    <input name="confirmPassword" type="password" required />
                  </label>
                `
            }
            <button class="primary-button" type="submit">${submitLabel}</button>
          </form>
          <p class="form-footnote">
            ${altLabel}
            <a href="${altHref}">${altCta}</a>
          </p>
        </article>
      </section>
    `
  });
}

function renderStatCard(label, value, note = "") {
  // Single highlighted statistic card
  return `
    <article class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>
  `;
}

function renderSummaryBreakdown(summary) {
  // Bar chart of label counts
  const entries = Object.entries(summary || {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  if (!entries.length) {
    return `<p class="empty-copy">No punch labels recorded yet.</p>`;
  }
  const largestCount = Number(entries[0][1]) || 1;
  return `
    <div class="summary-stack">
      ${entries
        .map(([label, count]) => {
          const width = Math.max(10, Math.round((Number(count || 0) / largestCount) * 100));
          return `
            <div class="summary-row">
              <span>${escapeHtml(humanizeLabel(label))}</span>
              <div class="summary-bar"><span style="width:${width}%"></span></div>
              <strong>${formatCount(count)}</strong>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function buildPolyline(points) {
  // SVG polyline points string
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function renderProgressTrend(progressTrend) {
  // Progress chart over recent sessions
  if (!progressTrend.length) {
    return `<div class="empty-state">Save a few sessions to see progress over time.</div>`;
  }

  // Chart geometry constants
  const width = 720;
  const height = 260;
  const padding = 34;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const maxEvents = Math.max(1, ...progressTrend.map((point) => point.totalEvents));
  const steps = Math.max(1, progressTrend.length - 1);

  // Coordinate mappers for chart values
  const xFor = (index) => padding + (index / steps) * chartWidth;
  const eventYFor = (value) => padding + chartHeight - (Number(value || 0) / maxEvents) * chartHeight;
  const rateYFor = (value) => padding + chartHeight - Number(value || 0) * chartHeight;
  const eventPoints = progressTrend.map((point, index) => ({ x: xFor(index), y: eventYFor(point.totalEvents) }));
  const cleanRatePoints = progressTrend.map((point, index) => ({ x: xFor(index), y: rateYFor(point.cleanRate) }));
  const latest = progressTrend[progressTrend.length - 1];

  return `
    <div class="progress-panel">
      <div class="progress-chart" role="img" aria-label="Progress over saved sessions">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <line class="chart-grid" x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" />
          <line class="chart-grid" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" />
          <polyline class="chart-line chart-line--events" points="${buildPolyline(eventPoints)}" />
          <polyline class="chart-line chart-line--clean" points="${buildPolyline(cleanRatePoints)}" />
          ${progressTrend
            .map((point, index) => {
              const x = xFor(index);
              return `
                <g>
                  <line class="chart-stem" x1="${x}" y1="${eventYFor(point.totalEvents)}" x2="${x}" y2="${height - padding}" />
                  <circle class="chart-dot chart-dot--events" cx="${x}" cy="${eventYFor(point.totalEvents)}" r="5" />
                  <circle class="chart-dot chart-dot--clean" cx="${x}" cy="${rateYFor(point.cleanRate)}" r="4" />
                </g>
              `;
            })
            .join("")}
        </svg>
      </div>
      <div class="progress-legend">
        <span><i class="legend-dot legend-dot--events"></i>Events</span>
        <span><i class="legend-dot legend-dot--clean"></i>Clean rate</span>
      </div>
      <div class="progress-latest">
        <div>
          <span>Latest session</span>
          <strong>${escapeHtml(latest.title)}</strong>
        </div>
        <div>
          <span>Clean rate</span>
          <strong>${formatPercent(latest.cleanRate)}</strong>
        </div>
      </div>
    </div>
  `;
}

function renderFavoritePill(isFavorite) {
  // Tiny favorite chip badge
  return isFavorite ? `<span class="chip chip--favorite">Favorite</span>` : "";
}

function renderSessionActions(session) {
  // Inline action buttons row
  return `
    <div class="button-row button-row--tight">
      <a class="ghost-button ghost-button--small" href="${config.withBasePath(`/sessions/${session.id}`)}">Details</a>
      <a class="ghost-button ghost-button--small" href="${config.withBasePath(`/compare${buildQueryString({ first: session.id })}`)}">Compare</a>
      <a class="ghost-button ghost-button--small" href="${config.withBasePath(`/sessions/${session.id}/export.csv`)}">Export</a>
    </div>
  `;
}

function renderSessionsTable(sessions, options = {}) {
  // Render the sessions list table
  const {
    emptyMessage = "No sessions recorded yet.",
    showActions = false
  } = options;

  if (!sessions.length) {
    return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
  }

  return `
    <div class="table-shell">
      <table class="session-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Arms</th>
            <th>Recorded</th>
            <th>Events</th>
            ${showActions ? "<th>Actions</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${sessions
            .map((session) => {
              return `
                <tr>
                  <td>
                    <a class="row-link" href="${config.withBasePath(`/sessions/${session.id}`)}">${escapeHtml(session.title)}</a>
                    <div class="inline-meta">
                      ${renderFavoritePill(session.is_favorite)}
                      <span class="chip">${escapeHtml(session.topPunch)}</span>
                    </div>
                    <small>${escapeHtml(session.notes || "No notes")}</small>
                  </td>
                  <td>
                    <div class="badge-row">
                      ${session.arms
                        .map((arm) => `<span class="arm-pill">${escapeHtml(formatArmLabel(arm))}</span>`)
                        .join("")}
                    </div>
                  </td>
                  <td>${escapeHtml(formatDateLabel(session.session_date || session.created_at))}</td>
                  <td>
                    <strong>${formatCount(session.total_events)}</strong>
                    <small>${formatPercent(session.cleanRate)} clean</small>
                  </td>
                  ${showActions ? `<td>${renderSessionActions(session)}</td>` : ""}
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDashboardPage({ user, stats, sessions, combinedSummary, progressTrend }) {
  // Build the main dashboard HTML
  return renderLayout({
    title: "PerfectPunch Dashboard",
    user,
    activePath: "/dashboard",
    pageName: "dashboard",
    content: `
      <section class="hero-card">
        <div>
          <p class="eyebrow">Session overview</p>
          <h1>${escapeHtml(user.username)}, your session desk is ready.</h1>
          <p>
            Review old sessions, compare left and right uploads, and keep your data tidy enough
            to coach from at a glance.
          </p>
        </div>
        <div class="hero-actions">
          <a class="primary-button" href="${config.withBasePath("/sessions/new")}">Record a new session</a>
          <a class="ghost-button ghost-button--light" href="${config.withBasePath("/history")}">Open full history</a>
          <a class="ghost-button ghost-button--light" href="${config.withBasePath("/compare")}">Compare sessions</a>
        </div>
      </section>

      <section class="stat-grid">
        ${renderStatCard("Recorded sessions", formatCount(stats.totalSessions), "Your saved session history")}
        ${renderStatCard("Favorites", formatCount(stats.favoriteSessions), "Pinned sessions to revisit")}
        ${renderStatCard("Arm uploads", formatCount(stats.totalUploads), `${formatCount(stats.leftUploads)} left · ${formatCount(stats.rightUploads)} right`)}
        ${renderStatCard("Detected events", formatCount(stats.totalEvents), "Across every saved upload")}
        ${renderStatCard("Uncertain rate", formatPercent(stats.uncertaintyRate), "Lower means cleaner reads")}
        ${renderStatCard("Top punch", stats.topPunch, `Profile jab arm: ${user.jab_arm}`)}
      </section>

      <section class="content-grid">
        <article class="card">
          <div class="card-head">
            <h2>Recent sessions</h2>
            <p>Jump straight back into your latest uploads.</p>
          </div>
          ${renderSessionsTable(sessions, { emptyMessage: "Record a session to start building your dashboard." })}
        </article>
        <article class="card">
          <div class="card-head">
            <h2>Punch mix</h2>
            <p>A clean roll-up of every saved punch label.</p>
          </div>
          ${renderSummaryBreakdown(combinedSummary)}
        </article>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Progress over time</h2>
          <p>Tracks your latest saved sessions by volume and clean punch rate.</p>
        </div>
        ${renderProgressTrend(progressTrend)}
      </section>
    `
  });
}

function renderUploadPage({ user, modelInfo, error = "" }) {
  // Render the upload form page
  const modelStatus = modelInfo?.trained
    ? `Ready · model ${modelInfo.model_version || "current"}`
    : modelInfo?.error || "Model artefacts are not ready yet.";

  return renderLayout({
    title: "Record Session",
    user,
    activePath: "/sessions/new",
    pageName: "upload",
    content: `
      <section class="hero-card hero-card--compact">
        <div>
          <p class="eyebrow">Record a session</p>
          <h1>Upload one arm or both arms.</h1>
          <p>
            Keep each file tagged to the correct arm so your history stays readable and jabs are
            reviewed in the right context.
          </p>
        </div>
        <div class="hero-meta">
          <span class="chip">${escapeHtml(modelStatus)}</span>
          <span class="chip">Jab arm profile: ${escapeHtml(user.jab_arm)}</span>
        </div>
      </section>

      <section class="content-grid">
        <article class="card">
          <div class="card-head">
            <h2>Upload form</h2>
            <p>JavaScript is used here so we can send one or two ZIP files in a clean single save.</p>
          </div>
          ${error ? `<p class="feedback feedback--error">${escapeHtml(error)}</p>` : ""}
          <form class="form-stack" data-upload-form>
            <label>
              <span>Session title</span>
              <input name="title" type="text" placeholder="Tuesday sparring review" />
            </label>
            <label>
              <span>Notes</span>
              <textarea name="notes" rows="4" placeholder="What were you working on in this round?"></textarea>
            </label>
            <label>
              <span>Optional session date override</span>
              <div class="date-time-grid">
                <input name="sessionDate" type="date" />
                <input name="sessionTime" type="time" step="1" />
              </div>
              <small class="field-note">Leave both empty to use the timestamp found in the upload metadata.</small>
            </label>

            <div class="mode-switch">
              <label class="choice-chip">
                <input type="radio" name="mode" value="single" checked />
                <span>Single arm</span>
              </label>
              <label class="choice-chip">
                <input type="radio" name="mode" value="dual" />
                <span>Both arms</span>
              </label>
            </div>

            <section class="upload-zone" data-mode-pane="single">
              <label>
                <span>Which arm are you uploading?</span>
                <select name="singleArm">
                  <option value="right">Right arm</option>
                  <option value="left">Left arm</option>
                </select>
              </label>
              <label>
                <span>ZIP file</span>
                <input name="singleFile" type="file" accept=".zip" />
              </label>
            </section>

            <section class="upload-zone" data-mode-pane="dual" hidden>
              <label>
                <span>Left arm ZIP</span>
                <input name="leftFile" type="file" accept=".zip" />
              </label>
              <label>
                <span>Right arm ZIP</span>
                <input name="rightFile" type="file" accept=".zip" />
              </label>
            </section>

            <button class="primary-button" type="submit">Analyse and save session</button>
            <p class="feedback" data-upload-status>Waiting for your files.</p>
          </form>
        </article>

        <article class="card">
          <div class="card-head">
            <h2>What gets saved</h2>
            <p>Your uploads are stored with user ownership, arm labels, and reusable history stats.</p>
          </div>
          <ul class="detail-list">
            <li>Every upload is tied to left or right arm so old sessions stay coach-friendly.</li>
            <li>A session can include one arm or both arms under the same saved workout.</li>
            <li>The dashboard stays focused on analysis, saved sessions, and progress history.</li>
            <li>If a non-jab arm shows jab labels, the session detail page will flag it for review.</li>
          </ul>
        </article>
      </section>
    `
  });
}

function renderHistoryFilters(filters) {
  // History filter card with form
  const exportHref = `${config.withBasePath("/history/export.csv")}${buildQueryString(filters)}`;
  return `
    <form class="card filter-card filter-form" method="get" action="${config.withBasePath("/history")}">
      <div class="card-head">
        <h2>Find sessions faster</h2>
        <p>Search by title or notes, narrow by arm or punch mix, then export the current slice.</p>
      </div>
      <div class="filter-grid">
        <label>
          <span>Search</span>
          <input name="search" type="text" value="${escapeHtml(filters.search)}" placeholder="sparring, jab, clean round" />
        </label>
        <label>
          <span>Arm</span>
          <select name="arm">
            <option value="">Any arm</option>
            <option value="left" ${filters.arm === "left" ? "selected" : ""}>Left arm</option>
            <option value="right" ${filters.arm === "right" ? "selected" : ""}>Right arm</option>
          </select>
        </label>
        <label>
          <span>Mode</span>
          <select name="mode">
            <option value="">Any mode</option>
            <option value="single" ${filters.mode === "single" ? "selected" : ""}>Single arm</option>
            <option value="dual" ${filters.mode === "dual" ? "selected" : ""}>Both arms</option>
          </select>
        </label>
        <label>
          <span>Favorite</span>
          <select name="favorite">
            <option value="all" ${filters.favorite === "all" ? "selected" : ""}>All sessions</option>
            <option value="only" ${filters.favorite === "only" ? "selected" : ""}>Favorites only</option>
            <option value="exclude" ${filters.favorite === "exclude" ? "selected" : ""}>Exclude favorites</option>
          </select>
        </label>
        <label>
          <span>Punch label</span>
          <select name="punchLabel">
            <option value="">Any punch label</option>
            ${knownPunchLabels
              .map((label) => `<option value="${escapeHtml(label)}" ${filters.punchLabel === label ? "selected" : ""}>${escapeHtml(humanizeLabel(label))}</option>`)
              .join("")}
          </select>
        </label>
        <label>
          <span>Sort by</span>
          <select name="sort">
            <option value="date_desc" ${filters.sort === "date_desc" ? "selected" : ""}>Newest first</option>
            <option value="date_asc" ${filters.sort === "date_asc" ? "selected" : ""}>Oldest first</option>
            <option value="events_desc" ${filters.sort === "events_desc" ? "selected" : ""}>Most events</option>
            <option value="title_asc" ${filters.sort === "title_asc" ? "selected" : ""}>Title A-Z</option>
          </select>
        </label>
        <label>
          <span>From date</span>
          <input name="dateFrom" type="date" value="${escapeHtml(filters.dateFrom)}" />
        </label>
        <label>
          <span>To date</span>
          <input name="dateTo" type="date" value="${escapeHtml(filters.dateTo)}" />
        </label>
      </div>
      <div class="button-row">
        <button class="primary-button" type="submit">Apply filters</button>
        <a class="ghost-button" href="${config.withBasePath("/history")}">Reset</a>
        <a class="ghost-button" href="${exportHref}">Export current list</a>
      </div>
    </form>
  `;
}

function renderHistoryPage({ user, sessions, filters }) {
  // Render the history listing page
  return renderLayout({
    title: "Session History",
    user,
    activePath: "/history",
    pageName: "history",
    content: `
      <section class="hero-card hero-card--compact">
        <div>
          <p class="eyebrow">History</p>
          <h1>Your saved sessions</h1>
          <p>Search, filter, compare, export, and reopen any recorded session when you want a cleaner coaching view.</p>
        </div>
        <div class="hero-actions">
          <a class="primary-button" href="${config.withBasePath("/sessions/new")}">Record another session</a>
          <a class="ghost-button ghost-button--light" href="${config.withBasePath("/compare")}">Open compare desk</a>
        </div>
      </section>

      ${renderHistoryFilters(filters)}

      <section class="card">
        <div class="card-head">
          <h2>All sessions</h2>
          <p>${formatCount(sessions.length)} sessions match the current filters.</p>
        </div>
        ${renderSessionsTable(sessions, { emptyMessage: "No sessions matched the current filters.", showActions: true })}
      </section>
    `
  });
}

function serializeForScript(value) {
  // Safe JSON for inline script tags
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function renderArmComparison(session) {
  // Compact per-arm comparison table
  if (!session.arms.length) {
    return `<div class="empty-state">No arm uploads were saved for this session.</div>`;
  }

  return `
    <div class="table-shell">
      <table class="session-table">
        <thead>
          <tr>
            <th>Arm</th>
            <th>Events</th>
            <th>Clean rate</th>
            <th>Top punch</th>
          </tr>
        </thead>
        <tbody>
          ${session.arms
            .map((armRecord) => `
              <tr>
                <td>${escapeHtml(formatArmLabel(armRecord.arm))}</td>
                <td>${formatCount(armRecord.total_events)}</td>
                <td>${formatPercent(armRecord.cleanRate)}</td>
                <td>${escapeHtml(armRecord.topPunch)}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderExplorerLabelChips(session) {
  // Filter chips for label types
  const chips = [
    `<button type="button" class="filter-chip filter-chip--active" data-label-filter="all">All events <span>${formatCount(session.allEvents.length)}</span></button>`
  ];

  for (const label of knownPunchLabels) {
    const count = Number(session.summary[label] || 0);
    if (!count) {
      continue;
    }
    chips.push(
      `<button type="button" class="filter-chip" data-label-filter="${escapeHtml(label)}">${escapeHtml(humanizeLabel(label))} <span>${formatCount(count)}</span></button>`
    );
  }

  return chips.join("");
}

function renderSessionExplorer(session) {
  // Interactive event explorer panel
  const payload = {
    labels: knownPunchLabels,
    events: session.allEvents
  };

  return `
    <section class="card explorer-card" data-session-explorer>
      <div class="card-head">
        <h2>Event explorer</h2>
        <p>Filter by punch label and arm, then sort the table while keeping the timeline in view.</p>
      </div>
      <script type="application/json" data-session-explorer-data>${serializeForScript(payload)}</script>
      <div class="explorer-toolbar">
        <div class="chip-strip" data-session-labels>
          ${renderExplorerLabelChips(session)}
        </div>
        <div class="filter-inline-grid">
          <label>
            <span>Arm</span>
            <select data-arm-filter>
              <option value="all">All arms</option>
              ${session.arms.map((armRecord) => `<option value="${escapeHtml(armRecord.arm)}">${escapeHtml(formatArmLabel(armRecord.arm))}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Sort table</span>
            <select data-sort-filter>
              <option value="time_asc">Time ascending</option>
              <option value="time_desc">Time descending</option>
              <option value="label_asc">Label A-Z</option>
            </select>
          </label>
        </div>
      </div>
      <div class="mini-stat-grid" data-explorer-metrics></div>
      <div class="timeline-shell" data-event-timeline>
        <div class="empty-state">Timeline is preparing.</div>
      </div>
      <div class="table-head-inline">
        <strong>Visible events</strong>
        <span data-explorer-meta>Preparing event table.</span>
      </div>
      <div class="table-shell" data-event-table>
        <div class="empty-state">Event table is preparing.</div>
      </div>
    </section>
  `;
}

function renderArmPanel(armRecord, user) {
  // Detail card for a single arm
  const jabMismatch = armRecord.arm !== user.jab_arm && Number(armRecord.summary.jab || 0) > 0;

  return `
    <article class="card arm-card">
      <div class="card-head">
        <h2>${escapeHtml(formatArmLabel(armRecord.arm))}</h2>
        <p>${escapeHtml(armRecord.original_filename)}</p>
      </div>
      <div class="meta-grid">
        <div><span>Recorded</span><strong>${escapeHtml(formatDateLabel(armRecord.session_date))}</strong></div>
        <div><span>Duration</span><strong>${formatSeconds(armRecord.duration_sec)}s</strong></div>
        <div><span>Events</span><strong>${formatCount(armRecord.total_events)}</strong></div>
        <div><span>Uncertain events</span><strong>${formatCount(armRecord.uncertain_events)}</strong></div>
      </div>
      ${jabMismatch ? `<p class="feedback feedback--warn">This arm is not the user profile jab arm, but jab labels were detected. Review those frames manually.</p>` : ""}
      <div class="section-label">Punch breakdown</div>
      ${renderSummaryBreakdown(armRecord.summary)}
      <div class="section-label">Event log</div>
      ${
        armRecord.events.length
          ? `
            <div class="table-shell">
              <table class="session-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Time</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  ${armRecord.events
                    .map((event) => {
                      return `
                        <tr>
                          <td>${String(event.index).padStart(2, "0")}</td>
                          <td>${formatSeconds(event.time_sec)}s</td>
                          <td>${escapeHtml(humanizeLabel(event.label))}</td>
                        </tr>
                      `;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>
          `
          : `<div class="empty-state">No events detected for this arm.</div>`
      }
    </article>
  `;
}

function renderSessionActionPanel(session) {
  // Hero action buttons for session
  const returnTo = ".";
  return `
    <div class="hero-actions">
      <a class="primary-button" href="${config.withBasePath(`/compare${buildQueryString({ first: session.id })}`)}">Compare this session</a>
      <a class="ghost-button ghost-button--light" href="${config.withBasePath(`/sessions/${session.id}/edit`)}">Edit details</a>
      <a class="ghost-button ghost-button--light" href="${config.withBasePath(`/sessions/${session.id}/export.csv`)}">Export CSV</a>
      <form method="post" action="${config.withBasePath(`/sessions/${session.id}/favorite`)}">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <button type="submit" class="ghost-button ghost-button--light">${session.is_favorite ? "Remove favorite" : "Mark favorite"}</button>
      </form>
      <form method="post" action="${config.withBasePath(`/sessions/${session.id}/delete`)}" onsubmit="return confirm('Delete this saved session? This also removes the stored ZIP uploads.');">
        <button type="submit" class="ghost-button ghost-button--danger">Delete session</button>
      </form>
    </div>
  `;
}

function renderSessionDetailPage({ user, session }) {
  // Render full session detail page
  return renderLayout({
    title: session.title,
    user,
    activePath: "/history",
    pageName: "session-detail",
    content: `
      <section class="hero-card hero-card--compact">
        <div>
          <p class="eyebrow">Saved session</p>
          <h1>${escapeHtml(session.title)}</h1>
          <p>${escapeHtml(session.notes || "No notes were added for this session.")}</p>
          <div class="hero-meta">
            <span class="chip">${escapeHtml(formatDateLabel(session.session_date || session.created_at))}</span>
            <span class="chip">${formatCount(session.total_events)} total events</span>
            ${renderFavoritePill(session.is_favorite)}
          </div>
        </div>
        ${renderSessionActionPanel(session)}
      </section>

      <section class="stat-grid">
        ${renderStatCard("Upload mode", session.upload_mode, "Single or dual arm session")}
        ${renderStatCard("Detected events", formatCount(session.total_events), "Across all uploaded arms")}
        ${renderStatCard("Clean rate", formatPercent(session.cleanRate), `${formatCount(session.cleanEvents)} clean events`)}
        ${renderStatCard("Distinct punches", formatCount(session.distinctPunches), `Top punch: ${session.topPunch}`)}
        ${renderStatCard("Model version", session.model_version || "Unknown", "Snapshot used for this session")}
        ${renderStatCard("Saved at", formatDateLabel(session.created_at), "Persisted to MySQL")}
      </section>

      <section class="content-grid">
        <article class="card">
          <div class="card-head">
            <h2>Overall breakdown</h2>
            <p>Merged across every uploaded arm in this saved session.</p>
          </div>
          ${renderSummaryBreakdown(session.summary)}
        </article>
        <article class="card">
          <div class="card-head">
            <h2>Arm comparison</h2>
            <p>Quickly compare event volume and punch mix between recorded uploads.</p>
          </div>
          ${renderArmComparison(session)}
        </article>
      </section>

      ${renderSessionExplorer(session)}

      <section class="content-grid">
        ${session.arms.map((armRecord) => renderArmPanel(armRecord, user)).join("")}
      </section>
    `
  });
}

function renderEditSessionPage({ user, session, error = "" }) {
  // Edit form for session metadata
  return renderLayout({
    title: `Edit ${session.title}`,
    user,
    activePath: "/history",
    pageName: "session-edit",
    content: `
      <section class="hero-card hero-card--compact">
        <div>
          <p class="eyebrow">Edit session</p>
          <h1>${escapeHtml(session.title)}</h1>
          <p>Update the saved title, notes, or favorite status without touching the original analysis.</p>
        </div>
        <div class="hero-actions">
          <a class="ghost-button ghost-button--light" href="${config.withBasePath(`/sessions/${session.id}`)}">Back to session</a>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Session details</h2>
          <p>Changes here update only the saved metadata around this analysis.</p>
        </div>
        ${error ? `<p class="feedback feedback--error">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="${config.withBasePath(`/sessions/${session.id}/edit`)}" class="form-stack">
          <label>
            <span>Session title</span>
            <input name="title" type="text" required value="${escapeHtml(session.title || "")}" />
          </label>
          <label>
            <span>Notes</span>
            <textarea name="notes" rows="6">${escapeHtml(session.notes || "")}</textarea>
          </label>
          <label class="checkbox-row">
            <input name="isFavorite" type="checkbox" ${session.is_favorite ? "checked" : ""} />
            <span>Mark this session as a favorite</span>
          </label>
          <div class="button-row">
            <button class="primary-button" type="submit">Save changes</button>
            <a class="ghost-button" href="${config.withBasePath(`/sessions/${session.id}`)}">Cancel</a>
          </div>
        </form>
      </section>
    `
  });
}

function renderCompareSessionCard(snapshot, slotLabel) {
  // Card showing one compare slot
  return `
    <article class="card compare-card">
      <div class="card-head">
        <h2>${escapeHtml(slotLabel)}: ${escapeHtml(snapshot.title)}</h2>
        <p>${escapeHtml(formatDateLabel(snapshot.sessionDate))} · ${escapeHtml(snapshot.uploadMode)} · ${snapshot.isFavorite ? "Favorite" : "Saved session"}</p>
      </div>
      <div class="meta-grid">
        <div><span>Events</span><strong>${formatCount(snapshot.totalEvents)}</strong></div>
        <div><span>Clean rate</span><strong>${formatPercent(snapshot.cleanRate)}</strong></div>
        <div><span>Top punch</span><strong>${escapeHtml(snapshot.topPunch)}</strong></div>
      </div>
      <div class="button-row button-row--tight">
        <a class="ghost-button ghost-button--small" href="${config.withBasePath(`/sessions/${snapshot.id}`)}">Open session</a>
        <a class="ghost-button ghost-button--small" href="${config.withBasePath(`/sessions/${snapshot.id}/export.csv`)}">Export CSV</a>
      </div>
    </article>
  `;
}

function renderCompareHighlights(highlights) {
  // Winner highlights row layout
  return `
    <section class="mini-stat-grid">
      ${highlights
        .map((highlight) => {
          const winnerClass =
            highlight.winner === "first"
              ? "compare-badge compare-badge--first"
              : highlight.winner === "second"
                ? "compare-badge compare-badge--second"
                : "compare-badge";
          const winnerLabel =
            highlight.winner === "tie" ? "Even" : highlight.winner === "first" ? "Session A" : "Session B";
          return `
            <article class="mini-stat-card">
              <span>${escapeHtml(highlight.label)}</span>
              <strong>${escapeHtml(highlight.firstDisplay)} vs ${escapeHtml(highlight.secondDisplay)}</strong>
              <small><span class="${winnerClass}">${winnerLabel}</span></small>
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

function renderComparePage({ user, sessionOptions, selectedIds, comparison, error }) {
  // Side-by-side compare desk page
  return renderLayout({
    title: "Compare Sessions",
    user,
    activePath: "/compare",
    pageName: "compare",
    content: `
      <section class="hero-card hero-card--compact">
        <div>
          <p class="eyebrow">Compare</p>
          <h1>Put two saved sessions side by side.</h1>
          <p>Check event volume, clean rate, and punch mix before deciding what changed.</p>
        </div>
        <div class="hero-actions">
          <a class="ghost-button ghost-button--light" href="${config.withBasePath("/history")}">Back to history</a>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Choose sessions</h2>
          <p>Pick any two saved sessions from your history.</p>
        </div>
        ${error ? `<p class="feedback feedback--error">${escapeHtml(error)}</p>` : ""}
        <form class="form-stack compare-form" method="get" action="${config.withBasePath("/compare")}">
          <div class="filter-inline-grid filter-inline-grid--wide">
            <label>
              <span>Session A</span>
              <select name="first">
                <option value="">Choose a session</option>
                ${sessionOptions
                  .map((session) => `<option value="${session.id}" ${selectedIds.firstSessionId === session.id ? "selected" : ""}>${escapeHtml(session.title)} · ${escapeHtml(formatDateLabel(session.session_date || session.created_at))}</option>`)
                  .join("")}
              </select>
            </label>
            <label>
              <span>Session B</span>
              <select name="second">
                <option value="">Choose a session</option>
                ${sessionOptions
                  .map((session) => `<option value="${session.id}" ${selectedIds.secondSessionId === session.id ? "selected" : ""}>${escapeHtml(session.title)} · ${escapeHtml(formatDateLabel(session.session_date || session.created_at))}</option>`)
                  .join("")}
              </select>
            </label>
          </div>
          <div class="button-row">
            <button class="primary-button" type="submit">Compare sessions</button>
            <a class="ghost-button" href="${config.withBasePath("/compare")}">Reset</a>
          </div>
        </form>
      </section>

      ${
        comparison
          ? `
            ${renderCompareHighlights(comparison.highlights)}
            <section class="content-grid">
              ${renderCompareSessionCard(comparison.first, "Session A")}
              ${renderCompareSessionCard(comparison.second, "Session B")}
            </section>
            <section class="card">
              <div class="card-head">
                <h2>Punch mix comparison</h2>
                <p>Counts are merged across all uploaded arms inside each saved session.</p>
              </div>
              <div class="table-shell">
                <table class="session-table">
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>Session A</th>
                      <th>Session B</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${comparison.labelRows
                      .map((row) => `
                        <tr>
                          <td>${escapeHtml(humanizeLabel(row.label))}</td>
                          <td>${formatCount(row.firstCount)}</td>
                          <td>${formatCount(row.secondCount)}</td>
                        </tr>
                      `)
                      .join("")}
                  </tbody>
                </table>
              </div>
            </section>
          `
          : `
            <section class="card">
              <div class="empty-state">Choose two sessions to load the comparison desk.</div>
            </section>
          `
      }
    `
  });
}

function renderErrorPage({ title, message, user = null }) {
  // Friendly error page with CTA
  return renderLayout({
    title,
    user,
    pageName: "error",
    activePath: "",
    content: `
      <section class="card error-card">
        <div class="card-head">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
        </div>
        ${
          user
            ? `<a class="primary-button" href="${config.withBasePath("/dashboard")}">Back to dashboard</a>`
            : `<a class="primary-button" href="${config.withBasePath("/login")}">Back to sign in</a>`
        }
      </section>
    `
  });
}

module.exports = {
  renderAuthPage,
  renderComparePage,
  renderDashboardPage,
  renderEditSessionPage,
  renderErrorPage,
  renderHistoryPage,
  renderSessionDetailPage,
  renderUploadPage
};
