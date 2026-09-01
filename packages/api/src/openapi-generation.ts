import type { OpenAPIGeneratorOptions } from "@elysia/openapi/gen";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function openApiGeneratorOptions(
  projectRoot: string,
  silent: boolean,
): OpenAPIGeneratorOptions {
  const tmpRoot = resolve(tmpdir(), `.thechat-openapi-${process.pid}`);

  return {
    projectRoot,
    tsconfigPath: "tsconfig.json",
    instanceName: "app",
    tmpRoot,
    silent,
    compilerOptions: {
      lib: ["ESNext", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ES2022",
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      outDir: resolve(tmpRoot, "dist"),
    },
  };
}
