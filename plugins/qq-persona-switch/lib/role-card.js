// 人格卡的解析与「按仿真模式取用」——**从 qq-bridge 的 src/role-card.js 原样搬来的**。
//
// 为什么要搬：插件要按对话注入人格卡正文，而桥接只在**全局**注入一份。要让
// 「A 群用小鲸鱼、B 群用傲娇助手」在桥上生效，只能由插件自己渲染正文；渲染规则
// 必须与桥接逐字一致，否则同一条卡片在两处会呈现成两套内容（模式标记被当正文、
// 〔一代〕专属指令漏进二代提示词）。
//
// 上游文件：qq-bridge/src/role-card.js（MIT，Derpyu520/qq-bridge）。搬过来之后
// 两边各有一份，**桥接改了这里不会跟着变**——所以 test/per-chat.test.js 里有一组
// 与上游同源的用例，专门盯住「模式标记怎么算、哪一行算一代指令」。
//
// 与桥接的差异只有一处：桥接还有 convertExampleSpacesToComma()（把示例里的
// 「空格分条」改写成「逗号停顿」）。那属于措辞润色，不影响注入哪些小节，插件不抄。
export const ROLE_INJECT_MODES = ['v1', 'v2']

const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
]

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0
    if (tag.re.test(heading)) return tag.mode
  }
  return 'all'
}

function stripModeTags(heading) {
  let out = String(heading)
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0
    out = out.replace(tag.re, '')
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim()
}

export function parseRoleSections(text) {
  const sections = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] }
        sections.push(current)
      }
      current.lines.push(line)
      continue
    }
    const title = stripModeTags(heading[2])
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] }
    sections.push(current)
  }
  return sections
}

export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2'
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function roleCharStats(text) {
  const source = String(text ?? '')
  const sections = parseRoleSections(source)
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0)
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  }
}

export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i