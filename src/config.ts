import { config } from "dotenv";

// Load .env file at module evaluation time so environment variables
// are available to all modules that import this config.
// This module is the entry point for environment setup.
config();

export const PORT = parseInt(process.env.PORT || "7888", 10);
export const HOST = process.env.HOST || "localhost";

export const AVAILABLE_MODELS: readonly string[] = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-20250514",
  "claude-opus-4-20250514",
] as const;
