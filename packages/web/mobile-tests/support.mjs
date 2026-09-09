import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(process.env.MOBILE_PLAYWRIGHT_ROOT ? path.join(process.env.MOBILE_PLAYWRIGHT_ROOT, "package.json") : new URL("../../../package.json", import.meta.url));
export const { test, expect, defineConfig } = require("@playwright/test");
