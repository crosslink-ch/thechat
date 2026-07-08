import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthOnboarding } from "./AuthModal";
import { useAuthStore } from "../stores/auth";

beforeEach(() => {
  useAuthStore.setState({ user: null, token: null, loading: false });
});

describe("AuthOnboarding", () => {
  it("starts with registration before the app shell is usable", () => {
    render(<AuthOnboarding />);

    expect(screen.getByText("Create your TheChat account")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("still lets existing users switch to login", () => {
    render(<AuthOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});
