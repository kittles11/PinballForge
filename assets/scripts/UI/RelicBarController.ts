import {
    _decorator, Component, Node, Label, Graphics, UITransform, Color, Vec3, tween,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { RelicType, RELIC_DATABASE, ALL_RELIC_TYPES } from '../Core/DataModels';
import { FloatingTextManager } from '../Core/FloatingTextManager';
import { Theme } from '../Core/ArtTheme';
import { mountIcon } from '../Core/IconLib';

const { ccclass } = _decorator;

/** 单个遗物瓷片尺寸（px）：收窄到 118×34，5 枚横排 622px 不超屏、不遮顶部 HUD 行 */
const TILE_WIDTH = 118;
const TILE_HEIGHT = 34;
/** 瓷片间距（px） */
const TILE_GAP = 8;
/** 瓷片底色：半透明暗金（与金币主题呼应） */
const TILE_BG = Theme.ui.tileGoldBg;
/** 瓷片边框色：亮金 */
const TILE_BORDER = Theme.ui.gold;

/**
 * 顶部 UI 遗物栏（RelicBarController）：挂在 Canvas/UILayer/RelicBar 节点（由 RelicManager 自举创建）。
 * - 监听 RELIC_CHANGED 实时渲染已获得的遗物矢量图标徽章列表（IconLib 染色），一字横排居中；
 * - 初始渲染同样由 RELIC_CHANGED 驱动（RelicManager.ensureMounted 挂载后广播一次当前集合），
 *   本类不再 import RelicManager，与其保持单向依赖（管理器 → 视图），杜绝循环引用。
 *
 * P2 遗物可读性（game-design：玩家必须能从界面确认规则，而非靠读代码）：
 *  - 占位文案展示「0/5」上限（上限唯一真源 = ALL_RELIC_TYPES 表长）；
 *  - 监听 RELIC_ACQUIRED：新瓷片弹入动画 + 跳字「获得 图标 名称」（addRelic 先 emit
 *    ACQUIRED 再 emit CHANGED，故重建完成后消费高亮标记，时序天然正确）；
 *  - 点击瓷片：跳字展示该遗物被动效果全文（玩家随时可复习规则）。
 */
@ccclass('RelicBar')
export class RelicBarController extends Component {
    /** 最近一次 RELIC_CHANGED 广播的遗物集合：start 初始渲染用（数据完全由事件驱动，不回查管理器） */
    private _lastTypes: RelicType[] = [];
    /** 刚获得的遗物（RELIC_ACQUIRED 置位，rebuild 完成后消费：弹入 + 跳字） */
    private _pendingHighlight: RelicType | null = null;

    protected onLoad(): void {
        // 场景历史遗留：RelicBar 节点上序列化出数十个重复 RelicBarController 实例。
        // rebuild() 首步是 removeAllChildren()，多实例同时监听 RELIC_CHANGED 会让同一节点被
        // 反复重建、彼此的瓷片互相抹除（无遗物时更是数十个占位 Label 完全重叠）。仅保留首个。
        if (this.node.getComponent(RelicBarController) !== this) {
            this.destroy();
            return;
        }
        // 顶部 HUD 两行式布局：遗物栏钉在 HUD 第二行下方（y=514），不再与能量/波次行挤叠
        this.node.setPosition(0, 514, 0);
        EventBus.on(GameEvents.RELIC_CHANGED, this.onRelicChanged, this);
        EventBus.on(GameEvents.RELIC_ACQUIRED, this.onRelicAcquired, this);
    }

    protected start(): void {
        this.rebuild(this._lastTypes);
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.RELIC_CHANGED, this.onRelicChanged, this);
        EventBus.off(GameEvents.RELIC_ACQUIRED, this.onRelicAcquired, this);
    }

    /** 遗物集合变化：缓存最新集合 + 整栏重建（数量上限 5，代价可忽略） */
    private onRelicChanged(types: RelicType[]): void {
        this._lastTypes = types;
        this.rebuild(types);
    }

    /** 获得新遗物：置高亮标记（addRelic 随后广播 RELIC_CHANGED 触发重建，重建尾部消费） */
    private onRelicAcquired(type: RelicType): void {
        this._pendingHighlight = type;
    }

    private rebuild(types: RelicType[]): void {
        if (!this.node?.isValid) {
            return;
        }
        // 清空旧瓷片
        for (const child of [...this.node.children]) {
            if (child?.isValid) {
                child.destroy();
            }
        }
        this.node.removeAllChildren();
        this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);

        if (types.length === 0) {
            this.addPlaceholder();
            this._pendingHighlight = null; // 占位态无瓷片可高亮（防御：理论上不会收到 ACQUIRED 后仍空池）
            return;
        }

        // 一字横排、水平居中
        const total = types.length;
        const startX = -((total - 1) * (TILE_WIDTH + TILE_GAP)) / 2;
        for (let i = 0; i < total; i++) {
            const tile = this.createTile(types[i]);
            tile.setPosition(startX + i * (TILE_WIDTH + TILE_GAP), 0, 0);
            this.node.addChild(tile);
        }
        this.highlightNewlyAcquired();
    }

    /** 新获得瓷片弹入（0.2→1.25→1 回弹）+ 跳字「🧿 获得 图标 名称」；消费后清标记 */
    private highlightNewlyAcquired(): void {
        const type = this._pendingHighlight;
        if (type === null || type === undefined) {
            return;
        }
        this._pendingHighlight = null;
        const info = RELIC_DATABASE[type];
        if (!info) {
            return;
        }
        for (const child of this.node.children) {
            if (child.name === `relic_${type}`) {
                child.setScale(0.2, 0.2, 1);
                tween(child)
                    .to(0.12, { scale: new Vec3(1.25, 1.25, 1) })
                    .to(0.08, { scale: new Vec3(1, 1, 1) })
                    .start();
                FloatingTextManager.instance?.showText(
                    `获得遗物 ${info.name}`, child.worldPosition, Theme.ui.gold, true,
                );
                return;
            }
        }
    }

    /** 未获得遗物时的占位提示（展示上限规则：0/5） */
    private addPlaceholder(): void {
        const label = this.makeLabel(`遗物 0/${ALL_RELIC_TYPES.length}（藏宝箱获取）`);
        label.color = Theme.ui.whiteGhost;
        label.fontSize = 17;
        this.node.addChild(label.node);
    }

    /** 创建单个遗物瓷片：半透明暗金圆角底板（亮金描边）+ 矢量图标 + 名称；点击复习被动全文 */
    private createTile(type: RelicType): Node {
        const info = RELIC_DATABASE[type];
        const tile = new Node(`relic_${type}`);
        tile.layer = this.node.layer;
        const tf = tile.getComponent(UITransform) ?? tile.addComponent(UITransform);
        // 显式尺寸：触摸命中区与视觉底板一致（默认 100×100 会超出瓷片误触）
        tf.setContentSize(TILE_WIDTH, TILE_HEIGHT);

        const g = tile.addComponent(Graphics);
        g.fillColor = TILE_BG;
        g.roundRect(-TILE_WIDTH / 2, -TILE_HEIGHT / 2, TILE_WIDTH, TILE_HEIGHT, 10);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = TILE_BORDER;
        g.roundRect(-TILE_WIDTH / 2, -TILE_HEIGHT / 2, TILE_WIDTH, TILE_HEIGHT, 10);
        g.stroke();

        // 矢量图标（主题金染色）+ 纯文本名称（替代原 emoji Label：字形跨平台一致）
        mountIcon(tile, info.icon, 22, TILE_BORDER, -TILE_WIDTH / 2 + 20, 0);
        const label = this.makeLabel(info.name);
        label.fontSize = 17;
        label.color = Theme.white;
        label.node.setPosition(12, 0, 0);
        tile.addChild(label.node);

        // 点击瓷片：跳字展示被动效果描述（tile 随 rebuild 销毁，监听随节点自然回收）
        tile.on(Node.EventType.TOUCH_END, () => {
            FloatingTextManager.instance?.showText(
                `${info.name}：${info.desc}`, tile.worldPosition, Theme.ui.gold,
            );
        }, this);
        return tile;
    }

    /** 生成一个居中的遗物 Label */
    private makeLabel(text: string): Label {
        const labelNode = new Node('Label');
        labelNode.layer = this.node.layer;
        labelNode.addComponent(UITransform).setContentSize(TILE_WIDTH - 12, TILE_HEIGHT - 8);
        const label = labelNode.addComponent(Label);
        label.string = text;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.SHRINK;
        return label;
    }
}
