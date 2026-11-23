import type { ReadStream } from 'node:tty';

export interface ConsoleInfo {
  version: string;
  gatewayId: string;
  urls: string[];
  pairedDevices: number;
  /** True when this console is attached to a gateway that runs in another process (e.g. systemd). */
  attached: boolean;
}

export interface PairingView {
  code: string;
  pairingUri: string;
  qrTerminal: string;
  expiresAt: number;
}

export interface ConsoleState {
  pairing: PairingView | null;
  showToken: boolean;
  notice: string | null;
}

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

export function renderConsole(info: ConsoleInfo, state: ConsoleState, token: string): string {
  const [primary, ...others] = info.urls;
  const lines = [
    `uniharn ${info.version} · gateway ${info.gatewayId.slice(0, 8)}${info.attached ? ' · running as a service' : ''}`,
    '',
    `Gateway URL:    ${primary ?? 'none (pass --public-url or --host)'}`,
    ...others.map((url) => `                ${url}`),
    `Paired devices: ${info.pairedDevices}`,
    `Master token:   ${state.showToken ? token : 'hidden'}`,
  ];
  if (state.notice) lines.push('', state.notice);
  if (state.pairing) {
    lines.push(
      '',
      'Scan with the uniharn app or your phone camera:',
      state.pairing.qrTerminal.trimEnd(),
      `Pairing code:   ${state.pairing.code}  (one-time, expires ${new Date(state.pairing.expiresAt).toLocaleTimeString()})`,
      `Pairing link:   ${state.pairing.pairingUri}`,
    );
  }
  lines.push(
    '',
    [
      `Enter: ${state.pairing ? 'hide' : 'show'} pairing QR`,
      `t: ${state.showToken ? 'hide' : 'show'} master token`,
      info.attached ? 'q: close (the service keeps running)' : 'q: stop the gateway',
    ].join(' · '),
  );
  return lines.join('\n') + '\n';
}

export type ConsoleAction = 'toggle-pairing' | 'toggle-token' | 'quit' | null;

export function consoleAction(key: string): ConsoleAction {
  if (key === '\r' || key === '\n' || key === ' ') return 'toggle-pairing';
  if (key === 't' || key === 'T') return 'toggle-token';
  if (key === 'q' || key === 'Q' || key === '\u0003' || key === '\u0004') return 'quit';
  return null;
}

export interface ConsoleOptions {
  info: () => ConsoleInfo;
  createPairing: () => Promise<PairingView>;
  token: string;
  onQuit: () => void;
  input?: ReadStream;
  output?: NodeJS.WriteStream;
  /** Show the pairing QR right away, e.g. while no device is paired yet. */
  showPairing?: boolean;
}

/** Interactive terminal panel for `uniharn`: connection details, and the pairing QR toggled with Enter. */
export function startConsole(opts: ConsoleOptions): () => void {
  const input = opts.input ?? (process.stdin as ReadStream);
  const output = opts.output ?? process.stdout;
  const state: ConsoleState = { pairing: null, showToken: false, notice: null };
  let devices = opts.info().pairedDevices;
  let busy = false;

  const draw = () => output.write(CLEAR + renderConsole(opts.info(), state, opts.token));
  const showPairing = async () => {
    busy = true;
    try {
      state.pairing = await opts.createPairing();
      state.notice = null;
    } catch (error) {
      state.notice = `Could not create a pairing code: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
    draw();
  };

  const timer = setInterval(() => {
    const info = opts.info();
    if (info.pairedDevices > devices && state.pairing) {
      state.pairing = null;
      state.notice = 'Device paired.';
      draw();
    } else if (state.pairing && Date.now() >= state.pairing.expiresAt && !busy) {
      void showPairing();
    }
    devices = info.pairedDevices;
  }, 1000);
  timer.unref();

  const onData = (chunk: Buffer | string) => {
    for (const key of chunk.toString()) {
      const action = consoleAction(key);
      if (action === 'quit') {
        stop();
        opts.onQuit();
        return;
      }
      if (action === 'toggle-token') {
        state.showToken = !state.showToken;
        draw();
      } else if (action === 'toggle-pairing' && !busy) {
        if (state.pairing) {
          state.pairing = null;
          state.notice = null;
          draw();
        } else {
          void showPairing();
        }
      }
    }
  };

  function stop() {
    clearInterval(timer);
    input.off('data', onData);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  }

  if (input.isTTY) input.setRawMode(true);
  input.setEncoding('utf8');
  input.on('data', onData);
  input.resume();
  if (opts.showPairing) void showPairing();
  else draw();
  return stop;
}
