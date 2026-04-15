import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type ThemeRegistrationRaw,
} from 'shiki';

// Obsidian & Gold — a warm dark theme built for the dashboard
export const obsidianGoldTheme: ThemeRegistrationRaw = {
  name: 'obsidian-gold',
  type: 'dark',
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#e8e6e1',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6b6760', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#b8a67f' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#d4a04a' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#928466', fontStyle: 'italic' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#d4a04a' } },
    { scope: ['entity.name.class', 'entity.name.type', 'support.class'], settings: { foreground: '#b8a67f' } },
    { scope: ['variable', 'variable.parameter', 'variable.other'], settings: { foreground: '#e8e6e1' } },
    { scope: ['variable.language'], settings: { foreground: '#928466', fontStyle: 'italic' } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: '#6b6760' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: '#b8a67f', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { foreground: '#e8e6e1', fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { foreground: '#e8e6e1', fontStyle: 'italic' } },
    { scope: ['markup.inline.raw', 'markup.fenced_code'], settings: { foreground: '#b8a67f' } },
    { scope: ['markup.list.unnumbered', 'markup.list.numbered'], settings: { foreground: '#928466' } },
    { scope: ['markup.quote'], settings: { foreground: '#6b6760', fontStyle: 'italic' } },
    { scope: ['markup.underline.link'], settings: { foreground: '#d4a04a' } },
    { scope: ['invalid'], settings: { foreground: '#c75454' } },
  ],
};

export const SUPPORTED_LANGS: BundledLanguage[] = [
  'markdown',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'bash',
  'shell',
  'json',
  'yaml',
  'rust',
  'swift',
  'python',
  'html',
  'css',
];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [obsidianGoldTheme],
      langs: SUPPORTED_LANGS,
    });
  }
  return highlighterPromise;
}

export async function highlight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const normalized = normalizeLang(lang);
  const loaded = hl.getLoadedLanguages();
  const use = loaded.includes(normalized as BundledLanguage) ? normalized : 'markdown';
  try {
    return hl.codeToHtml(code, { lang: use as BundledLanguage, theme: 'obsidian-gold' });
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

function normalizeLang(lang: string): string {
  const l = lang.trim().toLowerCase();
  switch (l) {
    case 'sh':
    case 'zsh':
      return 'bash';
    case 'ts':
      return 'typescript';
    case 'js':
      return 'javascript';
    case 'yml':
      return 'yaml';
    case 'md':
      return 'markdown';
    case 'py':
      return 'python';
    default:
      return l || 'markdown';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
