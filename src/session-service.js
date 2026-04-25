const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const config = require("./config");
const { query, withTransaction } = require("./db");
const { analyzeZipFile } = require("./analyzer");
const {
  averageConfidence,
  mergeSummaryCounts,
  pickTopPunch,
  safeJsonParse,
  slugifyFilename
} = require("./utils");

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

function summariseAnalysis(analysis) {
  const events = Array.isArray(analysis.events) ? analysis.events : [];
  const totalEvents = events.length;
  const uncertainEvents = events.filter((event) => event.label === "uncertain").length;
  const avgConfidence = totalEvents
    ? events.reduce((sum, event) => sum + Number(event.confidence || 0), 0) / totalEvents
    : 0;
  return {
    totalEvents,
    uncertainEvents,
    avgConfidence,
    summaryCounts: analysis.summary_counts || {}
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
        const summary = summariseAnalysis(analysis);

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
          events: analysis.events || []
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

async function listUserSessions(userId, limit = null) {
  const clauses = [
    `SELECT
       recorded_sessions.id,
       recorded_sessions.title,
       recorded_sessions.notes,
       recorded_sessions.upload_mode,
       recorded_sessions.session_date,
       recorded_sessions.total_events,
       recorded_sessions.uncertain_events,
       recorded_sessions.avg_confidence,
       recorded_sessions.model_version,
       recorded_sessions.summary_json,
       recorded_sessions.created_at,
       GROUP_CONCAT(recorded_session_arms.arm ORDER BY recorded_session_arms.arm SEPARATOR ',') AS arms
     FROM recorded_sessions
     LEFT JOIN recorded_session_arms
       ON recorded_session_arms.recorded_session_id = recorded_sessions.id
     WHERE recorded_sessions.user_id = ?
     GROUP BY recorded_sessions.id
     ORDER BY recorded_sessions.created_at DESC`
  ];
  const params = [userId];
  if (limit) {
    clauses.push("LIMIT ?");
    params.push(limit);
  }
  const rows = await query(clauses.join(" "), params);
  return rows.map((row) => ({
    ...row,
    arms: row.arms ? String(row.arms).split(",") : [],
    summary: safeJsonParse(row.summary_json, {})
  }));
}

async function getDashboardData(user) {
  const sessions = await listUserSessions(user.id, 6);
  const countRows = await query("SELECT COUNT(*) AS sessionCount FROM recorded_sessions WHERE user_id = ?", [user.id]);
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
       ORDER BY created_at DESC
       LIMIT 12
     ) AS recent_sessions
     ORDER BY created_at ASC`,
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
      const totalEvents = Number(row.total_events || 0);
      const uncertainEvents = Number(row.uncertain_events || 0);
      const cleanEvents = Math.max(0, totalEvents - uncertainEvents);
      return {
        id: row.id,
        title: row.title,
        sessionDate: row.session_date || row.created_at,
        totalEvents,
        cleanEvents,
        cleanRate: totalEvents ? cleanEvents / totalEvents : 0,
        avgConfidence: Number(row.avg_confidence || 0)
      };
    }),
    stats: {
      totalSessions: Number(countRows[0]?.sessionCount || 0),
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

async function listAllUserSessions(userId) {
  return listUserSessions(userId);
}

async function getRecordedSessionDetail(userId, sessionId) {
  const sessionRows = await query(
    `SELECT
       id,
       user_id,
       title,
       notes,
       upload_mode,
       session_date,
       total_events,
       uncertain_events,
       avg_confidence,
       model_version,
       summary_json,
       created_at
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

  return {
    ...session,
    summary: safeJsonParse(session.summary_json, {}),
    arms: armRows.map((row) => ({
      ...row,
      summary: safeJsonParse(row.summary_json, {}),
      events: safeJsonParse(row.events_json, [])
    }))
  };
}

module.exports = {
  getDashboardData,
  getRecordedSessionDetail,
  listAllUserSessions,
  persistUploadsAndAnalyze
};
