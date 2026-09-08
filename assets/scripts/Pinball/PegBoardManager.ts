import { _decorator, Component, EventKeyboard, Graphics, Input, KeyCode, Prefab, input, instantiate, Vec3 } from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { PegComponent, PegType, BOMB_RADIUS, setFirstExhaustHook } from './PegComponent';
import { RelicType } from '../Core/DataModels';
import { RelicManager, TIDAL_GILD_COUNT } from '../Core/RelicManager';
import { MetaManager } from '../Core/MetaManager';
import { Theme } from '../Core/ArtTheme';
import { FloatingTextManager } from '../Core/FloatingTextManager';

const { ccclass, property } = _decorator;

/** 版型 A：5 + 4 + 5 + 4 + 3 = 21 颗（顶层全宽封堵两侧通道） */
const LAYOUT_A = [5, 4, 5, 4, 3];
/** 版型 B：5 + 3 + 5 + 3 + 5 = 21 颗（顶层封堵直落，底层守护漏斗入口） */
const LAYOUT_B = [5, 3, 5, 3, 5];
/** 版型 C：4 + 5 + 3 + 5 + 4 = 21 颗（阶梯交错密集弹跳） */
const LAYOUT_C = [4, 5, 3, 5, 4];

/** 🌳 Meta「钉板实验台」Lv1 解锁版型 D：5 + 4 + 3 + 5 + 4 = 21（沙漏收腰，中路密集） */
const LAYOUT_D = [5, 4, 3, 5, 4];
/** 🌳 Meta「钉板实验台」Lv3 解锁版型 E：4 + 5 + 4 + 5 + 3 = 21（上密下疏，末行守护漏斗） */
const LAYOUT_E = [4, 5, 4, 5, 3];

/** 基础版型集合（恒可用）：每局随机取其一排布（三套均为 5 行 21 颗、最宽行恒 5 → 横向间距恒 172；相邻行奇偶半距错位，竖直直落通道宽 ≤ 半列距，封死整列贯通直落进漏斗的漏洞） */
const BASE_PEG_LAYOUTS = [LAYOUT_A, LAYOUT_B, LAYOUT_C];

/**
 * 当前有效版型池 = 基础三套 + Meta「钉板实验台」解锁的额外版型（Lv1→D，Lv3→E）。
 * 新版型经校验：5 行、和为 21、最宽行 5、无相邻等长行（→ 相邻行必半距错位，沿用既有「无直落通道」不变量），
 * 且每个相邻行对都已在 A/B/C 中出现过，几何安全性由构造保证。
 */
export function activePegLayouts(): number[][] {
    const lab = MetaManager.getBoardLabLv();
    const pool = [...BASE_PEG_LAYOUTS];
    if (lab >= 1) pool.push(LAYOUT_D);
    if (lab >= 3) pool.push(LAYOUT_E);
    return pool;
}

/** 每侧安全边距（px）：防止最外侧钉子半出 720×560 铺满区 */
const EDGE_PADDING = 16;

/** 钉板铺满尺寸（宽 × 高，px）：以本节点中心为原点铺满 */
const BOARD_WIDTH = 720;
const BOARD_HEIGHT = 560;

/** Boss 波软复位阈值（2026-09-06 方案乙「Boss 波红闪后钉板变空/只剩一颗」根修）：
 *  Boss 战时长远超 21×6=126 次受击预算，全场力竭的统一灰盘会被玩家读作「钉板变空」。
 *  当前力竭钉数达到该值（21 颗的 2/3）时全场复新：钉板始终保有 ≥1/3 活钉，
 *  力竭防连击设计照常生效，仅削平「整板灰盘」的感知塌陷与能量收入断流。 */
const BOSS_SOFT_RESET_EXHAUST_THRESHOLD = 14;

/** 过热钉掷选数量（方案B②）：每张新钉板随机点燃 3 颗，本波内撞中能量 ×3、受击一次即熄灭——
 *  数量钉死 3 颗是为了压方差：目标太多少不了、太少易错过，3 颗恰好构成「值得抢但不保底」的张力 */
const OVERHEAT_PEG_COUNT = 3;

/** 🎲 版型轮换（方案B②）：池内指针轮转一圈归零时重新随机取版型——连续波不重复同一板形 */
/**
 * 钉板全自动生成与随机化组件：
 * - start() 自动生成一张钉板，并在每次卡牌奖励选完（REWARD_SELECTED）的下一波自动重排新钉板；
 * - 每局随机从 3 种固定版型（5·4·5·4·3 / 5·3·5·3·5 / 4·5·3·5·4，均 21 颗）中选一种排布，钉子位置完全固定（无随机抖动），每行以 X=0 为中线水平居中；三套版型首行（或前两行）全宽覆盖 + 相邻行奇偶半距错位，封死「整列无钉直落进漏斗」的通道；
 * - 钉板固定铺满 720×560（以节点中心为原点）：横向间距按最宽行均分撑满、纵向间距按总行数均分撑满，仅留 EDGE_PADDING 安全边距；
 * - 每局随机抽取 1 颗炸药钉、随机 1~3 颗乘倍钉、1 颗刷新钉，其余为普通钉；爆炸半径随实际间距自适应。
 * 依赖：节点下无其它子节点冲突（generateBoard 会清除全部子节点），pegPrefab 需挂载 PegComponent 与物理碰撞体。
 */
@ccclass('PegBoardManager')
export class PegBoardManager extends Component {
    /** 钉子预制体（需挂 PegComponent + Collider2D） */
    @property(Prefab)
    pegPrefab: Prefab | null = null;

    /** 每局炸药钉数量（固定 1 颗） */
    @property
    bombCount = 1;

    /** 每局刷新钉数量（固定 1 颗） */
    @property
    refreshCount = 1;

    /** 首见力竭快照已拍标记（整会话一次性） */
    private _firstExhaustSnapped = false;

    /** Boss 波软复位开关：WAVE_START 载荷 config.isBoss 为 true 时武装，非 Boss 波 / 换波撤防 */
    private _bossSoftResetArmed = false;
    /** 软复位已排程标记：同帧连环力竭（炸药钉引爆）只排一次，防重复复新 */
    private _softResetPending = false;
    /** 本波软复位已执行次数（日志观测用，WAVE_START / generateBoard 时清零） */
    private _softResetCount = 0;
    /** 🛡 本板 21 颗钉的生成坐标存档（auditPegBoard 位置漂移审计的基准；generateBoard 时重建） */
    private readonly _spawnPositions: Vec3[] = [];

    /** 🎲 版型轮换指针（方案B②）：池内轮转一圈后重新洗牌，连续波不重复同一版型 */
    private _layoutRoll = 0;

    /** 📊 每板日志降噪（方案B 收尾）：generateBoard 的布局/渲染日志整会话只打首个波次的板，
     *  换波重建不再刷屏；软复位日志同理收口到「每波首次」。 */
    private _boardLogOnce = false;

    protected start(): void {
        // 开局先生成一张钉板
        this.generateBoard();
        // 🛡 钉板位置+渲染例行审计：每秒幂等自愈（位置漂移恢复 / Graphics 被清空重绘）
        this.schedule(() => this.auditPegBoard(), 1);
        // 每波卡牌奖励选完后进入下一波 → 重新生成整张随机新钉板
        EventBus.on(GameEvents.REWARD_SELECTED, this.onRewardSelected, this);
        // ★ 一次性运行时快照接线（2026-09-06 Boss 波排查；diagnosticSnapshot 纯只读，不改任何行为）：
        // ① 首见力竭：PegComponent 经注入钩子回调（避免反向 import 循环依赖），整会话只拍一次
        setFirstExhaustHook(() => {
            if (this._firstExhaustSnapped) {
                return;
            }
            this._firstExhaustSnapped = true;
            this.diagnosticSnapshot('first-exhaust');
        });
        // ② WAVE_START：Boss 波软复位武装/撤防（载荷 config.isBoss 由 LevelManager 提供：章节第 10 关第 3 波）
        //    + Boss 波开始后延迟 1 秒拍一次性诊断快照
        EventBus.on(GameEvents.WAVE_START, this.onWaveStart, this);
        // ③ 玩家观察到「红闪后钉板变空」时手动拍：按 D 键（Diagnostic；本游戏无键盘玩法，零冲突）
        input.on(Input.EventType.KEY_DOWN, this.onKeyDownDiag, this);
        // ④ Boss 波软复位信源（2026-09-06 方案乙）：PegComponent.exhaust 广播 PEG_EXHAUSTED →
        //    达阈值时下一帧全场复新，杜绝 Boss 波「整板灰盘被读作空板」
        EventBus.on(GameEvents.PEG_EXHAUSTED, this.onPegExhausted, this);
    }

    protected onDestroy(): void {
        EventBus.targetOff(this);
        input.off(Input.EventType.KEY_DOWN, this.onKeyDownDiag, this);
        setFirstExhaustHook(null);
    }

    private onWaveStart(data: { config?: { isBoss?: boolean } } | null): void {
        // ★ Boss 波软复位武装（2026-09-06 方案乙）：按本波 config.isBoss 开关；换波一律撤防并清零预算，
        //   非 Boss 波维持原设计（波内唯一复新入口是刷新钉被撞）
        this._bossSoftResetArmed = !!data?.config?.isBoss;
        this._softResetPending = false;
        this._softResetCount = 0;
        // 🛡 换波下一帧校验一次钉板位置：每波整板重排（REWARD_SELECTED → generateBoard），
        //   若位置在生成窗口内被改写（物理体钉回等），此处是暴露最快的观察点
        this.scheduleOnce(() => this.auditPegBoard('wave-start+1f'), 0);
        if (!this._bossSoftResetArmed) {
            return;
        }
        // 本组件自己的 scheduleOnce，与 WaveManager 的 unscheduleAllCallbacks 互不影响
        this.scheduleOnce(() => this.diagnosticSnapshot('boss+1s'), 1.0);
    }

    /**
     * ★ Boss 波软复位（2026-09-06 方案乙「Boss 波红闪后钉板变空/只剩一颗」根修）：
     * PegComponent.exhaust() 经 EventBus 广播力竭（解耦，防反向 import 循环依赖），此处：
     * 实时统计当前力竭数（不用累计口径——刷新钉被撞会复活全场，累计数会虚高），
     * 达到阈值后 scheduleOnce(0) 下一帧全场复新 + 跳字反馈（与 onRewardSelected 延迟重建同款
     * 物理栈护栏；resetPeg 本身已不触碰物理碰撞体，双保险）。同帧连环力竭（炸药钉）只排一次。
     */
    private onPegExhausted(): void {
        if (!this._bossSoftResetArmed || this._softResetPending || !this.node?.isValid) {
            return;
        }
        let exhausted = 0;
        for (const child of this.node.children) {
            if (child.getComponent(PegComponent)?.isExhausted) {
                exhausted++;
            }
        }
        if (exhausted < BOSS_SOFT_RESET_EXHAUST_THRESHOLD) {
            return;
        }
        this._softResetPending = true;
        this._softResetCount++;
        this.scheduleOnce(() => {
            this._softResetPending = false;
            if (!this._bossSoftResetArmed || !this.node?.isValid) {
                return; // 波次已推进 / 节点失效：让位（新波钉板本就整板重排，无需复新）
            }
            PegComponent.resetAllPegs();
            // 📊 复新日志收口到每波首次：Boss 战常触发多次软复位，逐次打印没有增量信息
            if (this._softResetCount === 1) {
                console.log(`[PegBoard] 🔄 Boss 波软复位：力竭 ${exhausted} ≥ 阈值 ${BOSS_SOFT_RESET_EXHAUST_THRESHOLD}，全场复新（本波第 ${this._softResetCount} 次，后续复新不再逐条打印）`);
            }
            FloatingTextManager.instance?.showText(
                '钉板复新！', this.node.worldPosition.clone(), Theme.peg.refresh, true,
            );
        }, 0);
    }

    private onKeyDownDiag(event: EventKeyboard): void {
        if (event.keyCode === KeyCode.KEY_D) {
            this.diagnosticSnapshot('after-red-flash');
        }
    }

    private onRewardSelected(): void {
        // ★ 延迟一帧重建（2026-09-05 根修）：REWARD_SELECTED 可能在弹珠 onBeginContact 的物理
        //   锁定栈内派发（雷球连击击杀最后一只敌人 → 波次结算 → emit），同步 generateBoard 会把
        //   21 颗带 RigidBody2D 的新钉在物理 step 中途激活，刷屏「Can not active RigidBody in
        //   contact listener」。scheduleOnce(0) 保证钉板重建永远跑在物理 step 之外。
        this.scheduleOnce(() => this.generateBoard(), 0);
    }

    /**
     * 清除旧钉子并按固定版型 + 随机类型生成一张新钉板：
     * 1. 销毁并移除全部旧子节点；
     * 2. 每局随机从 PEG_LAYOUTS（5·4·5·4·3 / 5·3·5·3·5 / 4·5·3·5·4，均 21 颗）中选一种版型逐行排布，钉子位置固定，每行以 X=0 为中线水平居中（首行全宽封顶、相邻行奇偶半距错位，杜绝直落漏斗）；
     * 3. 固定铺满 720×560（以节点中心为原点）：横向间距按最宽行均分撑满、纵向间距按总行数均分撑满，仅留 EDGE_PADDING 安全边距；
     * 4. 洗牌全部位置，随机抽取 bombCount 个炸药钉、随机 1~3 个乘倍钉、refreshCount 个刷新钉，其余为普通钉；
     * 5. 按实际间距注入爆炸半径，保证炸药钉始终能炸掉一整圈相邻钉；批量 instantiate(pegPrefab) → 设置坐标 → setPegType(type)；
     * 6. 方案B 决策深化：贴板缘钉标边缘高能（能量 ×1.5）+ 随机 3 颗过热钉（本波撞中能量 ×3、受击即熄）+ 版型轮换防同形连刷。
     */
    public generateBoard(): void {
        if (!this.pegPrefab || !this.node?.isValid) {
            return;
        }

        // 1. 清除旧钉子：逐个销毁释放物理碰撞，再统一移出父节点（等价于需求 removeAllChildren）
        const oldChildren = [...this.node.children];
        for (const child of oldChildren) {
            if (child?.isValid) {
                child.destroy();
            }
        }
        this.node.removeAllChildren();

        // ★ Boss 波软复位预算清零：新板 21 颗全部新鲜，本波复新次数重新起算
        this._softResetPending = false;
        this._softResetCount = 0;

        // 2. 每局随机选一种版型（基础三套 + Meta 钉板实验台解锁版型），并按该版型逐行计算固定坐标（每行以 X=0 为中线水平居中）
        const layouts = activePegLayouts();
        // 🎲 版型轮换（方案B②）：指针在池内轮转一圈后重新洗牌——连续波不重复同一板形，
        //   与过热钉掷选共同制造「每波长不一样」的节奏（开局首板 roll=1 恰好随机）
        this._layoutRoll = (this._layoutRoll + 1) % layouts.length;
        const layout = this._layoutRoll === 0
            ? layouts[Math.floor(Math.random() * layouts.length)]
            : layouts[this._layoutRoll];
        // 固定铺满 720×560：横向间距撑满最宽行、纵向间距撑满全部行，两侧各留 EDGE_PADDING，整体以节点中心对称
        const maxCols = Math.max(...layout);
        const spacingX = (BOARD_WIDTH - EDGE_PADDING * 2) / Math.max(1, maxCols - 1);
        const spacingY = (BOARD_HEIGHT - EDGE_PADDING * 2) / Math.max(1, layout.length - 1);
        const startY = BOARD_HEIGHT / 2 - EDGE_PADDING;
        const positions: Vec3[] = [];
        for (let r = 0; r < layout.length; r++) {
            const rowCols = layout[r];
            for (let c = 0; c < rowCols; c++) {
                // 第 c 颗钉子的 X = (col - (rowCols - 1) / 2) * spacingX
                const baseX = (c - (rowCols - 1) / 2) * spacingX;
                positions.push(new Vec3(
                    baseX,
                    startY - r * spacingY,
                    0,
                ));
            }
        }

        // 3. 随机分配类型：洗牌全部下标，前 bombCount 个 Bomb、随后 multiplierCount 个 Multiplier、再 refreshCount 个 Refresh，其余 Normal
        const total = positions.length;
        const multiplierCount = Math.floor(Math.random() * 3) + 1;   // 每局随机 1~3 颗乘倍钉
        const bombN = Math.min(this.bombCount, total);
        const multiplierN = Math.min(multiplierCount, total - bombN);
        const refreshN = Math.min(this.refreshCount, total - bombN - multiplierN);
        const index = positions.map((_, i) => i);
        for (let i = index.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = index[i];
            index[i] = index[j];
            index[j] = tmp;
        }
        const types: PegType[] = new Array(total).fill(PegType.Normal);
        for (let i = 0; i < bombN; i++) {
            types[index[i]] = PegType.Bomb;
        }
        for (let i = 0; i < multiplierN; i++) {
            types[index[bombN + i]] = PegType.Multiplier;
        }
        for (let i = 0; i < refreshN; i++) {
            types[index[bombN + multiplierN + i]] = PegType.Refresh;
        }

        // 4. 批量实例化并设置坐标与类型（逐钉 try/catch：单钉异常不吞整板——
        //    曾出现「钉板只剩 1 颗」的间歇性症状，靠此日志定位是实例化/设型哪一步断的）
        let spawned = 0;
        for (let i = 0; i < total; i++) {
            try {
                const pegNode = instantiate(this.pegPrefab);
                // ★ 坐标先于挂载（2026-09-06 根修「钉板塌缩成中心一坨」）：RigidBody2D 在节点挂载激活
                //   瞬间即按当前位置建立物理体——旧顺序 setParent→setPosition 让物理体以 prefab 默认
                //   (0,0)（世界=画布中心）建立，节点随后被引擎钉回物理体位置，21 颗钉在生成后 1 秒内
                //   全部塌缩到画布中心（[generate] 快照散开 / [boss+1s] 全 (0,0) 实证）。先 setPosition
                //   再 setParent，物理体建立瞬间就在正确坐标，钉回的也是正确位置。
                pegNode.setPosition(positions[i]);
                pegNode.setParent(this.node);
                const peg = pegNode.getComponent(PegComponent) || pegNode.addComponent(PegComponent);
                peg.setPegType(types[i]);
                // 爆炸半径随本局实际横向间距自适应：保证炸药钉始终能炸掉一整圈相邻钉
                peg.explosionRadius = Math.max(BOMB_RADIUS, spacingX * 1.2);
                spawned++;
            } catch (err) {
                console.error(`[诊断] 第 ${i} 颗钉实例化失败（已生成 ${spawned}/${total}）:`, err);
            }
        }

        // 5½. ★ 边缘高能带（方案B①）：本板最宽行的两枚贴板缘钉（行钉数=1 时全行视作边缘）
        //     标记 edgeBonus——能量 ×1.5（镀金赏金 ×2 在 OrbController 侧）。琥珀外环即视觉身份。
        //     「为高能钉冒掉槽风险」从发射前那一刻起成为显式决策（板缘弹道少弹跳、易漏槽）。
        let edgeMarked = 0;
        let edgeX = -Infinity;
        for (let i = 0; i < total; i++) {
            if (positions[i].x > edgeX) {
                edgeX = positions[i].x;
            }
        }
        for (let i = 0; i < total; i++) {
            if (Math.abs(positions[i].x - edgeX) < 0.5) {
                pegComponents[i].edgeBonus = true;
                edgeMarked++;
            }
        }

        // 🛡 生成坐标存档（审计基准）：children 即本板 21 颗钉（生成前 removeAllChildren 已清场），
        //   auditPegBoard 以此逐钉比对位置漂移
        this._spawnPositions.length = 0;
        for (const child of this.node.children) {
            if (child.getComponent(PegComponent)) {
                this._spawnPositions.push(child.position.clone());
            }
        }
        // ★ 可见性真实校验（2026-09-05 根修）：旧日志只数「实生成 21」，把「节点建出来了却一个
        //   都看不见」的隐形钉故障掩盖成生成成功——这正是该问题反复修不掉的直接原因。
        //   此后「生成成功」必须等于「全部可渲染」，并逐钉报出真实渲染状态供定位。
        let visible = 0;
        const invisible: string[] = [];
        for (const child of this.node.children) {
            const peg = child.getComponent(PegComponent);
            if (!peg) {
                continue;
            }
            if (peg.isRenderable()) {
                visible++;
            } else {
                const p = child.position;
                invisible.push(`${child.name}(${p.x.toFixed(0)},${p.y.toFixed(0)})`);
            }
        }
        // 📊 布局日志整会话只打首个波次的板（换波重建每波一条过于刷屏，方案B 收尾）
        if (!this._boardLogOnce) {
            console.log(`[诊断] 钉板生成：版型行数 ${layout.length}，应生成 ${total}，实生成 ${spawned}，` +
                `可渲染 ${visible}，节点位置 (${this.node.position.x.toFixed(0)},${this.node.position.y.toFixed(0)})，` +
                `缩放 ${this.node.scale.x.toFixed(2)}，父链激活 ${this.node.activeInHierarchy}`);
        }
        if (spawned < total) {
            console.error(`[诊断] 钉板不完整：${spawned}/${total}（配合上方逐钉错误定位）`);
        }
        if (visible < spawned) {
            console.error(`[诊断] 隐形钉！仅 ${visible}/${spawned} 可渲染，异常钉：${invisible.slice(0, 5).join(' ')}` +
                `（本体由 PegComponent.redrawArt 的 Graphics 实心圆盘无条件保证，` +
                `此处异常说明绘制层未建立或钉板父链未进入渲染树）`);
        }

        // 📊 生成收尾日志旗标（边缘/过热/镀金计数 + 隐形钉守卫共用）整会话只打首个波次的板——
        //    置位统一收口到过热日志的守卫内（generateBoard 最末），保证方案B 日志首波必打一遍

        // 5. ★ 潮汐镀金：持有遗物时，把本张钉板随机 2 颗普通钉镀金为乘倍钉；
        //    钉板每波随 REWARD_SELECTED 销毁重建，镀金随波天然退潮，无需复原逻辑
        if (RelicManager.hasRelic(RelicType.TidalGild)) {
            const gilded = PegComponent.gildRandomNormalPegs(TIDAL_GILD_COUNT);
            if (gilded.length > 0 && !this._boardLogOnce) {
                console.log('[PegBoard] 🌊 潮汐镀金：本波 ' + gilded.length + ' 颗普通钉镀金为乘倍钉');
            }
        }

        // 5¾. ★ 过热钉掷选（方案B②）：每张新钉板随机点燃 3 颗——本波内第一次被弹珠撞中能量 ×3
        //     （OrbController 撞前捕获 peg.isOverheated），受击即熄灭。与版型轮换共同制造
        //     「每波目标不一样」的瞄准张力；掷选放 generateBoard 尾部而非 WAVE_START 监听：
        //     WAVE_START 在 startWave 内同步发出时，新钉板要等下一帧 onRewardSelected→generateBoard 才重建。
        const pool = pegComponents.filter((p) => p.pegType === PegType.Normal);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
        }
        const overheated = pool.slice(0, OVERHEAT_PEG_COUNT);
        for (const peg of overheated) {
            peg.armOverheat();
        }
        if (!this._boardLogOnce) {
            console.log(`[PegBoard] 🔥 方案B 决策钉：边缘高能 ${edgeMarked} 颗（能量 ×1.5）+ 过热 ${overheated.length} 颗（本波能量 ×3，受击即熄）`);
            this._boardLogOnce = true;
        }

        // ★ 一次性运行时快照（2026-09-06）：生成后立即拍一张（原内联 dump 收编进 diagnosticSnapshot，
        //   统一四调用点：generate / first-exhaust / boss+1s / after-red-flash）
        this.diagnosticSnapshot('generate');
    }

    /**
     * ★ 一次性只读运行时快照（2026-09-06 Boss 波排查）：仅读取并打印 PegContainer 当前状态，
     *   绝不写入/修改任何行为（颜色 / 受击次数 / 爆炸半径 / active 一概不碰），无每帧日志。
     *   四个调用点：generate（生成后）/ first-exhaust（首见力竭）/ boss+1s（Boss 波开始 1 秒）/
     *   after-red-flash（玩家按 D 手动触发）。
     *   Graphics 绘制内容读 g.impl.paths.length（引擎 Impl.paths 为 public 字段；clear 后未重绘 ⇒ 0，
     *   是「绘制内容被清空」的直接证据；-1 = 不可读取）。
     */
    public diagnosticSnapshot(reason: string): void {
        let pegCount = 0;
        let activeCount = 0;
        let hierCount = 0;
        let artCount = 0;
        let gCount = 0;
        let gEnabledCount = 0;
        let exhaustedCount = 0;
        let hitsSum = 0;
        let hitsMax = 0;
        const rows: string[] = [];
        let index = 0;
        for (const child of this.node.children) {
            const tag = `#${index++}`;
            const peg = child.getComponent(PegComponent);
            if (!peg) {
                rows.push(`  ${tag} ${child.name}（无 PegComponent）`);
                continue;
            }
            pegCount++;
            if (child.active) {
                activeCount++;
            }
            if (child.activeInHierarchy) {
                hierCount++;
            }
            if (peg.isExhausted) {
                exhaustedCount++;
            }
            hitsSum += peg.currentHitCount;
            hitsMax = Math.max(hitsMax, peg.currentHitCount);
            const art = child.getChildByName('PegArt');
            const g = art?.getComponent(Graphics);
            if (art?.isValid) {
                artCount++;
            }
            if (g) {
                gCount++;
            }
            if (g?.enabled) {
                gEnabledCount++;
            }
            const t = (peg as unknown as { _tint?: { r: number; g: number; b: number; a: number } })._tint;
            const tint = t ? `${t.r}/${t.g}/${t.b}/${t.a}` : 'n/a';
            const impl = g ? (g as unknown as { impl?: { paths?: { length: number } | null } | null }).impl : null;
            const paths = impl?.paths ? impl.paths.length : -1;
            const p = child.position;
            const w = child.worldPosition;
            rows.push(`  ${tag} ${child.name}/${peg.pegType} 位(${p.x.toFixed(0)},${p.y.toFixed(0)}) 世界(${w.x.toFixed(0)},${w.y.toFixed(0)}) ` +
                `缩放(${child.scale.x.toFixed(2)},${child.scale.y.toFixed(2)}) PegArt层:${art ? art.activeInHierarchy : '无'} ` +
                `G:${g ? (g.enabled ? 'on' : 'off') : '无'} paths:${paths} 力竭:${peg.isExhausted ? 1 : 0} ` +
                `击:${peg.currentHitCount}/${peg.maxHitsPerRound} tint(r/g/b/a):${tint}`);
        }
        console.log(
            `[诊断快照][${reason}] 子节点:${this.node.children.length} Peg:${pegCount} active:${activeCount} ` +
            `hier:${hierCount} PegArt:${artCount} Graphics:${gCount} G.enabled:${gEnabledCount} ` +
            `力竭:${exhaustedCount} 受击Σ:${hitsSum} 受击max:${hitsMax} ` +
            `容器hier:${this.node.activeInHierarchy} 容器层:${this.node.layer}\n${rows.join('\n')}`,
        );
    }

    /**
     * 🛡 钉板位置+渲染幂等审计（2026-09-06 根修配套兜底）：
     * - 位置：逐钉比对生成坐标存档，偏差 >1px 当场恢复——任何未知改写者最坏 1 秒内被修复，
     *   且自愈日志会点名改写发生的时间窗（换波后 / 例行）；
     * - 渲染：Graphics 绘制内容被清空（impl.paths=0）时强制重绘。
     * 调用点：WAVE_START 下一帧（换波重排后首轮物理前）/ 每 1s 例行。零漂移时纯只读零日志。
     */
    private auditPegBoard(reason: string = 'periodic'): void {
        if (!this.node?.isValid || this._spawnPositions.length === 0) {
            return;
        }
        let fixedPos = 0;
        let fixedArt = 0;
        let index = 0;
        for (const child of this.node.children) {
            const peg = child.getComponent(PegComponent);
            if (!peg) {
                continue;
            }
            const want = this._spawnPositions[index++];
            if (want && Vec3.distance(child.position, want) > 1) {
                child.setPosition(want);
                fixedPos++;
            }
            const g = child.getChildByName('PegArt')?.getComponent(Graphics);
            const impl = g ? (g as unknown as { impl?: { paths?: { length: number } | null } | null }).impl : null;
            if (g?.enabled && impl && !impl.paths?.length) {
                peg.forceRedraw();
                fixedArt++;
            }
        }
        if (fixedPos > 0 || fixedArt > 0) {
            console.warn(`[PegBoard] 🛡 钉板自愈（${reason}）：位置恢复 ${fixedPos} 颗、重绘 ${fixedArt} 颗` +
                `——位置漂移 = 生成后仍有改写者在动的直接证据（根修：generateBoard 已改为坐标先于挂载）`);
        }
    }
}