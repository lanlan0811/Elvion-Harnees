import { randomUUID, createHash } from 'node:crypto';
import { resolveApiKey } from '../core/config.js';
import { errorMessage, sanitize } from '../core/security.js';
import type { AppConfig, ModelProfile, PermissionMode, RuntimeSnapshot, ToolExecutor, ProviderAdapter, Message, TranscriptEntry, ToolCall, ApprovalRequest, UserQuestion } from '../core/types.js';
import { createProvider } from '../providers/index.js';
import { createToolExecutor } from '../tools/index.js';
import { SessionStore } from './session.js';
import { compactMessages, contextBudget, estimateInput } from './context.js';
import { loadSystemPrompt } from './prompts.js';
export interface AgentOptions { store: SessionStore; config: AppConfig; executor?: ToolExecutor; providerFactory?: (profile: ModelProfile) => ProviderAdapter }
function profileFingerprint(profile: ModelProfile): string { return createHash('sha256').update(JSON.stringify({ id: profile.id, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model })).digest('hex'); }
export class AgentRuntime {
  private config: AppConfig; private store: SessionStore; private executor: ToolExecutor; private factory: (p: ModelProfile) => ProviderAdapter;
  private messages: Message[] = []; private snapshot: RuntimeSnapshot; private listeners = new Set<(s: RuntimeSnapshot) => void>();
  private controller?: AbortController; private busy?: Promise<void>; private approvalResolve?: (v: boolean) => void; private questionResolve?: (v: string | null) => void;
  private initialized: Promise<void>; private calibration = 1; private warned = false; private closing = false;
  private knownSecrets = new Set<string>();
  constructor(options: AgentOptions) {
    this.config = options.config; this.store = options.store; this.executor = options.executor || createToolExecutor(); this.factory = options.providerFactory || createProvider;
    this.rememberSecrets(options.config);
    const saved = this.store.latestState(); const profileId = saved?.profileId || this.config.activeProfileId;
    this.messages = structuredClone(saved?.messages || []);
    this.snapshot = { sessionId: this.store.info.id, title: this.store.info.title, cwd: this.store.info.cwd, status: 'idle', permission: 'ask', entries: structuredClone(saved?.entries || []), profile: this.config.profiles.find(p => p.id === profileId), contextPercent: 0, estimated: true, todos: structuredClone(saved?.todos || []), restored: !!saved, compactPending: false };
    if (saved) {
      if (!this.snapshot.profile || saved.profileFingerprint !== profileFingerprint(this.snapshot.profile)) {
        for (const message of this.messages) delete message.providerData;
      }
      this.replayDurableToolResults();
      const results = new Set(this.messages.filter(m => m.role === 'tool').map(m => m.toolCallId));
      for (const message of this.messages) for (const call of message.toolCalls || []) if (!results.has(call.id)) {
        const unknown = '上次操作中断，结果未知。请先核实，不得自动重跑。';
        this.messages.push({ role: 'tool', toolCallId: call.id, content: unknown });
        let card = this.snapshot.entries.find(entry => entry.kind === 'tool' && entry.toolCall?.id === call.id);
        if (!card) card = this.entry('tool', call.name + ' ' + JSON.stringify(call.arguments), { toolName: call.name, toolCall: this.clean(call) });
        card.status = '结果未知'; if (!card.output) card.output = unknown;
        this.entry('system', '上次操作结果未知：' + call.name + ' ' + JSON.stringify(call.arguments));
      }
      for (const entry of this.snapshot.entries) if (entry.kind === 'tool' && ['executing', 'approving', '执行中', '等待确认'].includes(entry.status || '')) entry.status = '结果未知';
      this.entry('system', '已恢复会话，权限已重置为每次询问；未完成操作不会自动重跑。');
    }
    this.initialized = this.initialize(); void this.initialized.catch(error => this.fail(error)); this.rebudget();
  }
  private replayDurableToolResults(): void {
    const lastState = this.store.events.findLastIndex(event => event.type === 'state');
    const calls = new Map(this.messages.flatMap(message => message.toolCalls || []).map(call => [call.id, call]));
    const results = new Set(this.messages.filter(message => message.role === 'tool').map(message => message.toolCallId));
    for (const event of this.store.events.slice(lastState + 1)) {
      if (event.type !== 'tool-end' || !event.data || typeof event.data !== 'object') continue;
      const data = event.data as { id?: unknown; status?: unknown; result?: { content?: unknown; isError?: unknown; metadata?: Record<string, unknown> } };
      if (typeof data.id !== 'string' || typeof data.result?.content !== 'string') continue;
      const call = calls.get(data.id); if (!call) continue;
      const content = sanitize(data.result.content, this.secrets());
      if (!results.has(data.id)) { this.messages.push({ role: 'tool', toolCallId: data.id, content }); results.add(data.id); }
      let card = this.snapshot.entries.find(entry => entry.kind === 'tool' && entry.toolCall?.id === data.id);
      if (!card) card = this.entry('tool', call.name + ' ' + JSON.stringify(call.arguments), { toolName: call.name, toolCall: this.clean(call), timestamp: event.timestamp });
      card.output = content;
      card.status = typeof data.status === 'string' ? sanitize(data.status, this.secrets()) : data.result.isError ? '失败' : '完成';
      card.metadata = this.clean({ ...data.result.metadata, durableRecovery: true });
    }
  }
  private rememberSecrets(config: AppConfig): void { for (const p of config.profiles) if (p.apiKey) this.knownSecrets.add(p.apiKey); }
  private secrets(): string[] { this.rememberSecrets(this.config); return [...this.knownSecrets]; }
  private clean<T>(value: T): T {
    const secrets = this.secrets();
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') return sanitize(item, secrets);
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [sanitize(key, secrets), visit(child)]));
      return item;
    };
    return visit(value) as T;
  }
  private async initialize(): Promise<void> {
    const system = await loadSystemPrompt();
    this.messages = [{ role: 'system', content: system }, ...this.messages.filter(message => message.role !== 'system' || message.content.startsWith('本会话压缩摘要：'))];
    for (const call of this.store.unfinishedTools()) await this.store.append('tool-end', { id: call.id, status: '结果未知' });
    this.rebudget(); await this.persist(); this.emit();
  }
  async ready(): Promise<void> { await this.initialized; }
  getSnapshot(): RuntimeSnapshot { return structuredClone(this.snapshot); }
  subscribe(listener: (s: RuntimeSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { const state = this.getSnapshot(); for (const listener of this.listeners) listener(state); }
  private entry(kind: TranscriptEntry['kind'], content: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry { const entry = { id: randomUUID(), kind, content: sanitize(content, this.secrets()), timestamp: new Date().toISOString(), ...extra }; this.snapshot.entries.push(entry); return entry; }
  private async persist(): Promise<void> { await this.store.append('state', this.clean({ messages: this.messages, entries: this.snapshot.entries, profileId: this.snapshot.profile?.id, profileFingerprint: this.snapshot.profile ? profileFingerprint(this.snapshot.profile) : undefined, todos: this.snapshot.todos })); }
  private rebudget(): void { this.snapshot.estimated = true; this.snapshot.contextPercent = this.snapshot.profile ? estimateInput(this.messages, this.executor.definitions) * this.calibration / this.snapshot.profile.contextWindow * 100 : 0; }
  private profile(): ModelProfile { const profile = this.snapshot.profile; if (!profile) throw new Error('请先通过 /provider 配置供应商和模型'); return profile; }
  updateConfig(config: AppConfig): void {
    const old = this.snapshot.profile; this.rememberSecrets(this.config); this.config = config; this.rememberSecrets(config);
    const next = config.profiles.find(p => p.id === old?.id) || config.profiles.find(p => p.id === config.activeProfileId);
    if (this.controller) this.snapshot.pendingProfile = next; else if (next) this.activate(next); else this.snapshot.profile = undefined; this.rebudget(); this.emit();
  }
  selectProfile(id: string): void {
    const target = this.config.profiles.find(p => p.id === id); if (!target) throw new Error('模型配置不存在');
    if (this.controller) { this.snapshot.pendingProfile = target; this.entry('system', '待切换：' + target.name + ' / ' + target.model + '，当前轮结束后生效'); }
    else { this.activate(target); void this.persist().catch(e => this.fail(e)); } this.emit();
  }
  cancelPendingProfile(): void { this.snapshot.pendingProfile = undefined; this.emit(); }
  private activate(profile: ModelProfile): void {
    const old = this.snapshot.profile;
    if (old?.id !== profile.id || old.model !== profile.model || old.protocol !== profile.protocol || old.baseUrl !== profile.baseUrl) { for (const message of this.messages) delete message.providerData; this.calibration = 1; }
    this.snapshot.profile = profile; this.snapshot.pendingProfile = undefined; this.entry('system', '当前模型：' + profile.name + ' / ' + profile.model); this.rebudget();
  }
  setPermission(mode: PermissionMode): void { this.snapshot.permission = mode; this.entry('system', '权限已切换：' + ({ ask: '每次询问', edit: '自动编辑', full: '完全访问' }[mode])); this.emit(); }
  approve(value: boolean): void { this.approvalResolve?.(value); }
  answer(value: string | null): void { this.questionResolve?.(value); }
  cancel(): void { this.controller?.abort(new Error('用户取消当前轮')); this.approvalResolve?.(false); this.questionResolve?.(null); }
  private fail(error: unknown): void { this.snapshot.status = 'failed'; this.snapshot.error = errorMessage(error, this.secrets()); this.entry('system', this.snapshot.error); this.emit(); }
  send(text: string): Promise<void> {
    if (this.controller || this.closing) return Promise.reject(new Error('当前轮尚未结束，请保留草稿稍后发送'));
    if (!text.trim()) return Promise.resolve();
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.busy = this.run(text, signal).catch(e => { if (signal.aborted) { this.snapshot.status = 'cancelled'; this.entry('system', '当前轮已取消；已完成的本地修改不会回滚。'); } else this.fail(e); }).finally(async () => {
      this.controller = undefined; this.snapshot.approval = undefined; this.snapshot.question = undefined;
      if (this.snapshot.pendingProfile) this.activate(this.snapshot.pendingProfile);
      if (!['failed', 'cancelled'].includes(this.snapshot.status)) this.snapshot.status = 'idle';
      this.rebudget(); await this.persist().catch(e => this.fail(e)); this.emit();
    }); return this.busy;
  }
  private async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted(); this.snapshot.status = 'approving'; this.snapshot.approval = this.clean(request);
    return new Promise<boolean>(resolve => { let finished = false; const done = (v: boolean) => { if (finished) return; finished = true; signal.removeEventListener('abort', cancel); this.approvalResolve = undefined; this.snapshot.approval = undefined; this.snapshot.status = 'executing'; this.emit(); resolve(v); }; const cancel = () => done(false); this.approvalResolve = done; signal.addEventListener('abort', cancel, { once: true }); this.emit(); });
  }
  private async requestQuestion(question: UserQuestion, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted(); this.snapshot.status = 'answering'; this.snapshot.question = this.clean(question);
    return new Promise(resolve => { let finished = false; const done = (v: string | null) => { if (finished) return; finished = true; signal.removeEventListener('abort', cancel); this.questionResolve = undefined; this.snapshot.question = undefined; this.snapshot.status = 'executing'; this.emit(); resolve(v); }; const cancel = () => done(null); this.questionResolve = done; signal.addEventListener('abort', cancel, { once: true }); this.emit(); });
  }
  private async run(text: string, signal: AbortSignal): Promise<void> {
    const runtime = this;
    await this.initialized; this.snapshot.error = undefined; const profile = this.profile(); const key = resolveApiKey(profile);
    this.messages.push({ role: 'user', content: sanitize(text, this.secrets()) }); this.entry('user', text);
    if (this.snapshot.title === '新会话') { this.snapshot.title = Array.from(text.replace(/\s+/g, ' ')).slice(0, 40).join(''); await this.store.append('title', sanitize(this.snapshot.title, this.secrets())); }
    await this.persist(); this.emit();
    const adapter = this.factory(profile);
    for (let iteration = 0; iteration < 100; iteration++) {
      signal.throwIfAborted(); this.rebudget();
      if (this.snapshot.contextPercent >= 75 && !this.warned) { this.warned = true; this.entry('system', '输入上下文达到 75%，可用 /compact 手动压缩。'); }
      if (this.snapshot.contextPercent >= 95 || this.snapshot.compactPending) await this.performCompact(signal, profile, key, adapter);
      const input = Math.ceil(estimateInput(this.messages, this.executor.definitions) * this.calibration);
      const budget = contextBudget(profile, input); if (budget.maxOutput <= 0) throw new Error('剩余上下文不足，请压缩或切换更大容量模型');
      this.snapshot.status = 'requesting'; const entry = this.entry('assistant', ''); this.emit();
      let content = ''; const calls: ToolCall[] = []; let items: unknown[] | undefined; let done = false;
      try {
        for await (const event of adapter.stream({ profile, apiKey: key, messages: this.messages, tools: this.executor.definitions, maxOutputTokens: budget.maxOutput, signal })) {
          signal.throwIfAborted();
          if (event.type === 'text') { content += event.text; entry.content = sanitize(content, this.secrets()); this.emit(); }
          if (event.type === 'tool') calls.push(event.call);
          if (event.type === 'provider-data') items = event.items;
          if (event.type === 'done') done = true;
          if (event.type === 'usage' && event.usage.inputTokens > 0) { this.calibration = Math.max(0.5, event.usage.inputTokens / estimateInput(this.messages, this.executor.definitions)); this.snapshot.contextPercent = event.usage.inputTokens / profile.contextWindow * 100; this.snapshot.estimated = false; entry.metadata = { usage: event.usage }; this.emit(); }
        }
        if (!done) throw new Error('模型流在完成前中断，未执行任何未确认调用');
      } catch (error) { entry.status = signal.aborted ? '已取消' : '失败'; if (content) this.messages.push({ role: 'assistant', content: sanitize(content, this.secrets()) + '\n[此回复中断，工具调用未执行]' }); await this.persist(); throw error; }
      const assistant: Message = { role: 'assistant', content: sanitize(content, this.secrets()), ...(calls.length ? { toolCalls: calls } : {}), ...(items ? { providerData: { profileId: profile.id, protocol: profile.protocol, items } } : {}) };
      this.messages.push(assistant); entry.status = '完成'; await this.persist();
      if (!calls.length) return;
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        if (signal.aborted) { this.messages.push({ role: 'tool', toolCallId: call.id, content: '用户取消，未执行' }); continue; }
        const card = this.entry('tool', call.name + ' ' + JSON.stringify(call.arguments), { toolName: call.name, toolCall: this.clean(call), status: '执行中', output: '' });
        await this.store.append('tool-start', this.clean(call)); await this.persist(); this.snapshot.status = 'executing'; this.emit();
        const started = Date.now(); let result;
        try { result = await this.executor.execute(call, { cwd: this.snapshot.cwd, workspace: this.snapshot.cwd, get permission() { return runtime.snapshot.permission; }, signal, approve: r => this.requestApproval(r, signal), ask: q => this.requestQuestion(q, signal), onOutput: output => { card.output = sanitize((card.output || '') + output, this.secrets()).slice(-200_000); this.emit(); }, setTodos: todos => { this.snapshot.todos = todos; this.emit(); }, secrets: this.secrets(), sessionDir: this.store.dir }); }
        catch (e) { result = { content: signal.aborted ? '工具执行已取消，已发生的副作用需要核实' : errorMessage(e, this.secrets()), isError: true }; }
        const output = sanitize(result.content, this.secrets()); card.output = output; card.status = signal.aborted ? '已取消' : result.metadata?.status === 'rejected' ? '已拒绝' : result.metadata?.status === 'cancelled' ? '已取消' : result.isError ? '失败' : '完成'; card.metadata = this.clean({ ...result.metadata, durationMs: Date.now() - started });
        this.messages.push({ role: 'tool', toolCallId: call.id, content: output });
        await this.store.append('tool-end', this.clean({ id: call.id, status: card.status, result })); await this.persist(); this.emit();
      }
      signal.throwIfAborted();
    }
    throw new Error('本轮达到 100 次模型循环上限，已停止，请检查任务');
  }
  async compact(): Promise<void> {
    if (this.controller) { this.snapshot.compactPending = !this.snapshot.compactPending; this.entry('system', this.snapshot.compactPending ? '将在下一个安全请求边界压缩上下文' : '已撤销待执行压缩'); this.emit(); return; }
    await this.initialized; const profile = this.profile(); const key = resolveApiKey(profile); const adapter = this.factory(profile); this.controller = new AbortController(); const signal = this.controller.signal;
    this.busy = this.performCompact(signal, profile, key, adapter).catch(e => { if (signal.aborted) { this.snapshot.status = 'cancelled'; this.entry('system', '上下文压缩已取消，原始历史保留。'); } else this.fail(e); }).finally(async () => { this.controller = undefined; if (this.snapshot.pendingProfile) this.activate(this.snapshot.pendingProfile); if (this.snapshot.status === 'compacting') this.snapshot.status = 'idle'; await this.persist().catch(e => this.fail(e)); this.emit(); }); await this.busy;
  }
  private async performCompact(signal: AbortSignal, profile: ModelProfile, key: string, adapter: ProviderAdapter): Promise<void> {
    const before = this.snapshot.contextPercent; this.snapshot.status = 'compacting'; this.emit();
    const compacted = await compactMessages({ messages: this.messages, profile, apiKey: key, adapter, signal, tools: this.executor.definitions });
    this.messages = this.clean(compacted); this.calibration = 1; this.snapshot.estimated = true; this.snapshot.compactPending = false; this.rebudget(); this.warned = this.snapshot.contextPercent >= 75;
    this.entry('system', '上下文压缩完成：' + before.toFixed(1) + '% → ' + this.snapshot.contextPercent.toFixed(1) + '%，原始记录已保留'); await this.persist(); this.emit();
  }
  async close(): Promise<void> { this.closing = true; this.cancel(); try { await this.busy; await this.initialized; } finally { await this.store.close(); } }
}
