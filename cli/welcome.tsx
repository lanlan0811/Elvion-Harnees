import React from 'react';
import { readFileSync } from 'node:fs';
import { Box, Text } from 'ink';

export const theme = { background: '#050B14', card: '#0B1422', text: '#DCE6FF', muted: '#9AAED1', border: '#536DAB', accent: '#8EBFFF', success: '#4DE0AB', warning: '#F0C36B', error: '#F08080' };
const load = (name: string) => readFileSync(new URL(`../assets/brand/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
export const foxLarge = load('elvion-fox-large');
export const foxSmall = load('elvion-fox-small');
export const wordmark = load('elvion-wordmark');
export function welcomeLayout(columns: number, rows: number): 'large' | 'compact' | 'stacked' | 'minimal' | 'too-small' {
  if (columns < 60 || rows < 18) return 'too-small';
  if (columns >= 140 && rows >= 42) return 'large';
  if (columns >= 100 && rows >= 34) return 'compact';
  if (columns >= 80 && rows >= 24) return 'stacked';
  return 'minimal';
}
function gradient(position: number, total: number): string {
  const t = position / Math.max(1, total - 1);
  return '#' + [167 + (68 - 167) * t, 139 + (215 - 139) * t, 250 + (238 - 250) * t].map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
}
export function BrandArt({ lines }: { lines: string[] }): React.JSX.Element {
  const width = Math.max(...lines.map(line => Array.from(line).length));
  return <Box flexDirection="column">{lines.map((line, row) => <Text key={row}>{Array.from(line).map((char, col) => <Text key={col} color={gradient(col, width)}>{char}</Text>)}</Text>)}</Box>;
}
export interface WelcomeProps { columns: number; rows: number; bashAvailable: boolean; bashError?: string; providerConfigured: boolean; toolsReady?: boolean }
export function Welcome({ columns, rows, bashAvailable, bashError, providerConfigured, toolsReady = true }: WelcomeProps): React.JSX.Element {
  const layout = welcomeLayout(columns, rows); const horizontal = layout === 'large' || layout === 'compact';
  if (layout === 'too-small') return <Text color={theme.warning}>窗口过小，请扩大至至少 60 列 × 18 行。Ctrl+C 退出。</Text>;
  const statusWidth = layout === 'large' ? Math.min(67, columns - 83) : layout === 'compact' ? Math.min(48, columns - 50) : Math.min(columns - 8, 65);
  const status = <Box width={statusWidth} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={layout === 'minimal' ? 0 : 1}>
    <Status label="运行时" value="就绪" ok />
    <Status label="执行环境" value={bashAvailable ? '可用' : '不可用'} ok={bashAvailable} />
    <Status label="工具" value={toolsReady ? '已初始化' : '初始化失败'} ok={toolsReady} />
    <Status label="Provider" value={providerConfigured ? '已配置' : '未配置'} ok={providerConfigured} />
    {layout !== 'minimal' && <><Text color={theme.border}>{'─'.repeat(Math.max(1, statusWidth - 4))}</Text><Text color={theme.muted}>Let's turn your ideas into reality.</Text></>}
  </Box>;
  return <Box flexDirection="column" width={Math.max(1, columns - 4)} flexGrow={1}>
    <Box justifyContent="flex-end"><Text color={theme.muted}>ELVION CLI v0.1.0</Text></Box>
    <Box flexDirection={horizontal ? 'row' : 'column'} alignItems={horizontal ? 'center' : 'flex-start'} justifyContent={horizontal ? 'space-between' : 'flex-start'} marginTop={layout === 'large' ? 2 : 1} flexGrow={1}>
      {horizontal && <Box width={layout === 'large' ? 74 : 46} flexShrink={0}><BrandArt lines={layout === 'large' ? foxLarge : foxSmall} /></Box>}
      <Box flexDirection="column" width={statusWidth}>
        {layout === 'large' ? <BrandArt lines={statusWidth < 65 ? wordmark.map(line => Array.from(line).filter((_, index) => index % 2 === 0).join('')) : wordmark} /> : <Text color={theme.accent} bold>ELVION</Text>}
        {layout !== 'minimal' && <Box marginTop={1} marginBottom={1}><Text color={theme.muted}>Your Partner in Action.</Text></Box>}
        {status}
        {!bashAvailable && <Text color={theme.error} wrap="wrap">{bashError ?? 'Bash 初始化失败'}；运行 elvion doctor 查看。</Text>}
        {!providerConfigured && <Text color={theme.warning}>输入 /provider 配置供应商与模型。</Text>}
      </Box>
    </Box>
  </Box>;
}
function Status({ label, value, ok }: { label: string; value: string; ok: boolean }): React.JSX.Element {
  return <Box justifyContent="space-between"><Text color={theme.muted}>{label}</Text><Text color={ok ? theme.success : theme.warning}>{value}</Text></Box>;
}
