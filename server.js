const { startServer } = require("./src/server");

startServer().catch((error) => {
  console.error("Failed to start PerfectPunch:", error);
  process.exit(1);
});
