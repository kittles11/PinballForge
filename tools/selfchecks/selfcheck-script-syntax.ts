/**
 * 脚本语法卫生自检 —— 「编辑锚点错位」损伤回归锁（2026-09-07 事故）。
 * 事故：向 AudioManager.ts 头部插入常量块时，插入锚点落在原文件级 doc 注释内部，
 * 造成 FIRE_SFX_COIN 重复声明 + doc 注释被截断为裸代码 → 编译器产出「报错替身模块」，
 * 运行时 import 依赖子树全灭（17 个自定义组件 MissingScript，预览大面积失效）。
 *
 * 对 assets 下全部 .ts（不含 *.d.ts）做纯结构扫描（零依赖、零引擎 import）：
 *  ① 块注释外出现以 * 开头的裸行（doc 注释续行脱巢 / 注释被截断）；
 *  ② 文件内 export const/let/var/function/class 同名重复声明；
 *  ③ 文件结束仍未闭合的块注释（有开启无收尾）；
 *  ④ 跨文件 @ccclass 同名冲突（复制粘贴类注册冲突）。
 *
 * ponytail: 结构启发，不做完整语法解析（Node 侧无 TS 解析器；真解析以编辑器编译为准）。
 * 裸 * 行仅在「语句边界后」（上一代码行以 ; { } 收尾，或是文件首个代码行）才判伤，
 * 借此排除乘法换行续行的合法写法（如 `a += b\n    * c;`）；字符串/正则字面量体内的
 * 注释符不识别（assets 现状无此类写法，出现再修）。能拦住本事故（①②即事故文件的两类伤）。
 */
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const ASSETS = resolve(process.cwd(), 'assets');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

/** 字符级扫描：跟踪块注释/行注释/字符串状态，收集「块注释外以 * 开头的行」与未闭合块注释。
 *  裸 * 行只在语句边界（上一代码行尾字符为 ; { }，或文件尚无代码）判伤，
 *  排除乘法换行续行（`speed\n * 2`）等合法写法；注释收尾后紧跟的孤儿行仍判伤（事故形态）。 */
function scanLines(src: string): { bareDoc: number[]; unclosed: boolean } {
    const bare: number[] = [];
    let i = 0, line = 1, inBlock = false, lineHasCode = false;
    let lastCodeTail: string | undefined;
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '\n') { line++; i++; lineHasCode = false; continue; }
        if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
        if (inBlock) {
            if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
            i++; continue;
        }
        if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < src.length && src[i] !== q) {
                if (src[i] === '\\') i++;
                else if (src[i] === '\n') { line++; lineHasCode = false; }
                i++;
            }
            lastCodeTail = q; i++; continue;
        }
        if (c === '*' && !lineHasCode) {
            if (lastCodeTail === undefined || c2(lastCodeTail)) bare.push(line);
        }
        lastCodeTail = c;
        lineHasCode = true;
        i++;
    }
    return { bareDoc: bare, unclosed: inBlock };
}

/** 语句边界行尾字符：; { }（const a = 1; / class X { / } 之后不可能接合法的乘法 * 续行） */
function c2(ch: string): boolean {
    return ch === ';' || ch === '{' || ch === '}';
}

const files = walk(ASSETS);
check(`assets 下扫描到 .ts 文件（实际 ${files.length} ≥ 50）`, files.length >= 50);

const bareDocHits: string[] = [];
const dupExportHits: string[] = [];
const unclosedHits: string[] = [];
const ccclassOwners = new Map<string, string[]>();

for (const f of files) {
    const rel = f.slice(ASSETS.length + 1);
    const src = readFileSync(f, 'utf8');

    const { bareDoc, unclosed } = scanLines(src);
    for (const ln of bareDoc) bareDocHits.push(`${rel}:${ln}`);
    if (unclosed) unclosedHits.push(rel);

    // strip 注释后查重复顶层 export 声明（export 只在顶层合法，无需作用域分析）
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const names = new Map<string, number>();
    for (const m of stripped.matchAll(/^\s*export\s+(?:abstract\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.set(m[1], (names.get(m[1]) ?? 0) + 1);
    }
    for (const [k, v] of names) if (v > 1) dupExportHits.push(`${rel}: ${k} ×${v}`);

    for (const m of stripped.matchAll(/@ccclass\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const list = ccclassOwners.get(m[1]) ?? [];
        list.push(rel);
        ccclassOwners.set(m[1], list);
    }
}

const ccclassDupes = [...ccclassOwners.entries()].filter(([, v]) => v.length > 1);

for (const x of bareDocHits) console.log(`   - 裸 doc 行（块注释外以 * 开头）: ${x}`);
for (const x of dupExportHits) console.log(`   - 重复顶层导出: ${x}`);
for (const x of unclosedHits) console.log(`   - 未闭合块注释: ${x}`);
for (const [k, v] of ccclassDupes) console.log(`   - @ccclass 同名冲突: ${k} => ${v.join(' , ')}`);

check(`① 无块注释外裸 * 行（${bareDocHits.length} 处）`, bareDocHits.length === 0);
check(`② 无同文件重复顶层导出（${dupExportHits.length} 处）`, dupExportHits.length === 0);
check(`③ 无未闭合块注释（${unclosedHits.length} 个文件）`, unclosedHits.length === 0);
check(`④ 无跨文件 @ccclass 同名冲突（${ccclassDupes.length} 组）`, ccclassDupes.length === 0);

console.log(`selfcheck-script-syntax: ${files.length} 个文件，${failed} 项失败`);
process.exit(failed > 0 ? 1 : 0);
