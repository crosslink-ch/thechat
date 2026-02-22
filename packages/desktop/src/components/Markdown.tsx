import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

const components: Components = {
  a: ({ children, ...props }) => (
    <a target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  pre: ({ children, ...props }) => (
    <pre className="md-code-block" {...props}>
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    // rehype-highlight adds className like "hljs language-js" for fenced blocks
    const isBlock = typeof className === "string" && className.includes("hljs");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="md-inline-code" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children, ...props }) => (
    <div className="md-table-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
