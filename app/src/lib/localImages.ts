import { rpc } from './api.svelte.ts';

const isRemote = (src: string) => /^(https?:|data:|blob:)/i.test(src);

/**
 * Svelte action for rendered agent Markdown: images given as a path on the gateway machine are loaded
 * through the gateway, and tapping any image calls `open`.
 */
export function localImages(node: HTMLElement, arg: { cwd?: string | null; open: (src: string, name: string) => void }) {
  let opts = arg;
  // Per reply: a later reply that reuses the path (a re-taken screenshot) fetches it again.
  const cache = new Map<string, Promise<string>>();
  const load = () => {
    for (const img of node.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (!src || isRemote(src)) continue;
      const key = (opts.cwd ?? '') + '\0' + src;
      let p = cache.get(key);
      if (!p) {
        p = rpc('fs.image', { path: src, cwd: opts.cwd }).then((r) => `data:${r.mimeType};base64,${r.data}`);
        p.catch(() => cache.delete(key));
        cache.set(key, p);
      }
      p.then((url) => img.isConnected && img.setAttribute('src', url)).catch(() => undefined);
    }
  };
  const click = (e: MouseEvent) => {
    const img = (e.target as HTMLElement).closest('img');
    if (img && isRemote(img.src)) opts.open(img.src, img.alt || 'Image');
  };
  load();
  const mo = new MutationObserver(load);
  mo.observe(node, { childList: true, subtree: true });
  node.addEventListener('click', click);
  return {
    update(next: typeof arg) {
      opts = next;
      load();
    },
    destroy() {
      mo.disconnect();
      node.removeEventListener('click', click);
    }
  };
}
