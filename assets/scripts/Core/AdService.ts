/**
 * 激励视频广告服务（模块级单例，GAME_PLAN 3.2 变现点位的统一出口）。
 *
 * 【定位】IAA（激励视频）为主，全部点位玩家主动触发，不做强制插屏（运营红线）。
 * 当前为 **mock 实现**：开发/软启动期 100% 发奖（console 可见），埋点全量上报，
 * 保证 ad_show → ad_complete 漏斗在测试包内可见；M4 接 SDK 时只替换 play() 内部
 * 为微信 / 抖音 rewardedVideoAd 调用（onClose(res.isEnded) → onReward、onError → onSkip），
 * 调用方（点位 UI）零改动。
 *
 * 【埋点】附录 A：ad_show（播放发起）/ ad_complete（播完发奖）——placement 字段区分点位。
 */
import { Analytics } from './Analytics';

/** 广告点位 id（附录 A：placement 上线不改名） */
export type AdPlacement =
    /** 死亡复活（结算弹窗，每局 1 次） */
    | 'revive'
    /** 结算碎片双倍（结算弹窗，每局 1 次） */
    | 'shards_double'
    /** 三选一免费刷新（奖励弹窗，每局 1 次） */
    | 'card_refresh';

class AdServiceClass {
    /**
     * 播放激励视频：播完回调 onReward 发奖；失败 / 中途关闭回调 onSkip（玩家无损失）。
     * mock 实现同步发奖；SDK 版本为异步回调，调用方不要假设同步时序（UI 刷新放回调内即可）。
     */
    showRewarded(placement: AdPlacement, onReward: () => void, onSkip?: () => void): void {
        Analytics.track('ad_show', { placement });
        // ponytail: mock=100% 发奖；M4 换 SDK 时在 play() 内部接 wx.createRewardedVideoAd，
        // onClose(isEnded)→onReward / onError→onSkip，调用方不动。
        this.play(placement, onReward, onSkip);
    }

    /** SDK 接入点：当前 mock 直接播完发奖 */
    private play(placement: AdPlacement, onReward: () => void, onSkip?: () => void): void {
        void onSkip;
        console.log(`[Ad] 激励视频（${placement}）播放完成（mock）→ 发奖`);
        Analytics.track('ad_complete', { placement });
        onReward();
    }
}

/** 全局单例 */
export const AdService = new AdServiceClass();
