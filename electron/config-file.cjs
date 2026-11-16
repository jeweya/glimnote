/**
 * 同步配置的落盘（docs/05）。
 *
 * localStorage 是按「来源」隔离的：开发版跑在 http://localhost:5174，安装版
 * 加载的是 file://，Chromium 把两者当成两个站点，各存一份。结果就是同一台
 * 机器上开发版同步正常、装完之后却提示「还没配置 Git」。
 *
 * 这里把配置放到 userData 下的普通 JSON，两个版本读同一份；文件里只有平台、
 * 用户名、仓库名、分支，没有令牌——令牌仍然由 credentials.cjs 用系统密钥加密。
 */
const path = require('node:path');
const fsp = require('node:fs/promises');

function createConfigStore({ dir, log = () => {} }) {
  const file = path.join(dir, 'git-config.json');

  /** 读取配置；文件不存在、解析失败都当作「没配置」，不让坏文件卡住启动 */
  async function read() {
    try {
      const text = await fsp.readFile(file, 'utf8');
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') return null;
      if (!('cfg' in data)) return null;
      // cfg 为 null 表示用户主动断开了同步：这是「墓碑」，不能当成没配置
      // 否则另一个客户端（比如开发版）会把自己的旧配置又迁回来
      const cfg = data.cfg && typeof data.cfg === 'object' ? data.cfg : null;
      return { cfg, login: typeof data.login === 'string' ? data.login : '' };
    } catch (e) {
      if (e && e.code !== 'ENOENT') log('warn', `读取同步配置失败：${(e && e.message) || e}`);
      return null;
    }
  }

  /** 写入配置；传 null 表示断开同步，写一个 cfg:null 的墓碑而不是删文件 */
  async function write(data) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      const cfg = data && data.cfg ? data.cfg : null;
      const login = data && typeof data.login === 'string' ? data.login : '';
      const payload = JSON.stringify({ v: 1, cfg, login }, null, 2);
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, payload, { mode: 0o600 });
      await fsp.rename(tmp, file);
      return true;
    } catch (e) {
      log('error', `保存同步配置失败：${(e && e.message) || e}`);
      return false;
    }
  }

  return { read, write, file };
}

module.exports = { createConfigStore };
