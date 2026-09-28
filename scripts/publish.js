import { spawn } from "child_process";

// Prevent recursive loop caused by npm's built-in "publish" lifecycle script
if (process.env.MBK_PUBLISH_PIPELINE_ACTIVE === "true") {
  process.exit(0);
}
process.env.MBK_PUBLISH_PIPELINE_ACTIVE = "true";

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n\x1b[36m➜ Running: ${command} ${args.join(" ")}\x1b[0m`);
    const child = spawn(command, args, {
      stdio: options.stdio || "inherit",
      shell: isWindows,
      ...options,
    });

    let stdout = "";
    let stderr = "";

    if (options.captureOutput) {
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function isNpmLoggedIn() {
  try {
    await runCommand(npmCmd, ["whoami"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function publishFlow() {
  console.log("\x1b[35m====================================================\x1b[0m");
  console.log("\x1b[35m  admindb — Automated Release & Publish Pipeline   \x1b[0m");
  console.log("\x1b[35m====================================================\x1b[0m");

  try {
    // 1. npm install
    console.log("\n\x1b[33m[1/4] Installing dependencies...\x1b[0m");
    await runCommand(npmCmd, ["install"]);

    // 2. npm run build
    console.log("\n\x1b[33m[2/4] Building and minifying bundle (.js & .d.ts)...\x1b[0m");
    await runCommand(npmCmd, ["run", "build"]);

    // 3. npm run test
    console.log("\n\x1b[33m[3/4] Running automated test suite...\x1b[0m");
    await runCommand(npmCmd, ["run", "test"]);

    // 4. npm publish
    console.log("\n\x1b[33m[4/4] Checking NPM authentication and publishing...\x1b[0m");
    const loggedIn = await isNpmLoggedIn();

    if (!loggedIn) {
      console.log("\n\x1b[33m⚠ Not logged in to NPM. Starting interactive login...\x1b[0m");
      await runCommand(npmCmd, ["login"], { stdio: "inherit" });
    }

    try {
      await runCommand(npmCmd, ["publish", "--ignore-scripts"], { stdio: "inherit" });
      console.log("\n\x1b[32m✔ Package successfully published to NPM!\x1b[0m\n");
    } catch (publishErr) {
      console.log("\n\x1b[33m⚠ Initial publish failed. Prompting for npm login...\x1b[0m");
      await runCommand(npmCmd, ["login"], { stdio: "inherit" });
      await runCommand(npmCmd, ["publish", "--ignore-scripts"], { stdio: "inherit" });
      console.log("\n\x1b[32m✔ Package successfully published to NPM!\x1b[0m\n");
    }
  } catch (err) {
    console.error(`\n\x1b[31m✖ Pipeline failed: ${err.message}\x1b[0m\n`);
    process.exit(1);
  }
}

publishFlow();
