import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import type { ComponentProps } from "react";

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdown>;

const remarkPlugins: NonNullable<ReactMarkdownProps["remarkPlugins"]> = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];
const rehypePlugins: NonNullable<ReactMarkdownProps["rehypePlugins"]> = [
  rehypeKatex,
  rehypeHighlight,
];

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
      <code className="rounded border border-border bg-elevated px-[0.4em] py-[0.15em] font-mono text-[0.9em]" {...props}>
        {children}
      </code>
    );
  },
  table: ({ children, ...props }) => (
    <div className="my-2 overflow-x-auto">
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
