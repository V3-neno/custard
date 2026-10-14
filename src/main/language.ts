// Whether a summary is in a writing system the user never used. A cheaper
// summary model sometimes answers in its own default language (DeepSeek's
// wrote chat notes in Chinese for chats held in English), so a chat note in
// a script that is nowhere in the user's own messages is written again.
// Scripts only: it can't tell English from Swedish, which share one.

const SCRIPTS: [string, RegExp][] = [
  ['Chinese or Japanese', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['Korean', /\p{Script=Hangul}/gu],
  ['Cyrillic', /\p{Script=Cyrillic}/gu],
  ['Arabic', /\p{Script=Arabic}/gu],
  ['Hebrew', /\p{Script=Hebrew}/gu],
  ['Greek', /\p{Script=Greek}/gu],
  ['Thai', /\p{Script=Thai}/gu],
  ['Devanagari', /\p{Script=Devanagari}/gu]
]
// A few stray characters (a quoted name, a symbol) don't count.
const MIN = 3

// The script the summary uses that the user's text never does, or null.
export function foreignScript(userText: string, summary: string): string | null {
  for (const [name, re] of SCRIPTS) {
    const inSummary = summary.match(re)?.length ?? 0
    if (inSummary >= MIN && !re.test(userText)) return name
    re.lastIndex = 0
  }
  return null
}
