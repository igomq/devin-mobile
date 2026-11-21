<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { app, isTauri, normalizeUrl, sameOriginUrl } from '#lib/app.svelte.ts';

	let url = $state(app.url || sameOriginUrl() || '');
	let token = $state(app.token);
	let showToken = $state(false);
	let error = $state<string | null>(null);
	let authBusy = $state(false);

	const connected = $derived(app.conn === 'open');
	const firstRun = $derived(!app.configured);

	function save(e: Event) {
		e.preventDefault();
		error = null;
		try {
			normalizeUrl(url);
		} catch {
			error = 'Enter a valid address, e.g. 100.101.102.103:8787';
			return;
		}
		if (!token.trim()) {
			error = 'Paste the pairing token printed by the gateway';
			return;
		}
		app.configure(url, token);
		const stop = $effect.root(() => {
			$effect(() => {
				if (app.conn === 'open') {
					stop();
					goto('/');
				} else if (app.conn === 'auth_failed') {
					error = app.connError ?? 'Token rejected';
					stop();
				}
			});
		});
	}

	async function login(methodId: string) {
		authBusy = true;
		try {
			await app.req('agent.authenticate', { methodId }, 300000);
			app.showToast('Devin CLI authenticated');
		} catch (e) {
			app.showError(e);
		} finally {
			authBusy = false;
		}
	}

	async function enableNotifications() {
		if (typeof Notification === 'undefined') return app.showToast('Notifications are not supported here', 'error');
		const r = await Notification.requestPermission();
		app.showToast(r === 'granted' ? 'Notifications enabled' : 'Notifications blocked');
	}
</script>

<div class="screen">
	<header class="topbar">
		<div class="topbar-row">
			{#if !firstRun}
				<button class="icon-btn" aria-label="Back" onclick={() => history.length > 1 ? history.back() : goto('/')}><Icon name="back" /></button>
			{:else}<span style="width:40px"></span>{/if}
			<div class="topbar-title"><span class="t">{firstRun ? 'Connect to your VM' : 'Settings'}</span></div>
			<span style="width:40px"></span>
		</div>
	</header>

	<main>
		{#if firstRun}
			<div class="hero">
				<div class="logo"><img src="/icon.svg" alt="" width="64" height="64" /></div>
				<h1>Devin Mobile</h1>
				<p class="muted">Control Devin CLI running on your Linux VM. Run the gateway on the VM, then pair this device over Tailscale.</p>
				<pre class="mono cmd">npx devin-mobile-gateway --print-token</pre>
			</div>
		{/if}

		<form onsubmit={save} class="card">
			<div class="field">
				<label for="url">Gateway address</label>
				<input id="url" class="input mono" bind:value={url} placeholder="100.x.y.z:8787 or my-vm.tailnet.ts.net:8787" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" />
			</div>
			<div class="field">
				<label for="token">Pairing token</label>
				<div class="tokrow">
					<input id="token" class="input mono" type={showToken ? 'text' : 'password'} bind:value={token} placeholder="token" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
					<button type="button" class="btn small" onclick={() => (showToken = !showToken)}>{showToken ? 'Hide' : 'Show'}</button>
				</div>
			</div>
			{#if error}<div class="err">{error}</div>{/if}
			<button class="btn primary" type="submit" disabled={app.conn === 'connecting'}>
				{#if app.conn === 'connecting'}<span class="spinner"></span> Connecting…{:else}{firstRun ? 'Connect' : 'Save & reconnect'}{/if}
			</button>
		</form>

		{#if !firstRun}
			<div class="section-label">Connection</div>
			<div class="card list-card">
				<div class="kv"><span>Status</span><span class="state {app.conn}">{app.conn === 'open' ? 'Connected' : app.conn === 'auth_failed' ? 'Token rejected' : app.conn === 'connecting' ? 'Connecting' : 'Offline'}</span></div>
				{#if app.hostname}<div class="kv"><span>Host</span><span class="mono">{app.hostname}</span></div>{/if}
				{#if app.agent?.agentInfo}<div class="kv"><span>Devin CLI</span><span class="mono">{app.agent.agentInfo.version}</span></div>{/if}
				{#if app.agent?.error}<div class="kv"><span>Agent</span><span class="err-text">{app.agent.error}</span></div>{/if}
			</div>

			{#if connected && app.agent?.authMethods?.length}
				<div class="section-label">Devin account</div>
				<div class="card">
					<p class="muted small">If sessions fail with an authentication error, sign in the CLI on the VM (`devin auth login`) or start the login flow here.</p>
					{#each app.agent.authMethods as m (m.id)}
						<button class="btn" disabled={authBusy} onclick={() => login(m.id)}>
							{#if authBusy}<span class="spinner"></span>{:else}<Icon name="key" size={16} />{/if}
							{m.name}
						</button>
					{/each}
				</div>
			{/if}

			<div class="section-label">App</div>
			<div class="card">
				{#if !isTauri()}
					<button class="btn" onclick={enableNotifications}>Enable notifications</button>
				{/if}
				<button class="btn danger" onclick={() => { app.forget(); token = ''; }}>Forget this VM</button>
			</div>
		{/if}
	</main>
</div>

<style>
	main {
		padding: 8px 16px calc(32px + var(--safe-bottom));
		max-width: 560px;
		margin: 0 auto;
		width: 100%;
	}
	.hero {
		text-align: center;
		padding: 24px 8px 20px;
	}
	.hero h1 {
		margin: 14px 0 6px;
		font-size: 24px;
		letter-spacing: -0.01em;
	}
	.hero p {
		margin: 0 auto 16px;
		max-width: 360px;
	}
	.logo img {
		border-radius: 16px;
		border: 1px solid var(--border);
	}
	.cmd {
		display: inline-block;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		padding: 8px 12px;
		border-radius: 10px;
		font-size: 13px;
		margin: 0;
		max-width: 100%;
		overflow-x: auto;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 14px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 16px;
	}
	.list-card {
		gap: 0;
		padding: 4px 16px;
	}
	.tokrow {
		display: flex;
		gap: 8px;
	}
	.err {
		color: var(--red);
		font-size: 14px;
	}
	.err-text {
		color: var(--red);
		text-align: right;
		overflow-wrap: anywhere;
	}
	.kv {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		padding: 11px 0;
		font-size: 14.5px;
	}
	.kv + .kv {
		border-top: 1px solid var(--border);
	}
	.kv > span:first-child {
		color: var(--text-2);
	}
	.state.open {
		color: var(--green);
	}
	.state.auth_failed {
		color: var(--red);
	}
	.small {
		font-size: 13px;
		margin: 0;
	}
	.section-label {
		padding-left: 4px;
	}
</style>
