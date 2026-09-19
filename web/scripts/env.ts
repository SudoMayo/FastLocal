// Import this first in every script: loads web/.env.local before config.ts reads process.env.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.join(__dirname, "..", ".env.local"), quiet: true });
