import { transform } from "sucrase";
import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useReducer,
  Fragment,
} from "react";

type CompileResult =
  | { ok: true; Component: React.ComponentType }
  | { ok: false; error: string };

const cache = new Map<string, CompileResult>();

export function compileTsx(code: string): CompileResult {
  const cached = cache.get(code);
  if (cached) return cached;

  let jsCode: string;
  try {
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      jsxPragma: "React.createElement",
      jsxFragmentPragma: "React.Fragment",
      production: true,
    });
    jsCode = result.code;
  } catch (e) {
    const result: CompileResult = {
      ok: false,
      error: `Compilation error: ${e instanceof Error ? e.message : String(e)}`,
    };
    cache.set(code, result);
    return result;
  }

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      "React",
      "useState",
      "useEffect",
      "useRef",
      "useMemo",
      "useCallback",
      "useReducer",
      "Fragment",
      jsCode + "\nreturn Component;"
    );
    const Component = factory(
      React,
      useState,
      useEffect,
      useRef,
      useMemo,
      useCallback,
      useReducer,
      Fragment
    );
    if (typeof Component !== "function") {
      const result: CompileResult = {
        ok: false,
        error: "Component must be a function. Define `function Component() { ... }`.",
      };
      cache.set(code, result);
      return result;
    }
    const compiled: CompileResult = { ok: true, Component };
    cache.set(code, compiled);
    return compiled;
  } catch (e) {
    const result: CompileResult = {
      ok: false,
      error: `Runtime error: ${e instanceof Error ? e.message : String(e)}`,
    };
    cache.set(code, result);
    return result;
  }
}

/** Clear the compilation cache (useful for testing) */
export function clearCompileCache(): void {
  cache.clear();
}
