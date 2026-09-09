import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { memo, useEffect, useRef, useState, type ComponentProps } from "react";

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

interface MarkdownProps {
  content: string;
  defer?: boolean;
  deferDelayMs?: number;
  onDeferredRender?: () => void;
}

export const Markdown = memo(function Markdown({
  content,
  defer = false,
  deferDelayMs = 0,
  onDeferredRender,
}: MarkdownProps) {
  const [readyContent, setReadyContent] = useState<string | null>(() =>
    defer ? null : content,
  );
  const onDeferredRenderRef = useRef(onDeferredRender);
  const notifiedContentRef = useRef<string | null>(null);
  onDeferredRenderRef.current = onDeferredRender;

  useEffect(() => {
    if (!defer) {
      setReadyContent(content);
      return;
    }

    setReadyContent(null);
    return scheduleDeferredRender(() => {
      setReadyContent(content);
    }, deferDelayMs);
  }, [content, defer, deferDelayMs]);

  const isReady = !defer || readyContent === content;

  useEffect(() => {
    if (!defer || !isReady || notifiedContentRef.current === content) return;
    notifiedContentRef.current = content;
    onDeferredRenderRef.current?.();
  }, [content, defer, isReady]);

  if (!isReady) {
    return <MarkdownPreview content={content} />;
  }

  return <MarkdownContent content={content} />;
}, areMarkdownPropsEqual);

const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
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
});

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="md-content whitespace-pre-wrap break-words text-text" aria-busy="true">
      {content}
    </div>
  );
}

function areMarkdownPropsEqual(previous: MarkdownProps, next: MarkdownProps) {
  return (
    previous.content === next.content &&
    (previous.defer ?? false) === (next.defer ?? false) &&
    (previous.deferDelayMs ?? 0) === (next.deferDelayMs ?? 0)
  );
}

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleDeferredRender(callback: () => void, delayMs: number) {
  const idleWindow = window as IdleWindow;
  let cancelled = false;
  let idleHandle: number | null = null;
  let fallbackHandle: number | null = null;

  const delayHandle = window.setTimeout(() => {
    if (cancelled) return;

    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(
        () => {
          idleHandle = null;
          if (!cancelled) callback();
        },
        { timeout: 600 },
      );
      return;
    }

    fallbackHandle = window.setTimeout(() => {
      fallbackHandle = null;
      if (!cancelled) callback();
    }, 0);
  }, Math.max(0, delayMs));

  return () => {
    cancelled = true;
    window.clearTimeout(delayHandle);
    if (idleHandle !== null && typeof idleWindow.cancelIdleCallback === "function") {
      idleWindow.cancelIdleCallback(idleHandle);
    }
    if (fallbackHandle !== null) {
      window.clearTimeout(fallbackHandle);
    }
  };
}
