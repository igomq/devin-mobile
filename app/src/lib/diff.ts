export type DiffLine = { t: ' ' | '+' | '-' | '@'; text: string; a?: number; b?: number };

export interface FileDiff {
	path: string;
	oldPath: string | null;
	lines: DiffLine[];
	binary: boolean;
	additions: number;
	deletions: number;
}

/** Parse `git diff` unified output into per-file line lists. */
export function parseUnified(diff: string): FileDiff[] {
	const files: FileDiff[] = [];
	let cur: FileDiff | null = null;
	let a = 0;
	let b = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			cur = { path: m?.[2] ?? line.slice(11), oldPath: m?.[1] ?? null, lines: [], binary: false, additions: 0, deletions: 0 };
			files.push(cur);
			continue;
		}
		if (!cur) continue;
		if (line.startsWith('@@')) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
			a = Number(m?.[1] ?? 0);
			b = Number(m?.[2] ?? 0);
			cur.lines.push({ t: '@', text: line });
		} else if (line.startsWith('+++ ') || line.startsWith('--- ')) {
			const p = line.slice(4).replace(/^[ab]\//, '');
			if (line.startsWith('+++ ') && p !== '/dev/null') cur.path = p;
		} else if (line.startsWith('Binary files')) {
			cur.binary = true;
		} else if (cur.lines.length === 0) {
			continue; // index/mode headers
		} else if (line.startsWith('+')) {
			cur.lines.push({ t: '+', text: line.slice(1), b: b++ });
			cur.additions++;
		} else if (line.startsWith('-')) {
			cur.lines.push({ t: '-', text: line.slice(1), a: a++ });
			cur.deletions++;
		} else if (line.startsWith(' ')) {
			cur.lines.push({ t: ' ', text: line.slice(1), a: a++, b: b++ });
		}
	}
	return files;
}

/** Line diff of two texts (LCS, bounded) used for ACP `diff` tool content. */
export function diffTexts(oldText: string | null, newText: string): DiffLine[] {
	const A = oldText ? oldText.split('\n') : [];
	const B = newText.split('\n');
	if (!oldText) return B.map((text, i) => ({ t: '+', text, b: i + 1 }));
	let start = 0;
	while (start < A.length && start < B.length && A[start] === B[start]) start++;
	let endA = A.length;
	let endB = B.length;
	while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
		endA--;
		endB--;
	}
	const a = A.slice(start, endA);
	const b = B.slice(start, endB);
	const out: DiffLine[] = [];
	const ctx = 3;
	const lead = Math.max(0, start - ctx);
	if (lead > 0) out.push({ t: '@', text: `@@ line ${lead + 1} @@` });
	for (let i = lead; i < start; i++) out.push({ t: ' ', text: A[i], a: i + 1, b: i + 1 });
	if (a.length * b.length > 4_000_000) {
		a.forEach((text, i) => out.push({ t: '-', text, a: start + i + 1 }));
		b.forEach((text, i) => out.push({ t: '+', text, b: start + i + 1 }));
	} else {
		const n = a.length;
		const m = b.length;
		const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[i] === b[j]) {
				out.push({ t: ' ', text: a[i], a: start + i + 1, b: start + j + 1 });
				i++;
				j++;
			} else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
				out.push({ t: '+', text: b[j], b: start + j + 1 });
				j++;
			} else {
				out.push({ t: '-', text: a[i], a: start + i + 1 });
				i++;
			}
		}
	}
	const tail = Math.min(A.length, endA + ctx);
	for (let i = endA; i < tail; i++) out.push({ t: ' ', text: A[i], a: i + 1, b: i - endA + endB + 1 });
	return out;
}
