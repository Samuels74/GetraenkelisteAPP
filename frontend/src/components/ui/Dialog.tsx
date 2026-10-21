import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './Button';
import type { ButtonVariant } from './buttonStyles';
import { cn } from './cn';
import { FormError } from './Field';

let openDialogs = 0;

function lockScroll() {
  if (openDialogs++ === 0) document.documentElement.style.overflow = 'hidden';
}

function unlockScroll() {
  openDialogs = Math.max(0, openDialogs - 1);
  if (openDialogs === 0) document.documentElement.style.overflow = '';
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `sheet`: bottom sheet on phones, centered card on larger screens. `fullscreen`: full screen on phones. */
  variant?: 'sheet' | 'fullscreen';
  testId?: string;
  /** Extra buttons in the header (left of the close button). */
  headerActions?: ReactNode;
  /** The user can close it: Escape / back gesture, backdrop click, "Schließen" (default true). */
  dismissible?: boolean;
  bodyClassName?: string;
}

/**
 * Accessible modal dialog based on the native <dialog> element (focus
 * trapping, Escape, top layer). Rendered only while `open`; an element with
 * `data-autofocus` inside receives focus when the dialog opens.
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogImpl {...props} />;
}

function DialogImpl({
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'sheet',
  testId,
  headerActions,
  dismissible = true,
  bodyClassName,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    lockScroll();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      unlockScroll();
      if (dialog.open) dialog.close();
    };
  }, []);

  const fullscreen = variant === 'fullscreen';

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-modal="true"
      data-testid={testId}
      onCancel={(event) => {
        // React passes the (non-bubbling) cancel event of a dialog opened from
        // this one – e.g. a confirmation in an edit dialog, a portal in our
        // React tree – up to this handler too: Escape or Android's back gesture
        // would close both and lose the edits. Only our own dialog counts.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'overflow-hidden border-0 bg-surface p-0 text-fg shadow-2xl',
        fullscreen
          ? 'fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none rounded-none sm:m-auto sm:h-[min(820px,92dvh)] sm:max-w-xl sm:rounded-2xl sm:border sm:border-line'
          : 'mx-0 mt-auto mb-0 max-h-[92dvh] w-full max-w-none rounded-t-3xl sm:m-auto sm:max-w-lg sm:rounded-2xl sm:border sm:border-line',
      )}
    >
      <div className={cn('flex flex-col', fullscreen ? 'h-full pt-safe sm:pt-0' : 'max-h-[92dvh]')}>
        <header className="flex shrink-0 items-center gap-1 border-b border-line py-1.5 pr-1.5 pl-4">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
          </h2>
          {headerActions}
          <IconButton label="Schließen" onClick={onClose} disabled={!dismissible} data-testid="dialog-close">
            <X className="size-6" aria-hidden />
          </IconButton>
        </header>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4', bodyClassName)}>
          {description ? (
            <p id={descriptionId} className="mb-4 text-base text-muted">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {footer ? (
          <footer className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
  error?: string | null;
  /**
   * Return the action's promise: until it settles the confirm button shows a
   * spinner and further taps are ignored.
   */
  onConfirm: () => void | Promise<unknown>;
  onClose: () => void;
  testId?: string;
}

/**
 * While a confirmed action is running, its dialog cannot be closed – a sent
 * request cannot be recalled, so "Abbrechen" would only hide the outcome (a
 * booking cancelled after the bartender pressed "Abbrechen"). Only if the
 * answer takes unusually long (a stalled connection) can it be closed again
 * after this time; the caller still reports the outcome then.
 */
export const CONFIRM_LOCKED_MAX_MS = 15_000;

/**
 * Confirmation for an action. Destructive actions (the default) focus
 * "Abbrechen" first, so Enter/Space right after opening does not confirm.
 * While the action runs (`onConfirm` returned a promise), the confirm button
 * shows a spinner and the dialog stays open until the outcome (see
 * CONFIRM_LOCKED_MAX_MS).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <ConfirmDialogImpl {...props} />;
}

function ConfirmDialogImpl({
  title,
  message,
  confirmLabel,
  confirmVariant = 'danger',
  loading,
  error,
  onConfirm,
  onClose,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  // Set synchronously: a double click whose clicks arrive before React
  // re-renders the busy button would otherwise run the action twice.
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  // the action has been running for CONFIRM_LOCKED_MAX_MS: closing is possible again
  const [slow, setSlow] = useState(false);
  const slowTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(slowTimer.current), []);
  const destructive = confirmVariant === 'danger' || confirmVariant === 'danger-soft';
  const locked = (Boolean(loading) || pending) && !slow;

  function confirm() {
    if (busy.current) return;
    const result = onConfirm();
    if (!(result instanceof Promise)) return;
    busy.current = true;
    setPending(true);
    slowTimer.current = window.setTimeout(() => setSlow(true), CONFIRM_LOCKED_MAX_MS);
    const done = () => {
      window.clearTimeout(slowTimer.current);
      busy.current = false;
      setPending(false);
      setSlow(false);
    };
    void result.then(done, done);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      testId={testId}
      dismissible={!locked}
      footer={
        <div className="flex gap-3">
          <Button block onClick={onClose} disabled={locked} data-autofocus={destructive ? '' : undefined}>
            Abbrechen
          </Button>
          <Button
            block
            variant={confirmVariant}
            loading={loading || pending}
            onClick={confirm}
            data-autofocus={destructive ? undefined : ''}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="text-base">{message}</div>
        <FormError message={error} />
      </div>
    </Dialog>
  );
}
