import { _decorator, Component, Prefab, instantiate, Vec3 } from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { PegComponent, PegType, BOMB_RADIUS } from './PegComponent';
import { RelicType } from '../Core/DataModels';
import { RelicManager, TIDAL_GILD_COUNT } from '../Core/RelicManager';
import { MetaManager } from '../Core/MetaManager';

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

    protected start(): void {
        // 开局先生成一张钉板
        this.generateBoard();
        // 每波卡牌奖励选完后进入下一波 → 重新生成整张随机新钉板
        EventBus.on(GameEvents.REWARD_SELECTED, this.onRewardSelected, this);
    }

    protected onDestroy(): void {
        EventBus.targetOff(this);
    }

    private onRewardSelected(): void {
        this.generateBoard();
    }

    /**
     * 清除旧钉子并按固定版型 + 随机类型生成一张新钉板：
     * 1. 销毁并移除全部旧子节点；
     * 2. 每局随机从 PEG_LAYOUTS（5·4·5·4·3 / 5·3·5·3·5 / 4·5·3·5·4，均 21 颗）中选一种版型逐行排布，钉子位置固定，每行以 X=0 为中线水平居中（首行全宽封顶、相邻行奇偶半距错位，杜绝直落漏斗）；
     * 3. 固定铺满 720×560（以节点中心为原点）：横向间距按最宽行均分撑满、纵向间距按总行数均分撑满，仅留 EDGE_PADDING 安全边距；
     * 4. 洗牌全部位置，随机抽取 bombCount 个炸药钉、随机 1~3 个乘倍钉、refreshCount 个刷新钉，其余为普通钉；
     * 5. 按实际间距注入爆炸半径，保证炸药钉始终能炸掉一整圈相邻钉；批量 instantiate(pegPrefab) → 设置坐标 → setPegType(type)。
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

        // 2. 每局随机选一种版型（基础三套 + Meta 钉板实验台解锁版型），并按该版型逐行计算固定坐标（每行以 X=0 为中线水平居中）
        const layouts = activePegLayouts();
        const layout = layouts[Math.floor(Math.random() * layouts.length)];
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

        // 4. 批量实例化并设置坐标与类型
        for (let i = 0; i < total; i++) {
            const pegNode = instantiate(this.pegPrefab);
            pegNode.setParent(this.node);
            pegNode.setPosition(positions[i]);
            const peg = pegNode.getComponent(PegComponent) || pegNode.addComponent(PegComponent);
            peg.setPegType(types[i]);
            // 爆炸半径随本局实际横向间距自适应：保证炸药钉始终能炸掉一整圈相邻钉
            peg.explosionRadius = Math.max(BOMB_RADIUS, spacingX * 1.2);
        }

        // 5. ★ 潮汐镀金：持有遗物时，把本张钉板随机 2 颗普通钉镀金为乘倍钉；
        //    钉板每波随 REWARD_SELECTED 销毁重建，镀金随波天然退潮，无需复原逻辑
        if (RelicManager.hasRelic(RelicType.TidalGild)) {
            const gilded = PegComponent.gildRandomNormalPegs(TIDAL_GILD_COUNT);
            if (gilded.length > 0) {
                console.log('[PegBoard] 🌊 潮汐镀金：本波 ' + gilded.length + ' 颗普通钉镀金为乘倍钉');
            }
        }
    }
}