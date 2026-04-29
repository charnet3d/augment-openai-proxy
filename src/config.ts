import { config } from "dotenv";

// Load .env file at module evaluation time so environment variables
// are available to all modules that import this config.
// This module is the entry point for environment setup.
config();

export const PORT = parseInt(process.env.PORT || "7888", 10);
export const HOST = process.env.HOST || "localhost";
