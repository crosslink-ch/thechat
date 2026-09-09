const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
};

export function getValidMessageDateTime(iso: string) {
  return Number.isFinite(new Date(iso).getTime()) ? iso : undefined;
}

export function formatMessageTimestamp(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Unknown time";

  const time = date.toLocaleTimeString([], TIME_OPTIONS);
  if (isSameLocalDate(date, now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDate(date, yesterday)) return `Yesterday at ${time}`;

  const dateOptions: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (date.getFullYear() !== now.getFullYear()) {
    dateOptions.year = "numeric";
  }

  return `${date.toLocaleDateString([], dateOptions)} at ${time}`;
}

export function formatFullMessageTimestamp(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isSameLocalDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
