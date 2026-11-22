#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore } from './auth.js';
import { type Config, getArg, loadConfig } from './config.js';
import {
  checkGatewayAuth, checkGatewayPorts, collectDiagnostics, gatewayUrl, installSystemdService,
  suggestedUrls, systemdServiceStatus, uninstallSystemdService,
} from './diagnostics.js';
import { redactSecrets } from './security.js';
import { createGatewayRegistry, createGatewayServer } from './server.js';

function printJson(value: object): void {
  console.log(JSON.stringify(value, null, 2));
}

async function doctor(config: Config, authStore: AuthStore, json: boolean): Promise<void> {
  const { registry } = createGatewayRegistry(config);
  const [, ports, { gatewayAuth, activeDeviceCount }] = await Promise.all([
    registry.probeAll(), checkGatewayPorts(config), checkGatewayAuth(config, authStore.gatewayId),
  ]);
  const report = {
    gatewayId: authStore.gatewayId,
    ...collectDiagnostics(config, registry, authStore, activeDeviceCount),
    masterTokenConfigured: Boolean(config.token),
    gatewayAuth,
    portReachability: ports,
  };
  if (json) {
    printJson(report);
    return;
  }
  console.log(`uniharn ${report.version} on ${report.hostname} (protocol ${report.protocolVersion}, app ${report.minAppVersion}+)`);
  console.log(`Node.js ${report.nodeVersion} · gateway ${report.gatewayId}`);
  console.log(report.isRoot ? 'User: root (run the gateway as a non-root user)' : 'User: non-root');
  if (report.publicBindWarning) console.log('Bind warning: configured to listen on all interfaces');
  console.log(`Gateway authentication: ${report.gatewayAuth} (master token ${report.masterTokenConfigured ? 'configured' : 'missing'})`);
  console.log(`Tailscale IP: ${report.tailscaleIp ?? 'unavailable'}`);
  console.log(`MagicDNS: ${report.magicDns ?? 'unavailable'}`);
  for (const port of ports) console.log(`${gatewayUrl(port.host, report.port)} · ${port.reachable ? 'reachable' : 'unreachable'}`);
  console.log(`Strict roots: ${report.strictRoots ? 'enabled' : 'disabled (discovery mode)'} · ${report.roots.join(', ')}`);
  for (const harness of report.harnesses) {
    console.log(`${harness.name}: ${harness.installed ? harness.version ?? harness.status : 'unavailable'} · auth ${harness.authStatus}`);
  }
  console.log(`Devices: ${report.pairedDeviceCount} paired · ${report.activeDeviceCount} connected`);
  if (report.suggestedUrls.length) console.log(`Gateway URLs: ${report.suggestedUrls.join(', ')}`);
  console.log(report.updateHint);
}

function manageService(action: string | undefined, config: Config, argv: string[]): void {
  switch (action) {
    case 'install': {
      const entryPath = fileURLToPath(import.meta.url);
      const args = [
        '--data-dir', config.dataDir,
        '--port', String(config.port),
        '--roots', config.roots.join(','),
        '--devin', config.devinBin.includes('/') ? resolve(config.devinBin) : config.devinBin,
      ];
      if (config.strictRoots) args.push('--strict-roots');
      if (config.publicUrl) args.push('--public-url', config.publicUrl);
      if (getArg(argv, 'host') ?? process.env.UNIHARN_HOST ?? process.env.DEVIN_MOBILE_HOST) args.push('--host', config.hosts.join(','));
      if (getArg(argv, 'static') ?? process.env.UNIHARN_STATIC ?? process.env.DEVIN_MOBILE_STATIC) args.push('--static', config.staticDir ?? 'none');
      args.push(...config.devinArgs);
      const file = installSystemdService({
        nodePath: process.execPath, entryPath, workingDirectory: dirname(entryPath), args, path: process.env.PATH,
      });
      console.log(`Installed and started ${file}`);
      break;
    }
    case 'uninstall':
      console.log(uninstallSystemdService() ? 'Uninstalled uniharn-gateway.service' : 'uniharn-gateway.service is not installed');
      break;
    case 'status':
      console.log(systemdServiceStatus());
      break;
    default:
      throw new Error('Usage: uniharn service install | uninstall | status');
  }
}

async function main(argv: string[], config: Config): Promise<void> {
  const command = argv[2]?.startsWith('-') ? 'gateway' : argv[2] ?? 'gateway';
  if (command === 'gateway') {
    const gateway = createGatewayServer(config);
    const addresses = await gateway.start();
    const safeLog = (message: string) => console.log(redactSecrets(message, [config.token]));
    for (const address of addresses) safeLog(`[uniharn] listening on ${gatewayUrl(address.address, address.port)}  (ws path /ws)`);
    if (config.legacyMigrated) safeLog('[uniharn] migrated legacy token from ~/.local/share/devin-mobile/token');
    safeLog(`[uniharn] devin binary: ${config.devinBin}`);
    safeLog(`[uniharn] static UI: ${config.staticDir ?? '(none)'}`);
    safeLog('[uniharn] pair a device with: uniharn pair');
    if (argv.includes('--print-token')) console.log(`[uniharn] token: ${config.token}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void gateway.notifyShutdown(`Stopped by ${signal}.`).finally(() => gateway.close().finally(() => process.exit(0)));
      });
    }
    return;
  }

  if (command === 'service') {
    manageService(argv[3], config, argv);
    return;
  }
  const authStore = new AuthStore(config.dataDir, config.token);
  const json = argv.includes('--json');
  switch (command) {
    case 'pair': {
      const ttl = getArg(argv, 'ttl');
      if ((argv.includes('--ttl') && ttl === undefined) || (ttl !== undefined && (!ttl.trim() || !Number.isFinite(Number(ttl))))) {
        throw new Error('--ttl requires a number of seconds');
      }
      const explicitUrl = getArg(argv, 'url');
      if (argv.includes('--url') && explicitUrl === undefined) throw new Error('--url requires a gateway URL');
      const url = explicitUrl ?? config.publicUrl ?? suggestedUrls(config)[0];
      const pair = await authStore.createPairingCode({ ttlSec: ttl === undefined ? undefined : Number(ttl), url });
      if (json) printJson(pair);
      else {
        console.log(pair.qrTerminal);
        console.log(`Pairing code: ${pair.code}`);
        console.log(`Expires at: ${new Date(pair.expiresAt).toISOString()}`);
        console.log(pair.pairingUri);
      }
      break;
    }
    case 'doctor':
    case 'status':
      await doctor(config, authStore, json);
      break;
    case 'devices':
      switch (argv[3]) {
        case 'list': {
          const devices = authStore.listDevices();
          if (json) printJson({ devices });
          else if (!devices.length) console.log('No paired devices. Run uniharn pair to add one.');
          else console.table(devices.map(({ deviceId, name, platform, lastSeenAt, revokedAt }) => ({
            deviceId, name, platform, lastSeen: new Date(lastSeenAt).toISOString(), status: revokedAt === null ? 'active' : 'revoked',
          })));
          break;
        }
        case 'revoke':
          if (!argv[4] || argv[4].startsWith('--')) throw new Error('Usage: uniharn devices revoke <id>');
          authStore.revokeDevice(argv[4]);
          console.log(`Revoked ${argv[4]}`);
          break;
        case 'revoke-all':
          console.log(`Revoked ${authStore.revokeAllDevices()} device(s)`);
          break;
        default:
          throw new Error('Usage: uniharn devices list | revoke <id> | revoke-all');
      }
      break;
    default:
      throw new Error('Usage: uniharn gateway | pair | doctor | status | devices | service');
  }
}

let config: Config | undefined;
try {
  config = loadConfig();
  await main(process.argv, config);
} catch (error) {
  const secrets = [config?.token, process.env.UNIHARN_TOKEN, process.env.DEVIN_MOBILE_TOKEN].filter((token): token is string => !!token);
  console.error(`[uniharn] ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)}`);
  process.exitCode = 1;
}
