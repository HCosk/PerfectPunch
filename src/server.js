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
  getDashboardData,
  getRecordedSessionDetail,
  listAllUserSessions,
  persistUploadsAndAnalyze
} = require("./session-service");
const {
  renderAuthPage,
  renderDashboardPage,
  renderErrorPage,
  renderHistoryPage,
  renderSessionDetailPage,
  renderUploadPage
} = require("./templates");

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function ensureDirectories() {
  await fs.mkdir(config.uploadDir, { recursive: true });
}

function buildApp() {
  const app = express();
  const withBasePath = config.withBasePath;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: `${config.uploadPayloadLimitMb}mb` }));
  app.use("/assets", express.static(config.publicDir));
  app.use(attachCurrentUser);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (req, res) => {
    res.redirect(req.user ? withBasePath("/dashboard") : withBasePath("/login"));
  });

  app.get("/login", (req, res) => {
    if (req.user) {
      return res.redirect(withBasePath("/dashboard"));
    }
    return res.send(renderAuthPage({ mode: "login" }));
  });

  app.post(
    "/login",
    asyncHandler(async (req, res) => {
      const values = { login: req.body.login || "" };
      const user = await authenticateUser(req.body.login, req.body.password);
      if (!user) {
        return res.status(401).send(renderAuthPage({ mode: "login", error: "Incorrect login details.", values }));
      }
      const session = await createAuthSession(user.id);
      persistSessionCookie(res, session.token);
      return res.redirect(withBasePath("/dashboard"));
    })
  );

  app.get("/signup", (req, res) => {
    if (req.user) {
      return res.redirect(withBasePath("/dashboard"));
    }
    return res.send(renderAuthPage({ mode: "signup", values: { jabArm: "right" } }));
  });

  app.post(
    "/signup",
    asyncHandler(async (req, res) => {
      const values = {
        username: req.body.username || "",
        email: req.body.email || "",
        jabArm: req.body.jabArm || "right"
      };
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
        const session = await createAuthSession(user.id);
        persistSessionCookie(res, session.token);
        return res.redirect(withBasePath("/dashboard"));
      } catch (error) {
        return res.status(400).send(renderAuthPage({ mode: "signup", error: error.message, values }));
      }
    })
  );

  app.post(
    "/logout",
    asyncHandler(async (req, res) => {
      await destroyAuthSession(req.authToken);
      clearSessionCookie(res);
      res.redirect(withBasePath("/login"));
    })
  );

  app.get(
    "/dashboard",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { stats, sessions, combinedSummary, progressTrend } = await getDashboardData(req.user);
      res.send(renderDashboardPage({ user: req.user, stats, sessions, combinedSummary, progressTrend }));
    })
  );

  app.get(
    "/sessions/new",
    requireAuth,
    asyncHandler(async (req, res) => {
      let modelInfo;
      try {
        modelInfo = await getModelInfo();
      } catch (error) {
        modelInfo = { trained: false, error: error.message };
      }
      res.send(renderUploadPage({ user: req.user, modelInfo }));
    })
  );

  app.post(
    "/api/sessions",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessionId = await persistUploadsAndAnalyze(req.user, req.body || {});
      res.json({
        ok: true,
        sessionId,
        redirectTo: withBasePath(`/sessions/${sessionId}`)
      });
    })
  );

  app.get(
    "/history",
    requireAuth,
    asyncHandler(async (req, res) => {
      const sessions = await listAllUserSessions(req.user.id);
      res.send(renderHistoryPage({ user: req.user, sessions }));
    })
  );

  app.get(
    "/sessions/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const session = await getRecordedSessionDetail(req.user.id, Number(req.params.id));
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

  app.use((req, res) => {
    res.status(404).send(
      renderErrorPage({
        title: "Page not found",
        message: "That page does not exist in this build.",
        user: req.user || null
      })
    );
  });

  app.use((error, req, res, _next) => {
    const status = error.statusCode || 500;
    const isApiRequest = req.path.startsWith("/api/") || req.originalUrl.startsWith(withBasePath("/api/"));
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

async function startServer() {
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
