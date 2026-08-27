import { useEffect, useState } from "react";

export type UserAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface UserAvatarProps {
  name: string;
  avatar?: string | null;
  size?: UserAvatarSize;
  className?: string;
}

const sizeClasses: Record<UserAvatarSize, string> = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-20 w-20 text-xl",
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function UserAvatar({
  name,
  avatar = null,
  size = "md",
  className = "",
}: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatar]);

  const label = `${name} profile picture`;
  const wrapperClass = [
    "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-muted font-semibold text-accent",
    sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (avatar && !imageFailed) {
    return (
      <span className={wrapperClass}>
        <img
          src={avatar}
          alt={label}
          className="h-full w-full object-cover"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className={wrapperClass} role="img" aria-label={label}>
      {initials(name)}
    </span>
  );
}
