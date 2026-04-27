const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const { query, withTransaction, execute } = require("./db");
const { analyzeZipFile } = require("./analyzer");
const {
  averageConfidence,
  formatArmLabel,
  knownPunchLabels,
  mergeSummaryCounts,
  pickTopPunch,
  safeJsonParse,
  slugifyFilename,
  toCsv
} = require("./utils");

const HISTORY_SORTS = new Set(["date_desc", "date_asc", "events_desc", "title_asc"]);
const ARM_LABEL_MAP = {
  left: {
    cross: "jab",
    right_hook: "left_hook",
    right_uppercut: "left_uppercut"
  },
  right: {
    jab: "cross",
    left_hook: "right_hook",
    left_uppercut: "right_uppercut"
  }
};
function validateUploadPayload(payload) {
  const title = String(payload.title || "").trim() || `Session ${new Date().toISOString().slice(0, 10)}`;
  const notes = String(payload.notes || "").trim();
  const mode = payload.mode === "dual" ? "dual" : "single";
  const sessionDateOverride = String(payload.sessionDateOverride || "").trim() || null;
  const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];

  if (mode === "single" && uploads.length !== 1) {
    throw new Error("Single-arm uploads need exactly one ZIP file.");
  }
  if (mode === "dual" && uploads.length !== 2) {
    throw new Error("Dual-arm uploads need one left ZIP and one right ZIP.");
  }

  const seenArms = new Set();
  const normalizedUploads = uploads.map((upload) => {
    const arm = upload.arm === "left" ? "left" : upload.arm === "right" ? "right" : null;
    if (!arm) {
      throw new Error("Each upload must be tagged as left or right arm.");
    }
    if (seenArms.has(arm)) {
      throw new Error("Each arm can only be uploaded once per recorded session.");
    }
    seenArms.add(arm);

    const name = String(upload.name || "").trim();
    const data = String(upload.data || "").trim();
    if (!name.toLowerCase().endsWith(".zip")) {
      throw new Error("Only ZIP uploads are supported.");
    }
    if (!data) {
      throw new Error(`The ${arm} arm upload is empty.`);
    }
    return { arm, name, data };
  });

  return { title, notes, mode, sessionDateOverride, uploads: normalizedUploads };
}

function normalizeEventLabelsForArm(events, arm) {
  const labelMap = ARM_LABEL_MAP[arm] || {};
  return (Array.isArray(events) ? events : []).map((event) => {
    const label = String(event.label || "uncertain");
    return {
      ...event,
      label: labelMap[label] || label
    };
  });
}

function summariseEvents(events) {
  const totalEvents = events.length;
  const uncertainEvents = events.filter((event) => event.label === "uncertain").length;

  const summaryCounts = events.reduce((counts, event) => {
    const label = String(event.label || "uncertain");
    counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});

  return {
    totalEvents,
    uncertainEvents,
    avgConfidence: 0,
    summaryCounts
  };
}

function getSessionTimestampExpression(alias = "recorded_sessions") {
  return `COALESCE(
    STR_TO_DATE(${alias}.session_date, '%Y-%m-%d_%H-%i-%s'),
    STR_TO_DATE(${alias}.session_date, '%Y-%m-%d %H:%i:%s'),
    ${alias}.created_at
  )`;
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function normalizeHistoryFilters(filters = {}) {
  const favorite = filters.favorite === "only" ? "only" : filters.favorite === "exclude" ? "exclude" : "all";
  return {
    search: String(filters.search || "").trim(),
    arm: filters.arm === "left" || filters.arm === "right" ? filters.arm : "",
    mode: filters.mode === "single" || filters.mode === "dual" ? filters.mode : "",
    favorite,
    punchLabel: knownPunchLabels.includes(filters.punchLabel) ? filters.punchLabel : "",
    dateFrom: isValidDateInput(filters.dateFrom) ? filters.dateFrom : "",
    dateTo: isValidDateInput(filters.dateTo) ? filters.dateTo : "",
    sort: HISTORY_SORTS.has(filters.sort) ? filters.sort : "date_desc"
  };
}

function buildHistoryWhereSql(filters, params, alias = "recorded_sessions") {
  const clauses = [`${alias}.user_id = ?`];
  const sessionTimestampExpr = getSessionTimestampExpression(alias);

  if (filters.search) {
    const searchPattern = `%${filters.search}%`;
    clauses.push(`(${alias}.title LIKE ? OR COALESCE(${alias}.notes, '') LIKE ?)`);
    params.push(searchPattern, searchPattern);
  }

  if (filters.arm) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM recorded_session_arms filter_arms
        WHERE filter_arms.recorded_session_id = ${alias}.id
          AND filter_arms.arm = ?
      )`
    );
    params.push(filters.arm);
  }

  if (filters.mode) {
    clauses.push(`${alias}.upload_mode = ?`);
    params.push(filters.mode);
  }

  if (filters.favorite === "only") {
    clauses.push(`${alias}.is_favorite = 1`);
  } else if (filters.favorite === "exclude") {
    clauses.push(`${alias}.is_favorite = 0`);
  }

  if (filters.punchLabel) {
    clauses.push(`${alias}.summary_json LIKE ?`);
    params.push(`%"${filters.punchLabel}":%`);
  }

  if (filters.dateFrom) {
    clauses.push(`DATE(${sessionTimestampExpr}) >= ?`);
    params.push(filters.dateFrom);
  }

  if (filters.dateTo) {
    clauses.push(`DATE(${sessionTimestampExpr}) <= ?`);
    params.push(filters.dateTo);
  }

  return clauses;
}

function buildHistoryOrderSql(filters, alias = "recorded_sessions") {
  const sessionTimestampExpr = getSessionTimestampExpression(alias);
  switch (filters.sort) {
    case "date_asc":
      return `${alias}.is_favorite DESC, ${sessionTimestampExpr} ASC, ${alias}.created_at ASC`;
    case "events_desc":
      return `${alias}.is_favorite DESC, ${alias}.total_events DESC, ${sessionTimestampExpr} DESC`;
    case "title_asc":
      return `${alias}.is_favorite DESC, ${alias}.title ASC, ${sessionTimestampExpr} DESC`;
    case "date_desc":
    default:
      return `${alias}.is_favorite DESC, ${sessionTimestampExpr} DESC, ${alias}.created_at DESC`;
  }
}

function normalizeStoredSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary || {}).map(([label, count]) => [label, Number(count || 0)])
  );
}

function normalizeStoredEvent(event, armRecord, index) {
  return {
    index: index + 1,
    arm: armRecord.arm,
    armLabel: formatArmLabel(armRecord.arm),
    originalFilename: armRecord.original_filename,
    sourceName: armRecord.source_name,
    time_sec: Number(event.time_sec || 0),
    label: String(event.label || "uncertain")
  };
}

function countDistinctPunches(summary) {
  return Object.entries(summary || {}).filter(([label, count]) => label !== "uncertain" && Number(count || 0) > 0).length;
}

function buildLabelRows(firstSummary, secondSummary) {
  const union = new Set([...Object.keys(firstSummary || {}), ...Object.keys(secondSummary || {})]);
  const ordered = [
    ...knownPunchLabels.filter((label) => union.has(label)),
    ...[...union].filter((label) => !knownPunchLabels.includes(label)).sort()
  ];
  return ordered.map((label) => ({
    label,
    firstCount: Number(firstSummary?.[label] || 0),
    secondCount: Number(secondSummary?.[label] || 0)
  }));
}

function normalizeSessionListRow(row) {
  const summary = normalizeStoredSummary(safeJsonParse(row.summary_json, {}));
  return {
    ...row,
    is_favorite: Boolean(row.is_favorite),
    total_events: Number(row.total_events || 0),
    uncertain_events: Number(row.uncertain_events || 0),
    avg_confidence: Number(row.avg_confidence || 0),
    arm_count: Number(row.arm_count || 0),
    duration_sec_total: Number(row.duration_sec_total || 0),
    arms: row.arms ? String(row.arms).split(",") : [],
    summary,
    topPunch: pickTopPunch(summary),
    cleanEvents: Math.max(0, Number(row.total_events || 0) - Number(row.uncertain_events || 0)),
    cleanRate: Number(row.total_events || 0)
      ? Math.max(0, Number(row.total_events || 0) - Number(row.uncertain_events || 0)) / Number(row.total_events || 0)
      : 0,
    distinctPunches: countDistinctPunches(summary)
  };
}

async function persistUploadsAndAnalyze(user, payload) {
  const normalized = validateUploadPayload(payload);
  const storageKey = crypto.randomUUID();
  const sessionDir = path.join(config.uploadDir, storageKey);
  await fs.mkdir(sessionDir, { recursive: true });

  try {
    const analyses = await Promise.all(
      normalized.uploads.map(async (upload) => {
        const filePath = path.join(sessionDir, `${upload.arm}-${slugifyFilename(upload.name)}`);
        const rawBytes = Buffer.from(upload.data, "base64");
        await fs.writeFile(filePath, rawBytes);
        const analysis = await analyzeZipFile(filePath, normalized.sessionDateOverride);
        const events = normalizeEventLabelsForArm(analysis.events, upload.arm);
        const summary = summariseEvents(events);

        return {
          arm: upload.arm,
          originalFilename: upload.name,
          storedPath: path.relative(config.rootDir, filePath),
          sourceName: analysis.session_date || path.basename(upload.name, ".zip"),
          sessionDate: analysis.session_date || normalized.sessionDateOverride,
          durationSec: Number(analysis.duration_sec || 0),
          totalEvents: summary.totalEvents,
          uncertainEvents: summary.uncertainEvents,
          avgConfidence: summary.avgConfidence,
          modelVersion: analysis.model_version || null,
          summaryCounts: summary.summaryCounts,
          events
        };
      })
    );

    const combinedSummary = mergeSummaryCounts(analyses.map((item) => item.summaryCounts));
    const totalEvents = analyses.reduce((sum, item) => sum + item.totalEvents, 0);
    const uncertainEvents = analyses.reduce((sum, item) => sum + item.uncertainEvents, 0);
    const avgConfidence = averageConfidence(analyses);
    const sessionDate = normalized.sessionDateOverride || analyses.find((item) => item.sessionDate)?.sessionDate || null;
    const modelVersion = analyses.find((item) => item.modelVersion)?.modelVersion || null;

    const sessionId = await withTransaction(async (connection) => {
      const [sessionResult] = await connection.execute(
        `INSERT INTO recorded_sessions
          (user_id, title, notes, upload_mode, session_date, total_events, uncertain_events, avg_confidence, model_version, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          normalized.title,
          normalized.notes || null,
          normalized.mode,
          sessionDate,
          totalEvents,
          uncertainEvents,
          avgConfidence,
          modelVersion,
          JSON.stringify(combinedSummary)
        ]
      );

      for (const analysis of analyses) {
        await connection.execute(
          `INSERT INTO recorded_session_arms
            (recorded_session_id, arm, original_filename, stored_path, source_name, session_date, duration_sec, total_events, uncertain_events, avg_confidence, model_version, summary_json, events_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionResult.insertId,
            analysis.arm,
            analysis.originalFilename,
            analysis.storedPath,
            analysis.sourceName,
            analysis.sessionDate,
            analysis.durationSec,
            analysis.totalEvents,
            analysis.uncertainEvents,
            analysis.avgConfidence,
            analysis.modelVersion,
            JSON.stringify(analysis.summaryCounts),
            JSON.stringify(analysis.events)
          ]
        );
      }

      return sessionResult.insertId;
    });

    return sessionId;
  } catch (error) {
    await fs.rm(sessionDir, { recursive: true, force: true });
    throw error;
  }
}

async function listUserSessions(userId, options = {}) {
  const filters = normalizeHistoryFilters(options.filters || {});
  const params = [userId];
  const whereClauses = buildHistoryWhereSql(filters, params);
  const orderSql = buildHistoryOrderSql(filters);
  const clauses = [
    `SELECT
       recorded_sessions.id,
       recorded_sessions.title,
       recorded_sessions.notes,
       recorded_sessions.is_favorite,
       recorded_sessions.upload_mode,
       recorded_sessions.session_date,
       recorded_sessions.total_events,
       recorded_sessions.uncertain_events,
       recorded_sessions.avg_confidence,
       recorded_sessions.model_version,
       recorded_sessions.summary_json,
       recorded_sessions.created_at,
       ${getSessionTimestampExpression()} AS session_timestamp,
       GROUP_CONCAT(DISTINCT recorded_session_arms.arm ORDER BY recorded_session_arms.arm SEPARATOR ',') AS arms,
       COUNT(recorded_session_arms.id) AS arm_count,
       COALESCE(SUM(recorded_session_arms.duration_sec), 0) AS duration_sec_total
     FROM recorded_sessions
     LEFT JOIN recorded_session_arms
       ON recorded_session_arms.recorded_session_id = recorded_sessions.id
     WHERE ${whereClauses.join(" AND ")}
     GROUP BY recorded_sessions.id
     ORDER BY ${orderSql}`
  ];

  if (options.limit) {
    clauses.push("LIMIT ?");
    params.push(Number(options.limit));
  }

  const rows = await query(clauses.join(" "), params);
  return rows.map(normalizeSessionListRow);
}

async function getDashboardData(user) {
  const sessions = await listUserSessions(user.id, { limit: 6, filters: { sort: "date_desc" } });
  const countRows = await query(
    `SELECT COUNT(*) AS sessionCount, COALESCE(SUM(is_favorite), 0) AS favoriteCount
     FROM recorded_sessions
     WHERE user_id = ?`,
    [user.id]
  );
  const trendRows = await query(
    `SELECT
       id,
       title,
       session_date,
       total_events,
       uncertain_events,
       avg_confidence,
       created_at
     FROM (
       SELECT
         id,
         title,
         session_date,
         total_events,
         uncertain_events,
         avg_confidence,
         created_at
       FROM recorded_sessions
       WHERE user_id = ?
       ORDER BY ${getSessionTimestampExpression()} DESC, created_at DESC
       LIMIT 12
     ) AS recent_sessions
     ORDER BY COALESCE(
       STR_TO_DATE(recent_sessions.session_date, '%Y-%m-%d_%H-%i-%s'),
       STR_TO_DATE(recent_sessions.session_date, '%Y-%m-%d %H:%i:%s'),
       recent_sessions.created_at
     ) ASC, recent_sessions.created_at ASC`,
    [user.id]
  );
  const armRows = await query(
    `SELECT
       recorded_session_arms.arm,
       recorded_session_arms.total_events,
       recorded_session_arms.uncertain_events,
       recorded_session_arms.avg_confidence,
       recorded_session_arms.summary_json
     FROM recorded_session_arms
     INNER JOIN recorded_sessions
       ON recorded_sessions.id = recorded_session_arms.recorded_session_id
     WHERE recorded_sessions.user_id = ?`,
    [user.id]
  );

  const combinedSummary = mergeSummaryCounts(armRows.map((row) => safeJsonParse(row.summary_json, {})));
  const totalEvents = armRows.reduce((sum, row) => sum + Number(row.total_events || 0), 0);
  const uncertainEvents = armRows.reduce((sum, row) => sum + Number(row.uncertain_events || 0), 0);
  const leftUploads = armRows.filter((row) => row.arm === "left").length;
  const rightUploads = armRows.filter((row) => row.arm === "right").length;

  return {
    sessions,
    combinedSummary,
    progressTrend: trendRows.map((row) => {
      const total = Number(row.total_events || 0);
      const uncertain = Number(row.uncertain_events || 0);
      const cleanEvents = Math.max(0, total - uncertain);
      return {
        id: row.id,
        title: row.title,
        sessionDate: row.session_date || row.created_at,
        totalEvents: total,
        cleanEvents,
        cleanRate: total ? cleanEvents / total : 0,
        avgConfidence: Number(row.avg_confidence || 0)
      };
    }),
    stats: {
      totalSessions: Number(countRows[0]?.sessionCount || 0),
      favoriteSessions: Number(countRows[0]?.favoriteCount || 0),
      totalUploads: armRows.length,
      totalEvents,
      averageConfidence: averageConfidence(armRows),
      uncertaintyRate: totalEvents ? uncertainEvents / totalEvents : 0,
      leftUploads,
      rightUploads,
      topPunch: pickTopPunch(combinedSummary)
    }
  };
}

async function listAllUserSessions(userId, options = {}) {
  return listUserSessions(userId, options);
}

async function getRecordedSessionDetail(userId, sessionId) {
  const sessionRows = await query(
    `SELECT
       id,
       user_id,
       title,
       notes,
       is_favorite,
       upload_mode,
       session_date,
       total_events,
       uncertain_events,
       avg_confidence,
       model_version,
       summary_json,
       created_at,
       ${getSessionTimestampExpression()} AS session_timestamp
     FROM recorded_sessions
     WHERE user_id = ? AND id = ?
     LIMIT 1`,
    [userId, sessionId]
  );
  const session = sessionRows[0];
  if (!session) {
    return null;
  }

  const armRows = await query(
    `SELECT
       id,
       arm,
       original_filename,
       stored_path,
       source_name,
       session_date,
       duration_sec,
       total_events,
       uncertain_events,
       avg_confidence,
       model_version,
       summary_json,
       events_json
     FROM recorded_session_arms
     WHERE recorded_session_id = ?
     ORDER BY arm ASC`,
    [sessionId]
  );

  const summary = normalizeStoredSummary(safeJsonParse(session.summary_json, {}));
  const arms = armRows.map((row) => {
    const armSummary = normalizeStoredSummary(safeJsonParse(row.summary_json, {}));
    const events = safeJsonParse(row.events_json, []).map((event, index) => normalizeStoredEvent(event, row, index));
    const totalEvents = Number(row.total_events || 0);
    const uncertainEvents = Number(row.uncertain_events || 0);
    return {
      ...row,
      duration_sec: Number(row.duration_sec || 0),
      total_events: totalEvents,
      uncertain_events: uncertainEvents,
      avg_confidence: Number(row.avg_confidence || 0),
      summary: armSummary,
      topPunch: pickTopPunch(armSummary),
      cleanEvents: Math.max(0, totalEvents - uncertainEvents),
      cleanRate: totalEvents ? Math.max(0, totalEvents - uncertainEvents) / totalEvents : 0,
      events
    };
  });

  const allEvents = arms
    .flatMap((armRecord) => armRecord.events)
    .sort((left, right) => Number(left.time_sec) - Number(right.time_sec) || left.index - right.index);

  const totalEvents = Number(session.total_events || 0);
  const uncertainEvents = Number(session.uncertain_events || 0);

  return {
    ...session,
    is_favorite: Boolean(session.is_favorite),
    total_events: totalEvents,
    uncertain_events: uncertainEvents,
    avg_confidence: Number(session.avg_confidence || 0),
    summary,
    arms,
    allEvents,
    durationSec: arms.reduce((sum, armRecord) => sum + Number(armRecord.duration_sec || 0), 0),
    cleanEvents: Math.max(0, totalEvents - uncertainEvents),
    cleanRate: totalEvents ? Math.max(0, totalEvents - uncertainEvents) / totalEvents : 0,
    distinctPunches: countDistinctPunches(summary),
    topPunch: pickTopPunch(summary)
  };
}

function buildComparisonHighlights(firstSnapshot, secondSnapshot) {
  const metrics = [
    {
      label: "More events",
      firstValue: firstSnapshot.totalEvents,
      secondValue: secondSnapshot.totalEvents,
      formatter: (value) => `${value}`
    },
    {
      label: "Cleaner reads",
      firstValue: firstSnapshot.cleanRate,
      secondValue: secondSnapshot.cleanRate,
      formatter: (value) => `${Math.round(value * 100)}%`
    },
    {
      label: "Distinct punches",
      firstValue: firstSnapshot.distinctPunches,
      secondValue: secondSnapshot.distinctPunches,
      formatter: (value) => `${value}`
    }
  ];

  return metrics.map((metric) => {
    const winner = metric.firstValue === metric.secondValue ? "tie" : metric.firstValue > metric.secondValue ? "first" : "second";
    return {
      ...metric,
      winner,
      firstDisplay: metric.formatter(metric.firstValue),
      secondDisplay: metric.formatter(metric.secondValue)
    };
  });
}

function buildSessionComparisonSnapshot(session) {
  return {
    id: session.id,
    title: session.title,
    notes: session.notes,
    isFavorite: session.is_favorite,
    sessionDate: session.session_date || session.created_at,
    uploadMode: session.upload_mode,
    totalEvents: session.total_events,
    uncertainEvents: session.uncertain_events,
    cleanEvents: session.cleanEvents,
    cleanRate: session.cleanRate,
    durationSec: session.durationSec,
    distinctPunches: session.distinctPunches,
    topPunch: session.topPunch,
    armCount: session.arms.length,
    summary: session.summary
  };
}

async function getSessionCompareData(userId, firstSessionId, secondSessionId) {
  const sessionOptions = await listUserSessions(userId, { filters: { sort: "date_desc" } });
  if (!firstSessionId || !secondSessionId) {
    return {
      sessionOptions,
      selectedIds: { firstSessionId, secondSessionId },
      comparison: null,
      error: null
    };
  }

  if (firstSessionId === secondSessionId) {
    return {
      sessionOptions,
      selectedIds: { firstSessionId, secondSessionId },
      comparison: null,
      error: "Choose two different sessions to compare."
    };
  }

  const [firstSession, secondSession] = await Promise.all([
    getRecordedSessionDetail(userId, firstSessionId),
    getRecordedSessionDetail(userId, secondSessionId)
  ]);

  if (!firstSession || !secondSession) {
    return {
      sessionOptions,
      selectedIds: { firstSessionId, secondSessionId },
      comparison: null,
      error: "One of the selected sessions could not be loaded."
    };
  }

  const firstSnapshot = buildSessionComparisonSnapshot(firstSession);
  const secondSnapshot = buildSessionComparisonSnapshot(secondSession);

  return {
    sessionOptions,
    selectedIds: { firstSessionId, secondSessionId },
    comparison: {
      first: firstSnapshot,
      second: secondSnapshot,
      labelRows: buildLabelRows(firstSnapshot.summary, secondSnapshot.summary),
      highlights: buildComparisonHighlights(firstSnapshot, secondSnapshot)
    },
    error: null
  };
}

function normalizeSessionUpdatePayload(payload = {}) {
  const title = String(payload.title || "").trim();
  const notes = String(payload.notes || "").trim();
  if (!title) {
    throw new Error("Session title is required.");
  }
  if (title.length > 255) {
    throw new Error("Session title must be 255 characters or fewer.");
  }
  return {
    title,
    notes,
    isFavorite:
      payload.isFavorite === true ||
      payload.isFavorite === "true" ||
      payload.isFavorite === "1" ||
      payload.isFavorite === "on"
  };
}

async function updateRecordedSession(userId, sessionId, payload) {
  const normalized = normalizeSessionUpdatePayload(payload);
  const result = await execute(
    `UPDATE recorded_sessions
     SET title = ?, notes = ?, is_favorite = ?
     WHERE user_id = ? AND id = ?`,
    [normalized.title, normalized.notes || null, normalized.isFavorite ? 1 : 0, userId, sessionId]
  );
  if (!result.affectedRows) {
    return null;
  }
  return getRecordedSessionDetail(userId, sessionId);
}

async function toggleRecordedSessionFavorite(userId, sessionId) {
  const rows = await query(
    "SELECT is_favorite FROM recorded_sessions WHERE user_id = ? AND id = ? LIMIT 1",
    [userId, sessionId]
  );
  const session = rows[0];
  if (!session) {
    return null;
  }
  const nextValue = session.is_favorite ? 0 : 1;
  await execute(
    "UPDATE recorded_sessions SET is_favorite = ? WHERE user_id = ? AND id = ?",
    [nextValue, userId, sessionId]
  );
  return Boolean(nextValue);
}

async function deleteRecordedSession(userId, sessionId) {
  const sessionRows = await query(
    "SELECT id, title FROM recorded_sessions WHERE user_id = ? AND id = ? LIMIT 1",
    [userId, sessionId]
  );
  const session = sessionRows[0];
  if (!session) {
    return null;
  }

  const armRows = await query(
    `SELECT stored_path
     FROM recorded_session_arms
     WHERE recorded_session_id = ?`,
    [sessionId]
  );
  const storageDirs = [...new Set(armRows.map((row) => path.dirname(path.join(config.rootDir, row.stored_path))))];

  await withTransaction(async (connection) => {
    const [result] = await connection.execute(
      "DELETE FROM recorded_sessions WHERE user_id = ? AND id = ? LIMIT 1",
      [userId, sessionId]
    );
    if (!result.affectedRows) {
      throw new Error("That session could not be deleted.");
    }
  });

  await Promise.all(storageDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));

  return {
    id: session.id,
    title: session.title
  };
}

function buildHistoryExportCsv(sessions) {
  const rows = [
    [
      "session_id",
      "title",
      "favorite",
      "upload_mode",
      "session_date",
      "created_at",
      "arms",
      "total_events",
      "uncertain_events",
      "top_punch",
      "notes"
    ]
  ];

  for (const session of sessions) {
    rows.push([
      session.id,
      session.title,
      session.is_favorite ? "yes" : "no",
      session.upload_mode,
      session.session_date || "",
      session.created_at,
      session.arms.join(" | "),
      session.total_events,
      session.uncertain_events,
      session.topPunch,
      session.notes || ""
    ]);
  }

  return toCsv(rows);
}

function buildSessionEventsCsv(session) {
  const rows = [
    [
      "session_id",
      "session_title",
      "favorite",
      "session_date",
      "upload_mode",
      "arm",
      "source_name",
      "original_filename",
      "event_index",
      "time_sec",
      "label"
    ]
  ];

  for (const armRecord of session.arms) {
    if (!armRecord.events.length) {
      rows.push([
        session.id,
        session.title,
        session.is_favorite ? "yes" : "no",
        session.session_date || "",
        session.upload_mode,
        armRecord.arm,
        armRecord.source_name || "",
        armRecord.original_filename,
        "",
        "",
        "no_events_detected"
      ]);
      continue;
    }

    for (const event of armRecord.events) {
      rows.push([
        session.id,
        session.title,
        session.is_favorite ? "yes" : "no",
        session.session_date || "",
        session.upload_mode,
        armRecord.arm,
        armRecord.source_name || "",
        armRecord.original_filename,
        event.index,
        Number(event.time_sec || 0).toFixed(3),
        event.label
      ]);
    }
  }

  return toCsv(rows);
}

module.exports = {
  buildHistoryExportCsv,
  buildSessionEventsCsv,
  getDashboardData,
  getRecordedSessionDetail,
  getSessionCompareData,
  listAllUserSessions,
  normalizeEventLabelsForArm,
  normalizeHistoryFilters,
  persistUploadsAndAnalyze,
  summariseEvents,
  toggleRecordedSessionFavorite,
  updateRecordedSession,
  deleteRecordedSession
};
