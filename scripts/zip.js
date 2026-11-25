// Buat zip source code untuk dibagikan / diupload ke web: release/<nama>-v<versi>.zip
//
//   npm run zip
//
// Isi zip diambil dari commit terakhir (git archive), jadi hanya file yang ada di repo yang ikut.
// .env, data/ (database & backup), assets/qris.jpg, node_modules/ dan file lain di .gitignore
// tidak mungkin ikut. Perubahan yang belum di-commit juga TIDAK ikut.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

process.chdir(path.join(import.meta.dirname, '..'));

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  console.error('❌ Folder ini bukan repo git (atau git belum terpasang). Zip dibuat dari commit git.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = pkg.name;
const version = pkg.version;

// Pengaman: tolak bila ada file rahasia yang ter-commit
const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
const forbidden = files.filter(
  (f) =>
    /(^|\/)\.env$/.test(f) ||
    f.startsWith('data/') ||
    f === 'assets/qris.jpg' ||
    /\.(zip|rar|7z|db|sqlite)$/i.test(f),
);
if (forbidden.length) {
  console.error('❌ File berikut tidak boleh ikut zip, tetapi ter-commit di repo:');
  for (const f of forbidden) console.error(`   - ${f}`);
  console.error('   Hapus dari git dulu (git rm --cached <file>), lalu commit.');
  process.exit(1);
}

const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) {
  console.warn('⚠️  Ada perubahan yang belum di-commit. Perubahan ini TIDAK ikut ke zip:');
  console.warn(dirty.replace(/^/gm, '   '));
  console.warn('');
}

const outDir = 'release';
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}-v${version}.zip`);

git('archive', '--format=zip', `--prefix=${name}/`, '-o', out, 'HEAD');

const commit = git('rev-parse', '--short', 'HEAD');
const tag = (() => {
  try {
    return git('describe', '--tags', '--exact-match', 'HEAD');
  } catch {
    return null;
  }
})();
const sizeKb = (fs.statSync(out).size / 1024).toFixed(0);

console.log(`✅ ${out} (${sizeKb} KB, ${files.length} file, commit ${commit})`);
if (!tag) {
  console.log(`ℹ️  Commit ini belum punya tag versi. Untuk rilis resmi: npm version patch|minor, lalu npm run zip.`);
}
