// RatingStars — designer contract: rating, max, size, showValue. Filled
// stars are signal green (the only filled glyphs in the system); empty
// stars are gray-300; partial fill via clip. The value renders in tabular
// figures. Follows components/display/RatingStars.jsx in the DS bundle.
import { cn } from "~/lib/utils";

const STAR_PATH =
  "M12 2l2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17.1 6 20.4l1.3-6.7-5-4.7 6.8-.8z";

export interface RatingStarsProps extends React.ComponentProps<"span"> {
  rating?: number;
  max?: number;
  /** Star glyph size in CSS pixels. */
  size?: number;
  /** Render the numeric value ("4.8") beside the stars. */
  showValue?: boolean;
}

export function RatingStars({
  rating = 0,
  max = 5,
  size = 16,
  showValue = false,
  className,
  ...props
}: RatingStarsProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      {...props}
    >
      <span
        className="inline-flex gap-0.5"
        role="img"
        aria-label={`${rating} of ${max} stars`}
      >
        {Array.from({ length: max }, (_, i) => {
          const fill = Math.max(0, Math.min(1, rating - i));
          return (
            <svg
              // biome-ignore lint/suspicious/noArrayIndexKey: stars are positional by definition
              key={i}
              width={size}
              height={size}
              viewBox="0 0 24 24"
              className="block"
              aria-hidden="true"
            >
              <path d={STAR_PATH} fill="var(--gray-300)" />
              {fill > 0 && (
                <g
                  style={
                    fill < 1
                      ? { clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)` }
                      : undefined
                  }
                >
                  <path d={STAR_PATH} fill="var(--accent-star)" />
                </g>
              )}
            </svg>
          );
        })}
      </span>
      {showValue && (
        <span className="font-sans text-sm font-semibold leading-none text-ink-900 tabular-nums">
          {Number(rating).toFixed(1)}
        </span>
      )}
    </span>
  );
}
