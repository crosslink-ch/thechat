import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";

export const API_URL = __BACKEND_URL__;

export const api = treaty<App>(API_URL);
