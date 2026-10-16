import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatCost, getCurrency } from './currency.js'
import { formatTokens } from './format.js'
import type { OptimizeResult } from './optimize.js'

type ShareContext = { periodLabel: string; projectFilter?: string[]; excludeFilter?: string[] }

// Pick a fence longer than any backticks in the fix, so file contents survive intact.
function codeBlock(content: string, language: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${content}\n${fence}`
}

export function formatOptimizeMarkdown(result: OptimizeResult, context: ShareContext, generatedAt = new Date()): string {
  const { findings, costRate, coverage } = result
  const totalTokens = findings.reduce((sum, finding) => sum + finding.tokensSaved, 0)
  const lines = [
    '# Exe Watcher optimizer recommendations', '',
    'Review these recommendations against the relevant projects and your Claude Code settings. Apply the appropriate fixes and explain what changed.', '',
    `Generated: ${generatedAt.toISOString()}`,
    `Period: ${context.periodLabel}`,
    'Provider: Claude Code',
    `Cost currency: ${getCurrency().code}`,
  ]
  if (context.projectFilter?.length) lines.push(`Included projects: ${context.projectFilter.join(', ')}`)
  if (context.excludeFilter?.length) lines.push(`Excluded projects: ${context.excludeFilter.join(', ')}`)
  lines.push('')
  if (coverage?.partial) {
    lines.push(`Partial analysis: ${coverage.completedFiles}/${coverage.totalFiles} logs fully checked; some records remain unchecked.`,
      'Cleanup suggestions requiring complete history and the overall health grade are omitted.', '')
  } else {
    lines.push(`Setup health: ${result.healthGrade} (${result.healthScore}/100).`, '')
  }
  lines.push(`Potential savings: ~${formatTokens(totalTokens)} tokens (~${formatCost(totalTokens * costRate)}).`,
    'Token and cost savings are estimates. Copying or saving does not apply any changes.', '')
  if (!findings.length) lines.push(coverage?.partial
    ? 'No recommendations in the checked records; unchecked history is unknown.'
    : 'No recommendations found for this period.', '')
  findings.forEach((finding, index) => {
    const action = finding.fix
    lines.push(`## ${index + 1}. ${finding.title}`, '',
      `Impact: ${finding.impact}${finding.trend === 'improving' ? ' · improving' : ''}`, '',
      finding.explanation, '',
      `Estimated savings: ~${formatTokens(finding.tokensSaved)} tokens (~${formatCost(finding.tokensSaved * costRate)}).`, '',
      '### Suggested fix', '', action.label, '')
    if (action.type === 'file-content') lines.push('File:', codeBlock(action.path, 'text'), '')
    lines.push(codeBlock(action.type === 'file-content' ? action.content : action.text, action.type === 'command' ? 'sh' : 'text'), '')
  })
  return lines.join('\n')
}

function sendToClipboard(command: string, args: string[], markdown: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Fixed commands only; recommendations go through stdin, never a shell.
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Clipboard timed out')) }, 3000)
    const fail = (error: Error) => { clearTimeout(timer); child.kill('SIGKILL'); reject(error) }
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('Clipboard unavailable'))
    })
    // Windows clip recognizes UTF-16 with a BOM; preserve non-ASCII fixes there too.
    child.stdin.end(process.platform === 'win32'
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(markdown, 'utf16le')])
      : Buffer.from(markdown, 'utf8'))
  })
}

export async function copyOptimizeMarkdown(markdown: string): Promise<void> {
  const commands: [string, string[]][] = process.platform === 'darwin' ? [['/usr/bin/pbcopy', []]]
    : process.platform === 'win32' ? [['clip.exe', []]]
      : process.platform === 'linux' ? [['wl-copy', ['--type', 'text/plain;charset=utf-8']], ['xclip', ['-selection', 'clipboard']]] : []
  for (const [command, args] of commands) {
    try { await sendToClipboard(command, args, markdown); return } catch { /* Try the next available clipboard. */ }
  }
  throw new Error('Could not copy. Press e to save a Markdown file instead.')
}

export async function saveOptimizeMarkdown(markdown: string, directory?: string): Promise<string> {
  const downloads = join(homedir(), 'Downloads')
  const folder = directory ?? ((await stat(downloads).catch(() => null))?.isDirectory() ? downloads : process.cwd())
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = resolve(folder, `exe-watcher-optimizer-${stamp}-${randomUUID().slice(0, 8)}.md`)
  // Private file, exclusive creation: never overwrite an existing file or symlink.
  await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return path
}
