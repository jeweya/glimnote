/**
 * 插入代码块时的语言清单与格式化。
 *
 * 格式化用 Prettier 的浏览器版：体积不小，所以只在用户真的点了「格式化」时才按语言懒加载，
 * 平时打开笔记不受影响。Prettier 覆盖不到的语言（Python / Java / SQL…）退化成「整理空白」，
 * 至少把粘贴时常带的缩进混乱、行尾空格和多余空行处理干净。
 */

export interface CodeLanguage {
  /** 下拉框里的取值 */
  id: string;
  /** 中文名 */
  label: string;
  /** 写进 ``` 后面的语言标记 */
  fence: string;
  /** 有值表示可以用 Prettier 精排 */
  parser?: string;
  /** 需要哪些 Prettier 插件 */
  plugins?: string[];
}

export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'text', label: '纯文本', fence: 'text' },
  {
    id: 'js',
    label: 'JavaScript',
    fence: 'js',
    parser: 'babel',
    plugins: ['babel', 'estree'],
  },
  {
    id: 'ts',
    label: 'TypeScript',
    fence: 'ts',
    parser: 'typescript',
    plugins: ['typescript', 'estree'],
  },
  {
    id: 'jsx',
    label: 'React (JSX)',
    fence: 'jsx',
    parser: 'babel',
    plugins: ['babel', 'estree'],
  },
  { id: 'json', label: 'JSON', fence: 'json', parser: 'json', plugins: ['babel', 'estree'] },
  { id: 'html', label: 'HTML', fence: 'html', parser: 'html', plugins: ['html', 'estree'] },
  { id: 'vue', label: 'Vue', fence: 'vue', parser: 'vue', plugins: ['html', 'estree'] },
  { id: 'css', label: 'CSS', fence: 'css', parser: 'css', plugins: ['postcss'] },
  { id: 'scss', label: 'SCSS', fence: 'scss', parser: 'scss', plugins: ['postcss'] },
  {
    id: 'md',
    label: 'Markdown',
    fence: 'md',
    parser: 'markdown',
    plugins: ['markdown', 'estree', 'babel', 'postcss'],
  },
  { id: 'yaml', label: 'YAML', fence: 'yaml', parser: 'yaml', plugins: ['yaml'] },
  { id: 'python', label: 'Python', fence: 'python' },
  { id: 'java', label: 'Java', fence: 'java' },
  { id: 'go', label: 'Go', fence: 'go' },
  { id: 'rust', label: 'Rust', fence: 'rust' },
  { id: 'c', label: 'C / C++', fence: 'c' },
  { id: 'csharp', label: 'C#', fence: 'csharp' },
  { id: 'sql', label: 'SQL', fence: 'sql' },
  { id: 'shell', label: 'Shell', fence: 'bash' },
  { id: 'other', label: '其它', fence: '' },
];

export function findLanguage(id: string) {
  return CODE_LANGUAGES.find((l) => l.id === id) || CODE_LANGUAGES[0];
}

/** 这个语言能不能精排（否则只做空白整理） */
export function canPrettify(id: string) {
  return Boolean(findLanguage(id).parser);
}

/** 每个 plugin 单独动态 import，Vite 才能按需拆包：没点格式化就不会下载 */
function loadPlugins(names: string[]): Promise<unknown>[] {
  return names.map((name) => {
    switch (name) {
      case 'babel':
        return import('prettier/plugins/babel');
      case 'typescript':
        return import('prettier/plugins/typescript');
      case 'estree':
        return import('prettier/plugins/estree');
      case 'html':
        return import('prettier/plugins/html');
      case 'postcss':
        return import('prettier/plugins/postcss');
      case 'markdown':
        return import('prettier/plugins/markdown');
      case 'yaml':
        return import('prettier/plugins/yaml');
      default:
        return Promise.resolve(null);
    }
  });
}

/**
 * 统一换行、去掉行尾空格、连续空行压成一行。
 * 行首的 Tab 按两个空格展开（Python 这类靠缩进的语言也至少看起来一致）。
 */
export function tidyCode(raw: string, indent = 2) {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^\t+/, (tabs) => ' '.repeat(indent * tabs.length)));

  const out: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (!line.trim()) {
      blank += 1;
      if (blank > 1) continue;
      out.push('');
      continue;
    }
    blank = 0;
    out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

export interface FormatResult {
  code: string;
  /** prettier = 精排；tidy = 只整理了空白 */
  mode: 'prettier' | 'tidy';
}

/** 格式化一段代码。语法有问题时抛错，调用方负责提示用户。 */
export async function formatCode(raw: string, languageId: string): Promise<FormatResult> {
  const source = raw.replace(/\r\n?/g, '\n');
  const lang = findLanguage(languageId);
  if (!lang.parser || !lang.plugins) {
    // Python 习惯四空格缩进，其它语言两空格
    return { code: tidyCode(source, languageId === 'python' ? 4 : 2), mode: 'tidy' };
  }

  const [{ format }, ...plugins] = await Promise.all([import('prettier/standalone'), ...loadPlugins(lang.plugins)]);
  const text = await format(source, {
    parser: lang.parser,
    plugins: plugins.filter(Boolean) as never[],
    printWidth: 90,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: 'all',
    proseWrap: 'preserve',
  } as never);
  return { code: text.replace(/\n+$/, ''), mode: 'prettier' };
}
