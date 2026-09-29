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

/** Radio group styled as segmented buttons (wraps on narrow screens). */
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
      <div className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-2xl bg-surface-2 p-1">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative flex min-h-12 min-w-0 cursor-pointer items-center justify-center rounded-xl px-1 text-sm font-semibold whitespace-nowrap transition-colors',
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
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
