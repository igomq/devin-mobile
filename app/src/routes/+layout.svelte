<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import { onMount } from 'svelte';
	import { app } from '#lib/app.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	let ready = $state(false);

	onMount(() => {
		app.init();
		ready = true;
		const vv = window.visualViewport;
		const sync = () => document.documentElement.style.setProperty('--vvh', `${vv?.height ?? window.innerHeight}px`);
		sync();
		vv?.addEventListener('resize', sync);
		return () => vv?.removeEventListener('resize', sync);
	});

	const offline = $derived(app.configured && app.everConnected && app.conn !== 'open');
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if ready}
	{@render children()}
{/if}

{#if offline}
	<div class="conn-banner" role="status">
		<span class="spinner"></span>
		{app.conn === 'auth_failed' ? 'Token rejected — re-pair in Settings' : 'Reconnecting to VM…'}
	</div>
{/if}

{#if app.toast}
	<div class="toast {app.toast.kind}" role="alert">{app.toast.text}</div>
{/if}

<style>
	.conn-banner {
		position: fixed;
		top: calc(var(--safe-top) + var(--header-h) + 6px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 14px;
		border-radius: 999px;
		font-size: 13px;
		background: var(--bg-elev-2);
		border: 1px solid var(--border);
		color: var(--text-2);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		white-space: nowrap;
	}
	.toast {
		position: fixed;
		left: 16px;
		right: 16px;
		bottom: calc(var(--safe-bottom) + 96px);
		z-index: 100;
		margin: 0 auto;
		max-width: 520px;
		padding: 12px 16px;
		border-radius: 14px;
		background: var(--bg-elev-2);
		border: 1px solid var(--border);
		font-size: 14px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
		animation: rise 0.18s ease-out;
	}
	.toast.error {
		border-color: color-mix(in srgb, var(--red) 50%, var(--border));
		color: #fecaca;
	}
	@keyframes rise {
		from {
			transform: translateY(8px);
			opacity: 0;
		}
	}
</style>
