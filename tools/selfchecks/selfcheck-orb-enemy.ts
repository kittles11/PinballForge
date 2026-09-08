/**
 * 弹珠×敌人直接物理交互自检（纯 Node，无引擎依赖）—— Task 002（2026-09-07）：
 *   node --experimental-transform-types --import ./register-ts-hook.mjs selfcheck-orb-enemy.ts
 *
 * 背景：此前敌人无物理体（Enemy.prefab 无 RigidBody2D / Collider2D），弹珠径直穿过敌人，
 * 全部伤害只能绕道「钉板 → 能量 → 漏斗 → 炮塔」间接结算——弹珠与敌人零物理交互。
 * 本次根修：敌人补 Kinematic 刚体 + 圆形碰撞体（ENEMY 组，仅与 ORB 互通），弹珠撞敌 = 直伤 ×0.5 + 击退。
 * 覆盖：① project.json 碰撞矩阵真解析（ENEMY 组 + ORB↔ENEMY 互通 + 与钉/墙/漏斗隔离）
 *       ② 敌人物理体（Kinematic / 分组 / 半径随缩放 / 幂等） ③ 弹珠命中链（直伤倍率 / 冷却 / 出物理锁 / 守卫）
 *       ④ 击退常量纯算术复核
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'assets', 'scripts');
const read = (...p: string[]): string => readFileSync(resolve(SCRIPTS, ...p), 'utf8');

/** 去掉块注释 / 行注释，避免注释里的示例文字干扰检查 */
const strip = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name: string, cond: boolean): void {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
}

const enemy = strip(read('Battle', 'EnemyController.ts'));
const orb = strip(read('Pinball', 'OrbController.ts'));

// ── ① 碰撞矩阵真解析（JSON.parse 校验 settings，不靠正则猜） ──
const proj = JSON.parse(readFileSync(resolve(ROOT, 'settings', 'v2', 'packages', 'project.json'), 'utf8'));
const groups: { index: number; name: string }[] = proj.physics?.collisionGroups ?? [];
const matrix: Record<string, number> = proj.physics?.collisionMatrix ?? {};
const enemyGroup = groups.find((g) => g.name === 'ENEMY');
check('ENEMY 组已注册（index 5 = 位掩码 32）', enemyGroup?.index === 5);
check('ORB 矩阵含 ENEMY 位（62 = 30 | 32，原有四组互通零回归）',
    (matrix['1'] & 32) !== 0 && (matrix['1'] & 30) === 30);
check('ENEMY 仅与 ORB 互通（"5" = 2，不碰钉/墙/漏斗：不挡弹珠路径、不误触入槽）',
    matrix['5'] === 2);

// ── ② 敌人物理体：Kinematic 刚体 + 圆形碰撞体（onLoad 内创建，幂等） ──
check('onLoad 调用 ensurePhysicsBody（敌人激活即带物理体）',
    /this\.ensurePhysicsBody\(\);/.test(enemy));
check('刚体类型 Kinematic（位置由 setPosition 驱动，不受弹珠冲击位移）',
    /rb\.type = ERigidBody2DType\.Kinematic;/.test(enemy));
check('刚体分组 ENEMY_GROUP_MASK（1 << 5，与 project.json 对齐）',
    /const ENEMY_GROUP_MASK = 1 << 5;/.test(enemy) && /rb\.group = ENEMY_GROUP_MASK;/.test(enemy));
check('圆形碰撞体半径随节点缩放适配（ENEMY_BODY_RADIUS × scale，Boss / 小怪体型命中）',
    /col\.radius = ENEMY_BODY_RADIUS \* Math\.abs\(this\.node\.scale\.x \|\| 1\);/.test(enemy));
check('幂等守卫：已有刚体时跳过（prefab 未来预配不重复添加）',
    /getComponent\(RigidBody2D\)\) \{\s*return;\s*\}/.test(enemy));

// ── ③ 弹珠命中链：直伤 ×0.5 / 冷却 / 出物理锁 / 双向守卫 ──
check('碰撞分派：getComponent(EnemyController) 分支优先于漏斗名兜底',
    /const enemy = otherCollider\.node\.getComponent\(EnemyController\);\s*if \(enemy\) \{\s*this\.hitEnemy\(enemy\);\s*return;\s*\}/.test(orb));
check('直伤倍率常量 0.5（撞敌 = accumulatedDamage × 0.5，走 takeDamage 同炮击通道）',
    /const ENEMY_HIT_DAMAGE_MULT = 0\.5;/.test(orb));
check('伤害走 takeDamage(dmg, this.orbType)（球种应答：等离子穿透 / 熔岩熔核剥盾自动生效）',
    /enemy\.takeDamage\(dmg, this\.orbType\);/.test(orb));
check('命中冷却 0.15s（防物理贴脸抖动一帧多次扣血）',
    /const ENEMY_HIT_COOLDOWN = 0\.15;/.test(orb)
    && /now - this\._lastEnemyHitAt < ENEMY_HIT_COOLDOWN \* 1000/.test(orb));
check('伤害结算 scheduleOnce(0) 出物理锁（同步击杀会就地触发波次结算——雷球连击同款根修）',
    /this\.scheduleOnce\(\(\) => \{\s*if \(enemy\.node\?\.isValid && !enemy\.isDead && !this\._destroying && !this\._funnelEntered\) \{\s*enemy\.takeDamage\(dmg, this\.orbType\);/.test(orb));
check('伤害快照：结算前 accumulatedDamage 已定（延迟期间撞钉增量不回溯）',
    /const dmg = this\.accumulatedDamage \* ENEMY_HIT_DAMAGE_MULT;/.test(orb));
check('命中守卫：入槽 / 销毁流程中跳过（与 update 兜底同守卫语义）',
    /if \(this\._funnelEntered \|\| this\._destroying \|\| !enemy\.node\?\.isValid \|\| enemy\.isDead\) \{/.test(orb));
check('命中即击退：enemy.knockback()（反馈在敌人侧兑现）',
    /enemy\.knockback\(\);/.test(orb));

// ── ④ 击退常量纯算术复核 ──
check('击退接线：knockback 置位 _knockbackSpeed，update 衰减消费（向右 = 推离防线）',
    /this\._knockbackSpeed = KNOCKBACK_SPEED;/.test(enemy)
    && /nx \+= this\._knockbackSpeed \* dt;/.test(enemy)
    && /this\._knockbackSpeed = Math\.max\(0, this\._knockbackSpeed - KNOCKBACK_DECAY \* dt\);/.test(enemy));
check('击退状态互斥：冻结 / 施法 / 头槌 / 庆祝 / 死亡中不生效（位置由各自驱动接管）',
    /public knockback\(\): void \{\s*if \(this\._dead \|\| !this\.node\?\.isValid \|\| this\.isFrozen \|\| this\._casting\s*\|\| this\._lungeAnimating \|\| this\._celebrating\) \{/.test(enemy));
const kbSpeed = 90, kbDecay = 240;
const slideDist = (kbSpeed * kbSpeed) / (2 * kbDecay);
check(`击退滑行距离 v²/2a = ${slideDist}px（< 头槌 25px：击退不打乱防线攻防节奏）`,
    Math.abs(slideDist - 16.875) < 0.01 && slideDist < 25);

console.log(failed === 0 ? '\n✅ 弹珠×敌人物理交互自检全部通过' : `\n❌ ${failed} 项未通过`);
// 仅失败路径显式非零退出；成功路径自然结束（Windows node 偶发 process.exit(0) libuv 崩溃会污染退出码）
if (failed > 0) process.exit(1);