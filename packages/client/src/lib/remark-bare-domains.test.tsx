import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";

function links(content: string) {
  const { container } = render(<Markdown content={content} />);
  return [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
}

describe("remarkBareDomains", () => {
  it("links bare domains, including bold ones and paths", () => {
    expect(links("I checked **propilatus.ch**, and brunos.ch/de/rezepte.")).toEqual([
      ["propilatus.ch", "https://propilatus.ch"],
      ["brunos.ch/de/rezepte", "https://brunos.ch/de/rezepte"],
    ]);
  });

  it("keeps file names, emails and code as plain text", () => {
    expect(
      links("See README.md, main.py and run.sh; mail tony@example.test; run `curl brunos.ch`."),
    ).toEqual([["tony@example.test", "mailto:tony@example.test"]]);
  });

  it("leaves existing links alone", () => {
    expect(links("[the site](https://brunos.ch) and https://example.com")).toEqual([
      ["the site", "https://brunos.ch"],
      ["https://example.com", "https://example.com"],
    ]);
  });

  it("opens linked domains in a new window", () => {
    render(<Markdown content="Go to example.com" />);
    expect(screen.getByRole("link", { name: "example.com" })).toHaveAttribute("target", "_blank");
  });
});
