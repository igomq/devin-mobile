import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

function esc(s: string) {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function highlight(code: string, lang?: string): string {
	try {
		if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		if (code.length < 20000) return hljs.highlightAuto(code).value;
	} catch {
		/* fall through */
	}
	return esc(code);
}

const md = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		code({ text, lang }) {
			const l = (lang ?? '').split(/\s/)[0];
			return `<div class="codeblock"><div class="codeblock-head"><span>${esc(l || 'text')}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code class="hljs">${highlight(text, l)}</code></pre></div>`;
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;
		}
	}
});

export function renderMarkdown(src: string): string {
	const html = md.parse(src, { async: false }) as string;
	return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'] });
}

export function langFromPath(path: string): string | undefined {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	const map: Record<string, string> = {
		ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
		py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
		cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
		json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', md: 'markdown', html: 'xml', svelte: 'xml', vue: 'xml',
		xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', dockerfile: 'dockerfile', makefile: 'makefile'
	};
	return map[ext];
}
