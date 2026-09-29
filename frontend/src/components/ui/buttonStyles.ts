import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'danger-soft';
export type ButtonSize = 'md' | 'lg';

export const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

export const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary shadow-sm hover:bg-primary-hover active:bg-primary-hover',
  secondary: 'border border-line bg-surface text-fg shadow-sm hover:bg-surface-2 active:bg-surface-3',
  soft: 'bg-primary-soft text-on-primary-soft hover:brightness-[0.97] active:brightness-95',
  ghost: 'text-fg hover:bg-surface-2 active:bg-surface-3',
  danger: 'bg-danger text-on-danger shadow-sm hover:bg-danger-hover',
  'danger-soft': 'bg-danger-soft text-on-danger-soft hover:brightness-[0.97] active:brightness-95',
};

export const sizes: Record<ButtonSize, string> = {
  md: 'min-h-12 px-4 text-base',
  lg: 'min-h-14 px-5 text-lg',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string): string {
  return cn(base, variants[variant], sizes[size], extra);
}

