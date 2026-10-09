import { useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckIcon, CopyIcon } from './icons'

// Blocks taller than this start collapsed, with "Show more" under them.
const COLLAPSED_HEIGHT = 320

// A code block with a one-click Copy button, so drafted prompts, skills and
// code can be copied whole. Copy always takes the whole block, collapsed or not.
function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setLong(el.scrollHeight > COLLAPSED_HEIGHT + 40)
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    return () => resize.disconnect()
  }, [children])
  const collapsed = long && !open
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          const text = ref.current?.textContent?.replace(/\n$/, '') ?? ''
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-2.5 right-2.5 z-10 rounded-md p-1 text-[15px] text-ash-400 hover:bg-forge-800 hover:text-ash-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <pre
        ref={ref}
        data-collapsed={collapsed || undefined}
        className="pr-10"
        style={
          collapsed
            ? {
                maxHeight: COLLAPSED_HEIGHT,
                overflowY: 'hidden',
                maskImage: 'linear-gradient(to bottom, black 70%, transparent)'
              }
            : undefined
        }
      >
        {children}
      </pre>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
          className="mt-1.5 px-1 text-[13px] text-ash-400 hover:text-ash-100"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
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
