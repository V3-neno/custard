import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
