export type Protocol = 'openai-responses' | 'openai-chat' | 'anthropic';
export type PermissionMode = 'ask' | 'edit' | 'full';
export interface ModelProfile {
  id: string; name: string; protocol: Protocol; baseUrl: string; model: string;
  apiKey?: string; contextWindow: number; maxOutputTokens: number;
  outputParameter?: 'max_tokens' | 'max_completion_tokens';
}
export interface AppConfig { version: 1; profiles: ModelProfile[]; activeProfileId?: string }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  toolCalls?: ToolCall[]; toolCallId?: string;
  providerData?: { profileId: string; protocol: Protocol; items: unknown[] };
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Usage { inputTokens: number; outputTokens: number; cachedTokens?: number }
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'provider-data'; items: unknown[] }
  | { type: 'done'; reason: string };
export interface ProviderRequest {
  profile: ModelProfile; apiKey: string; messages: Message[]; tools: ToolDefinition[];
  maxOutputTokens: number; signal: AbortSignal;
}
export interface ProviderAdapter { stream(request: ProviderRequest): AsyncIterable<ProviderEvent> }
export interface ToolResult { content: string; isError?: boolean; metadata?: Record<string, unknown> }
export interface ApprovalRequest { id: string; tool: string; title: string; details: string; paths?: string[] }
export interface UserQuestion { id: string; question: string; options?: string[] }
export interface ToolContext {
  cwd: string; workspace: string; permission: PermissionMode; signal: AbortSignal;
  approve(request: ApprovalRequest): Promise<boolean>;
  ask(question: UserQuestion): Promise<string | null>;
  onOutput(text: string): void; setTodos(todos: TodoItem[]): void;
  secrets: string[]; sessionDir: string;
}
export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface ToolExecutor { definitions: ToolDefinition[]; execute(call: ToolCall, context: ToolContext): Promise<ToolResult> }
export type RuntimeStatus = 'idle' | 'requesting' | 'approving' | 'executing' | 'answering' | 'compacting' | 'cancelled' | 'failed';
export interface TranscriptEntry {
  id: string; kind: 'user' | 'assistant' | 'tool' | 'system'; content: string; timestamp: string;
  toolName?: string; toolCall?: ToolCall; status?: string; output?: string; metadata?: Record<string, unknown>;
}
export interface RuntimeSnapshot {
  sessionId: string; title: string; cwd: string; status: RuntimeStatus; permission: PermissionMode;
  entries: TranscriptEntry[]; profile?: ModelProfile; pendingProfile?: ModelProfile;
  contextPercent: number; estimated: boolean; approval?: ApprovalRequest; question?: UserQuestion;
  todos: TodoItem[]; error?: string; restored: boolean; compactPending: boolean;
}
export interface SessionInfo { id: string; title: string; cwd: string; createdAt: string; updatedAt: string; locked: boolean }
