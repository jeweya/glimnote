import { importText } from './repo';

export async function importMarkdownFiles(files: File[], notebook: string) {
  let count = 0;
  for (const file of files) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) continue;
    try {
      const text = await file.text();
      await importText(file.name, text, notebook || 'inbox');
      count += 1;
    } catch {
      /* 跳过无法读取的文件 */
    }
  }
  return count;
}
