/** Triggers a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Downloads text (e.g. CSV) as a UTF-8 file. */
export function downloadText(content: string, filename: string, type = 'text/csv;charset=utf-8'): void {
  downloadBlob(new Blob([content], { type }), filename);
}
