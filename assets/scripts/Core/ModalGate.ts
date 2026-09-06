/**
 * 模态现实校验（ModalGate）：以「对话框节点真实 active 状态」为准的弹窗判定。
 *
 * 背景：事件镜像式互斥守卫（_modalOpen 由 UI_MODAL_CHANGED 事件维护）已被实测反复卡死——
 * 任何一次 true 之后 false 丢失（热重载清 UI、弹窗中途被隐藏、发射方漏发），徽章与发射器
 * 就永久失联（2026-09-03 连续三轮排查）。本模块提供唯一真源查询：所有模态弹窗都是
 * Canvas/UILayer 的直接子节点且以名字登记，任何时刻都能反查真实状态。
 *
 * 用法：点击守卫先用事件镜像快速判断，再用本查询纠偏（镜像 true 但现实无弹窗 → 自愈并打点）。
 */
import { find } from 'cc';

/** UILayer 下按名登记的全部模态弹窗节点（新增弹窗时在此登记） */
const MODAL_NODE_NAMES = [
    'DailyTaskDialog',
    'DeckViewDialog',
    'ShopDialog',
    'RewardDialog',
    'ResultDialog',
    'SignInDialog',
    'SettingsDialog',
] as const;

/** 当前是否真的有模态弹窗处于激活状态（场景未就绪时按无弹窗处理） */
export function anyModalOpen(): boolean {
    const uiLayer = find('Canvas/UILayer');
    if (!uiLayer?.isValid) {
        return false;
    }
    for (const name of MODAL_NODE_NAMES) {
        const n = uiLayer.getChildByName(name);
        if (n?.isValid && n.active) {
            return true;
        }
    }
    return false;
}

/**
 * 强制关闭全部已打开的模态弹窗（结算界面弹出前调用）。
 *
 * 背景：战斗中开着的任务/背包弹窗是运行时 addChild 的代码节点，渲染序天然压在
 * 场景节点 ResultDialog 之上——结算触发时若不先关掉它们，结算界面会被压在遮罩
 * 之下（玩家关掉当前面板后「又露出一个关不掉的界面」，2026-09-04 排查）。
 * 直接置 active=false 是安全的：各弹窗的关闭逻辑本就只有广播 + active=false
 * （DailyTaskDialog.closeDialog 同款），模态状态随后由结算界面的
 * UI_MODAL_CHANGED true 接管，场景重载时一切归零。
 */
export function closeAllModals(): void {
    const uiLayer = find('Canvas/UILayer');
    if (!uiLayer?.isValid) {
        return;
    }
    for (const name of MODAL_NODE_NAMES) {
        const n = uiLayer.getChildByName(name);
        if (n?.isValid && n.active) {
            n.active = false;
        }
    }
}
