const { spawn } = require("node:child_process");

const config = require("./config");

function runPythonCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, [config.pythonCliPath, ...args], {
      cwd: config.rootDir,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {});
        } catch (error) {
          reject(new Error(`Python CLI returned invalid JSON: ${stdout || stderr}`));
        }
        return;
      }

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
  const args = ["analyze", "--zip-path", zipPath];
  if (sessionDateOverride) {
    args.push("--session-date", sessionDateOverride);
  }
  return runPythonCommand(args);
}

async function getModelInfo() {
  return runPythonCommand(["info"]);
}

module.exports = {
  analyzeZipFile,
  getModelInfo
};
