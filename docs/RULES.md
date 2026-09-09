# Cocos Creator + 微信小游戏开发规则

> 蒸馏自三本书：《Cocos Creator 3.x 游戏开发入门与实战》（黄鸿信）、《微信小游戏开发：前端篇》《微信小游戏开发：后端篇》（李艺）。
> 本文件是 Cline / AI 编程助手在为 **Cocos Creator 3.x 构建微信小游戏** 时必须遵守的规则。规则按优先级组织：铁律 > 平台差异 > 工程规范 > 实现模式 > 发布检查。

## 0. 技术栈锁定

- 引擎：Cocos Creator 3.x（TypeScript），不是 Cocos2d-x Lua/JS、不是裸 Canvas、不是 Unity。
- 目标平台：微信小游戏（构建发布 → 微信小游戏，产物 `wechatgame/`，用微信开发者工具打开预览与上传）。
- 脚本语言 TypeScript；微信原生小游戏原生 API（wx.*）通过 `sys` / 条件编译或插件层调用，运行环境无 DOM、无 BOM、无 document/window（有 GameGlobal）。
- 后端默认分层递进：本地缓存 → 文件系统 → 微信云开发 → 自建服务器；不要为单机游戏引入服务器。

## 1. 铁律（违反即 bug，来自书中真实踩坑）

1. **模拟器通过 ≠ 真机通过。** 微信小游戏在模拟器 / PC微信 / Mac微信 / iOS / Android 五端实现各不相同；除模拟器外的四端是上线前必须实测的环境。凡 UI 表现类代码（阴影、渐变、字体、颜色），必须真机验证。
2. **手机端不支持：Canvas 阴影（shadowBlur/shadowColor/shadowOffsetX/Y）、渐变填充（createLinearGradient）、十六进制 RGBA 颜色（如 `#00000033`）、部分字体样式（斜体等）。** 替代方案：需要渐变/阴影的效果直接做成图片；RGBA 改用纯色。
3. **本地资源引用路径不能以 `./` 开头。** 写 `static/images/a.png`，不写 `./static/images/a.png`——后者在真机上加载失败。
4. **DOM API 不存在。** `document.getElementById` → `wx.createCanvas()`；`new Image()` → `wx.createImage()`；`new Audio()` → `wx.createInnerAudioContext()`；`addEventListener/removeEventListener` → `wx.onTouchEnd / wx.offTouchEnd` 等全局触摸监听（无 targetTouches，取 `res.touches[0]` 或 `res.changedTouches[0]` 的 clientX/clientY）。
5. **音频：** `InnerAudioContext.currentTime` 只读，重置播放头用 `seek(0)`；`onStop` 不监听自然播完，循环/播完检测用 `onEnded`；`pause()` 后再 `play()` 从暂停处继续，`stop()` 后从头；官方已放弃 Audio 组件，WebAudioContext 仅 iOS 可用，生产一律 `wx.createInnerAudioContext()`。
6. **授权：** 播放声音不需要授权；`scope.userInfo` 不能用 `wx.authorize` 直接弹（生产禁用），必须 `wx.createUserInfoButton` 让用户点击；`scope.userLocation` 可直接 `wx.authorize`。
7. **Box2D 碰撞回调不触发？** 勾选刚体 `EnabledContactListener`。且 Box2D 下移动父节点不会带动子节点，必须逐节点操作。
8. **重复触发 Tween 会叠加。** 每次启动缓动前先停止旧缓动（保存 tween 引用并 stop），并用状态变量防止重入（如子弹未返回时不可再次发射）。
9. **定时器必须配对清除。** setTimeout/setInterval 返回的 id 必须保存；游戏结束/重启/组件销毁时 clearTimeout/clearInterval，否则重启后定时器叠加。两类定时器编号池共享，clear 方法可混用。
10. **事件监听配对移除。** 有一个 on 必有对应 off；off 参数必须与 on 完全一致 → 回调用命名函数，不用匿名函数。贯穿整个生命周期的监听可不移除。
11. **异步回调会丢 this。** setTimeout/事件/rAF 回调里要用 this 时必须 bind（或改箭头函数并理解其向上取 this 的规则）。
12. **异步接口一律 `.catch(console.log)` 或 promisify + catch。** Console 红色错误影响运行必须处理，灰色警告一般可忽略。
13. **服务端时间用 `db.serverDate()`，不要用客户端 `new Date()`**（端上时间不可靠）。
14. **开放数据域（好友排行榜）是单向隔离的：** 主域只能 `postMessage` 进去，不能把好友数据传回主域；开放数据域内不能 import 主域模块（工具函数复制进去）；`wx.getFriendCloudStorage` 仅开放数据域可调。KVData：`key` = 排行榜标识，`value` = `JSON.stringify({wxgame:{score, update_time}})`，读写 key 必须一致。
15. **小游戏端直接操作云数据库时 remove 每次只能删 1 条**，批量删除走云函数。

## 2. Cocos Creator 工程规范

### 2.1 目录结构（项目创建即规划）
```
assets/
  scenes/        场景（Game.scene 等，首场景在构建设置指定）
  scripts/       TypeScript 脚本（一个文件一个类，文件名=类名）
  sources/       图片、粒子等静态素材
  prefabs/       预制体（可复用节点模板）
  resources/     仅放需要 resources.load 动态加载的资源
  animations/    动画剪辑 AnimationClip
```
- 设计分辨率：横版 1280×720 / 竖版 720×1280，在 项目设置→项目数据 中设定。
- 所有 2D 显示元素挂在 Canvas（RenderRoot2D）之下才会渲染。

### 2.2 脚本组件
- 组件类必须 `@ccclass('唯一类名')` + `extends Component`；需要在编辑器绑定/可见的属性加 `@property`，否则只在代码内部可用。
- 生命周期顺序：`onLoad → onEnable → start → update(每帧) → lateUpdate → onDisable → onDestroy`。初始化放 onLoad；依赖其他组件初始状态的放 start；每帧逻辑 update；动画/物理之后的事 lateUpdate；清理（解绑事件、停定时器、停缓动）放 onDestroy。
- 简单位移动画/按钮反馈用 Tween（`tween(node).to(1, {position}, ...)`），复杂角色动画/特效用 Spine/DragonBones，不要用内置动画编辑器硬做。
- 动画播完再执行逻辑：监听 `Animation.EventType.FINISHED`（如回合制游戏中，回合翻转必须放在动画完成回调里，否则动画未播完玩家就能操作）。
- 碰撞检测选型：少量对象/不求精确 → update 里算两点距离（`Vec3.distance < 阈值`）；对象多或需要物理效果（弹跳、重力）→ 物理系统。2D：只查碰撞用 Builtin，要刚体/弹性用 Box2D；3D 默认 PhysX。在 项目设置→功能裁剪 中选择。
- 频繁 instantiate/destroy 是性能大忌 → 对象池/循环复用（出屏对象重置坐标再入列）。

### 2.3 输入
- 跨端点击统一监听触摸事件 `input.on(Input.EventType.TOUCH_START, ...)`（触摸事件在移动端与 PC 均触发），不选鼠标事件。
- 代码示例骨架：
```ts
input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
// onDestroy 中：
input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
```

## 3. 微信小游戏平台规则

### 3.1 原生组件与 UI 层级
五层结构（自下而上）：① 游戏背景层 ② 游戏页面层 ③ 游戏前景层（自绘顶级 UI）④ 系统原生 UI 层（`wx.createOpenSettingButton` / `wx.createGameClubButton` / `wx.createFeedbackButton` / `wx.createUserInfoButton`）⑤ 系统模态弹窗层（`wx.showModal` / `wx.showToast`）。
- `wx.createXxxButton` 创建的原生按钮由运行时绘制：不受画布清屏影响、无需手动 add、有 `show()`；定位用绝对坐标（放在顶级 UI 容器时容器只能是 Box，不能是 VBox/HBox）。

### 3.2 反馈接口
- 轻提示 `wx.showToast({title, icon:'success'|'error'|'loading'|'none', image?, duration, mask})`；确认弹窗 `wx.showModal({title, content, showCancel})`，返回 Promise 风格可 await。

### 3.3 系统事件
- 来电/闹钟/切后台等中断：`wx.onAudioInterruptionBegin/End`，End 时检查 `bgAudio.paused` 后手动 `play()` 恢复，音频不会自动恢复。
- 全局错误兜底：`wx.onError(err => {...})` 记录错误日志（先本地，有后端后上报）。
- 主动 GC：`wx.triggerGC()`（不保证立即生效；生产环境交给运行时即可，不要滥用）。
- 防沉迷（合规必接）：`wx.checkIsUserAdvisedToRest({todayPlayedTime})`，自行累计当日游玩时长并持久化；结果是 true 则弹窗警告并在确认后 `wx.exitMiniProgram()`。
- 振动：`wx.vibrateShort()` 失败降级 `wx.vibrateLong()`，两者都加 catch（PC 端与旧机型不支持短振）。
- 自定义字体：`wx.loadFont(本地路径)`；只需有限字符时先在 iconfont webfont 生成小体积字体文件。

### 3.4 排行榜 / 广告 / 社交
- 游戏内好友排行榜（个人开发者可用）：管理后台配置排行榜（key 如 `rank`）→ `game.json` 加 `"openDataContext": "open_data"` → 开放数据域目录写渲染代码（共享离屏画布）→ 主域 `wx.getOpenDataContext()` + `postMessage({command, data})` 指令式通信 → 主域 `drawImage(openDataContext.canvas, 0, 0)` 转绘。
- 广告（个人开发者可接，流量主需 UV≥1000）：
  - Banner：`wx.createBannerAd({adUnitId, style})`，创建后直接 `show()`（自动加载），放在不影响游玩的区域，必须监听 `onError`。
  - 激励视频：`wx.createRewardedVideoAd({adUnitId})`，手动 `load()`，`onLoad` 后 `show()`；`onClose(res => res.isEnded && 发放奖励)`——只有看完才发奖。
- 客服/反馈/游戏圈：默认用微信官方客服后台即可；按钮用对应 `wx.create*Button`。

### 3.5 存储与后端选型阶梯（按需递进，不过度设计）
1. **LocalStorage**：`wx.setStorageSync(key, value)` / `wx.getStorageSync(key)`，单 key 1MB、总量 10MB，适合配置、最高分等非机密小数据。
2. **FileSystemManager**：`wx.env.USER_DATA_PATH` 用户目录，上限 50MB；写文件前 JSON.stringify；读前先 access 判断存在性。
3. **微信云开发**（个人开发者首选）：免鉴权、免运维。`project.config.json` 配 `cloudfunctionRoot`；两个环境 dev/prod；云函数 `cloud.getWXContext()` 直接拿 openid；端上直接操作云数据库是云函数权限的子集，只做非机密操作；分页 `limit+skip+offset` 配 `count` 取 total；并发写用原子操作 `_.inc / _.push / _.addToSet`；查询操作符 `_.eq/lt/gt/in/...`。
4. **自建服务器**（Node koa2 或 Go iris + MySQL）：仅当云开发不能满足时。开发期本地跑 + frp 内网穿透 + Nginx 80 端口转发，再配微信后台消息推送（URL 必须 80/443）。

### 3.6 网络与异步
- promisify 模板（端上异步接口统一转 async/await）：
```ts
export function promisify(asyncApi) {
  return (args = {}) => new Promise((resolve, reject) =>
    asyncApi(Object.assign(args, { success: resolve, fail: reject })));
}
// 用法：await promisify(wx.setStorage)({key, data}).catch(console.log)
```
- 空值安全：`res?.data ?? {}`。
- openid 获取走云函数并做私有缓存（首次拉取后复用）。
- 网络请求 `wx.request`；返回统一 `{errMsg, data}` 结构，`errMsg === 'ok'` 表示成功——与微信官方接口风格保持一致，降低心智负担。

## 4. 代码组织模式（两书共同验证的架构）

### 4.1 游戏主循环六周期函数
所有小游戏逻辑按六个周期函数组织：
- `init`（一次性初始化：音频、材质、事件监听开启）
- `start`（开始一局：重置状态、计分、定时）
- `run`（纯数据计算：运动、碰撞、胜负判定）
- `render`（纯渲染：只读数据画界面）
- `loop`（rAF 循环调 run + render）
- `end`（结束逻辑：清理、记录、展示结算）

**核心原则：控制数据而非直接控制渲染。** 多处视图依赖同一份数据时，只改数据，渲染自动反映；计算与渲染严格分离。

### 4.2 模块结构与管理者单例
```
src/
  managers/   data / audio / font / lbs / cloud / open_data / backend_api ...
  views/      page(基类) / 各页面对象 / 游戏实体对象
  libs/       event_dispatcher 等通用库
```
- 每个管理器是单例：文件底部 `export default new XxxManager()`；需要防重复初始化时 `if (this.initialized) return; this.initialized = true`。
- Cocos 侧对应：AudioSource/管理类节点常驻 + 类内静态 `getInstance()`；或模块级单例导出。
- 管理器方法参数化带默认值：`options?.volume ?? 1`；会变的数据参数化，模块自管常量不参数化。
- 内部状态 `#` 私有化，对外暴露 getter；图片等重资源只加载一次复用。
- 一个文件只定义一个类。
- 事件名统一定义为常量（防重名），自建 `EventDispatcher`（on/off/once/emit）做模块间解耦。
- 页面/场景切换：Game 对象持有 `#currentPage`，`turnToPage` 时旧页 `end()` 新页 `start()`。
- 保持接口返回结构稳定：扩展新方法时保持旧结构（ errMsg/data ），调用方无感替换——新旧实现可互相替换（代理/策略的通用思想）。

### 4.3 通用防御式细节
- 全局变量最小化：能局部不文件，能文件不全局；确需全局挂 `GameGlobal`（小游戏）。
- 游戏状态机用显式状态变量（如 gameState/turnNum），防重入、防操作时序错乱。
- 限时逻辑：结束分支处 clearTimeout；重启前清除旧定时器。
- 资源路径：本地路径不带 `./`；大资源（BGM、大图）放网络存储用 URL，控制包体（小游戏主包 4MB 内）。
- 音频格式固定 mp3（微信全端支持 mp3/aac/m4a/wav），不做 canPlayType 兼容分支。

## 5. 开发流程与产品规则

- 原型优先：核心玩法 → 能玩 → 再打磨；原型阶段用色块美术、允许脏代码，"完成比完美重要"；核心玩法跑通后再模块化重构。
- 先做核心玩法的可玩版本，用最简单的碰撞/动画方案，遇到瓶颈才升级方案（距离判断 → 物理系统；Tween → 动画编辑器/Spine）。
- 反馈迭代由近到远：先朋友（不指导、观察操作），后社群/论坛。
- 上线检查：软著申请、平台开发者账号（个人可入驻 TapTap/微信小游戏）、icon + 3~5 张截图 + 80 字简介 + 10s 视频；广告变现走穿山甲/优量汇；内购需要版号，无版号选广告变现。
- 微信小游戏构建：Cocos 构建发布面板选"微信小游戏"，AppID 填后台获取的 ID；产物用微信开发者工具打开；上传前在真机预览四端表现。

## 6. 调试规则

- Cocos：浏览器预览用 Chrome F12 看日志；构建报错打开构建日志检索 error/failure。
- 微信：调试区 Storage 面板查缓存；Network→Cloud 查云函数调用；真机用远程调试（注意版本要求）；Console 红色必须修、灰色可忽略。
- 物理调试：开启 `debugDrawFlags` 绘制碰撞区域（做成可开关的 Setting 组件）。
- 遇到诡异问题先怀疑基础库版本（升级最新基础库可避免旧版 bug）；再怀疑平台差异（换端测试）；最后才是自己的代码。

## 7. 反模式清单（禁止）

- ❌ 使用 document/window/DOM API（小游戏环境不存在）。
- ❌ 本地资源路径以 `./` 开头。
- ❌ 依赖阴影/渐变/RGBA 十六进制色做关键 UI（真机不显示，关键信息会丢失）。
- ❌ 匿名函数做事件回调（无法 off）。
- ❌ 创建定时器不保存 id、游戏结束不清理。
- ❌ 每帧 new 对象 / 频繁 instantiate-destroy（用对象池）。
- ❌ 在 update 里做复杂字符串拼接/频繁 getter 调用等重活。
- ❌ 把机密信息（密钥、AppSecret）放前端；LBS key 等应放后端（书中作者坦承教学示例直接放前端是错误示范）。
- ❌ 客户端 new Date() 做服务端记录时间戳。
- ❌ 在没有后端需求的单机游戏里引入服务器与数据库。
- ❌ 主包塞大音频大图（BGM 走网络 URL 或压缩）。
- ❌ 一个文件塞多个类 / 函数既算数据又画界面（计算与渲染分离）。
