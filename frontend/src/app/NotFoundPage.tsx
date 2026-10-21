import { ButtonLink } from '../components/ui/Button';
import { EmptyState } from '../components/ui/Feedback';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function NotFoundPage() {
  // (also after an in-app navigation: the previous page's title must not stay)
  useDocumentTitle('Seite nicht gefunden');
  return (
    <EmptyState title="Seite nicht gefunden" titleAs="h1" className="pt-20">
      <p>Diese Seite gibt es nicht.</p>
      <ButtonLink to="/" variant="primary" className="mt-4">
        Zum Buchen
      </ButtonLink>
    </EmptyState>
  );
}
