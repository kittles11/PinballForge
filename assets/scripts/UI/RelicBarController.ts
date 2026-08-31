import {
    _decorator, Component, Node, Label, Graphics, UITransform, Color,
} from 'cc';
import { EventBus, GameEvents } from '../Core/EventBus';
import { RelicType, RELIC_DATABASE } from '../Core/DataModels';

const { ccclass } = _decorator;

/** 单个遗物瓷片尺寸（px） */
const TILE_WIDTH = 150;
const TILE_HEIGHT = 40;
/** 瓷片间距（px） */
const TILE_GAP = 8;
/** 瓷片底色：半透明暗金（与金币主题呼应） */
const TILE_BG = new Color(46, 40, 16, 200);
/** 瓷片边框色：亮金 */
const TILE_BORDER = new Color(255, 216, 120, 255);

/**
 * 顶部 UI 遗物栏（RelicBarController）：挂在 Canvas/UILayer/RelicBar 节点（由 RelicManager 自举创建）。
 * - 监听 RELIC_CHANGED 实时渲染已获得的遗物 Emoji 徽章列表，一字横排居中；
 * - 初始渲染同样由 RELIC_CHANGED 驱动（RelicManager.ensureMounted 挂载后广播一次当前集合），
 *   本类不再 import RelicManager，与其保持单向依赖（管理器 → 视图），杜绝循环引用。
 */
@ccclass('RelicBar')
export class RelicBarController extends Component {
    /** 最近一次 RELIC_CHANGED 广播的遗物集合：start 初始渲染用（数据完全由事件驱动，不回查管理器） */
    private _lastTypes: RelicType[] = [];

    protected onLoad(): void {
        EventBus.on(GameEvents.RELIC_CHANGED, this.onRelicChanged, this);
    }

    protected start(): void {
        this.rebuild(this._lastTypes);
    }

    protected onDestroy(): void {
        EventBus.off(GameEvents.RELIC_CHANGED, this.onRelicChanged, this);
    }

    /** 遗物集合变化：缓存最新集合 + 整栏重建（数量上限 5，代价可忽略） */
    private onRelicChanged(types: RelicType[]): void {
        this._lastTypes = types;
        this.rebuild(types);
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
    }

    /** 未获得遗物时的占位提示 */
    private addPlaceholder(): void {
        const label = this.makeLabel('🧿 遗物：暂无');
        label.color = new Color(255, 255, 255, 120);
        label.fontSize = 20;
        this.node.addChild(label.node);
    }

    /** 创建单个遗物瓷片：半透明暗金圆角底板（亮金描边）+ 图标 + 名称 */
    private createTile(type: RelicType): Node {
        const info = RELIC_DATABASE[type];
        const tile = new Node(`${info.icon}${info.name}`);
        tile.layer = this.node.layer;
        tile.getComponent(UITransform) ?? tile.addComponent(UITransform);

        const g = tile.addComponent(Graphics);
        g.fillColor = TILE_BG;
        g.roundRect(-TILE_WIDTH / 2, -TILE_HEIGHT / 2, TILE_WIDTH, TILE_HEIGHT, 10);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = TILE_BORDER;
        g.roundRect(-TILE_WIDTH / 2, -TILE_HEIGHT / 2, TILE_WIDTH, TILE_HEIGHT, 10);
        g.stroke();

        const label = this.makeLabel(`${info.icon} ${info.name}`);
        label.fontSize = 20;
        label.color = Color.WHITE;
        tile.addChild(label.node);
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
