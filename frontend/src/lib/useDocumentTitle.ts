import { useEffect } from 'react';

const APP_NAME = 'Getränkeliste';

/** Sets `document.title` to `<title> · Getränkeliste` while the page is shown. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
