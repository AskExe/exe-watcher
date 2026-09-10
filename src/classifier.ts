import type { ClassifiedTurn, ParsedTurn, TaskCategory } from './types.js'

const TEST_PATTERNS = /\b(test|pytest|vitest|jest|mocha|spec|coverage|npm\s+test|npx\s+vitest|npx\s+jest)\b/i
const GIT_PATTERNS = /\bgit\s+(push|pull|commit|merge|rebase|checkout|branch|stash|log|diff|status|add|reset|cherry-pick|tag)\b/i
const BUILD_PATTERNS = /\b(npm\s+run\s+build|npm\s+publish|pip\s+install|docker|deploy|make\s+build|npm\s+run\s+dev|npm\s+start|pm2|systemctl|brew|cargo\s+build)\b/i
const INSTALL_PATTERNS = /\b(npm\s+install|pip\s+install|brew\s+install|apt\s+install|cargo\s+add)\b/i

const DEBUG_KEYWORDS = /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|status\s+code|404|500|401|403)\b/i
const FEATURE_KEYWORDS = /\b(add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the))\b/i
const REFACTOR_KEYWORDS = /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i
const BRAINSTORM_KEYWORDS = /\b(brainstorm|idea|what\s+if|explore|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend)\b/i
const RESEARCH_KEYWORDS = /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare)\b/i

const FILE_PATTERNS = /\.(py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh|go|rs|java|rb|php|css|html|md|csv|xml)\b/i
const SCRIPT_PATTERNS = /\b(run\s+\S+\.\w+|execute|scrip?t|curl|api\s+\S+|endpoint|request\s+url|fetch\s+\S+|query|database|db\s+\S+)\b/i
const URL_PATTERN = /https?:\/\/\S+/i

const MESSAGE_PATTERNS = [TEST_PATTERNS, GIT_PATTERNS, BUILD_PATTERNS, INSTALL_PATTERNS,
  DEBUG_KEYWORDS, FEATURE_KEYWORDS, REFACTOR_KEYWORDS, BRAINSTORM_KEYWORDS,
  RESEARCH_KEYWORDS, FILE_PATTERNS, SCRIPT_PATTERNS, URL_PATTERN]

/** Preserve every classifier signal from the full prompt without retaining megabytes
 * of agent instructions in every cached turn. Prefix is for display only. */
export function compactUserMessage(text: string, signals?: number): { userMessage: string; userMessageSignals: number } {
  return {
    userMessage: Buffer.from(text.slice(0, 512)).toString('utf8'),
    userMessageSignals: signals ?? MESSAGE_PATTERNS.reduce((mask, pattern, index) => mask | (pattern.test(text) ? 1 << index : 0), 0),
  }
}
function messageMatches(turn: ParsedTurn, pattern: RegExp): boolean {
  return turn.userMessageSignals === undefined ? pattern.test(turn.userMessage)
    : (turn.userMessageSignals & (1 << MESSAGE_PATTERNS.indexOf(pattern))) !== 0
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit', 'cursor:edit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
export const BASH_TOOLS = new Set(['Bash', 'BashTool', 'PowerShellTool'])
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TodoWrite'])
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'ToolSearch'])

function hasEditTools(tools: string[]): boolean {
  return tools.some(t => EDIT_TOOLS.has(t))
}

function hasReadTools(tools: string[]): boolean {
  return tools.some(t => READ_TOOLS.has(t))
}

function hasBashTool(tools: string[]): boolean {
  return tools.some(t => BASH_TOOLS.has(t))
}

function hasTaskTools(tools: string[]): boolean {
  return tools.some(t => TASK_TOOLS.has(t))
}

function hasSearchTools(tools: string[]): boolean {
  return tools.some(t => SEARCH_TOOLS.has(t))
}

function hasMcpTools(tools: string[]): boolean {
  return tools.some(t => t.startsWith('mcp__'))
}

function hasSkillTool(tools: string[]): boolean {
  return tools.some(t => t === 'Skill')
}

function getAllTools(turn: ParsedTurn): string[] {
  return turn.assistantCalls.flatMap(c => c.tools)
}

function classifyByToolPattern(turn: ParsedTurn): TaskCategory | null {
  const tools = getAllTools(turn)
  if (tools.length === 0) return null

  if (turn.assistantCalls.some(c => c.hasPlanMode)) return 'planning'
  if (turn.assistantCalls.some(c => c.hasAgentSpawn)) return 'planning'

  const hasEdits = hasEditTools(tools)
  const hasReads = hasReadTools(tools)
  const hasBash = hasBashTool(tools)
  const hasTasks = hasTaskTools(tools)
  const hasSearch = hasSearchTools(tools)
  const hasMcp = hasMcpTools(tools)
  const hasSkill = hasSkillTool(tools)

  if (hasBash && !hasEdits) {
    if (messageMatches(turn, TEST_PATTERNS)) return 'testing'
    if (messageMatches(turn, GIT_PATTERNS)) return 'devops'
    if (messageMatches(turn, BUILD_PATTERNS)) return 'devops'
    if (messageMatches(turn, INSTALL_PATTERNS)) return 'devops'
  }

  if (hasEdits) return 'building'

  if (hasBash && hasReads) return 'research'
  if (hasBash) return 'building'

  if (hasSearch || hasMcp) return 'research'
  if (hasReads && !hasEdits) return 'research'
  if (hasTasks && !hasEdits) return 'planning'
  if (hasSkill) return 'building'

  return null
}

function refineByKeywords(category: TaskCategory, turn: ParsedTurn): TaskCategory {
  if (category === 'building') {
    if (messageMatches(turn, DEBUG_KEYWORDS)) return 'debugging'
    return 'building'
  }

  if (category === 'research') {
    if (messageMatches(turn, DEBUG_KEYWORDS)) return 'debugging'
    return 'research'
  }

  return category
}

function classifyConversation(turn: ParsedTurn): TaskCategory {
  if (messageMatches(turn, BRAINSTORM_KEYWORDS)) return 'research'
  if (messageMatches(turn, RESEARCH_KEYWORDS)) return 'research'
  if (messageMatches(turn, DEBUG_KEYWORDS)) return 'debugging'
  if (messageMatches(turn, FEATURE_KEYWORDS)) return 'building'
  if (messageMatches(turn, FILE_PATTERNS)) return 'building'
  if (messageMatches(turn, SCRIPT_PATTERNS)) return 'building'
  if (messageMatches(turn, URL_PATTERN)) return 'research'
  return 'research'
}

function countRetries(turn: ParsedTurn): number {
  let sawEditBeforeBash = false
  let sawBashAfterEdit = false
  let retries = 0

  for (const call of turn.assistantCalls) {
    const hasEdit = call.tools.some(t => EDIT_TOOLS.has(t))
    const hasBash = call.tools.some(t => BASH_TOOLS.has(t))

    if (hasEdit) {
      if (sawBashAfterEdit) retries++
      sawEditBeforeBash = true
      sawBashAfterEdit = false
    }
    if (hasBash && sawEditBeforeBash) {
      sawBashAfterEdit = true
    }
  }

  return retries
}

function turnHasEdits(turn: ParsedTurn): boolean {
  return turn.assistantCalls.some(c => c.tools.some(t => EDIT_TOOLS.has(t)))
}

export function classifyTurn(turn: ParsedTurn): ClassifiedTurn {
  const tools = getAllTools(turn)

  let category: TaskCategory

  if (tools.length === 0) {
    category = classifyConversation(turn)
  } else {
    const toolCategory = classifyByToolPattern(turn)
    if (toolCategory) {
      category = refineByKeywords(toolCategory, turn)
    } else {
      category = classifyConversation(turn)
    }
  }

  return { ...turn, category, retries: countRetries(turn), hasEdits: turnHasEdits(turn) }
}
