import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthOnboarding } from "./AuthModal";
import {
  EmailVerificationRequiredError,
  useAuthStore,
} from "../stores/auth";

const originalLogin = useAuthStore.getState().login;

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    token: null,
    loading: false,
    login: originalLogin,
  });
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

  it("moves an accepted unverified login into OTP recovery", async () => {
    const login = vi
      .fn()
      .mockRejectedValue(
        new EmailVerificationRequiredError("jane@example.com"),
      );
    useAuthStore.setState({ login });
    render(<AuthOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "Jane@Example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith("Jane@Example.com", "password123");
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send a new code" }),
    ).toBeInTheDocument();
  });
});
