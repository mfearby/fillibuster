/**
 * Small browser-file helpers for the options page: saving text as a download
 * and reading a picked/dropped file back as text. Neither needs an extension
 * permission — they are plain web APIs available to any extension page.
 */

/**
 * Save `text` as a file named `filename` via a temporary object URL and an
 * `<a download>` click. The browser shows its usual download behaviour.
 */
export function downloadText(
  filename: string,
  text: string,
  mime = 'application/json',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `fillibuster-backup-YYYY-MM-DD.json`, using the local date. */
export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `fillibuster-backup-${date}.json`;
}

/** Read a picked or dropped file as UTF-8 text. */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.readAsText(file);
  });
}
