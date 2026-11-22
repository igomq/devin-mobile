<script lang="ts">
  const paths = {
    back: 'M15 5l-7 7 7 7',
    plus: 'M12 5v14M5 12h14',
    send: 'M12 19V5M6 11l6-6 6 6',
    stop: 'M7 7h10v10H7z',
    diff: 'M8 4v10M3 9h10M15 19h6M6 20a2 2 0 100-4 2 2 0 000 4zM18 8a2 2 0 100-4 2 2 0 000 4zM18 8v3a3 3 0 01-3 3H6',
    terminal: 'M5 8l4 4-4 4M12 16h7',
    bell: 'M6 16V11a6 6 0 0112 0v5l1.5 2h-15zM10 20.5a2 2 0 004 0',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    chevron: 'M9 6l6 6-6 6',
    down: 'M6 9l6 6 6-6',
    folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    x: 'M6 6l12 12M18 6L6 18',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
    brain: 'M12 3a4 4 0 00-4 4 4 4 0 00-2 7.5A4 4 0 0012 21a4 4 0 006-6.5A4 4 0 0016 7a4 4 0 00-4-4zM12 3v18',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
    file: 'M7 3h7l5 5v13H7zM14 3v5h5',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
    git: 'M6 8a2 2 0 100-4 2 2 0 000 4zM6 20a2 2 0 100-4 2 2 0 000 4zM18 12a2 2 0 100-4 2 2 0 000 4zM6 8v8M18 12c0 3-6 1-6 4',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
    play: 'M7 5l12 7-12 7z',
    home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
    keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
    sidebar: 'M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM9 4v16M5.5 8h1M5.5 11h1',
    copy: 'M9 9h9a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1v-9a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V5a1 1 0 011-1h9a1 1 0 011 1v1',
    compose: 'M12 20h8M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
    qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18v2M18 14h2',
    device: 'M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2'
  };
  let { name, size = 22 }: { name: keyof typeof paths; size?: number } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name] ?? ''} />
</svg>
