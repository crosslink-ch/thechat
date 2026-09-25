/**
 * Shared visual primitives as Tailwind class strings, so they compose with the
 * existing markup (native buttons, Radix parts) without wrapper components.
 * Keep behaviour hooks (semantic classes, data-*, aria-*) on the elements.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft";
export type ButtonSize = "sm" | "md" | "lg";

const buttonBase =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-[inherit] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent-fill text-white hover:not-disabled:bg-accent-hover",
  secondary: "border-border-strong bg-elevated text-text hover:not-disabled:bg-button-hover",
  ghost: "border-transparent bg-transparent text-text-secondary hover:not-disabled:bg-hover hover:not-disabled:text-text",
  danger: "border-transparent bg-error text-white hover:not-disabled:bg-error/85",
  "danger-soft": "border-error-border bg-error-bg text-error-bright hover:not-disabled:bg-error/20",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[0.857rem]",
  md: "h-8 px-3 text-[0.929rem]",
  lg: "h-10 px-4 text-[0.929rem]",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md") {
  return `${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]}`;
}

/** Square, borderless button holding a single icon. */
export function iconButtonClass(size: "sm" | "md" | "lg" = "md") {
  const box = size === "sm" ? "size-6" : size === "lg" ? "size-9" : "size-8";
  return `inline-flex ${box} shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-dimmed transition-colors duration-150 hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-45`;
}

const inputBase =
  "w-full min-w-0 rounded-lg border border-border-strong bg-base px-3 py-2 text-[0.929rem] text-text outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-text-placeholder focus:border-accent/60 focus:ring-3 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60";

export const inputClass = `${inputBase} font-[inherit]`;

/** Input for tokens, ids and other code-like values. */
export const monoInputClass = `${inputBase} font-mono placeholder:font-sans`;

export const labelClass = "mb-1.5 block text-[0.857rem] font-medium text-text-secondary";

// Dialogs: dim overlay, frosted surface, soft rise-in (reversed on close).
export const dialogOverlayClass =
  "fixed inset-0 bg-overlay backdrop-blur-[2px] animate-overlay-in data-[state=closed]:animate-overlay-out";

export const dialogSurfaceClass =
  "rounded-xl border border-border bg-surface/95 shadow-card backdrop-blur-2xl backdrop-saturate-150";

export const dialogContentClass = `${dialogSurfaceClass} animate-dialog-in data-[state=closed]:animate-dialog-out`;

export const dialogTitleClass = "text-[1.071rem] font-semibold text-text";

// Menus and popovers share the frosted surface at a tighter scale.
export const menuContentClass =
  "min-w-[180px] overflow-hidden rounded-xl border border-border bg-surface/95 p-1.5 shadow-card backdrop-blur-2xl backdrop-saturate-150 animate-menu-in";

/** Menu item geometry without colours, for items with their own colour state. */
export const menuItemBaseClass =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2.5 py-1.5 text-left font-[inherit] text-[0.929rem] outline-none transition-colors duration-100";

export const menuItemClass = `${menuItemBaseClass} text-text-secondary hover:bg-hover hover:text-text data-[highlighted]:bg-hover data-[highlighted]:text-text`;

export const menuDangerItemClass = `${menuItemBaseClass} text-error-bright hover:bg-error/10 data-[highlighted]:bg-error/10`;

export const menuSeparatorClass = "my-1 h-px bg-border";

/** Quiet sentence-case heading for sidebar and panel sections. */
export const sectionLabelClass = "text-[0.857rem] font-medium text-text-dimmed";

// Avatar colours: deterministic per person, distinct hues, readable with white initials.
const AVATAR_COLORS = [
  "#2f6fdf", "#0f9488", "#2e9e5b", "#7c5cdb", "#dd6b20", "#d64545",
  "#d6457f", "#5058d8", "#b7791f", "#1f8fcf", "#9b4fd1", "#5f6b7a",
];

export function avatarColor(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
