import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders assistant text as GitHub-flavored markdown. Styling lives in the
// `.md` block in index.css. Links open in a new tab.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
