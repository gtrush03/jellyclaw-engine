import { useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { highlight } from '@/lib/shiki';
import { cn } from '@/lib/cn';
import { CopyButton } from './CopyButton';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const components: Components = {
    h1: ({ children, ...p }) => (
      <h1 {...p}>{children}</h1>
    ),
    h2: ({ children, ...p }) => (
      <h2 {...p}>{children}</h2>
    ),
    h3: ({ children, ...p }) => (
      <h3 {...p}>{children}</h3>
    ),
    a: ({ href, children, ...p }) => (
      <a href={href} target="_blank" rel="noreferrer" {...p}>
        {children}
      </a>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className: cls, children, ...rest }) => {
      const codeStr = String(children ?? '').replace(/\n$/, '');
      const match = /language-([\w-]+)/.exec(cls ?? '');
      const isBlock = !!match || codeStr.includes('\n');
      if (!isBlock) {
        return (
          <code className={cls} {...rest}>
            {children}
          </code>
        );
      }
      const lang = match?.[1] ?? 'markdown';
      return <ShikiCode code={codeStr} lang={lang} />;
    },
  };

  // Transform HTML comments to subtle callout divs via simple preprocessing
  // We wrap them as raw HTML spans rehype-raw will keep them intact.
  const prepared = content.replace(
    /<!--\s*([\s\S]*?)\s*-->/g,
    (_m, inner) => `<div class="html-comment">${String(inner).replace(/</g, '&lt;')}</div>`,
  );

  return (
    <div className={cn('prose-gold text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

interface ShikiCodeProps {
  code: string;
  lang: string;
}

function ShikiCode({ code, lang }: ShikiCodeProps): ReactNode {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang)
      .then((out) => {
        if (!cancelled) setHtml(out);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="my-4 rounded-lg border hairline bg-[color:var(--color-gold-faint)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b hairline">
        <span className="font-mono text-[10px] tracking-wider text-[color:var(--color-text-muted)] uppercase">
          {lang}
        </span>
        <CopyButton text={code} variant="inline" size="sm" label="Copy" />
      </div>
      <div className="p-3 overflow-x-auto shiki-wrapper">
        {error ? (
          <pre className="font-mono text-xs text-[color:var(--color-danger)]">{error}</pre>
        ) : html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="font-mono text-xs text-[color:var(--color-text)] opacity-60">{code}</pre>
        )}
      </div>
    </div>
  );
}
