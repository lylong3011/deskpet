// 免安装版打包：把 Electron 运行时 + 应用文件组装成可直接双击运行的目录
// 用法: node scripts/pack-dir.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'DeskPet-win32-x64');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  console.error('未找到 Electron 运行时，请先安装 electron 依赖');
  process.exit(1);
}

console.log('清理输出目录…');
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

console.log('复制 Electron 运行时…');
copyDir(ELECTRON_DIST, OUT);
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'DeskPet.exe'));

console.log('复制应用文件…');
const appDir = path.join(OUT, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const dir of ['electron', 'renderer', 'assets']) {
  copyDir(path.join(ROOT, dir), path.join(appDir, dir));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const slim = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  author: pkg.author,
  license: pkg.license,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(slim, null, 2), 'utf8');

// portable 版把数据放在 exe 同级 data 目录（main.js 未强制，这里留一个提示文件）
fs.writeFileSync(
  path.join(OUT, '使用说明.txt'),
  '双击 DeskPet.exe 即可运行。\r\n如需彻底卸载，删除整个文件夹即可。\r\n用户数据保存在：%APPDATA%\\deskpet\r\n',
  'utf8'
);

const size = require('node:child_process')
  .execSync(`powershell -NoProfile -Command "(Get-ChildItem -Recurse '${OUT.replace(/'/g, "''")}' | Measure-Object -Property Length -Sum).Sum"`)
  .toString()
  .trim();

console.log(`完成：${OUT}`);
console.log(`体积约 ${(Number(size) / 1024 / 1024).toFixed(1)} MB`);
console.log(`入口：${path.join(OUT, 'DeskPet.exe')}`);
