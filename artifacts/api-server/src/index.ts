import { spawn } from "child_process";
import app from "./app";
import { logger } from "./lib/logger";
import { initReady, statsReady } from "./routes/proxy";

if (!process.env.IS_CHILD) {
  console.log("[Supervisor] Starting proxy server in supervisor mode...");

  const startChild = () => {
    const child = spawn(process.argv[0], [...process.argv.slice(1)], {
      env: { ...process.env, IS_CHILD: "true" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    child.on("message", (msg: any) => {
      if (msg && msg.type === "reload") {
        console.log("[Supervisor] Reload message received. Restarting child process...");
        child.kill("SIGTERM");
      }
    });

    child.on("exit", (code, signal) => {
      console.log(`[Supervisor] Child exited (code: ${code}, signal: ${signal}). Respawning...`);
      setTimeout(startChild, 1000);
    });
  };

  startChild();
} else {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  Promise.all([initReady, statsReady]).then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  }).catch((err) => {
    logger.error({ err }, "Failed to initialise persisted data");
    process.exit(1);
  });
}
