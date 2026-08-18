import { mcpAuthenticate } from "./auth";
import { registerTools } from "./tools";
import { createMcpRoutes } from "./transport";

export { createMcpRoutes } from "./transport";

export const mcpRoutes = createMcpRoutes({
  authenticate: mcpAuthenticate,
  setupTools: registerTools,
});
