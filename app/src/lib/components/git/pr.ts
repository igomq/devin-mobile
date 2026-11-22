import type { PullRequestSummary } from '#lib/types.ts';

export function prStateBadge(pr: Pick<PullRequestSummary, 'state' | 'isDraft'>) {
  const s = (pr.state || '').toUpperCase();
  if (s === 'MERGED') return { text: 'merged', cls: 'violet' };
  if (s === 'CLOSED') return { text: 'closed', cls: 'red' };
  if (pr.isDraft) return { text: 'draft', cls: '' };
  return { text: 'open', cls: 'green' };
}

export function reviewBadge(decision: string | null | undefined) {
  switch ((decision || '').toUpperCase()) {
    case 'APPROVED':
      return { text: 'approved', cls: 'green' };
    case 'CHANGES_REQUESTED':
      return { text: 'changes requested', cls: 'red' };
    case 'REVIEW_REQUIRED':
      return { text: 'review required', cls: 'amber' };
    default:
      return null;
  }
}
