import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A code block with a one-click Copy button, so drafted prompts, skills and
// code can be copied whole.
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          const text = ref.current?.innerText.replace(/\n$/, '') ?? ''
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-2 right-2 rounded-full border border-forge-700 bg-forge-850 px-2.5 py-0.5 text-[11px] text-ash-400 hover:text-ash-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre ref={ref} className="pt-10">
        {children}
      </pre>
    </div>
  )
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
