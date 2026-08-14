import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthOnboarding } from "./AuthModal";
import {
  EmailVerificationRequiredError,
  useAuthStore,
} from "../stores/auth";

const originalLogin = useAuthStore.getState().login;
const originalRequestPasswordReset =
  useAuthStore.getState().requestPasswordReset;
const originalResetPassword = useAuthStore.getState().resetPassword;
const genericRequestMessage =
  "If an account exists for that email, a password reset code will be sent.";

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: null,
    token: null,
    loading: false,
    login: originalLogin,
    requestPasswordReset: originalRequestPasswordReset,
    resetPassword: originalResetPassword,
  });
});

function openPasswordReset(email = "Jane@Example.com") {
  render(<AuthOnboarding />);
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
}

describe("AuthOnboarding", () => {
  it("starts with registration before the app shell is usable", () => {
    render(<AuthOnboarding />);

    expect(screen.getByText("Create your TheChat account")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Create account" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("still lets existing users switch to login", () => {
    render(<AuthOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(
      screen.getByRole("heading", { name: "Log in" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Forgot password?" }),
    ).toBeInTheDocument();
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

describe("password reset UI", () => {
  it("opens from login and preserves the entered email", () => {
    openPasswordReset();

    expect(
      screen.getByRole("heading", { name: "Reset password" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reset your TheChat password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("Jane@Example.com");
    expect(
      screen.getByRole("button", { name: "Back to login" }),
    ).toBeInTheDocument();
  });

  it("validates the email before calling the reset request API", async () => {
    const requestPasswordReset = vi.fn();
    useAuthStore.setState({ requestPasswordReset });
    openPasswordReset("not-an-email");

    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please enter a valid email address",
    );
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("completes the generic code flow and returns to login", async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue(genericRequestMessage);
    const resetPassword = vi
      .fn()
      .mockResolvedValue(
        "Password reset. You can now log in with your new password.",
      );
    useAuthStore.setState({ requestPasswordReset, resetPassword });
    openPasswordReset();

    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

    expect(
      await screen.findByRole("heading", { name: "Enter reset code" }),
    ).toBeInTheDocument();
    expect(requestPasswordReset).toHaveBeenCalledWith("jane@example.com");
    expect(screen.getByRole("status")).toHaveTextContent(genericRequestMessage);

    const resetCodeInput = screen.getByLabelText("Reset code");
    fireEvent.change(resetCodeInput, { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Send another code" }));
    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledTimes(2));
    expect(resetCodeInput).toHaveValue("");
    expect(resetCodeInput).toHaveFocus();

    fireEvent.change(screen.getByLabelText("Reset code"), {
      target: { value: "12a34 56" },
    });
    expect(screen.getByLabelText("Reset code")).toHaveValue("123456");
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-456" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords do not match",
    );
    expect(resetPassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password-456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith(
        "jane@example.com",
        "123456",
        "new-password-456",
      );
    });
    expect(
      await screen.findByRole("heading", { name: "Log in" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("jane@example.com");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Password reset. You can now log in with your new password.",
    );
  });

  it("shows request and confirmation failures without leaving the flow", async () => {
    const requestPasswordReset = vi
      .fn()
      .mockRejectedValueOnce(new Error("Reset service unavailable"))
      .mockResolvedValueOnce(genericRequestMessage);
    const resetPassword = vi
      .fn()
      .mockRejectedValue(new Error("Invalid or expired password reset code"));
    useAuthStore.setState({ requestPasswordReset, resetPassword });
    openPasswordReset("jane@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reset service unavailable",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(
      await screen.findByRole("heading", { name: "Enter reset code" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reset code"), {
      target: { value: "123456" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-456" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password-456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid or expired password reset code",
    );
    expect(
      screen.getByRole("heading", { name: "Enter reset code" }),
    ).toBeInTheDocument();
  });
});
