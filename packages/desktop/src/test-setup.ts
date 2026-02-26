import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  clearMocks();
});
