import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;

export type PullRequestStateFilter = 'open' | 'closed' | 'merged' | 'all';

export interface GhStatus {
  ghInstalled: boolean;
  authenticated: boolean;
  isGitHubRepo: boolean;
  repoSlug: string | null;
  remoteUrl: string | null;
  error?: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string;
}

export interface PullRequestView extends PullRequestSummary {
  body: string;
  statusCheckRollup: unknown;
  files: unknown[];
}

export interface CreatedPullRequest {
  url: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
}

export interface CreatePullRequestOptions {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

const SUMMARY_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'url',
  'headRefName',
  'baseRefName',
  'author',
  'createdAt',
  'updatedAt',
  'additions',
  'deletions',
  'changedFiles',
  'reviewDecision',
  'mergeable',
].join(',');

const VIEW_FIELDS = `${SUMMARY_FIELDS},body,statusCheckRollup,files`;

function commandFailure(prefix: string, error: unknown): Error {
  const e = error as { stderr?: unknown; message?: unknown; code?: unknown };
  const detail = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (detail) return new Error(`${prefix}: ${detail}`);
  if (typeof e?.code === 'string' && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new Error(`${prefix} (${e.code})`);
  }
  return new Error(prefix);
}

async function runText(
  command: string,
  args: string[],
  cwd: string,
  maxBuffer = 16 * 1024 * 1024,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer,
      encoding: 'utf8',
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return stdout;
  } catch (error) {
    throw commandFailure(`${command} ${args[0] ?? ''} failed`, error);
  }
}

async function runGh(cwd: string, args: string[]): Promise<string> {
  return runText('gh', args, cwd, 16 * 1024 * 1024, { GH_PROMPT_DISABLED: '1' });
}

function parseJson<T>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`GitHub CLI returned invalid JSON for ${command}`);
  }
}

function isGitHubHostname(hostname: string): boolean {
  return hostname.toLowerCase() === 'github.com';
}

function slugFromPath(pathname: string): string | null {
  const path = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

interface GitHubRemote {
  slug: string;
  remoteUrl: string;
}

function parseGitHubRemote(rawUrl: string): GitHubRemote | null {
  const candidate = rawUrl.trim();
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
    if (!isGitHubHostname(url.hostname)) return null;
    const slug = slugFromPath(url.pathname);
    if (!slug) return null;
    return { slug, remoteUrl: redactRemoteUrl(candidate) };
  } catch {
    const match = /^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/.exec(candidate);
    if (!match || !isGitHubHostname(match[2])) return null;
    const slug = slugFromPath(match[3]);
    if (!slug) return null;
    return { slug, remoteUrl: redactRemoteUrl(candidate) };
  }
}

/** Remove URL userinfo and query material before a remote URL leaves this module. */
function redactRemoteUrl(rawUrl: string): string {
  const candidate = rawUrl.trim();
  try {
    const url = new URL(candidate);
    const auth = url.username || url.password
      ? url.protocol === 'ssh:' && url.username === 'git' && !url.password ? 'git@' : '***@'
      : '';
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  } catch {
    const withoutQuery = candidate.split(/[?#]/, 1)[0];
    return withoutQuery.replace(/^([^@/\s]+)@/, (_match, user: string) => user === 'git' ? 'git@' : '***@');
  }
}

async function readGitHubRemote(cwd: string): Promise<GitHubRemote | null> {
  // Raw configured URLs: `git remote -v` applies url.<base>.insteadOf rewrites (e.g. a credential proxy),
  // which would hide that the remote is GitHub.
  let output = '';
  try {
    ({ stdout: output } = await execFileAsync('git', ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'], {
      cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }));
  } catch (error) {
    // Exit code 1 means no remote URL is configured.
    if ((error as { code?: unknown }).code !== 1) throw commandFailure('git config failed', error);
  }
  const remotes: Array<{ name: string; url: string }> = [];
  for (const entry of output.split('\0')) {
    const match = /^remote\.(.+)\.url\n([\s\S]+)$/.exec(entry);
    if (match && !remotes.some((remote) => remote.name === match[1])) remotes.push({ name: match[1], url: match[2] });
  }
  const origin = remotes.find((remote) => remote.name === 'origin');
  const preferred = origin ? [origin, ...remotes.filter((remote) => remote !== origin)] : remotes;
  for (const remote of preferred) {
    const githubRemote = parseGitHubRemote(remote.url);
    if (githubRemote) return githubRemote;
  }
  return null;
}

async function requireGitHubRepo(cwd: string): Promise<GitHubRemote> {
  const remote = await readGitHubRemote(cwd);
  if (!remote) throw new Error('Not a GitHub repository (no supported github.com remote found)');
  return remote;
}

function repoFlag(remote: GitHubRemote): string {
  return `github.com/${remote.slug}`;
}

/** Inspect gh availability/authentication and identify a GitHub remote without requiring auth. */
export async function detectGhStatus(cwd: string): Promise<GhStatus> {
  let ghInstalled = false;
  let authenticated = false;
  let error: string | undefined;

  try {
    await runGh(cwd, ['--version']);
    ghInstalled = true;
  } catch {
    error = 'GitHub CLI (gh) is not installed';
  }

  if (ghInstalled) {
    try {
      await runGh(cwd, ['auth', 'status', '--hostname', 'github.com']);
      authenticated = true;
    } catch {
      error = 'GitHub CLI is not authenticated';
    }
  }

  let remote: GitHubRemote | null = null;
  try {
    remote = await readGitHubRemote(cwd);
  } catch {
    if (!error) error = 'Unable to inspect git remotes';
  }

  return {
    ghInstalled,
    authenticated,
    isGitHubRepo: remote !== null,
    repoSlug: remote?.slug ?? null,
    remoteUrl: remote?.remoteUrl ?? null,
    ...(error ? { error } : {}),
  };
}

function validatePrNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError('Pull request number must be a positive integer');
}

function validateListOptions(opts: { state?: PullRequestStateFilter; limit?: number }): { state: PullRequestStateFilter; limit: number } {
  const state = opts.state ?? 'open';
  const limit = opts.limit ?? 30;
  if (!['open', 'closed', 'merged', 'all'].includes(state)) throw new TypeError('Invalid pull request state');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Pull request limit must be a positive integer');
  return { state, limit };
}

/** Return GitHub's JSON summary objects for pull requests in the repository at cwd. */
export async function listPrs(
  cwd: string,
  opts: { state?: PullRequestStateFilter; limit?: number } = {},
): Promise<PullRequestSummary[]> {
  const { state, limit } = validateListOptions(opts);
  const remote = await requireGitHubRepo(cwd);
  const stdout = await runGh(cwd, [
    'pr', 'list', `--repo=${repoFlag(remote)}`, `--state=${state}`, `--limit=${limit}`, `--json=${SUMMARY_FIELDS}`,
  ]);
  const result = parseJson<unknown>(stdout, 'pr list');
  if (!Array.isArray(result)) throw new Error('GitHub CLI returned an invalid pull request list');
  return result as PullRequestSummary[];
}

/** Return a pull request summary with its body, status checks, and changed files. */
export async function viewPr(cwd: string, number: number): Promise<PullRequestView> {
  validatePrNumber(number);
  const remote = await requireGitHubRepo(cwd);
  return readPrView(cwd, String(number), remote);
}

function boundedUtf8(bytes: Buffer): string {
  const prefix = bytes.subarray(0, MAX_DIFF_BYTES);
  let result = new StringDecoder('utf8').write(prefix);
  if (Buffer.byteLength(result, 'utf8') > MAX_DIFF_BYTES) {
    const clipped = Buffer.from(result, 'utf8').subarray(0, MAX_DIFF_BYTES);
    result = new StringDecoder('utf8').write(clipped);
  }
  return result;
}

/** Return at most 4 MiB of diff text, with the limit measured in UTF-8 bytes. */
export async function diffPr(cwd: string, number: number): Promise<{ diff: string; truncated: boolean }> {
  validatePrNumber(number);
  const remote = await requireGitHubRepo(cwd);
  const args = ['pr', 'diff', String(number), `--repo=${repoFlag(remote)}`];
  const response = await new Promise<{ stdout: Buffer; truncated: boolean }>((resolvePromise, rejectPromise) => {
    execFile('gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: MAX_DIFF_BYTES + 1,
      encoding: 'buffer',
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    }, (error, stdout, stderr) => {
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      if (!error) {
        resolvePromise({ stdout: bytes, truncated: bytes.byteLength > MAX_DIFF_BYTES });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && bytes.byteLength > MAX_DIFF_BYTES) {
        resolvePromise({ stdout: bytes, truncated: true });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        rejectPromise(new Error('gh pr diff failed (stderr exceeded maxBuffer)'));
        return;
      }
      const detail = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')).trim().slice(0, 2000);
      rejectPromise(new Error(detail || 'gh pr diff failed'));
    });
  });
  return {
    diff: boundedUtf8(response.stdout),
    truncated: response.truncated || response.stdout.byteLength > MAX_DIFF_BYTES,
  };
}

function validateCreateOptions(opts: CreatePullRequestOptions): void {
  if (typeof opts.title !== 'string' || !opts.title.trim()) throw new TypeError('Pull request title is required');
  if (opts.body !== undefined && typeof opts.body !== 'string') throw new TypeError('Pull request body must be a string');
  for (const [field, value] of [['base', opts.base], ['head', opts.head]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.startsWith('-'))) {
      throw new TypeError(`Pull request ${field} must be a non-empty branch name`);
    }
  }
  if (opts.draft !== undefined && typeof opts.draft !== 'boolean') throw new TypeError('Pull request draft must be a boolean');
}

function createdPr(stdout: string, remote: GitHubRemote): { url: string; number: number } {
  const urlText = stdout.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[),.;]+$/, '');
  if (!urlText) throw new Error('GitHub CLI did not return a pull request URL');
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('GitHub CLI returned an invalid pull request URL');
  }
  if (url.protocol !== 'https:' || !isGitHubHostname(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('GitHub CLI returned a non-GitHub pull request URL');
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  const slug = match ? `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}` : '';
  if (slug.toLowerCase() !== remote.slug.toLowerCase()) throw new Error('GitHub CLI returned a pull request for a different repository');
  const number = match ? Number(match[3]) : NaN;
  validatePrNumber(number);
  return { url: urlText, number };
}

async function readPrView(cwd: string, spec: string, remote: GitHubRemote): Promise<PullRequestView> {
  const stdout = await runGh(cwd, ['pr', 'view', spec, `--repo=${repoFlag(remote)}`, `--json=${VIEW_FIELDS}`]);
  const result = parseJson<unknown>(stdout, 'pr view');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('GitHub CLI returned an invalid pull request');
  return result as PullRequestView;
}

/** Create a pull request and read it back to return the gateway's structured response. */
export async function createPr(cwd: string, opts: CreatePullRequestOptions): Promise<CreatedPullRequest> {
  validateCreateOptions(opts);
  const remote = await requireGitHubRepo(cwd);
  const args = ['pr', 'create', `--repo=${repoFlag(remote)}`, `--title=${opts.title}`, `--body=${opts.body ?? ''}`];
  if (opts.base !== undefined) args.push(`--base=${opts.base}`);
  if (opts.head !== undefined) args.push(`--head=${opts.head}`);
  if (opts.draft) args.push('--draft');

  const created = createdPr(await runGh(cwd, args), remote);
  let pr: PullRequestView;
  try {
    pr = await readPrView(cwd, created.url, remote);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Pull request was created at ${created.url}, but readback failed: ${detail}`);
  }
  return {
    url: created.url,
    number: created.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
  };
}

export interface SessionPrLink {
  sessionId: string;
  cwd: string;
  number: number;
  url: string;
  title: string;
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  linkedAt: number;
}

export type NewSessionPrLink = Omit<SessionPrLink, 'sessionId' | 'linkedAt'> & { linkedAt?: number };

/** Persist the pull request associated with each harness session. */
export class SessionPrStore {
  private links = new Map<string, SessionPrLink>();
  private filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, 'session-prs.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const entries = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.sessionId === 'string' && entry.sessionId &&
          typeof entry.cwd === 'string' &&
          Number.isSafeInteger(entry.number) && entry.number > 0 &&
          typeof entry.url === 'string' &&
          typeof entry.title === 'string' &&
          Number.isFinite(entry.linkedAt)
        ) {
          this.links.set(entry.sessionId, { ...entry } as SessionPrLink);
        }
      }
    } catch {
      // Ignore corrupt data rather than preventing gateway startup.
    }
  }

  private save(links: Map<string, SessionPrLink>): void {
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify([...links.values()], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }

  link(sessionId: string, input: NewSessionPrLink): SessionPrLink {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('Session ID is required');
    if (!input || typeof input !== 'object') throw new TypeError('Pull request link is required');
    validatePrNumber(input.number);
    if (typeof input.cwd !== 'string' || !input.cwd.trim()) throw new TypeError('Working directory is required');
    if (typeof input.title !== 'string') throw new TypeError('Pull request title is required');
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new TypeError('Pull request URL must be a valid GitHub URL');
    }
    if (url.protocol !== 'https:' || !isGitHubHostname(url.hostname)) throw new TypeError('Pull request URL must use github.com');
    for (const [field, value] of [['state', input.state], ['headRefName', input.headRefName], ['baseRefName', input.baseRefName]] as const) {
      if (value !== undefined && typeof value !== 'string') throw new TypeError(`${field} must be a string`);
    }
    const linkedAt = input.linkedAt ?? Date.now();
    if (!Number.isFinite(linkedAt)) throw new TypeError('linkedAt must be a finite timestamp');
    const link: SessionPrLink = {
      sessionId,
      cwd: resolve(input.cwd),
      number: input.number,
      url: `${url.origin}${url.pathname}`,
      title: input.title,
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.headRefName !== undefined ? { headRefName: input.headRefName } : {}),
      ...(input.baseRefName !== undefined ? { baseRefName: input.baseRefName } : {}),
      linkedAt,
    };
    const next = new Map(this.links);
    next.set(sessionId, link);
    this.save(next);
    this.links = next;
    return { ...link };
  }

  get(sessionId: string): SessionPrLink | undefined {
    const link = this.links.get(sessionId);
    return link ? { ...link } : undefined;
  }

  unlink(sessionId: string): boolean {
    if (!this.links.has(sessionId)) return false;
    const next = new Map(this.links);
    next.delete(sessionId);
    this.save(next);
    this.links = next;
    return true;
  }

  list(): SessionPrLink[] {
    return [...this.links.values()]
      .sort((a, b) => b.linkedAt - a.linkedAt || a.sessionId.localeCompare(b.sessionId))
      .map((link) => ({ ...link }));
  }
}
