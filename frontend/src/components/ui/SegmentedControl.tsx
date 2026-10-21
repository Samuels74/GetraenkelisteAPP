import { useId } from 'react';
import { cn } from './cn';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  testId?: string;
}

/**
 * Radio group styled as segmented buttons: equal widths in one row while the
 * labels fit, otherwise the options wrap into further rows (narrow phones
 * with large text) instead of squeezing labels below 48 px or over each other.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  testId,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={cn('min-w-0', className)} data-testid={testId}>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap gap-0.5 rounded-2xl bg-surface-2 p-1">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative flex min-h-12 min-w-fit flex-1 cursor-pointer items-center justify-center rounded-xl px-1 text-sm font-semibold whitespace-nowrap transition-colors',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-ring',
                checked ? 'bg-surface text-fg shadow-sm dark:bg-surface-3' : 'text-muted hover:text-fg',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {/* (at least 48 px with the padding) */}
              <span className="min-w-10 text-center">{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
