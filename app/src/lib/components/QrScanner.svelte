<script lang="ts">
  import { onMount } from 'svelte';
  import { isTauri } from '#lib/api.svelte.ts';

  // Live camera preview that reports the first QR code it reads. `ondecode` returns true to accept the
  // value (the camera stops) or false to keep scanning. The camera is released on unmount.
  let { ondecode }: { ondecode: (text: string) => boolean } = $props();

  interface Detector {
    detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
  }
  interface DetectorClass {
    new (opts: { formats: string[] }): Detector;
    getSupportedFormats?(): Promise<string[]>;
  }
  type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => { data: string } | null;

  const UNAVAILABLE = 'Camera needs the app or HTTPS; enter the code instead.';
  const FRAME_MS = 125; // ~8 fps is plenty for a QR code and easy on the battery.

  let video = $state<HTMLVideoElement>();
  let error = $state<string | null>(null);
  let ready = $state(false);
  let hint = $state<string | null>(null);

  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let detector: Detector | null = null;
  let jsQR: JsQr | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let lastRejected = '';

  function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    if (video) video.srcObject = null;
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || (!isTauri && !window.isSecureContext)) {
      error = UNAVAILABLE;
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      const name = (e as DOMException)?.name;
      error =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was denied. Allow it in settings, or enter the code instead.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera found; enter the code instead.'
            : UNAVAILABLE;
      return;
    }
    if (stopped || !video) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay of a muted inline video is allowed; play() can still reject if we were torn down meanwhile.
    }
    await pickDecoder();
    if (stopped) return;
    if (!detector && !jsQR) {
      error = 'QR scanning is not supported here; enter the code instead.';
      stop();
      return;
    }
    ready = true;
    tick();
  }

  async function pickDecoder() {
    const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    if (Native) {
      try {
        const formats = (await Native.getSupportedFormats?.()) ?? ['qr_code'];
        if (formats.includes('qr_code')) detector = new Native({ formats: ['qr_code'] });
      } catch {
        detector = null;
      }
    }
    if (!detector) {
      try {
        jsQR = (await import('jsqr')).default as unknown as JsQr;
      } catch {
        jsQR = null;
      }
    }
  }

  async function read(v: HTMLVideoElement): Promise<string | null> {
    if (detector) {
      try {
        const found = await detector.detect(v);
        return found[0]?.rawValue ?? null;
      } catch {
        // Some engines expose BarcodeDetector but fail at runtime; fall back to jsQR from now on.
        detector = null;
        jsQR ??= ((await import('jsqr')).default as unknown as JsQr) ?? null;
        return null;
      }
    }
    if (!jsQR || !v.videoWidth) return null;
    // Downscale: a QR code filling part of the frame decodes fine at this size and much faster.
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    canvas ??= document.createElement('canvas');
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  }

  async function tick() {
    if (stopped || !video) return;
    if (video.readyState >= 2) {
      const text = await read(video);
      if (stopped) return;
      if (text) {
        if (ondecode(text)) return stop();
        if (text !== lastRejected) {
          lastRejected = text;
          hint = 'That QR code is not a uniharn pairing code.';
        }
      }
    }
    timer = setTimeout(tick, FRAME_MS);
  }

  onMount(() => {
    start();
    return stop;
  });
</script>

<div class="scanner">
  {#if error}
    <div class="message" role="alert">
      <p>{error}</p>
    </div>
  {:else}
    <div class="viewport">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} playsinline muted autoplay></video>
      <div class="finder" aria-hidden="true"></div>
      {#if !ready}<div class="starting"><span class="spinner"></span></div>{/if}
    </div>
    <p class="caption" aria-live="polite">{hint ?? 'Point the camera at the QR code shown by uniharn pair.'}</p>
  {/if}
</div>

<style>
  .scanner {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
  }
  .viewport {
    position: relative;
    flex: 1;
    min-height: 260px;
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg);
    box-shadow: 0 0 0 1px var(--line);
  }
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .finder {
    position: absolute;
    left: 50%;
    top: 50%;
    width: min(64%, 280px);
    aspect-ratio: 1;
    translate: -50% -50%;
    border-radius: var(--r-lg);
    box-shadow:
      0 0 0 2px var(--accent),
      0 0 0 100vmax var(--scrim);
  }
  .starting {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .caption {
    margin: 0;
    text-align: center;
    font-size: 14px;
    color: var(--text-2);
  }
  .message {
    margin: auto 0;
    padding: 28px 12px;
    text-align: center;
    color: var(--text-2);
    font-size: 15px;
  }
  .message p {
    margin: 0;
  }
</style>
