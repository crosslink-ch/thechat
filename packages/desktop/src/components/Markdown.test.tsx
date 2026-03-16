import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders inline math with KaTeX when delimited by double dollars", () => {
    const { container } = render(
      <Markdown content={"Euler's identity is $$e^{i\\pi} + 1 = 0$$."} />,
    );

    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByText("Euler's identity is", { exact: false })).toBeInTheDocument();
  });

  it("renders block math with KaTeX", () => {
    const { container } = render(
      <Markdown content={"$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$"} />,
    );

    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("does not treat single-dollar text as math", () => {
    const { container } = render(
      <Markdown content={"The plan costs $20 per month and shell vars look like $HOME."} />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("The plan costs $20 per month and shell vars look like $HOME.")).toBeInTheDocument();
  });

  it("renders fenced math blocks", () => {
    const { container } = render(
      <Markdown content={"```math\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n```"} />,
    );

    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
});
