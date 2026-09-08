import { isWeb } from "../../packages/client/src/platform/environment";
import type { PlatformServices } from "../../packages/client/src/platform/contracts";
import { services as desktop } from "../../packages/desktop/src/platform/services";
import { services as web } from "../../packages/web/src/platform/services";
// Tests historically switch isWeb with vi.mock. Production uses a fixed adapter.
export const services: PlatformServices = new Proxy({} as PlatformServices, {
  get(_target, key: keyof PlatformServices) { return (isWeb ? web : desktop)[key]; },
});
