import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAppearance,
  type BotAvatarColor,
} from "@thechat/shared";
import { BotFace } from "./BotFace";

const COLOR_NAMES: Record<BotAvatarColor, string> = {
  "#3498DB": "Blue",
  "#1ABC9C": "Teal",
  "#2ECC71": "Green",
  "#9B59B6": "Purple",
  "#E67E22": "Orange",
  "#E74C3C": "Red",
  "#16A085": "Dark teal",
  "#2980B9": "Dark blue",
  "#8E44AD": "Dark purple",
  "#27AE60": "Dark green",
  "#D35400": "Pumpkin",
  "#C0392B": "Dark red",
  "#F39C12": "Amber",
  "#34495E": "Slate",
  "#E84393": "Pink",
  "#00B894": "Mint",
  "#0984E3": "Bright blue",
  "#6C5CE7": "Indigo",
  "#FD79A8": "Light pink",
  "#00CEC9": "Cyan",
  "#FDCB6E": "Light amber",
  "#636E72": "Gray",
};

const pickerLabelClass = "text-[0.857rem] font-medium text-text-secondary";

function shapeName(shape: string) {
  return shape.charAt(0).toUpperCase() + shape.slice(1);
}

/**
 * The bot avatar picker: every shape drawn in the chosen colour, then the
 * colour swatches. Each pick is reported at once; the caller decides
 * whether that saves or only updates a draft.
 */
export function BotAppearancePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: BotAppearance;
  onChange: (next: BotAppearance) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <span className={pickerLabelClass}>Shape</span>
        <div
          role="group"
          aria-label="Shape"
          className="grid grid-cols-[repeat(auto-fill,44px)] gap-1.5"
        >
          {BOT_AVATAR_SHAPES.map((shape) => {
            const selected = shape === value.shape;
            return (
              <button
                key={shape}
                type="button"
                title={shapeName(shape)}
                aria-label={`${shapeName(shape)} bot`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  if (!selected) onChange({ ...value, shape });
                }}
                className={`flex size-11 cursor-pointer items-center justify-center rounded-lg border-2 bg-white/[0.04] p-0 transition-colors duration-150 hover:not-disabled:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
                  selected ? "border-text" : "border-transparent"
                }`}
              >
                <BotFace appearance={{ shape, color: value.color }} size={28} />
              </button>
            );
          })}
        </div>
        <p className="text-[0.786rem] leading-relaxed text-text-dimmed">
          Minimal is a static, faceless glyph with standard activity indicators.
          It is used only when you select it, never by default or at random.
        </p>
      </div>

      <div className="grid gap-2">
        <span className={pickerLabelClass}>Colour</span>
        <div
          role="group"
          aria-label="Colour"
          className="grid max-w-[340px] grid-cols-11 gap-2"
        >
          {BOT_AVATAR_COLORS.map((color) => {
            const selected = color === value.color;
            return (
              <button
                key={color}
                type="button"
                title={COLOR_NAMES[color]}
                aria-label={COLOR_NAMES[color]}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  if (!selected) onChange({ ...value, color });
                }}
                className={`aspect-square w-full cursor-pointer rounded-full border-none p-0 outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${
                  selected ? "outline-2 outline-text" : ""
                }`}
                style={{ backgroundColor: color }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
