// Bridge to the Python analyzer CLI
const { spawn } = require("node:child_process");

const config = require("./config");

function runPythonCommand(args) {
  // Spawn python CLI and collect output
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, [config.pythonCliPath, ...args], {
      cwd: config.rootDir,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    // Collect stdout chunks
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    // Collect stderr chunks
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // Success path parses JSON
      if (code === 0) {
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {});
        } catch (error) {
          reject(new Error(`Python CLI returned invalid JSON: ${stdout || stderr}`));
        }
        return;
      }

      // Try to parse error JSON
      try {
        const payload = JSON.parse(stdout || "{}");
        reject(new Error(payload.error || stderr || "Python analysis failed."));
      } catch (error) {
        reject(new Error(stderr || stdout || "Python analysis failed."));
      }
    });
  });
}

async function analyzeZipFile(zipPath, sessionDateOverride) {
  // Run inference on a saved ZIP
  const args = ["analyze", "--zip-path", zipPath];
  if (sessionDateOverride) {
    args.push("--session-date", sessionDateOverride);
  }
  return runPythonCommand(args);
}

async function getModelInfo() {
  // Fetch current model metadata
  return runPythonCommand(["info"]);
}

module.exports = {
  analyzeZipFile,
  getModelInfo
};
