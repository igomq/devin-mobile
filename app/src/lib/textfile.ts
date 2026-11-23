/** Text files the composer attaches as text rather than as images. */
const TEXT_EXT = /\.(md|markdown|txt|text|log|csv|json|ya?ml|toml)$/i;

export function isTextFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith('text/') || TEXT_EXT.test(f.name);
}

export function isMarkdown(name: string, mimeType = ''): boolean {
  return /\.(md|markdown)$/i.test(name) || mimeType === 'text/markdown';
}

/**
 * Decodes a text file whose encoding is unknown: a BOM wins, then strict UTF-8, then the legacy
 * encodings files from Korean Windows tools use (EUC-KR / CP949), then Windows-1252.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  for (const enc of ['utf-8', 'euc-kr']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      /* try the next encoding */
    }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
