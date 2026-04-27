// Application entry point
const { startServer } = require("./src/server");

// Boot server and exit on failure
startServer().catch((error) => {
  console.error("Failed to start PerfectPunch:", error);
  process.exit(1);
});
