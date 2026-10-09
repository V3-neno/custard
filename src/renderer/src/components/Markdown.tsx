import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckIcon, CopyIcon } from './icons'

// A code block with a one-click Copy button, so drafted prompts, skills and
// code can be copied whole.
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          const text = ref.current?.innerText.replace(/\n$/, '') ?? ''
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-2.5 right-2.5 rounded-md p-1 text-[15px] text-ash-400 hover:bg-forge-800 hover:text-ash-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <pre ref={ref} className="pr-10">
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
