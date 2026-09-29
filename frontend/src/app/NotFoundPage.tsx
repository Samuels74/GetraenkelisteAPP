import { ButtonLink } from '../components/ui/Button';
import { EmptyState } from '../components/ui/Feedback';

export function NotFoundPage() {
  return (
    <EmptyState title="Seite nicht gefunden" className="pt-20">
      <p>Diese Seite gibt es nicht.</p>
      <ButtonLink to="/" variant="primary" className="mt-4">
        Zum Buchen
      </ButtonLink>
    </EmptyState>
  );
}
