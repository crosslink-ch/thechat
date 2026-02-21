import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

export const api = treaty<App>(API_URL);
