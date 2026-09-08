/**
 * 编码规范自检（纯 Node，无引擎依赖）——校验 assets/scripts 全部 .ts 是否符合项目编码规范：
 *   node --experimental-transform-types selfcheck-code-standards.ts
 *
 * 规则 1  单文件单组件：每个文件最多 1 个 @ccclass 组件类（数据 / 管理器为纯类，不挂组件）；
 * 规则 1b @ccclass 名全局唯一（Cocos 类系统按名注册，重名会互相覆盖）；
 * 规则 3  导入规范：统一 `import { ... } from 'cc'` 且装饰器解构使用，禁止 _decorator.xxx 内联；
 * 规则 4  无运行时循环引用：项目内模块 import 图无环
 *         （import type 为编译期擦除的类型边，不计入运行时依赖）；
 * 规则 5  @property 禁用 null! 非空断言：必须 `T | null = null` 并在用前判空，
 *         否则「场景未接线」在类型系统里隐身、运行时才炸（本规则此前只写在 .clinerules、无机器校验）。
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';

const ROOT = resolve(process.cwd(), 'assets', 'scripts');

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' —— ' + detail : ''}`);
    if (!ok) failed += 1;
}

/** 递归收集 assets/scripts 下全部 .ts（.d.ts 除外） */
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...walk(p));
        } else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

/** 把 import 源解析为项目内文件的规范 key；解析不到返回 null（外部依赖如 'cc'） */
function resolveImport(fromFile: string, src: string): string | null {
    if (!src.startsWith('.')) {
        return null;
    }
    const base = resolve(dirname(fromFile), src);
    for (const cand of [base + '.ts', join(base, 'index.ts')]) {
        try {
            if (statSync(cand).isFile()) {
                return relative(ROOT, cand).split('\\').join('/');
            }
        } catch {
            /* 候选不存在，试下一个 */
        }
    }
    return null;
}

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files = walk(ROOT);
const graph = new Map<string, Set<string>>(); // 运行时 import 边（类型边不计入）
const fileByKey = new Map<string, string>();
for (const f of files) {
    const key = relative(ROOT, f).split('\\').join('/');
    fileByKey.set(key, f);
    graph.set(key, new Set());
}

const ccclassPerFile = new Map<string, string[]>();
const allNames = new Map<string, string[]>(); // ccclass 名 -> 出现的文件
const inlineDecorator: string[] = [];

for (const [key, file] of fileByKey) {
    const code = readFileSync(file, 'utf8');

    // 规则 1 / 1b：@ccclass 数量与名字
    const names = [...code.matchAll(/@ccclass\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    ccclassPerFile.set(key, names);
    for (const n of names) {
        allNames.set(n, [...(allNames.get(n) ?? []), key]);
    }

    // 规则 3：_decorator.xxx 内联（剥注释后检查真实代码）
    if (/_decorator\s*\.\w/.test(stripComments(code))) {
        inlineDecorator.push(key);
    }

    // 规则 4：import 边（import type → 类型边，编译后擦除）
    const edges = graph.get(key) as Set<string>;
    const re = /import\s+(type\s+)?(?:\{[^}]*\}|\w+)\s*from\s*['"]([^'"]+)['"]/g;
    for (const m of code.matchAll(re)) {
        if (m[1]) {
            continue;
        }
        const to = resolveImport(file, m[2]);
        if (to && to !== key) {
            edges.add(to);
        }
    }
}

// ---- 规则 1：单文件单组件 ----
const multi: string[] = [];
for (const [key, names] of ccclassPerFile) {
    if (names.length > 1) {
        multi.push(`${key}（${names.length} 个: ${names.join(', ')}）`);
    }
}
check('规则1 每个文件 ≤1 个 @ccclass 组件', multi.length === 0, multi.join('; '));

// ---- 规则 1b：ccclass 名全局唯一 ----
const dup: string[] = [];
for (const [n, owners] of allNames) {
    if (owners.length > 1) {
        dup.push(`'${n}' 同时出现在 ${owners.join(' & ')}`);
    }
}
check('规则1b @ccclass 名全局唯一', dup.length === 0, dup.join('; '));

// ---- 规则 3：装饰器解构 ----
check('规则3 装饰器统一解构（无 _decorator.xxx 内联）', inlineDecorator.length === 0, inlineDecorator.join('; '));

// ---- 规则 5：@property 禁用非空断言（.clinerules 第 5 条）----
// 此前该规则只写在 .clinerules 里、无任何机器校验，导致 7 处 `= null!` 长期违规无人发现。
// `= null!` 会让「场景未接线」在类型系统里隐身（声明成非空却运行时为 null），
// 必须写成 `T | null = null` 并在用前判空，接线缺失才会在使用点暴露。
const nullBangProp: string[] = [];
const PROP_DECL = /@property\b/;
const NULL_BANG = /=\s*null\s*!/;
for (const [key, file] of fileByKey) {
    const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
    let armed = false; // 上一非空行是 @property 装饰器，本行应是其声明体
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.trim() === '') continue;
        if (armed && NULL_BANG.test(ln)) {
            nullBangProp.push(`${key}:${i + 1}`);
            armed = false;
            continue;
        }
        if (PROP_DECL.test(ln)) {
            if (NULL_BANG.test(ln)) nullBangProp.push(`${key}:${i + 1}`);
            armed = true;
            continue;
        }
        armed = false;
    }
}
check('规则5 @property 禁用 null! 非空断言', nullBangProp.length === 0, nullBangProp.join('; '));

// ---- 规则 4：DFS 三色标记找环 ----
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map<string, number>();
const stack: string[] = [];
const cycles: string[] = [];
function dfs(u: string): void {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.get(u) ?? []) {
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) {
            cycles.push([...stack.slice(stack.indexOf(v)), v].join(' -> '));
        } else if (c === WHITE) {
            dfs(v);
        }
    }
    stack.pop();
    color.set(u, BLACK);
}
for (const key of graph.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) {
        dfs(key);
    }
}
check('规则4 无运行时 import 环（import type 不计）', cycles.length === 0, cycles.join('  |  '));

const edgeCount = [...graph.values()].reduce((s, e) => s + e.size, 0);
console.log(`\n扫描 ${files.length} 个文件，运行时 import 边 ${edgeCount} 条（跨目录 ${files.length} 点有向图）。`);
if (failed > 0) {
    console.log(`自检失败：${failed} 项不合规`);
    process.exit(1);
}
console.log('编码规范自检全部通过 ✔');
