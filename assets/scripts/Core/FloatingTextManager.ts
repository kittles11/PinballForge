import {
    _decorator, Component, Node, Color, Vec3, Label, UITransform, UIOpacity, Tween, tween, find,
} from 'cc';

const { ccclass } = _decorator;

/** 普通跳字字号（px） */
const FONT_SIZE_NORMAL = 22;
/** 暴击跳字字号（px） */
const FONT_SIZE_CRIT = 30;
/** 暴击起手缩放（0.06s 弹跳段起点） */
const CRIT_SCALE_FROM = 1.4;
/** 暴击弹跳峰值缩放 */
const CRIT_SCALE_TO = 1.6;
/** 暴击弹跳时长（秒） */
const CRIT_POP_DURATION = 0.06;
/** 暴击上浮时长（秒）：随上浮同步淡出 */
const CRIT_FLOAT_DURATION = 0.4;
/** 暴击上浮距离（px） */
const CRIT_FLOAT_DISTANCE = 40;
/** 普通上浮时长（秒）：随上浮同步淡出 */
const NORMAL_FLOAT_DURATION = 0.35;
/** 普通上浮距离（px） */
const NORMAL_FLOAT_DISTANCE = 30;
/** 对象池上限：超出后回收改为直接销毁，防极端高频撞钉场景池无限膨胀 */
const MAX_POOL_SIZE = 32;

/**
 * 全局浮动跳字池（单例 FloatingTextManager.instance）：
 * - 零 Inspector 配置：首次访问 instance 时惰性自建，挂到 Canvas/UILayer（兜底 Canvas）下；
 * - 轻量 Label 节点经对象池复用（无 Prefab / 无资源依赖，纯代码创建），暴击大字与普通跳字两套动效；
 * - 动效结束由 tween 尾帧回收进池（复用时打断旧 tween），池超上限直接销毁，杜绝内存泄漏。
 * 调用方式：FloatingTextManager.instance?.showText('+20', worldPos, Color.YELLOW, true)
 */
@ccclass('FloatingTextManager')
export class FloatingTextManager extends Component {
    /** 单例内部存储（经 getter/setter 暴露，读取时机不存在则惰性自建） */
    private static _instance: FloatingTextManager | null = null;

    /** 单例引用：首次访问时若不存在则自动创建并挂载到 Canvas/UILayer 下 */
    public static get instance(): FloatingTextManager | null {
        if (this._instance?.isValid) {
            return this._instance;
        }
        return this.bootstrap();
    }

    public static set instance(value: FloatingTextManager | null) {
        this._instance = value;
    }

    /** 空闲跳字节点池（复用） */
    private _pool: Node[] = [];
    /** 自身 UITransform：世界坐标 → 本地坐标转换用 */
    private _uiTransform: UITransform | null = null;

    /** 惰性自建：优先挂 Canvas/UILayer，兜底 Canvas；场景无 Canvas 时返回 null（调用方 ?. 静默跳过） */
    private static bootstrap(): FloatingTextManager | null {
        const host = find('Canvas/UILayer') ?? find('Canvas');
        if (!host) {
            return null;
        }
        const layer = new Node('FloatingTextLayer');
        layer.layer = host.layer; // 与宿主同 layer，确保被同一 UI 相机渲染
        layer.addComponent(UITransform);
        host.addChild(layer);
        // 入树激活后 addComponent → onLoad 同步执行并写回 _instance
        this._instance = layer.addComponent(FloatingTextManager);
        console.log('[FloatingText] 惰性自建跳字特效层：Canvas/UILayer/FloatingTextLayer');
        return this._instance;
    }

    protected onLoad(): void {
        FloatingTextManager.instance = this;
        this._uiTransform = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    }

    protected onDestroy(): void {
        if (FloatingTextManager._instance === this) {
            FloatingTextManager._instance = null;
        }
        // 子节点（跳字）随本节点一并销毁，仅需清空池引用防悬挂
        this._pool.length = 0;
        this._uiTransform = null;
    }

    /**
     * 核心入口：在指定世界坐标弹出一条浮动跳字。
     * @param text     文本内容（如 '+60'、'-200 💥'）
     * @param worldPos 世界坐标（钉子 / 漏斗槽 / 敌人头顶）
     * @param color    文字颜色
     * @param isCrit   暴击样式：1.4 倍起手 → 0.06s 弹跳至 1.6 倍 → 0.4s 上浮 40px 淡出；
     *                 普通样式：1.0 倍 → 0.35s 上浮 30px 淡出。
     */
    public showText(text: string, worldPos: Vec3, color: Color, isCrit: boolean = false): void {
        const xform = this._uiTransform;
        if (!xform?.isValid || !this.node?.isValid) {
            return;
        }
        const node = this._obtain();
        node.active = true;
        // 世界坐标 → 特效层本地坐标（UILayer 若有偏移/缩放也自动换算正确）
        node.setPosition(xform.convertToNodeSpaceAR(worldPos));

        const label = node.getComponent(Label);
        if (label) {
            label.string = text;
            label.fontSize = isCrit ? FONT_SIZE_CRIT : FONT_SIZE_NORMAL;
            label.color = color;
        }

        // 透明度复位（复用旧节点时先打断残留 tween，防止上一次的淡出链污染本次动效）
        const opacity = node.getComponent(UIOpacity);
        if (opacity) {
            Tween.stopAllByTarget(opacity);
            opacity.opacity = 255;
        }
        Tween.stopAllByTarget(node);

        if (isCrit) {
            // 暴击：1.4 倍起手 → 0.06s 弹跳至 1.6 倍 → 0.4s 上浮 40px + 淡出
            node.setScale(CRIT_SCALE_FROM, CRIT_SCALE_FROM, 1);
            const endY = node.position.y + CRIT_FLOAT_DISTANCE;
            tween(node)
                .to(CRIT_POP_DURATION, { scale: new Vec3(CRIT_SCALE_TO, CRIT_SCALE_TO, 1) })
                .to(CRIT_FLOAT_DURATION, { position: new Vec3(node.position.x, endY, 0) })
                .call(() => this._recycle(node))
                .start();
            if (opacity) {
                // 弹跳段不透明，随上浮段同步淡出
                tween(opacity)
                    .delay(CRIT_POP_DURATION)
                    .to(CRIT_FLOAT_DURATION, { opacity: 0 })
                    .start();
            }
        } else {
            // 普通：1.0 倍 → 0.35s 上浮 30px + 淡出
            node.setScale(1, 1, 1);
            const endY = node.position.y + NORMAL_FLOAT_DISTANCE;
            tween(node)
                .to(NORMAL_FLOAT_DURATION, { position: new Vec3(node.position.x, endY, 0) })
                .call(() => this._recycle(node))
                .start();
            if (opacity) {
                tween(opacity).to(NORMAL_FLOAT_DURATION, { opacity: 0 }).start();
            }
        }
    }

    /** 取节点：优先池内复用，池空则纯代码创建（Node + UITransform + UIOpacity + Label，零资源依赖） */
    private _obtain(): Node {
        const pooled = this._pool.pop();
        if (pooled?.isValid) {
            return pooled;
        }
        return this._createNode();
    }

    private _createNode(): Node {
        const node = new Node('FloatText');
        node.layer = this.node.layer;
        node.addComponent(UITransform);
        node.addComponent(UIOpacity);
        const label = node.addComponent(Label);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        label.overflow = Label.Overflow.NONE;
        this.node.addChild(node);
        return node;
    }

    /** 回收：停全部 tween → 隐藏入池；池超上限时直接销毁（池大小封顶 = 历史峰值并发跳字数） */
    private _recycle(node: Node): void {
        if (!node?.isValid) {
            return;
        }
        Tween.stopAllByTarget(node);
        const opacity = node.getComponent(UIOpacity);
        if (opacity) {
            Tween.stopAllByTarget(opacity);
        }
        if (this._pool.length >= MAX_POOL_SIZE) {
            node.destroy();
            return;
        }
        node.active = false;
        this._pool.push(node);
    }
}
