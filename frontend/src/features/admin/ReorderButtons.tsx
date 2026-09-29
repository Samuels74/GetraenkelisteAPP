import { ChevronDown, ChevronUp } from 'lucide-react';
import { IconButton } from '../../components/ui/Button';

export function ReorderButtons({
  name,
  isFirst,
  isLast,
  disabled,
  onMove,
}: {
  name: string;
  isFirst: boolean;
  isLast: boolean;
  disabled?: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <div className="flex shrink-0">
      <IconButton label={`${name} nach oben`} disabled={isFirst || disabled} onClick={() => onMove(-1)}>
        <ChevronUp className="size-5" aria-hidden />
      </IconButton>
      <IconButton label={`${name} nach unten`} disabled={isLast || disabled} onClick={() => onMove(1)}>
        <ChevronDown className="size-5" aria-hidden />
      </IconButton>
    </div>
  );
}
