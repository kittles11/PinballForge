// 一次性补丁②：here 系自检的仓库根锚点提升（迁移 tools/selfchecks/ 后 here 少了两级）
import { readFileSync, writeFileSync } from 'fs';
const files = ['deck-view', 'launcher-stuck', 'peg-layouts', 'peg-position', 'peg-soft-reset', 'wave-watchdog', 'icon-ui'];
for (const f of files) {
    const p = `tools/selfchecks/selfcheck-${f}.ts`;
    const before = readFileSync(p, 'utf8');
    const after = before
        .replace(
            /const here = dirname\(fileURLToPath\(import\.meta\.url\)\);/,
            "const here = dirname(fileURLToPath(import.meta.url));\n// Task 005: 自检已迁至 tools/selfchecks/，仓库根锚点从 here 上提两级\nconst REPO_ROOT = join(here, '..', '..');",
        )
        .replace(/join\(here, 'assets'/g, "join(REPO_ROOT, 'assets'")
        .replace(/join\(here, \.\.\.p\)/g, 'join(REPO_ROOT, ...p)');
    writeFileSync(p, after === before ? before : after);
    console.log(after === before ? 'NO CHANGE:' : 'patched:', f);
}
