import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HOST, PORT } from "./config";
import chatRouter from "./routes/chat";
import modelsRouter from "./routes/models";
import { validateCredentials } from "./services/augmentClient";

const app = new Hono();

// Global middleware
app.use("*", cors({
  origin: process.env.CORS_ORIGIN || "*",
}));
app.use("*", logger());

// Health check
app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "augment-oai-proxy",
    version: "1.0.0",
  });
});

// OpenAI-compatible routes
app.route("/v1/chat", chatRouter);
app.route("/v1/models", modelsRouter);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        message: "Not found",
        type: "not_found",
        code: 404,
      },
    },
    404
  );
});

// Start server
async function main() {
  // Check credentials
  const credentialsValid = await validateCredentials();
  if (!credentialsValid) {
    console.warn(
      "[WARN] No Augment credentials found. Run 'auggie login' or set AUGMENT_API_KEY/AUGMENT_API_URL."
    );
  }

  const http = await import("node:http");

  const httpServer = http.createServer(async (req, res) => {
    const response = await app.fetch(req as any, {} as any);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              res.end();
              return;
            }
            try {
              res.write(value);
              pump();
            } catch {
              res.end();
            }
          })
          .catch(() => {
            res.end();
          });
      };
      pump();
    } else {
      res.end();
    }
  });

  httpServer.listen(PORT, HOST, () => {
    printBanner();
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printBanner() {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║     Augment OAI Proxy is running     ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  URL:  http://${HOST}:${PORT}           ║`);
  console.log(`║  Chat: http://${HOST}:${PORT}/v1/chat/completions║`);
  console.log(`║  Models: http://${HOST}:${PORT}/v1/models        ║`);
  console.log("╚══════════════════════════════════════╝");
  console.log("");
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
