import { useState, useEffect, useRef } from "react";
import { inputClass } from "./ui";

export function ModelCombobox({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const filtered = options.filter((o) => {
    const q = query.toLowerCase();
    return o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q);
  });

  const displayValue = open
    ? query
    : options.find((o) => o.id === value)?.name ?? value;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const select = (id: string) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[activeIdx]) select(filtered[activeIdx].id);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
            inputRef.current?.blur();
          }
        }}
        placeholder="Search models..."
        className={inputClass}
        spellCheck={false}
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          // Frosted menu surface; the list itself scrolls, so no overflow-hidden.
          className="absolute z-50 mt-1 flex max-h-[200px] w-full flex-col gap-px overflow-y-auto rounded-xl border border-border bg-surface/95 p-1.5 shadow-card backdrop-blur-2xl backdrop-saturate-150 animate-menu-in"
        >
          {filtered.map((o, i) => (
            <li
              key={o.id}
              onMouseDown={(e) => {
                e.preventDefault();
                select(o.id);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`flex shrink-0 cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-[0.929rem] transition-colors duration-75 ${
                i === activeIdx ? "bg-hover text-text" : "text-text-secondary"
              }`}
            >
              <span className="truncate font-medium">{o.name}</span>
              <span className="min-w-0 truncate font-mono text-[0.786rem] text-text-dimmed">{o.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
