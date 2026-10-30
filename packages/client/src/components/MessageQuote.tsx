import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";
import {
  dialogContentClass,
  dialogOverlayClass,
  dialogTitleClass,
  iconButtonClass,
} from "./ui";

const clampClass = {
  draft: "line-clamp-3",
  sent: "line-clamp-3",
} as const;

/**
 * A quoted snippet shown as a small card: in the composer while replying, and
 * above a sent message. Clicking it shows the whole quote.
 */
export function QuoteCard({
  text,
  variant,
  className = "",
}: {
  text: string;
  variant: keyof typeof clampClass;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The card is the dialog's trigger, so closing the dialog returns focus to it.
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          data-testid={variant === "draft" ? "quote-draft-card" : "message-quote"}
          title="Show the full quote"
          className={`block cursor-pointer rounded-lg border border-border bg-base/60 py-1.5 pl-2 pr-2.5 text-left font-[inherit] transition-colors duration-100 hover:border-border-strong hover:bg-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ${className}`}
        >
          <span className="sr-only">Quote: </span>
          <span
            className={`block whitespace-pre-line break-words border-l-2 border-border-strong pl-2 text-[0.786rem] leading-[1.4] text-text-muted [overflow-wrap:anywhere] ${clampClass[variant]}`}
          >
            {text}
          </span>
        </button>
      </Dialog.Trigger>
      <QuoteDialogContent text={text} />
    </Dialog.Root>
  );
}

function QuoteDialogContent({ text }: { text: string }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
      <Dialog.Content
        aria-describedby={undefined}
        className={`app-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[min(80vh,640px)] w-[calc(100%-2rem)] max-w-[540px] -translate-x-1/2 -translate-y-1/2 flex-col ${dialogContentClass}`}
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
          <Dialog.Title className={dialogTitleClass}>Quote</Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              className={`-mr-1.5 ${iconButtonClass("md")}`}
              aria-label="Close quote"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>
        <blockquote className="mx-5 mb-5 mt-1 min-h-0 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border-strong pl-3.5 text-[0.929rem] leading-[1.55] text-text-secondary [overflow-wrap:anywhere]">
          {text}
        </blockquote>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
