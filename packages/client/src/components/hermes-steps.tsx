import {
  Bot,
  ChevronRight,
  Clock,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Image,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { OrbLoader } from "./OrbLoader";

/** Building blocks shared by Hermes activity views (live timeline, work logs). */

export function ExpandChevron({
  expanded,
  className = "",
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <ChevronRight
      size={14}
      aria-hidden="true"
      className={`shrink-0 text-text-dimmed transition-transform duration-150 ${
        expanded ? "rotate-90" : ""
      } ${className}`}
    />
  );
}

/** A finished step's marker: a small muted icon for what the step did. */
export function StepIcon({
  icon: Icon,
  className = "text-text-dimmed",
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <span className={`flex size-5 shrink-0 items-center justify-center ${className}`}>
      <Icon size={15} aria-hidden="true" />
    </span>
  );
}

/** Animated marker for the step in progress. */
export function StepOrb({ state }: { state: "solving" | "working" }) {
  return <OrbLoader state={state} size={20} className="shrink-0" />;
}

export type StepKind =
  | "command"
  | "web"
  | "search"
  | "list"
  | "read"
  | "edit"
  | "todo"
  | "agent"
  | "image"
  | "time"
  | "other";

export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
export const times = (count: number, phrase: string) =>
  count === 1 ? phrase : `${phrase} ${count} times`;

/** Icon and summary phrase for each kind of tool step. */
export const STEP_KINDS: Record<StepKind, { icon: LucideIcon; summary: (count: number) => string }> = {
  command: { icon: SquareTerminal, summary: (n) => `Ran ${plural(n, "command")}` },
  web: { icon: Globe, summary: (n) => times(n, "Searched the web") },
  search: { icon: Search, summary: (n) => times(n, "Searched the code") },
  list: { icon: FolderOpen, summary: (n) => `Listed ${plural(n, "folder")}` },
  read: { icon: FileText, summary: (n) => `Read ${plural(n, "file")}` },
  edit: { icon: FilePen, summary: (n) => `Changed ${plural(n, "file")}` },
  todo: { icon: ListTodo, summary: (n) => times(n, "Updated the plan") },
  agent: { icon: Bot, summary: (n) => `Delegated ${plural(n, "task")}` },
  image: { icon: Image, summary: (n) => `Viewed ${plural(n, "image")}` },
  time: { icon: Clock, summary: (n) => times(n, "Checked the time") },
  other: { icon: Wrench, summary: (n) => `Used ${plural(n, "tool")}` },
};

/** Classifies a tool by the words in its name (read_file, web_search, …). */
export function toolKind(toolName: string | null): StepKind {
  const words = (toolName ?? "").toLowerCase().split(/[^a-z]+/);
  const has = (...candidates: string[]) => candidates.some((word) => words.includes(word));
  if (has("terminal", "shell", "bash", "command", "exec", "execute", "execution", "python", "run")) return "command";
  if (has("web", "fetch", "browse", "browser", "http", "url")) return "web";
  if (has("search", "grep", "find", "glob")) return "search";
  if (has("list", "ls", "dir", "directory", "tree")) return "list";
  if (has("read", "view", "cat", "open")) return "read";
  if (has("write", "edit", "multiedit", "patch", "replace", "create", "delete", "file", "files")) return "edit";
  if (has("todo", "todoread", "todowrite", "plan")) return "todo";
  if (has("delegate", "delegation", "agent", "spawn", "task", "subagent")) return "agent";
  if (has("image", "vision", "screenshot")) return "image";
  if (has("time", "schedule", "cron", "cronjob")) return "time";
  return "other";
}
