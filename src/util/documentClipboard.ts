export default function buildDocumentClipboardText(content: string, extension: string): string {
  if (extension !== 'docx') return content;
  const document = new DOMParser().parseFromString(content, 'text/html');
  document.querySelectorAll('br').forEach((element) => element.replaceWith('\n'));
  document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, tr').forEach((element) => element.append('\n'));
  return document.body.textContent?.trimEnd() || '';
}
