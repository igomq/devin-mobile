<script lang="ts">
	import { renderMarkdown } from '#lib/markdown.ts';
	let { text }: { text: string } = $props();
	const html = $derived(renderMarkdown(text));

	function onclick(e: MouseEvent) {
		const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null;
		if (!btn) return;
		const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
		navigator.clipboard?.writeText(code).then(() => {
			btn.textContent = 'Copied';
			setTimeout(() => (btn.textContent = 'Copy'), 1200);
		});
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" {onclick}>{@html html}</div>
