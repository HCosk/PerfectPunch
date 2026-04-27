// Express server and HTTP routes
const path = require("node:path");
const fs = require("node:fs/promises");

const express = require("express");

const {
  attachCurrentUser,
  authenticateUser,
  clearSessionCookie,
  createAuthSession,
  createUser,
  destroyAuthSession,
  persistSessionCookie,
  requireAuth
} = require("./auth");
const { getModelInfo } = require("./analyzer");
const config = require("./config");
const { initializeDatabase } = require("./db");
const {
  buildHistoryExportCsv,
  buildSessionEventsCsv,
  deleteRecordedSession,
  getDashboardData,
  getRecordedSessionDetail,
  getSessionCompareData,
  listAllUserSessions,
  normalizeHistoryFilters,
  persistUploadsAndAnalyze,
  toggleRecordedSessionFavorite,
  updateRecordedSession
} = require("./session-service");
const {
  renderAuthPage,
  renderComparePage,
  renderDashboardPage,
  renderEditSessionPage,
  renderErrorPage,
  renderHistoryPage,
  renderSessionDetailPage,
  renderUploadPage
} = require("./templates");
const { slugifyFilename } = require("./utils");

function asyncHandler(handler) {
  // Forward async errors to Express
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function getAppRedirectTarget(req, targetPath) {
  // Build a proxy-safe redirect target
  const normalizedTarget = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  if (config.basePath) {
    return config.withBasePath(normalizedTarget);
  }
  // Fall back to relative redirect
  const sourceDir = path.posix.dirname(req.path || "/");
  const relativeTarget = path.posix.relative(sourceDir, normalizedTarget);
  return relativeTarget || ".";
}

function parseSessionId(rawValue) {
  // Validate session id from URL
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error("Session id is invalid.");
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function resolveReturnTo(rawValue, fallbackPath) {
  // Block open-redirect return targets
  const value = String(rawValue || "").trim();
  if (!value.startsWith("/")) {
    return fallbackPath;
  }
  if (config.basePath) {
    return value === config.basePath || value.startsWith(`${config.basePath}/`) ? value : fallbackPath;
  }
  return value;
}

function sendCsv(res, filename, content) {
  // Stream CSV content as attachment
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(content);
}

async function ensureDirectories() {
  // Make sure upload dir exists
  await fs.mkdir(config.uploadDir, { recursive: true });
}

function buildCoreApp() {
  // Wire all feature routes and middleware
  const app = express();

  // Base middleware setup
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: `${config.uploadPayloadLimitMb}mb` }));
  app.use("/assets", express.static(config.publicDir));
  app.use(attachCurrentUser);

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Root redirects based on auth
  app.get("/", (req, res) => {
    res.redirect(req.user ? getAppRedirectTarget(req, "/dashboard") : getAppRedirectTarget(req, "/login"));
  });

  // Login page renderer
  app.get("/login", (req, res) => {
    if (req.user) {
      return res.redirect(getAppRedirectTarget(req, "/dashboard"));
    }
    return res.send(renderAuthPage({ mode: "login" }));
  });

  // Login form submission
  app.post(
    "/login",
    asyncHandler(async (req, res) => {
      const values = { login: req.body.login || "" };
      const user = await authenticateUser(req.body.login, req.body.password);
      if (!user) {
        return res.status(401).send(renderAuthPage({ mode: "login", error: "Incorrect login details.", values }));
      }
      // Issue session cookie on success
      const session = await createAuthSession(user.id);
      persistSessionCookie(res, session.token);
      return res.redirect(getAppRedirectTarget(req, "/dashboard"));
    })
  );

  // Signup page renderer
  app.get("/signup", (req, res) => {
    if (req.user) {
      return res.redirect(getAppRedirectTarget(req, "/dashboard"));
    }
    return res.send(renderAuthPage({ mode: "signup", values: { jabArm: "right" } }));
  });

  // Signup form submission
  app.post(
    "/signup",
    asyncHandler(async (req, res) => {
      const values = {
        username: req.body.username || "",
        email: req.body.email || "",
        jabArm: req.body.jabArm || "right"
      };
      // Compare both password fields
      if (req.body.password !== req.body.confirmPassword) {
        return res.status(400).send(renderAuthPage({ mode: "signup", error: "Passwords do not match.", values }));
      }
      try {
        const user = await createUser({
          username: req.body.username,
          email: req.body.email,
          password: req.body.password,
          jabArm: req.body.jabArm
        });
        // Auto sign-in after signup
        const session = await createAuthSession(user.id);
        persistSessionCookie(res, session.token);
        return res.redirect(getAppRedirectTarget(req, "/dashboard"));
      } catch (error) {
        return res.status(400).send(renderAuthPage({ mode: "signup", error: error.message, values }));
      }
    })
  );

  // Logout drops the session
  app.post(
    "/logout",
    asyncHandler(async (req, res) => {
      await destroyAuthSession(req.authToken);
      clearSessionCookie(res);
      res.redirect(getAppRedirectTarget(req, "/login"));
    })
  );

  // Dashboard summary route
  app.get(
    "/dashboard",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { stats, sessions, combinedSummary, progressTrend } = await getDashboardData(req.user);
      res.send(renderDashboardPage({ user: req.user, stats, sessions, combinedSummary, progressTrend }));
    })
  );

  // Upload form route
  app.get(
    "/sessions/new",
    requireAuth,
    asyncHandler(async (req, res) => {
      // Best-effort model status fetch
      let modelInfo;
      try {
        modelInfo = await getModelInfo();
      } catch (error) {
        modelInfo = { trained: false, error: error.message };
      }
      res.send(renderUploadPage({ user: req.user, modelInfo }));
    })
  );

  // JSON API to save uploads
  app.post(
    "/api/sessions",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = await persistUploadsAndAnalyze(req.user, req.body || {});
      res.json({
        ok: true,
        sessionId,
        // Resolve redirect for proxied deploys
        redirectTo: config.basePath ? config.withBasePath(`/sessions/${sessionId}`) : `../sessions/${sessionId}`
      });
    })
  );

  // History list page
  app.get(
    "/history",
    requireAuth,
    asyncHandler(async (req, res) => {
      const filters = normalizeHistoryFilters(req.query || {});
      const sessions = await listAllUserSessions(req.user.id, { filters });
      res.send(renderHistoryPage({ user: req.user, sessions, filters }));
    })
  );

  // CSV history export
  app.get(
    "/history/export.csv",
    requireAuth,
    asyncHandler(async (req, res) => {
      const filters = normalizeHistoryFilters(req.query || {});
      const sessions = await listAllUserSessions(req.user.id, { filters });
      const content = buildHistoryExportCsv(sessions);
      sendCsv(res, `perfectpunch-history-${new Date().toISOString().slice(0, 10)}.csv`, content);
    })
  );

  // Side-by-side compare page
  app.get(
    "/compare",
    requireAuth,
    asyncHandler(async (req, res) => {
      const firstSessionId = Number.parseInt(String(req.query.first || ""), 10) || null;
      const secondSessionId = Number.parseInt(String(req.query.second || ""), 10) || null;
      const compareData = await getSessionCompareData(req.user.id, firstSessionId, secondSessionId);
      res.send(renderComparePage({ user: req.user, ...compareData }));
    })
  );

  // Edit form for a session
  app.get(
    "/sessions/:id/edit",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = parseSessionId(req.params.id);
      const session = await getRecordedSessionDetail(req.user.id, sessionId);
      if (!session) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      return res.send(renderEditSessionPage({ user: req.user, session }));
    })
  );

  // Apply session edit changes
  app.post(
    "/sessions/:id/edit",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = parseSessionId(req.params.id);
      const existingSession = await getRecordedSessionDetail(req.user.id, sessionId);
      if (!existingSession) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      try {
        await updateRecordedSession(req.user.id, sessionId, req.body || {});
        return res.redirect(config.withBasePath(`/sessions/${sessionId}`));
      } catch (error) {
        // Re-render form with error message
        const viewModel = {
          ...existingSession,
          title: req.body.title,
          notes: req.body.notes,
          is_favorite: req.body.isFavorite === "on"
        };
        return res.status(400).send(renderEditSessionPage({ user: req.user, session: viewModel, error: error.message }));
      }
    })
  );

  // Toggle favorite flag
  app.post(
    "/sessions/:id/favorite",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = parseSessionId(req.params.id);
      const favoriteValue = await toggleRecordedSessionFavorite(req.user.id, sessionId);
      if (favoriteValue === null) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      const fallbackPath = config.withBasePath(`/sessions/${sessionId}`);
      const returnTo = resolveReturnTo(req.body.returnTo, fallbackPath);
      return res.redirect(returnTo);
    })
  );

  // Delete a saved session
  app.post(
    "/sessions/:id/delete",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = parseSessionId(req.params.id);
      const deleted = await deleteRecordedSession(req.user.id, sessionId);
      if (!deleted) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      return res.redirect(config.withBasePath("/history"));
    })
  );

  // Per-session events CSV export
  app.get(
    "/sessions/:id/export.csv",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = parseSessionId(req.params.id);
      const session = await getRecordedSessionDetail(req.user.id, sessionId);
      if (!session) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      const content = buildSessionEventsCsv(session);
      sendCsv(res, `${slugifyFilename(session.title || `session-${sessionId}`)}-events.csv`, content);
    })
  );

  // Session detail page
  app.get(
    "/sessions/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const session = await getRecordedSessionDetail(req.user.id, parseSessionId(req.params.id));
      if (!session) {
        return res.status(404).send(renderErrorPage({
          title: "Session not found",
          message: "That saved session does not exist for this user.",
          user: req.user
        }));
      }
      return res.send(renderSessionDetailPage({ user: req.user, session }));
    })
  );

  // Catch-all 404 handler
  app.use((req, res) => {
    res.status(404).send(
      renderErrorPage({
        title: "Page not found",
        message: "That page does not exist in this build.",
        user: req.user || null
      })
    );
  });

  // Top-level error handler
  app.use((error, req, res, _next) => {
    const status = error.statusCode || 500;
    const isApiRequest = req.path.startsWith("/api/") || req.originalUrl.startsWith(config.withBasePath("/api/"));
    if (isApiRequest) {
      return res.status(status).json({ ok: false, error: error.message || "Unexpected error." });
    }
    return res.status(status).send(
      renderErrorPage({
        title: status === 500 ? "Something went wrong" : "Request error",
        message: error.message || "Unexpected error.",
        user: req.user || null
      })
    );
  });

  return app;
}

function buildApp() {
  // Mount the app under the configured base path when running behind a proxy
  const coreApp = buildCoreApp();

  if (!config.basePath) {
    return coreApp;
  }

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/", (_req, res) => {
    res.redirect(config.basePath);
  });
  app.use(config.basePath, coreApp);
  app.use((req, res) => {
    if (req.path.startsWith(`${config.basePath}/`) || req.path === config.basePath) {
      return res.status(404).send(
        renderErrorPage({
          title: "Page not found",
          message: "That page does not exist in this build.",
          user: null
        })
      );
    }
    return res.redirect(config.basePath);
  });
  return app;
}

async function startServer() {
  // Prepare disk and DB then listen
  await ensureDirectories();
  await initializeDatabase();

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`PerfectPunch listening on http://localhost:${config.port}`);
  });
  return server;
}

module.exports = {
  buildApp,
  startServer
};
