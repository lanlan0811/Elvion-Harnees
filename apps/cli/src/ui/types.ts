import type { PermissionMode } from '@elvion/kernel';

export interface BrandAssets { largeFox: string; smallFox: string; wordmark: string }
export interface HealthStatus { state: 'ok' | 'warning' | 'error' | 'pending'; label: string }
export interface UiHealth { runtime: HealthStatus; execution: HealthStatus; tools: HealthStatus }
export type SlashCommand = 'provider' | 'model' | 'permissions' | 'sessions' | 'resume' | 'new' | 'help';
export interface UiMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'task' | 'usage' | 'system' | 'verification' | 'error' | 'diff' | 'report';
  text: string;
  title?: string;
  status?: string;
}
export interface UiApproval { id: string; tool: string; arguments: unknown; cwd: string; scope: string }
export interface UiOverlay { title: string; lines: string[] }
export interface ElvionAppProps {
  version: string;
  assets: BrandAssets;
  health: UiHealth;
  permissionMode: PermissionMode;
  messages: readonly UiMessage[];
  busy: boolean;
  model?: string;
  workspace: string;
  approval?: UiApproval;
  overlay?: UiOverlay;
  onSubmit(text: string): void | Promise<void>;
  onCommand(command: SlashCommand, args: string): void | Promise<void>;
  onCancel(): void;
  onApproval(id: string, approved: boolean): void;
  onExit?(): void;
  onCloseOverlay?(): void;
}
