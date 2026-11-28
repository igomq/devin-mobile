import type { HarnessRegistry } from './harnesses/registry.js';
import type { Session, SessionEvent } from './sessions.js';
import type { WorkspaceStore } from './workspaces.js';
import type { ProfileStore, TeamStore } from './presets.js';
import type { Orchestrator } from './orchestrator.js';
import { Scheduler, type SchedulerOptions, type SchedulerTask } from './scheduler.js';

/** RPC facade: unknown methods return undefined, as with the other gateway RPC modules. */
export function createSchedulerRpc(dataDir: string, options: SchedulerOptions) {
  const scheduler = new Scheduler(dataDir, options);
  const id = (p: any) => { const value = p?.taskId ?? p?.id; if (typeof value !== 'string' || !value.trim()) throw new Error('taskId is required'); return value; };
  return {
    scheduler,
    start: () => scheduler.start(),
    close: () => scheduler.close(),
    handle(type: string, p: any): Promise<any> | undefined {
      if (!['scheduler.list', 'scheduler.create', 'scheduler.update', 'scheduler.delete', 'scheduler.cancel', 'scheduler.release', 'scheduler.confirm'].includes(type)) return undefined;
      return Promise.resolve().then(async () => {
        switch (type) {
          case 'scheduler.list': return { tasks: scheduler.list().filter(task => (!p?.workspaceId || task.workspaceId === p.workspaceId) && (!p?.sessionId || task.sessionId === p.sessionId)) };
          case 'scheduler.create': return { task: await scheduler.create(p.task ?? p) };
          case 'scheduler.update': return { task: await scheduler.update(id(p), p.patch ?? p.task ?? p) };
          case 'scheduler.delete': return { task: scheduler.delete(id(p)) };
          case 'scheduler.cancel': return { task: scheduler.cancel(id(p)) };
          case 'scheduler.release': return { task: scheduler.release(id(p)) };
          case 'scheduler.confirm': return { task: scheduler.confirm(id(p)) };
        }
      });
    },
  };
}

/** Adapter prompts return before the turn finishes; wait for the matching session's terminal event. */
export function gatewaySchedulerOptions(registry: HarnessRegistry, workspaces: WorkspaceStore, checkPath: (path: string) => string, notify: NonNullable<SchedulerOptions['notify']>, presets?: { profiles: ProfileStore; teams: TeamStore; orchestrator: Orchestrator }): SchedulerOptions {
  async function target(sessionId: string, workspaceId?: string) {
    const { adapter, harnessId, nativeId } = registry.resolveSession(sessionId);
    if (!nativeId) throw new Error('Invalid session target');
    if (workspaceId) {
      const workspace = workspaces.get(workspaceId);
      if (!workspace || !workspace.sessions.some(s => s.sessionId === sessionId && s.harnessId === harnessId)) throw new Error('Session does not belong to workspace');
      checkPath(workspace.cwd);
    }
    const session = await adapter.ensureLoaded(nativeId);
    checkPath(session.cwd);
    if (session.subagent) throw new Error('Native subagent sessions cannot be scheduled');
    if (workspaceId && workspaces.get(workspaceId)?.cwd !== session.cwd) throw new Error('Session folder does not match workspace');
    return { adapter, harnessId, nativeId, session };
  }
  return {
    checkTarget: async (sessionId, workspaceId, selection) => {
      const { session, harnessId } = await target(sessionId, workspaceId);
      if (selection?.harness && selection.harness !== harnessId) throw new Error('Harness does not match the selected session');
      const team = selection?.team ? presets?.teams.get(selection.team) : undefined;
      if (selection?.team && !team) throw new Error('Team not found');
      const profileId = selection?.profile ?? team?.profileId;
      const profile = profileId ? presets?.profiles.get(profileId) : undefined;
      if (profileId && !profile) throw new Error('Profile not found');
      if (profile) {
        if (checkPath(profile.cwd) !== checkPath(session.cwd)) throw new Error('Profile folder does not match the session');
        if (profile.workspaceId && ((workspaceId && profile.workspaceId !== workspaceId) || !workspaces.get(profile.workspaceId)?.sessions.some(s => s.sessionId === sessionId && s.harnessId === harnessId))) throw new Error('Profile workspace does not match the task');
        if (!team && profile.envAllowlist?.length && JSON.stringify([...profile.envAllowlist].sort()) !== JSON.stringify([...(session.options.envAllowlist ?? [])].sort())) throw new Error('Profile environment does not match the selected session');
        if (!team && profile.harnessId !== harnessId) throw new Error('Profile harness does not match the session');
      }
      if (team?.cwd && checkPath(team.cwd) !== checkPath(session.cwd)) throw new Error('Team folder does not match the session');
      if (team) for (const role of team.roles) registry.require(role.harnessId);
    }, notify,
    executor: async (task: SchedulerTask, step, signal) => {
      const { adapter, harnessId, nativeId, session } = await target(task.sessionId, task.workspaceId);
      if (signal.aborted) return;
      if (task.harness && task.harness !== harnessId) throw new Error('Harness does not match the selected session');
      const team = task.team ? presets?.teams.get(task.team) : undefined;
      if (task.team && !team) throw new Error('Team not found');
      const profileId = task.profile ?? team?.profileId;
      const profile = profileId ? presets?.profiles.get(profileId) : undefined;
      if (profileId && !profile) throw new Error('Profile not found');
      if (profile) {
        if (checkPath(profile.cwd) !== checkPath(session.cwd)) throw new Error('Profile folder does not match the session');
        if (profile.workspaceId && ((task.workspaceId && profile.workspaceId !== task.workspaceId) || !workspaces.get(profile.workspaceId)?.sessions.some(s => s.sessionId === task.sessionId && s.harnessId === harnessId))) throw new Error('Profile workspace does not match the task');
        if (!team && profile.envAllowlist?.length && JSON.stringify([...profile.envAllowlist].sort()) !== JSON.stringify([...(session.options.envAllowlist ?? [])].sort())) throw new Error('Profile environment does not match the selected session');
        if (!team && profile.harnessId !== harnessId) throw new Error('Profile harness does not match the session');
      }
      if (team?.cwd && checkPath(team.cwd) !== checkPath(session.cwd)) throw new Error('Team folder does not match the session');
      const prelude = profile ? [profile.prelude, profile.gitWorkflowNotes && `Git workflow: ${profile.gitWorkflowNotes}`, profile.defaultBranch && `Default branch: ${profile.defaultBranch}`, profile.commonCommands?.length && `Common commands:\n${profile.commonCommands.join('\n')}`].filter(Boolean).join('\n\n') : '';
      if (team && presets) {
        const links: string[] = [];
        const cancel = () => { for (const id of links) { const link = presets.orchestrator.get(id); if (link?.status === 'running') { const child = registry.resolveSession(link.childSessionId); void child.adapter.cancel(child.nativeId).catch(() => undefined); } } };
        signal.addEventListener('abort', cancel);
        try {
          for (const role of team.roles) {
            if (signal.aborted) break;
            const started = await presets.orchestrator.delegate(task.sessionId, role.harnessId, step.prompt, { cwd: session.cwd, model: task.model ?? role.model, mode: role.mode, effort: role.effort, instruction: role.instruction, prelude, subagentModel: profile?.subagentModel, envAllowlist: profile?.envAllowlist });
            links.push(started.link.id);
            if (signal.aborted) cancel();
          }
          while (links.some(id => presets.orchestrator.get(id)?.status === 'running')) await new Promise(resolve => setTimeout(resolve, 100));
          if (signal.aborted) return;
          if (links.some(id => presets.orchestrator.get(id)?.status !== 'done')) throw Object.assign(new Error('A scheduled team role failed'), { retryable: false });
          return;
        } catch (error) {
          cancel();
          while (links.some(id => presets.orchestrator.get(id)?.status === 'running')) await new Promise(resolve => setTimeout(resolve, 100));
          // Some roles may already have performed work; never replay a partially launched team.
          if (links.length) throw Object.assign(new Error(`Team execution failed after starting ${links.length} role(s)`, { cause: error }), { retryable: false });
          throw error;
        } finally { signal.removeEventListener('abort', cancel); }
      }
      if (session.running || session.permissions.size) throw new Error('Target session is busy');
      const selectedModel = task.model ?? profile?.model;
      if (selectedModel) {
        const model = session.summary().configOptions.find((o: any) => o?.category === 'model' || o?.id === 'model');
        if (!model) throw new Error('Target session does not support model selection');
        await adapter.setConfigOption(nativeId, model.id, selectedModel);
      }
      if (signal.aborted) return;
      if (session.running || session.permissions.size) throw new Error('Target session is busy');
      await new Promise<void>((resolve, reject) => {
        let settled = false; let submitted = false;
        const cleanup = () => { adapter.off('event', onEvent); signal.removeEventListener('abort', onAbort); };
        const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(); };
        const onEvent = (s: Session, event: SessionEvent) => {
          if (s !== session || !submitted) return;
          if (event.update?.sessionUpdate === '_turn_error') finish(new Error(String(event.update.message ?? 'Turn failed')));
          if (event.update?.sessionUpdate === '_turn_end') {
            const reason = event.update.stopReason;
            finish(reason && !['end_turn', 'stop_sequence'].includes(reason) ? new Error(`Turn stopped: ${reason}`) : undefined);
          }
        };
        const onAbort = () => { void adapter.cancel(nativeId).catch(() => undefined); };
        adapter.on('event', onEvent); signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { finish(new Error('Execution canceled')); return; }
        submitted = true;
        void adapter.prompt(nativeId, prelude ? `${prelude}\n\n${step.prompt}` : step.prompt).then(() => { if (signal.aborted) void adapter.cancel(nativeId).catch(() => undefined); }).catch(e => finish(e instanceof Error ? e : new Error(String(e))));
      });
    },
  };
}
